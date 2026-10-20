# DispatchX: handoff for coding agents

Read this whole file before changing anything. It explains what exists, how it is wired,
how to run and test it, how it deploys to AWS, and the traps already hit.

Owners: Anannya Samudra and Lakshit Sachdeva (Sem VII Cloud Computing project, AWS Academy
Cloud Architecting syllabus). Repo: https://github.com/anannyay/DispatchX (public, branch `main`).

---

## 1. What the product is

A real-time, same-city parcel delivery and dispatch platform (think Porter/Dunzo).

- **Customer** books a pickup → drop, gets a quote, tracks the rider live, sees proof-of-delivery photo.
- **Rider** goes online, streams GPS, receives job offers with a 20 s countdown, accepts/declines,
  confirms pickup, completes delivery with an optional photo.
- **Dispatcher** watches a live operations map (kepler.gl), KPIs, alerts and a dispatch log, can
  force-assign or re-dispatch orders, and has a **Cluster** page that visualises the live container
  platform (ECS on AWS, or Kubernetes) with a chaos "stop this task" button.

Demo accounts (password `dispatchx123`): `customer@dispatchx.dev`, `rider@dispatchx.dev`,
`dispatch@dispatchx.dev`, `admin@dispatchx.dev`. Simulator accounts: `rider{N}@sim.dispatchx.dev`,
`customer{N}@sim.dispatchx.dev`. All created by `python -m app.seed`.

## 2. Current state (as of this handoff)

**Local UI update — October 20, 2026:** the public cloud explorer and presentation cleanup
are implemented locally, with checks and remaining work in
[`docs/cloud-explorer-handoff.md`](docs/cloud-explorer-handoff.md). Consult the feature branch/PR
for publication status; no AWS deployment was performed during this work. The AWS/CI statements
below are from the original handoff, not a current health check.

- Deployed and working on AWS in **ap-southeast-2 (Sydney)**.
  App: `https://d1lwatbh61o9k3.cloudfront.net` · Grafana: `/grafana/`.
  The CloudFront domain changes if the stack is destroyed and recreated; read the `AppUrl`
  output of the `dispatchx` stack or the latest deploy run's summary.
- All three GitHub Actions workflows are green: Deploy to AWS, Kubernetes (kind) e2e, (Destroy is manual).
- Presentation material: `docs/presentation-guide.html` (also published as a claude.ai artifact).
- The stack costs about US$4–5/day of the account's free credits. Destroy it when not needed
  (section 9). Do not leave it running for days without telling the owners.

## 3. Repository layout

```
backend/            FastAPI + Socket.IO + Celery + SQS consumer. One Docker image, several roles.
  app/main.py         ASGI app: FastAPI under /api, Socket.IO under /socket.io, /metrics
  app/config.py       pydantic-settings; every env var (section 6)
  app/models.py       SQLAlchemy models: User, RiderProfile, Order, OrderEvent
  app/realtime.py     Socket.IO server (AsyncRedisManager) + write-only Redis emitter `emit()`
  app/redis_client.py Redis clients and the canonical Redis key layout
  app/services/
    dispatch.py       rider matching, offers, timeouts, accept/reject, online/offline
    orders.py         order state machine `transition()` (audit log + broadcast + domain event)
    events.py         publish domain events: SNS when configured, else Celery locally
    handlers.py       event consumers (dispatch, notify), idempotent
    notify.py         customer notifications (Socket.IO + SNS email)
    geo.py            haversine + quote (distance ×1.3 road factor, fare, ETA)
    infra.py          Cluster View snapshot from ECS API or in-cluster Kubernetes API; chaos stop
  app/routers/        auth, orders, riders, uploads, admin
  app/workers/        celery_app.py (+ beat schedule), tasks.py, sqs_consumer.py
  app/seed.py         demo/sim accounts (idempotent)
  alembic/            migrations (env.py takes a MySQL GET_LOCK so parallel containers don't race)
  entrypoint.sh       roles: api | worker | beat | consumer | migrate | seed
  tests/test_infra.py unit tests for the Cluster View normaliser (pytest)
  tests/smoke_e2e.py  full order lifecycle against any BASE_URL (used locally, in CI and against prod)
frontend/           Next.js 15 (App Router) + TypeScript + Tailwind, output: standalone
  src/app/            pages: / (landing), /login, /register, /customer, /customer/orders/[id],
                      /rider, /dispatch (kepler ops map), /dispatch/cluster
  src/components/kepler/OpsMap.tsx  live kepler.gl map (see section 8)
  src/app/architecture/            public, backend-independent cloud explorer
  src/components/architecture/     diagram, playback and environment comparison
  src/lib/architecture*.ts         diagram content and validated shareable view state
  tests/                          architecture data/state checks and optional browser smoke
  src/components/kepler/store.ts    redux store for kepler.gl, map controls config
  src/components/Map.tsx            Leaflet map for customer/rider pages (Esri Dark Gray tiles)
  src/components/ui.tsx             design-system primitives (Button, Panel, Metric, StatusBadge, KV…)
  src/lib/                          api client (JWT refresh), auth context, socket hooks, types, nav
  tailwind.config.ts                design tokens taken from kepler.gl's theme (k-* colours)
simulator/          simulator.py: N virtual riders + customers against any base URL (load + demo)
infra/              CloudFormation (section 7)
k8s/                Kubernetes manifests + kind scripts (section 10)
monitoring/         Prometheus (Cloud Map DNS-SRV discovery) and Grafana images, dashboard generator
.github/workflows/  deploy.yml, destroy.yml, k8s.yml
docker-compose.yml  full local stack incl. MySQL, Redis, Prometheus, Grafana
docs/               presentation guide
```

## 4. How the system works

### Order lifecycle
`pending → assigned → picked_up → delivered`, plus `cancelled`, and `unassigned` (dispatch gave up
after `MAX_DISPATCH_ATTEMPTS`, dispatcher must act). Allowed transitions live in
`services/orders.py::ALLOWED`. **Always change status through `transition()`**: it writes the
`order_events` audit row, emits `order:update` over Socket.IO to the order, customer, rider and
dispatch rooms, and publishes `order.<status>` to the event bus. The one exception is
`dispatch.accept_offer`, which uses a conditional `UPDATE … WHERE status='pending'` for atomicity
and then broadcasts/publishes manually.

### Dispatch (`services/dispatch.py`)
1. `order.created` event → `handle_dispatch` → `dispatch_order(order_id)`.
2. Redis `GEOSEARCH` on `riders:geo` around the pickup; radius grows 3 → 6 → 12 → 25 km every
   2 attempts. Candidates must be in `riders:available`, have fresh GPS (< 45 s) and not be in
   `order:{id}:tried`. Score = distance_km + (5 − rating).
3. Per-rider lock `rider:{id}:offer` via `SET NX` (TTL = offer timeout + 15 s grace) so a rider
   never holds two offers. `order:{id}:offer` records who has it.
4. Emits `job:offer` to room `rider:{id}`; schedules Celery `offer_timeout_task` after 21 s.
5. Timeout/reject → next candidate. No candidate → retry in 5 s. After 12 attempts → `unassigned`
   + `dispatch:alert`.
6. Per-order `lock:dispatch:{id}` (SET NX, 10 s) makes duplicate SQS deliveries harmless.
7. Celery Beat safety nets: `rescue_stuck_orders_task` (45 s) re-dispatches pending orders with no
   live offer, `sla_monitor_task` (30 s), `prune_stale_riders_task` (60 s).

The 15 s offer-key grace exists because of a real bug: keys expired at the same instant the timeout
task ran, stranding orders. Do not remove it.

### Real time
Every API container runs a Socket.IO `AsyncServer` with `AsyncRedisManager`, so emits reach clients
on any instance. Sync code (REST handlers, Celery, SQS consumer) emits through
`realtime.emit()`, a write-only `RedisManager`. Clients connect with `auth: {token}` (JWT) and
WebSocket transport only. Rooms: `user:{id}`, `rider:{id}`, `order:{id}`, `dispatch` (staff).

| Event | Direction | Payload / purpose |
|---|---|---|
| `rider:location` | rider → server (ack) | `{lat,lng,heading,speed}` every ~2 s; server updates Redis, re-emits |
| `rider:location` | server → `order:{id}` | live position for the customer tracking page |
| `fleet:location` | server → `dispatch` | every ping, for the ops map (client batches to 1 Hz) |
| `fleet:rider` | server → `dispatch` | rider online/offline |
| `order:subscribe` / `order:unsubscribe` | client → server | join/leave `order:{id}` (permission-checked) |
| `order:update` | server → rooms | full serialized order after every transition |
| `job:offer` / `job:offer_closed` | server → `rider:{id}` | offer with `expires_at`; withdrawal |
| `dispatch:log` / `dispatch:alert` | server → `dispatch` | log lines; warnings/critical alerts |
| `notification` | server → `user:{id}` | customer toast (title, body) |

### Redis key layout (`app/redis_client.py`)
`riders:geo` (GEO), `riders:online` (SET), `riders:available` (SET), `rider:{id}:state` (HASH:
lat,lng,heading,speed,ts,name,rating,vehicle,order_id), `rider:{id}:offer`, `order:{id}:offer`,
`order:{id}:tried` (SET, 1 h), `lock:dispatch:{id}`, `metrics:*` counters, `metrics:assign_seconds`
(LIST, last 500), `notifications:{user_id}` (LIST), `infra:snapshot` (3 s cache), Celery broker keys.
Redis returns ints for SISMEMBER: wrap in `bool()` before returning JSON (a stray `0` once
rendered in the UI).

### Event bus
`services/events.publish(type, payload)`:
- **AWS** (`SNS_TOPIC_ARN` set): SNS `dispatchx-order-events` with message attribute `event_type`.
  Subscriptions with filter policies + raw delivery:
  `dispatchx-dispatch` (created/pending/delivered/cancelled) and `dispatchx-notify` are read by the
  `consumer` service (`workers/sqs_consumer.py`); `dispatchx-analytics` (all events) is read by
  the `dispatchx-analytics-ingest` Lambda. Each queue has a DLQ (maxReceiveCount 5).
- **Local**: Celery `handle_event_task` calls the same handlers.

### REST API (all under `/api`, Swagger at `/api/docs`)
- `auth`: POST `/register`, `/login`, `/refresh`; GET `/me`
- `orders`: POST `/quote`, POST `` (create), GET `` (list, role-scoped), GET `/{id}`, GET
  `/{id}/events`, POST `/{id}/cancel`, GET `/notifications/me`
- `riders`: GET `/me`, POST `/me/online`, `/me/offline`, `/offers/{id}/accept`, `/offers/{id}/reject`,
  `/orders/{id}/pickup`, `/orders/{id}/deliver`
- `uploads`: POST `/pod` (presigned S3 PUT; local disk fallback `/uploads/local/...`), GET `/pod/{order_id}`
- `admin` (dispatcher/admin): GET `/stats`, `/fleet`, `/riders`, `/infra`; POST
  `/orders/{id}/redispatch`, `/orders/{id}/assign`, `/infra/tasks/{task_id}/stop`
- ops: GET `/health` (ALB liveness), `/ready` (DB + Redis)
- `/metrics` (Prometheus; blocked publicly at the ALB): HTTP metrics + `dispatchx_*` business
  metrics read from Redis at scrape time (aggregate with `max()` across instances)

## 5. Run and test locally

Prereqs: Python 3.12+, Node 22, Docker (or just Redis for the lightweight path).

**Full stack (MySQL):**
```bash
docker compose up --build -d
docker compose exec api python -m app.seed --riders 100 --customers 30
# web http://localhost:3000 · API docs http://localhost:8000/api/docs · Grafana http://localhost:3001
```

**Lightweight (SQLite + local Redis), what the agent sandbox used:**
```bash
python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt "python-socketio[client]==5.12.1"
redis-server --daemonize yes
cd backend && export DATABASE_URL=sqlite:////tmp/dx.db
../.venv/bin/alembic upgrade head && ../.venv/bin/python -m app.seed --riders 60
../.venv/bin/uvicorn app.main:app --port 8000 &
../.venv/bin/celery -A app.workers.celery_app worker -P threads --concurrency=8 &
cd ../frontend && cp .env.example .env.local && npm ci && npm run build && npx next start -p 3000
```
Without a Celery worker nothing gets dispatched (orders pile up, `offers=0`). That is the first thing
to check when "nothing happens".

**Tests:**
```bash
cd backend && DATABASE_URL=sqlite:///./t.db python -m pytest -q tests/test_infra.py
BASE_URL=http://localhost:8000 python backend/tests/smoke_e2e.py      # needs API + worker running
python simulator/simulator.py --base-url http://localhost:8000 --riders 50 --orders-per-min 20
cd frontend && npx next build       # also type-checks; must pass before pushing
.venv/bin/cfn-lint                  # all templates, config in .cfnlintrc (region ap-southeast-2)
python infra/src/check_params.py    # nested-stack parameter/output wiring
```

## 6. Configuration (env vars, `app/config.py`)

`DATABASE_URL` or `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` (built with `URL.create`, so any
password is safe) · `REDIS_URL` · `JWT_SECRET` · `CORS_ORIGINS` · `AWS_REGION` · `SNS_TOPIC_ARN` ·
`NOTIFY_TOPIC_ARN` · `SQS_DISPATCH_QUEUE_URL` · `SQS_NOTIFY_QUEUE_URL` · `S3_BUCKET` ·
`PUBLIC_API_URL` (local upload links) · `ECS_CLUSTER` (enables ECS Cluster View) ·
`CELERY_POOL` / `CELERY_CONCURRENCY` (entrypoint) · `UVICORN_WORKERS` (keep 1; scale containers instead) ·
dispatch tuning `DISPATCH_RADII_KM`, `OFFER_TIMEOUT_S`, `MAX_DISPATCH_ATTEMPTS`, fares, `AVG_SPEED_KMH`.
Frontend: `NEXT_PUBLIC_API_URL` (empty in production = same origin through CloudFront; baked at build time).

## 7. AWS infrastructure (`infra/`)

Region **ap-southeast-2 only** (see section 11). Two top-level stacks:

- `dispatchx-bootstrap` (`infra/bootstrap.yml`, deployed once by hand with the CLI): ECR repos
  `dispatchx/{backend,web,prometheus,grafana}` and the artifacts bucket (exports
  `dispatchx-*-repo`, `dispatchx-artifacts-bucket`).
- `dispatchx` (`infra/main.yml`, deployed by CI after `aws cloudformation package`): nested stacks

| Nested stack | File | Key resources |
|---|---|---|
| Network | `stacks/network.yml` | VPC 10.20.0.0/16; public/app/data subnets ×2 AZ; IGW; one NAT; route tables (data tier has no internet route); data-tier NACL; S3 gateway endpoint; SGs (ALB ← CloudFront prefix list; ECS ← ALB + self; DB/cache ← ECS); flow logs (REJECT) |
| Data | `stacks/data.yml` | RDS MySQL 8.4.10 `dispatchx-mysql` db.t4g.micro (MultiAZ param); ElastiCache Valkey 8 cache.t3.micro (replica param); S3 POD bucket (versioned, lifecycle, EventBridge on) + data lake bucket; Secrets Manager (DB creds, JWT), **unnamed** secrets on purpose |
| Messaging | `stacks/messaging.yml` | SNS order-events / customer-notifications / alerts (email subs if `AlertEmail`); SQS dispatch/notify/analytics + DLQs; filter policies |
| App | `stacks/app.yml` (**generated**) | ECS cluster `dispatchx-cluster` (Container Insights); ASG 2–4 t3.small + capacity provider (managed scaling); ALB `dispatchx-alb` (default 403; rules require `X-Origin-Verify`); WAF; Cloud Map `dispatchx.local`; task defs + services api/web/worker/beat/consumer/monitoring (bridge networking, dynamic ports, circuit breaker rollback); auto scaling (api CPU 60%, worker CPU 70%, consumer SQS backlog); IAM roles |
| Edge | `stacks/edge.yml` | CloudFront: default + `/api/*` + `/socket.io/*` uncached (AllViewer), `/_next/static/*` cached, managed security headers, origin header secret |
| Analytics | `stacks/analytics.yml` | Lambda `dispatchx-analytics-ingest` (SQS → S3 NDJSON `events/dt=YYYY-MM-DD/`); Glue `dispatchx_analytics.order_events` (partition projection); Athena workgroup `dispatchx-analytics` + 4 named queries; Lambda `dispatchx-pod-validator` via EventBridge |
| Observability | `stacks/observability.yml` | CloudWatch dashboard `dispatchx-overview`; 10 alarms → alerts topic |

**`infra/stacks/app.yml` is generated.** Edit `infra/src/app.template.yml` (and the shared env block in
`infra/src/build.py`), then run `python infra/src/build.py`. CI fails if `app.yml` is stale.

The origin secret is the stack-ID UUID (`!Select [2, !Split ["/", !Ref AWS::StackId]]`), shared by
CloudFront and the ALB rules. Direct ALB access returns 403 by design.

## 8. Frontend notes (read before touching UI)

- **Design language = kepler.gl.** Tokens in `tailwind.config.ts` (`k-side #242730`, `k-panel #29323C`,
  `k-line #3A414C`, `k-accent #1FBAD6`, `k-go #0F9668`, …), Inter + JetBrains Mono via fontsource,
  lucide-react icons, small radii, uppercase `.k-label` micro-labels. **No emoji, no pill badges, no
  big rounded cards**: the owners rejected that look as "kiddish/AI-generated". Reuse `components/ui.tsx`.
- **kepler.gl** is `@kepler.gl/*@3.3.0-alpha.14` (first release containing commit
  keplergl/kepler.gl@59048d0, which the owners asked for). React 19 compatible.
  - `package.json` **overrides pin every `@deck.gl/*` to 9.3.11 and `@luma.gl/*` to 9.3.6.** Mixed
    versions caused `DECKGL_FILTER_COLOR: no matching overloaded function` shader errors. Keep them pinned;
    after any dependency change verify with `npm ls @deck.gl/core @luma.gl/core` (one version each).
  - `OpsMap.tsx` keeps four datasets (riders, trips, waiting, demand) and syncs diffs with
    `addToDataset(id, rows, {upsertBy: "id"})` / `removeFromDataset(id, {field: "id", values})`.
    Row arrays must match the dataset field order.
  - kepler renders the **first layer in the config on top** (riders, waiting, trips, demand).
  - Ordinal `colorRange` colours map to the **sorted** domain: list colorMap pairs alphabetically.
  - Map click → order selection reads the id from kepler's own `dataContainer.valueAt(index, 0)`
    (kepler's row order differs from ours after upserts).
  - Loaded with `next/dynamic` `ssr: false`. Basemap is kepler's `dark-matter` (CARTO vector style,
    works without a key).
- **Leaflet maps** (customer/tracking/rider) use **Esri World Dark Gray Base + Reference** tiles.
  CARTO raster tiles now show "API KEY REQUIRED" outside localhost; don't switch back.
- Address search/reverse geocoding uses OpenStreetMap Nominatim from the browser (rate-limited, fine for demos).
- Next.js pages may only export `default` (+ Next config exports): shared constants go in `src/lib/`.

## 9. CI/CD and operating the AWS deployment

Workflows (`.github/workflows/`):
- **deploy.yml** (push to `main` touching backend/frontend/monitoring/infra, or manual):
  test & lint → build 4 images (buildx, GHA cache, `linux/amd64`, tags `<sha>` + `latest`) → if stack is
  `ROLLBACK_COMPLETE` delete it → `cloudformation package` + `deploy` → seed (ECS `run-task` with command
  override `seed --riders 300 --customers 50`) → smoke test against the CloudFront URL → publish URLs as
  notices/summary. On failure, `infra/scripts/diagnose.py` turns stack events, stopped-task reasons and
  log tails into `::error`/`::warning` annotations.
  Manual inputs: `db_multi_az`, `cache_replicas` (keep|true|false), `seed_riders`.
- **destroy.yml** (manual, type `destroy`): optional final RDS snapshot, empty both buckets (all
  versions), delete `dispatchx`. Keeps the bootstrap stack and images.
- **k8s.yml**: runs `k8s/up.sh` on a kind cluster, smoke test through NGINX ingress, asserts Cluster View
  sees 3 nodes.

Auth to AWS: repository secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (IAM user
`dispatchx-admin`, AdministratorAccess). Optional repository variable `ALERT_EMAIL` (not set yet)
subscribes an email to alarms and notifications; the address must confirm the SNS email.

Reading pipeline results without a GitHub token (the repo is public):
`GET https://api.github.com/repos/anannyay/dispatchx/actions/runs?per_page=5`, then
`/actions/runs/{id}/jobs`, then `/check-runs/{job_id}/annotations` (errors, URLs). Job logs need auth.

Timings: first deploy ~23 min, updates ~8–10 min, destroy ~10–15 min, k8s e2e ~3 min.

## 10. Kubernetes (`k8s/`)

kind cluster (1 control plane + 2 workers labelled `zone-a`/`zone-b`, host port 8080 → ingress).
Deployments api/worker/beat/web/redis, StatefulSet mysql + PVC, Services, NGINX Ingress (cookie
affinity, long timeouts for WebSockets), HPA api 2–8 @ 50% CPU and worker 1–3, RBAC so the api's
ServiceAccount can list pods/nodes/deployments/events and delete pods (Cluster View), seed Job.
`k8s/up.sh` / `k8s/up.ps1` installs ingress-nginx v1.11.3 + metrics-server v0.7.2 (patched
`--kubelet-insecure-tls`), builds images, `kind load`s them, `kubectl apply -k k8s`.
`k8s/README.md` has the ECS ↔ Kubernetes mapping. Validate with
`kubectl kustomize k8s | kubeconform -strict -kubernetes-version 1.31.0`.

## 11. Account constraints and traps (learned the hard way)

1. **AWS Free plan account.** A service control policy denies everything outside **ap-southeast-2**
   (even AdministratorAccess). Global services (IAM, CloudFront) work. `us-east-1` is blocked, so:
   no ECR Public login, no CloudFront-scope WAF, no ACM certs for CloudFront. WAF is REGIONAL on the ALB.
2. **`iam:CreateOpenIDConnectProvider` is blocked**, so GitHub OIDC is impossible; CI uses access-key secrets.
3. The Free plan may block other create actions not yet used. If you add a new AWS service, expect a
   possible `explicit deny in a service control policy`; the diagnose step will show it.
4. **The owners will not upgrade to a paid plan or spend money.** Stay within credits; destroy when idle.
5. **ECR Public anonymous pulls hit "Data limit exceeded"** on GitHub runners. Base images come from
   Docker Hub (`python:3.12-slim`, `node:22-alpine`, `grafana/grafana`) and quay.io (Prometheus).
6. **Secrets are unnamed** in CloudFormation: deleted secrets are retained for days and a fixed name
   would block re-creation after a destroy.
7. RDS `DeletionPolicy: Delete` for fast rollbacks; the destroy workflow offers a final snapshot.
8. A failed first create leaves `ROLLBACK_COMPLETE`; the deploy workflow deletes it automatically.
9. Shell gotcha in scripts: `pgrep -f`/`pkill -f`/`ps | grep` patterns can match the invoking shell's
   own command line (this killed shells and hid a dead Celery worker). Use `ps -eo pid,args` with a
   bracketed pattern like `[c]elery`, and kill by PID.
10. The owners work on **Windows PowerShell**. Give them PowerShell commands, one per line; they once
    pasted prompts and output back into the shell. The simulator's Ctrl+C handling has a Windows fallback.
11. Never paste or commit AWS keys. Redis `dump.rdb` files are gitignored; keep it that way.

## 12. Known limitations / possible next work

- ETAs and simulated movement are straight-line (distance ×1.3 at 22 km/h); no road routing or live
  traffic. Options: OSRM for routes; TomTom/Mapbox/Google for traffic (all need keys).
- Single NAT Gateway (cost); production would use one per AZ.
- RDS Multi-AZ and the ElastiCache replica are off by default (toggle via deploy inputs).
- No custom domain/ACM certificate (blocked by region policy); HTTPS is the CloudFront default cert.
- `ALERT_EMAIL` repository variable not set, so alarms have no subscriber yet.
- Prometheus storage is ephemeral (task restart loses history); CloudWatch keeps infra history.
- Local uploads (no S3) are stored on one container's disk; fine for dev only.

## 13. Working agreements

- Keep the kepler.gl visual language and the existing component primitives.
- Before pushing: `npx next build` (frontend), pytest + smoke test (backend), `cfn-lint` +
  `check_params.py` + `build.py` (infra), `actionlint` for workflows. CI runs most of these too.
- Pushing to `main` deploys to AWS automatically when backend/frontend/monitoring/infra change.
  Changes only under `docs/` or root markdown do not deploy.
- After a deploy, verify with the run's smoke test result and ask the owners to check the live UI:
  agent sandboxes usually cannot reach CloudFront or map tile servers.

## 14. Cloud explorer follow-up

- Read `docs/cloud-explorer-handoff.md` for the local October 20, 2026 implementation,
  exact checks, presentation path and remaining gaps.
- `/architecture` is a public, backend-independent schematic. `/dispatch/cluster` is the
  authenticated snapshot view. Never imply that playback performs live scaling or chaos actions.
- Keep Docker packaging, local/CI Kubernetes, and AWS ECS on EC2 distinct; do not claim EKS.
- Frontend checks: `npm test`, `npx tsc --noEmit --incremental false`, `npm run build`.
  `npm run test:browser` needs the external tool/browser described in the handoff.
- The existing staff-accessible stop-task endpoint remains a public-demo risk. Address its
  backend authorization before deploying this presentation publicly; stale-button disabling
  is not a security boundary.

## 15. Functional console verification follow-up

- `docs/local-demo-handoff.md` records subsequent October 20, 2026 real-stack validation.
  MySQL/Redis/Celery delivery smoke and the three-role browser lifecycle passed locally;
  AWS deployment/failover still has not been verified in this work.
- Compose now gates MySQL on an authenticated TCP query, then gates worker/Beat/web on
  API readiness after migrations. Keep these dependencies acyclic.
- Customer/rider retry states, quote/offer races, device-GPS fallback and Leaflet route
  transition errors have focused fixes and regression coverage.
- Frontend `npm test` now runs 26 tests. `npm run test:delivery` uses a real local backend
  with separate role sessions, controlled geocoder/device coordinates, and an idle demo rider.
  Stop the simulator before running it. Never point this mutating test at a public deployment.
