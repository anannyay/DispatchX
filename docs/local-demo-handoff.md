# Functional console and local-demo follow-up

Verified **October 20, 2026**, after the initial cloud-explorer implementation.
Branch: `codex/cloud-explorer`; upstream PR: `anannyay/DispatchX#1`.
This supersedes the initial handoff's statement that the real delivery lifecycle had not run.
**No AWS operations or deployment were performed.**

**Subsequent update:** `docs/SCALABILITY-PROGRESS.md` records the configurable `/demo`,
System signals, booking/dispatch safeguards and the expanded verification. The evidence table
below describes the earlier pass; current counts are 106 backend tests, 46 frontend tests and
46 browser scenarios. `docs/DEMO-RUNBOOK.md` is the exact current presentation sequence.

## What changed in the actual application

- `docker-compose.yml`: MySQL readiness now requires an authenticated TCP query against
  the application database. The API has a Python-standard-library `/api/ready` healthcheck.
  Worker, Beat and web wait for the API to finish migrations and become ready.
- `frontend/src/app/customer/page.tsx`: retryable delivery-list and quote failures,
  loading feedback, ignored superseded quote responses, and reverse-geocoding race protection.
- `frontend/src/app/rider/page.tsx`: retryable initial/refresh errors, stale-response guards,
  offer resets that preserve newer socket events, and actual GPS-to-demo fallback on errors.
- `frontend/src/components/Map.tsx`: disable deferred Leaflet zoom/fit animation that raised
  `_leaflet_pos` errors during booking-to-tracking navigation. Dependency pins are unchanged.
- `frontend/tests/console-errors.test.cjs`: 19 focused controlled-lifecycle regression tests.
- `frontend/tests/delivery-browser.cjs`: real local customer/rider/dispatcher browser journey,
  exposed as `npm run test:delivery`; no application API or Socket.IO responses are mocked.
- `frontend/src/lib/architecture.ts`: remove a rider source-line anchor made stale by the fixes.

## Evidence, not just UI appearance

| Check | Observed result |
|---|---|
| Cold-start reproduction | Original socket-based MySQL ping became healthy before TCP was ready; API migration failed with PyMySQL 2003, then worker jobs saw missing tables |
| Fixed cold start with a new isolated MySQL volume | MySQL became ready, migrations finished, API became healthy, then worker/Beat started; scheduled jobs succeeded |
| `npm test` in `frontend/` | **26 passed**: 7 architecture/state tests and 19 console regressions |
| `npx tsc --noEmit --incremental false` | **Passed** |
| `npm run build` | **Passed**; the previously documented optional map-dependency warnings remain |
| `npm run test:browser` | **30 scenarios passed** against the rebuilt frontend; cluster/operations fixtures remain explicitly synthetic |
| `python -m pytest -p no:cacheprovider -q tests/test_infra.py` | **2 passed**, inside the backend image with tests mounted read-only |
| `BASE_URL=http://127.0.0.1:8000 python tests/smoke_e2e.py` | **Passed** against MySQL + Redis + API + Celery: timed offer, acceptance, live customer GPS, pickup, photo upload, delivery and audit trail |
| `npm run test:delivery` | **Passed twice after the map fix**, using real browser logins/actions across all three roles; saved order/photo verified again after reload; cancellation persisted; customer `/admin/infra` access returned 403 |
| `git diff --check` | **Passed** |

The browser journey controls the external address-lookup results and device GPS coordinates
for repeatability. It does not fake authentication, quotes, dispatch, events, uploads or storage.
The first run completed delivery but caught a Leaflet JavaScript error; the post-fix runs
completed without uncaught page errors. Physical device GPS and geocoder availability are
not established by these controlled inputs. AWS/S3/ECS/Kubernetes failover remains unverified.

The first container test command found no tests because `backend/.dockerignore` deliberately
excludes them. Tests were then mounted read-only, without changing the production image.
The first Socket.IO smoke attempt was rejected by the intentionally narrow local CORS list;
adding the local test origin to the temporary override resolved it. Backend CORS policy was
not weakened in the repository.

## What is running locally

- Full local app: `http://localhost:3000` (same-origin loopback preview gateway).
- API and readiness: `http://localhost:8000/api/docs`, `/api/ready`.
- Standalone frontend preview: `http://localhost:3200` (architecture works independently;
  use port 3000 for authenticated application flows in this preview arrangement).
- Colima runs Compose project **`dispatchx-demo`**: MySQL, Redis, API, worker and Beat.
  MySQL/Redis are internal only; API port 8000 is bound to loopback.
- Twenty simulated riders and five simulated customers were seeded. The earlier finite
  900-second simulation in **`dispatchx-demo-simulator`** has exited. No simulator was running
  during the latest manual/scripted delivery checks. Start a bounded preset only afterward.

The isolated run used temporary `dispatchx-safe-local.override.yml` and
`dispatchx-preview-proxy.cjs` files in the session's approved temporary directory. Those contain
only local test defaults and are not committed. The repository's private `.env.local` was
neither read nor mounted. An earlier reproduction project, `dispatchx-preview`, was stopped;
its isolated volumes were retained. No other containers or volumes were removed.

## Reproduce with the normal project stack

Use the existing local environment configuration described in `AGENTS.md`, with Docker
service names `mysql`/`redis` and no AWS integrations enabled. Do not paste cloud credentials
into the repo. From the repository root, PowerShell:

```powershell
docker compose up --build -d
docker compose exec api python -m app.seed --riders 20 --customers 5
```

Use the one-click demo roles at `/login`. To act as multiple roles simultaneously, use
**separate browser profiles/private sessions**, not ordinary tabs sharing localStorage.
For an uninterrupted manual journey, stop the simulator first and put the demo rider
online near the customer's pickup. The scripted browser test refuses an already-busy
demo rider rather than completing someone else's delivery.

With the external Playwright setup from `cloud-explorer-handoff.md`, run from `frontend/`:

```powershell
$env:BASE_URL = "http://localhost:3000"
$env:API_BASE_URL = "http://localhost:8000"
npm test
npm run test:delivery
```

To animate the console for a presentation, use the existing simulator in a separate Python
environment. From `simulator/` on PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe simulator.py --base-url http://localhost:8000 --riders 20 --customers 5 --orders-per-min 6 --radius-km 3 --speedup 10 --duration 900
```

## Honest remaining boundary

This is now a verified **local delivery demo**, not a claim of complete production readiness.
The subsequent pass restricts chaos-stop to admin plus explicit deployment opt-in, off by
default. Never enable it with the public seeded admin account. No remote health check,
cloud deployment, live managed-S3 upload,
or real ECS/Kubernetes failover was performed. All follow-up changes belong on the same PR;
merging to `main` can trigger AWS deployment and is a separate decision.

For a subsequent AWS check, configure credentials locally and provide only the profile name
and intended stack/region. Never put AWS access keys, secret keys or session tokens in chat,
committed files, screenshots or PR descriptions.
