# DispatchX · eight-minute presentation runbook

Entry point: **`/demo`**, a public, backend-independent presentation desk. Use the
permanent **Architecture** and **Role login** navigation. The page contains the
command generator, environment scope, exact click/say/observe sequence and evidence
boundary. This document matches those sections.

## Prepare before the clock

1. Choose an **already-running** environment and verify its application/API address.
   `/demo` does not discover or start a deployment. The architecture explorer works
   without a backend; that does not establish that authentication or delivery works.
2. Seed accounts in that environment using its existing workflow below. Have an
   idle demo rider and nearby pickup/drop locations ready. Use the role buttons at
   `/login`: **Customer**, **Rider**, **Dispatcher**.
3. Open **three independent browser profiles/sessions**. Ordinary tabs share
   localStorage; private windows can also share one private session. Keep the
   presentation desk in a separate tab. Set the rider to **Demo (click map)** and
   place it near the pickup; these are simulated coordinates, not device-GPS evidence.
4. **Stop all existing simulators before the manual delivery.** Press Ctrl+C in
   each simulator terminal, or stop its specifically identified simulator container.
   Wait for exit; inspect the rider state and competing simulated riders. A rider
   with an active order may remain online during simulator shutdown. Complete or
   resolve existing work before beginning; do not assume shutdown clears it.
5. Have a terminal in the repository root and the existing Python environment with
   `simulator/requirements.txt` available. Prepare any existing kind/AWS evidence
   beforehand. The eight-minute script does not include provisioning or installation.

## Configure commands on `/demo`

**Settings affect the generated simulator command, not a running process.** The
page generates text only: it sends no simulator/load HTTP request, does not execute
the seed command, and does not start cloud resources. Copying is not execution.
Editing values cannot stop or change a running simulator.

| Preset | Riders | Customers | Orders/min | Accept probability | Radius km | Speedup | Duration s |
|---|---:|---:|---:|---:|---:|---:|---:|
| Explain | 5 | 5 | 1 | 1 | 3 | 10 | 300 |
| Busy fleet | 20 | 5 | 6 | 0.85 | 3 | 10 | 300 |
| Failure/retry | 3 | 5 | 2 | 0 | 3 | 10 | 240 |

All numeric fields remain editable and visible:

- Riders: integer **1–100**; customers: integer **1–30**.
- Orders/min: **0–30**; acceptance probability: **0–1**.
- Duration: **60–900 seconds**; simulator radius: **1–10 km**; movement speedup: **1–20**.
- Selecting a preset or pressing **Reset preset** restores its numeric values and
  **preserves the base URL**. A custom-values status identifies edits.

The base URL defaults to `http://localhost:8000`. Enter an absolute HTTP(S) URL
without credentials, query, fragment, raw spaces/control characters or backslashes.
Use the application/API root, normally without `/api`. URL serialization normalizes
the address and encodes path characters; a root URL gains a trailing slash.
This changes **only the simulator target**, not role-login/navigation destinations,
frontend API configuration or the seed destination. Role links use the current app
origin; open the other environment's app yourself when presenting it.

**Copy PowerShell**, **Copy POSIX** and **Copy seed command**, together with their
read-only command fields, are always present. Any invalid field displays an error,
removes executable output and disables all three copy buttons. If clipboard access
is denied or unavailable, the corresponding command is focused and selected; use
Ctrl+C / Command+C or the device's Copy action. There is no hidden execution button.

### Simulator semantics

The commands use the actual options in `simulator/simulator.py`:
`--base-url`, `--riders`, `--customers`, `--orders-per-min`, `--accept-rate`,
`--duration`, `--radius-km`, `--speedup`. Other simulator defaults remain:
`--city bangalore`, `--start-index 1`, `--tick 2.0`, `--ramp 0.05`.

- Orders arrive randomly at a mean rate, not an exact promised total.
- Speedup changes movement only, not arrival rate or offer/retry timers.
- Radius affects simulated initial positions/pickups, not backend dispatch radii.
- Acceptance 0 rejects or ignores offers; it exercises retry/timeout paths without
  stopping infrastructure. Existing/manual riders can still accept orders. An
  `unassigned` result is eventual and is not guaranteed during a short presentation.
- Orders/min 0 still logs in riders and can accept existing offers. It is **not**
  a simulator stop control.
- Duration is finite. Ctrl+C stops early. Saved orders and queued backend work can
  remain afterward, and shutdown does not guarantee an idle fleet.

For the default Explain preset, both shells produce the following equivalent
one-line command (quoting differs between shells when a URL contains apostrophes).
Run it **only after the manual delivery**, from the repository root:

```powershell
python simulator/simulator.py --base-url 'http://localhost:8000/' --riders '5' --customers '5' --orders-per-min '1' --accept-rate '1' --duration '300' --radius-km '3' --speedup '10'
```

The page uses literal shell arguments, including shell-specific single-quote
escaping. Use the generated command for your shell rather than rewriting its quotes.

## Environment and seeding scope

### Local Compose

Use your existing **local** Docker context/Compose project and its normal setup
from `AGENTS.md`. The app is normally `http://localhost:3000`; simulator/API root
is `http://localhost:8000`. The generated seed command matches the selected counts:

```powershell
docker compose exec api python -m app.seed --riders 5 --customers 5
```

This creates missing normal demo accounts and simulator accounts starting at index 1.
It does not delete extra accounts or reset existing orders. The base URL is not used
by this command. If your local stack uses custom Compose project/override arguments,
use that established invocation rather than accidentally addressing another project.

Local evidence commands (PowerShell or POSIX, one per line):

```powershell
docker compose ps
docker compose images
```

**Under Compose, Live cluster is unavailable by design.** Its backend queries ECS
or Kubernetes, not Docker. Use the terminal for running local containers and
`/dispatch/system` for application signals. There is no Compose autoscaler or
multi-host failover proof here.

### Configured kind · local / CI

`k8s/README.md` describes the existing workflow. Seeding is the Job in
`k8s/seed-job.yaml` (configured for 150 riders / 40 customers, covering these UI
bounds when successfully run). Use that established Job workflow for the actual
target; ensure the required accounts exist. **Compose seed does not seed kind.**
The usual existing ingress is `http://localhost:8080`.

If kind is already running, open its app as Dispatcher and inspect `/dispatch/cluster`.
Use an explicit context for terminal observations:

```powershell
kubectl --context kind-dispatchx get nodes
kubectl --context kind-dispatchx -n dispatchx get pods -o wide
kubectl --context kind-dispatchx -n dispatchx get hpa
```

If the context/cluster is absent, explain the Kubernetes schematic and manifests as
**configured**, not live. HPA changes pod replicas on fixed kind nodes, not the node
count. No cluster creation or pod deletion is part of this presentation.

### Existing AWS · ECS on EC2

Use the actual URL from the existing stack, not a historical CloudFront hostname.
The established seeding workflow is the ECS seed task in
`.github/workflows/deploy.yml` (see `AGENTS.md`, deployment section). Ensure the target
has at least the selected counts. Do not trigger a new deployment just to follow
this runbook. **Compose seed does not seed AWS**, even with an AWS simulator URL.

The source configures **ECS on EC2**, not EKS. Use a fresh authenticated ECS cluster
snapshot only when that deployment is available. CloudFormation and the schematic
do not prove present health, scaling or failover. `/demo` executes no AWS commands.

## Exact eight-minute walkthrough

The time ranges below match `/demo`. They are presenter timeboxes, not guarantees of
network/backend timing. If an action fails, show the failure and continue explaining
the evidence boundary; do not replace it with a claim that the flow succeeded.

### 00:00–01:00 · Architecture responsibilities

- **Click:** **Open Services flow** → Services → Follow a delivery; use **Next step**.
- **Say:** “The API handles requests; MySQL stores orders and history. Redis holds
  locations, locks and pub/sub. Celery runs background matching locally; Beat
  schedules maintenance. These are process responsibilities in one backend codebase.”
- **Observe:** source-backed connections and component responsibilities. Playback
  explains events; it is not live telemetry and does not create an order.

### 01:00–03:30 · Real delivery across three profiles

- **01:00–01:30 — Click:** in the isolated profiles, `/login` → **Customer**, **Rider**,
  **Dispatcher**. Rider: **Demo (click map)**, position near pickup, **Toggle online**.
- **01:30–02:00 — Click:** Customer chooses nearby pickup/drop with map clicks or
  address search, waits for quote, then **Book delivery**. Rider presses **Accept**
  before the offer expires.
- **02:00–03:00 — Click:** Rider presses **Confirm pickup**, then **Complete without
  photo** (or **Photo & complete delivery** and selects a prepared photo).
- **03:00–03:30 — Click:** reload the customer tracking page; Dispatcher → **Recent**
  and identify the same order.
- **Say:** “This uses real authentication, API calls, database writes, asynchronous
  matching and Socket.IO. Only the rider coordinates are simulated.”
- **Observe:** matching order ID and `pending → assigned → picked_up → delivered`.
  Customer labels include **Heading to pickup** and **Heading to drop-off**. State
  after reload is persistence evidence. A photo is optional and local storage does
  not establish an S3 upload. Keep all simulators stopped throughout this step.

### 03:30–04:30 · Docker ps and image roles

- **Click/do:** run `docker compose ps`, then `docker compose images`; **Open Docker
  flow** → From source to containers. Inspect `backend/entrypoint.sh`.
- **Say:** “Images package code/dependencies; containers run processes. API, worker
  and Beat use the same backend source/Dockerfile with different entrypoint commands.
  Compose may assign separate image tags; web has its own image. Named volumes hold
  MySQL data and local photos.”
- **Observe:** actual local container status/image IDs. Compose's unavailable cluster
  view is expected: terminal evidence covers Docker; Live cluster covers ECS/K8s.

### 04:30–05:30 · Kubernetes configured versus actual kind

- **Click/do:** **Open Kubernetes layer**; inspect Deployments, Services, Horizontal
  Pod Autoscaler. If kind is already available, show its `/dispatch/cluster` and the
  explicit-context read-only commands above. Otherwise show manifests only.
- **Say:** “Controllers reconcile desired replicas, Services route to pods, readiness
  controls traffic, CPU HPA changes API/worker pod counts. Nodes are fixed; Beat is
  a single scheduler. This is local/CI Kubernetes, not an EKS deployment.”
- **Observe:** separate configured targets from current Ready pods/HPA metrics. Unknown
  metrics, unchanged replicas and animation are not autoscaling/recovery evidence.

### 05:30–06:30 · AWS ECS versus EKS, state and messaging

- **Click:** **Open AWS layer**; trace CloudFront → ALB → ECS, then RDS, cache, SNS/SQS.
  Optionally inspect an already-available AWS app's fresh authenticated Live cluster.
- **Say:** “This repository configures ECS on EC2. EKS is AWS's managed Kubernetes
  service, a different orchestrator not deployed here. RDS MySQL and ElastiCache
  Valkey externalize state. SNS fans out to SQS; consumers retry and queues have DLQs.
  Local/kind instead uses Celery.”
- **Observe:** source configuration versus observed ECS tasks. Neither establishes
  current failover success or exactly-once processing. No AWS execution is triggered.

### 06:30–07:30 · System signals and optional bounded load

- **Click:** in the dispatcher profile, **Open System signals** (`/dispatch/system`).
  Inspect sample time/freshness, dependencies, available riders, pending/unassigned,
  Queue ready and Assignment p95. Expand **Dispatch counters & safeguards**.
- **Optional, after manual delivery:** paste **one** generated command in a separate
  terminal. Compare samples and terminal output, then **Ctrl+C before 07:30**.
  Use the finite preset duration if running a separate longer demonstration later.
- **Say:** “These are sampled application measurements. Queue ready is the default
  Celery ready queue, not in-flight work or SQS backlog. Unknown is not zero. p95 needs
  its sample count; a small preset is not a capacity benchmark.”
- **Observe:** real before/after values, times and errors, without promising a change
  in a minute. Failure/retry may not reach `unassigned` within this timebox. Stopping
  new simulator activity does not remove saved orders or queued jobs.

### 07:30–08:00 · Limitations and evidence

- **Click:** **Review evidence boundary** on `/demo`; confirm the simulator exited.
- **Say:** state the actual environment, time, order ID, reload result, container
  evidence and sample times. Explain simulated straight-line movement, single-host
  Compose, nonpersistent local/kind Redis, unshared kind API photo disk, optional
  rather than default RDS Multi-AZ/cache replicas, and the absence of a transactional
  outbox or exactly-once event delivery.
- **Observe:** distinguish the evidence collected today from source-configured HPA,
  ECS scaling, managed-state options and retries. Preset size and animation establish
  neither throughput nor high availability nor a currently running AWS deployment.

## Evidence record and checks

Record each presentation separately: environment/address, date/time, order ID and
reload outcome, actual container/image or pod/task output, System sample times and
values, simulator preset/edits and stop result. Label each item **observed**,
**source-configured**, **failed** or **unavailable**. This runbook is a procedure,
not a record of a newly completed delivery or cloud deployment.

Configuration regression checks run from `frontend/`:

```powershell
npx tsc --noEmit --incremental false
npm test
```

`tests/demo-config.test.cjs` covers exact presets, reset, every bound, numeric parsing,
URL validation, seed counts, actual argparse options, adversarial shell arguments and
the complete 480-second timeline. The POSIX test intercepts Python with an argument
printer rather than running load; PowerShell is checked against a restricted literal
grammar. Native Windows PowerShell behavior requires a Windows terminal check.

Browser acceptance checks: `/demo` without login/backend; permanent Architecture/Role
login links; all preset/edit/reset states; invalid copy disabled with visible errors;
clipboard success and denied-permission selection fallback; keyboard focus and labels;
320px viewport and zoom with no page overflow or hidden controls; then the separately
prepared real three-role flow and authenticated System view. Record actual results;
typechecking/unit tests alone do not establish these browser or live-stack outcomes.

### Verified locally on October 20, 2026

The 46-scenario Chrome suite passed, including the preset/configuration/clipboard controls,
System failure states and 320–1440px layouts. The separate real-browser journey passed
delivery, photo/audit read-back, cancellation, live System polling and all three role navbars
at 320px. `docs/SCALABILITY-PROGRESS.md` records the exact evidence and reproduction setup.
These checks do not time an eight-minute human presentation or prove cloud scaling/failover.

Task-stop actions require an administrator **and** `ENABLE_CHAOS_TESTS=true`; the default is
off. Leave it off for this flow and never enable it with public access to the seeded admin
account. No workload deletion is needed to follow the runbook.

When finished, confirm the simulator has exited. If the local stack is no longer needed,
use its established Compose project/override invocation with `stop` (not volume deletion).
Do not leave an existing AWS deployment running without informing its owners; cloud teardown
requires a separate, explicit decision and is not a button or command generated by `/demo`.
