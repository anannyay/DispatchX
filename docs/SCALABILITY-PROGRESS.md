# DispatchX — scalability and reliability progress

**Updated: October 20, 2026.** This is the readable working log for the current improvement pass.
Start here rather than reading the coding-agent handoff. Entries distinguish plans from proof.

## The outcome we are building

A cloud-computing project that can explain **and demonstrate** how it handles more work,
concurrent requests, delayed workers, and failures. We are keeping the existing stack rather
than adding services just to make the architecture diagram look larger.

**Not claimed:** unlimited scale, exactly-once event delivery, production availability numbers,
or AWS autoscaling performance inferred from a laptop test. No AWS deployment is authorized by
this work, and no cloud credentials belong in this document.

## Current work board

| Area | Goal | Status |
|---|---|---|
| Dispatch hot path | Batch Redis reads; retain matching rules; protect lock ownership and competing assignments | Tests, real MySQL contention and delivery smoke passed |
| Safe booking retries | One order for concurrent retries with the same customer/key/payload; reject conflicting reuse | 20 concurrent real API requests produced one persisted order |
| Operations visibility | Live application dependency, backlog, age and dispatch signals, with explicit unknown/stale states | Real browser polling passed; failure/stale/offline fixtures passed |
| Demo safety | Destructive chaos actions disabled by default and restricted independently of public dispatcher access | Unit matrix and live default-deny checks passed |
| Repeatable measurements | Bounded local before/after workload with percentiles, failures and environment disclosure | First before/after measurement complete |
| Presentation | Configurable finite presets, consistent navigation and exact eight-minute flow | `/demo` and `docs/DEMO-RUNBOOK.md` implemented; 320–1440px checks passed |
| Verification | Regression tests, real MySQL/Redis checks, production build and browser journeys | 106 backend tests, 46 frontend tests, 46 browser scenarios and real delivery passed |

## Starting point

- Baseline revision: `6a412c0` on `codex/cloud-explorer`.
- The previous pass already verified a real local customer → rider → dispatcher delivery,
  photo upload, persisted read-back, cancellation, and live updates.
- The cloud explorer explains Services, Docker, Kubernetes and AWS, but is a schematic;
  it does not pretend to be live infrastructure telemetry.
- Local API, MySQL, Redis, Celery worker and Beat are available in an isolated Compose demo.
  The previous finite simulator run is separate from any benchmark.

## Findings from source inspection at the baseline

1. Candidate matching makes separate Redis calls per rider. Fleet inspection makes roughly
   three calls per online rider. Network round trips can grow much faster than useful work.
2. The API accepts order creation without a durable retry identity. A client retry after a
   lost response can create another order.
3. Dispatch locks are released with unconditional deletion. A delayed owner could remove a
   newer owner's lock after the original TTL expires.
4. The stop-task endpoint is available to staff, including the public dispatcher demo.
5. Existing metrics explain delivery activity but do not provide one compact view of queue
   backlog, oldest pending work, dependency health, and the limits of those measurements.

These are code findings, not measured performance results. Baselines and verified results
will be added below as they are collected.

## How to read the eventual results

- **Implemented** means the code exists, not that cloud behavior is proven.
- **Tested locally** names the actual test, runtime and workload.
- **Measured improvement** requires the same workload/environment before and after.
- **Remaining boundary** records failure modes or scaling limits we have not eliminated.

## Update 1 — baseline recorded; independent implementations ready for integration

- The 500-rider fleet snapshot baseline made **1,501 client/network round trips** per call.
  Median **71.440 ms**, p95 **80.434 ms**, after 3 warmups and 15 measured calls.
- This is a direct backend-function measurement using real local Redis, not end-to-end HTTP
  latency or a maximum fleet-capacity claim. Runtime: Python 3.12.13, Redis 7.4.10, Linux ARM64
  containers on the same Colima VM. Test data was created only in an initially empty Redis
  database 15 and removed afterward; the running demo's database 0 was untouched.
- Raw samples: `docs/benchmarks/fleet-read-results.csv`.
- Independent implementations now exist for batched candidate matching/ownership-safe
  cleanup, durable booking identities, and the new System signals UI. Their isolated tests
  have passed, but integration and actual MySQL concurrency verification are still pending.
- Important boundary: retry identities do **not** close the database-commit/event-publication
  gap. A transactional outbox remains separate work; we will not call this exactly-once delivery.

## Update 2 — measured fleet-read improvement

Same 500-rider dataset, same Redis instance, same runtime, 3 warmups and 15 samples per version:

| Direct fleet snapshot | Before | After batching |
|---|---:|---:|
| Median elapsed time | 71.440 ms | 9.191 ms |
| Sample p95 (nearest rank) | 80.434 ms | 25.045 ms |
| Client/network round trips | 1,501 | 4 |

That is approximately **7.8× faster at the median for this specific read path**, not an 8×
claim about the whole application. The response-content fingerprint was identical (excluding
the naturally changing `last_seen_s`). Batches are limited to 200 riders each and the full
response contract is retained. Memory/output size still grows with the fleet size.

The shared local VM produced two after-run outliers; all individual samples remain in the CSV.
This measures real Redis reads but excludes HTTP, JWT authentication, browser rendering and
WAN latency. It does not establish a safe production throughput limit.

## Update 3 — real MySQL concurrency and delivery verified

- Rebuilt the backend, applied migration `0002` to the isolated Compose MySQL database,
  and recreated API/worker/Beat. `/api/ready` reported database and Redis ready.
- `backend/tests/verify_mysql_concurrency.py` passed against the real API and MySQL's
  `REPEATABLE-READ` isolation: **20 simultaneous keyed bookings produced one order, one
  booking identity and one initial audit event**. Later replay, payload conflict (409),
  customer-scoped identity and independent unkeyed requests also passed.
- Two simultaneous service-level accept calls for the same fresh rider and different orders
  produced one active assignment under InnoDB locking. These use controlled offer fixtures,
  not two naturally delivered browser offers. The script cancels only its own test orders.
- System signals returned actual dependency measurements. Customer access was denied;
  both dispatcher and admin stop requests were denied with chaos opt-in off. No actual
  workload stop, cloud operation, or failover was attempted.
- All **106 backend regression tests** passed, including actual Redis Lua checks. One
  upstream Starlette/AnyIO deprecation warning remains.
- Real MySQL/Redis/Celery smoke passed again: order **136**, live assignment and location,
  pickup, photo upload, delivery and persisted audit trail.
- Frontend production build passed with `/demo` and `/dispatch/system`. Existing optional
  native WebSocket dependency warnings remain. New responsive/control browser checks are next.

## Update 4 — presentation and browser integration verified

- `/demo` now provides **Explain**, **Busy fleet** and **Failure/retry** presets, editable
  bounded settings, safe shell commands, clipboard fallback, and the exact eight-minute
  click/say/observe flow. It executes nothing. Presenter notes: `docs/DEMO-RUNBOOK.md`.
- Shared console navigation retains Demo guide, Cloud explorer and role destinations on
  small screens. Stop controls remain visible but disabled without backend permission.
- **46 frontend tests**, TypeScript checking and the production build passed. The
  **46-scenario Chrome suite** checks public exploration, presets, invalid-copy disabling,
  reset/clipboard behavior, navigation at 320/390/768/1440px, and System loading, pause,
  failure, degraded, stale/offline and slow-request serialization states.
- Cluster/System failure scenarios use explicitly synthetic responses; they do not prove
  actual infrastructure failure recovery. Test-harness selector/clock/rounding assumptions
  were corrected before the passing run; no app failure was hidden by those corrections.
- The separate **real-browser delivery test passed again**, including order **139**, photo
  upload, audit/read-back and cancellation. It now also checks the actual booking retry
  header, two live System samples from MySQL/Redis, pause, and customer/rider/dispatcher
  navigation/logout at 320px. Only external geocoding/device coordinates are controlled.
- The finite simulator has exited. The local app is available at `http://localhost:3000/demo`;
  the local API/worker/Beat/MySQL/Redis remain running for inspection. No AWS action occurred.
- Delivery target: existing PR **anannyay/DispatchX#1**, branch `codex/cloud-explorer`.
  GitHub records publication status; no merge or AWS deployment is part of this pass.

## Reproduce the checks

Use a dedicated **local** stack with migrations applied, seeded accounts and no simulator
running. Use its existing Compose project/override arguments where applicable. Never point
mutating checks at a public deployment. From the repository root, PowerShell or POSIX:

```powershell
docker compose run --rm --no-deps --entrypoint python -v "${PWD}/backend:/app:ro" -e PYTHONPATH=/app -e DATABASE_URL=sqlite:////tmp/dispatchx-tests.db -e DISPATCH_TEST_REDIS_URL=redis://redis:6379/15 api -m pytest -p no:cacheprovider -q tests
docker compose run --rm --no-deps --entrypoint python -v "${PWD}/backend/tests:/app/tests:ro" -e PYTHONPATH=/app api tests/verify_mysql_concurrency.py --allow-local-mutations
```

The first command uses isolated SQLite fixtures and namespaced Redis Lua fixtures. The
second uses the real local API/MySQL, creates a fresh test rider, and cancels its own orders;
it does not delete users/audit history. Tests are mounted because production images exclude
them. The benchmark additionally requires an initially empty local Redis database (not 0).

From `frontend/`, with the external Playwright setup described in
`docs/cloud-explorer-handoff.md` and the local preview already running:

```powershell
npm test
npx tsc --noEmit --incremental false
npm run build
npm run test:browser
npm run test:delivery
```

Restart the production preview after rebuilding. Browser-suite defaults: preview at
`http://127.0.0.1:3200`; real delivery app at `http://localhost:3000`. Configure `BASE_URL`,
`API_BASE_URL` and `PLAYWRIGHT_MODULE` for your local setup. The delivery test requires an
idle seeded demo rider. A failing check is not evidence of a passing deployment.

## Remaining boundaries

- Local measurements do not establish production throughput, autoscaler behavior or HA.
  AWS/kind deployment, multi-instance routing, managed S3 and failover were not exercised.
- Booking retry protection is durable on the server, but the form's attempt key is not
  persisted across reloads. Keys have no expiry. There is no transactional outbox.
- Dispatch leases can expire mid-flight; raw order/rider offer IDs cannot distinguish a
  later generation of the same pair. SQL/Redis/event effects are not a single transaction.
- The full fleet response still grows with fleet size, despite bounded Redis batches.
- The System ready count excludes scheduled/in-flight tasks and SQS. Maintenance is a
  last-success observation, not worker count or uptime. Browser history is not monitoring storage.
- `ENABLE_CHAOS_TESTS=false` remains the safe default. Admin plus opt-in is necessary, but
  enabling it with the seeded public admin account would still be unsafe.
- Native Windows PowerShell execution, physical GPS and live geocoder availability are
  not established by the local tests. Existing optional build/deprecation warnings remain.
