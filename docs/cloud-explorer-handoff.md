# Cloud explorer: implementation and presentation handoff

Updated: **October 20, 2026**. Work on `codex/cloud-explorer`, based on `40e8258`.
This document records local implementation and verification; consult the branch/PR for
publication status. **No AWS deployment was performed during this work.** The older AWS/CI
status in `AGENTS.md` is historical; it was not reverified in this session.

## Goal and result

Make this a clear cloud-computing demonstration, not a wall of dashboards.
The public `/architecture` route works without login, a backend, or AWS credentials.
It explains the repository's actual implementation, rather than fabricated live metrics.

- Four layers: application services, Docker packaging, local/CI Kubernetes, AWS ECS on EC2.
- 40 inspectable components, 11 guided flows, and 43 walkthrough steps, with source links.
- Component/flow/step deep links, back/forward navigation, keyboard tabs, selectable playback
  pace, pause/replay, presentation mode with Escape, and clipboard fallback.
- Diagram and list modes; mobile defaults to a list. Mobile walkthrough controls appear
  before the diagram. Component selection brings the inspector into view.
- An expandable comparison of Compose, Kubernetes, and AWS responsibilities.
- Cleaner home page and console navigation; secondary operations metrics and logs are
  disclosed on demand rather than permanently crowding the map.
- Cluster snapshots distinguish loading, errors, offline/paused, unconfigured, and empty
  states. Failed refreshes preserve the last successful response and label it as stale.
  Unknown measurements are not displayed as zero. Polling ignores superseded responses.

## What changed

The previous session already supplied the landing page, explorer scaffolding, navigation,
and initial operations/cluster simplifications. This session finished those changes; it did
not replace the app or alter the backend, deployment manifests, dependency versions, or
deck.gl/luma.gl pins. Two bounded implementation agents corrected architecture data and
finished operations/cluster behavior; their work was integrated and checked.

| Repository-relative files | Purpose |
|---|---|
| `frontend/src/lib/architecture.ts` | Source-checked diagram nodes, connections, explanations and flows |
| `frontend/src/lib/architecture-state.ts` | Validated URL state; one-based shared step numbers |
| `frontend/src/components/architecture/CloudExplorer.tsx` | Inspector, playback, mobile list, sharing, keyboard/history behavior |
| `frontend/src/components/architecture/DeploymentComparison.tsx` | Optional environment comparison and configuration references |
| `frontend/src/app/architecture/{page.tsx,explorer.css}` | Public route, metadata and responsive presentation styling |
| `frontend/src/app/{page.tsx,home.css}` | Architecture-first home page and role-demo entry points |
| `frontend/src/app/dispatch/{page.tsx,cluster/page.tsx}` | Progressive disclosure, polling races, accurate snapshot states |
| `frontend/src/components/Navbar.tsx`, `frontend/src/lib/nav.ts` | Explorer/live-cluster links and mobile navigation |
| `frontend/tests/architecture.test.cjs`, `frontend/tests/browser-smoke.cjs` | Dependency-free data/state tests and optional browser verification |
| `frontend/package.json` | `test` and `test:browser` commands only; lockfile unchanged |

## Architectural distinctions to preserve

1. The backend is **one codebase/image with several process roles**, not independently
   owned microservices/databases. API, worker and consumer can scale separately; Beat is a singleton.
2. **Kubernetes is the local/CI alternative to ECS**, not an EKS deployment behind ECS.
   HPA changes API/worker replica counts, not the number of kind nodes or Beat schedulers.
3. AWS viewer traffic is HTTPS/WSS to CloudFront; the configured CloudFront→ALB origin uses
   HTTP port 80. Do not label every connection HTTPS.
4. The rider browser sends the photo directly to S3 after obtaining a signed URL. Lambda
   validates metadata/tags asynchronously; it does not approve the delivery or delete bad objects.
5. Diagram playback is explanatory, not a load generator, live telemetry, or a chaos action.
6. HA options are not defaults. No transactional outbox or exactly-once processing is implemented.
   Local/kind Redis has no configured persistent volume; kind API photo storage is unshared pod disk.

## Checks actually run

All frontend commands ran from `frontend/` on Node 24.15.0 / npm 11.12.1.
The repository targets Node 22; this session did not execute a Node 22 CI runner.

| Check | Result |
|---|---|
| `npm test` | **Passed: 7 tests**, covering every graph reference/source path and all component/flow URL round trips, invalid input and step bounds |
| `./node_modules/.bin/tsc --noEmit --incremental false` | **Passed** |
| `npm run build` | **Passed**, including Next's type-checking and all 11 static pages |
| `npm run test:browser` with external Playwright Core and local preview | **Passed: 30 scenarios**, real installed Chrome; all components/steps, text bounds, history, playback, sharing, presentation, mobile widths 320/390/768/1024, role link, mocked cluster outages and mobile operations disclosure |
| `git diff --check` | **Passed** |
| Additional temporary TSX lifecycle harness | **20/20 passed** for serial polling, pause/retry/offline/unmount races, socket-vs-REST merging and metrics disclosure; not a committed test suite |
| Standalone ESLint | **Not run**; no ESLint setup added. Do not call the build a standalone lint pass |
| Backend lifecycle smoke, actual AWS/kind recovery, deployment/CI | **Not run**; no stack was started or changed |

The browser suite uses synthetic, local-only sessions and intercepted cluster/operations
responses. It blocks mutation requests and external HTTP requests. It does **not** prove a
real order lifecycle, map tiles/GPS, cloud health or actual failover. No JavaScript page errors
or mutation requests occurred during the final suite. Desktop/mobile screenshots were also
inspected; temporary images and tools are outside the repository.

Build warnings remain for optional `bufferutil` and `utf-8-validate` imports in the existing
kepler.gl → loaders.gl → thrift/ws dependency chain. The build succeeds; no version pins were changed.
Early browser runs found a missing exact selector label and 320px tab overflow; both were fixed
and the complete suite rerun. The source-path test also needed to handle GitHub line anchors.

## Run the presentation

From the repository root, PowerShell commands (one per line):

```powershell
Set-Location frontend
npm ci
npm test
npm run build
npx next start --hostname 127.0.0.1 --port 3200
```

Open `http://localhost:3200/architecture`. A production preview was left running on this
port at handoff. It is a frontend-only preview, not a running delivery backend. Do not infer
that login/dispatch works from the public explorer. The full stack commands remain in `AGENTS.md`.

Suggested five-minute demonstration:

1. **Services → Follow a delivery.** Inspect API, Redis and the background handler.
2. **Docker → From source to containers.** Explain image vs container and shared backend roles.
3. **Kubernetes → Scale under load / Recover a lost API pod.** Explain desired state, readiness,
   HPA, and the difference between scaling pods and adding machines.
4. **AWS → An order through AWS / Handle a failed consumer.** Explain edge routing, managed
   state, SNS/SQS fan-out, retries, DLQs, direct S3 uploads and analytics.
5. Expand the environment comparison and discuss the current limitations. Only move to
   **Live cluster** if an actual stack is running and dispatcher access is available.

For slides/projectors, select **Presentation view**. Escape exits and pauses playback.
Use **Copy view link** to bookmark a particular component or walkthrough step.

### Reproduce the optional browser suite

Requires installed Google Chrome. Playwright Core is deliberately not a new app dependency.
In a second PowerShell terminal, from `frontend/`, install the pinned test tool into a temporary
directory and point the script at it:

```powershell
npm install --prefix "$env:TEMP\dispatchx-browser-tools" --no-audit --no-fund --package-lock=false --ignore-scripts playwright-core@1.51.1
$env:PLAYWRIGHT_MODULE = "$env:TEMP\dispatchx-browser-tools\node_modules\playwright-core"
$env:BASE_URL = "http://127.0.0.1:3200"
npm run test:browser
```

Equivalent environment variables work on macOS/Linux. `BROWSER_CHANNEL` optionally changes
the installed browser channel. `SCREENSHOT_DIR`, if supplied, must be an existing directory.
The test refuses non-local preview hosts and never exercises the stop-task button.

## Next step and remaining safety boundary

First, review the local presentation with the owners, starting at `/architecture?layer=services`.
Before any public deployment, gate the existing destructive chaos endpoint independently of
the public dispatcher demo: `backend/app/routers/admin.py::chaos_stop` still uses `require_staff`.
Disabling its button while snapshots are stale is a UX safeguard, **not an authorization fix**.
This pre-existing public-demo risk remains unresolved; no destructive request was sent.

After that, run the real customer → rider → dispatcher lifecycle against an explicitly chosen
local/test stack and then the existing backend smoke test. Validate actual recovery separately
from animation. Publishing or pushing to `main` is not part of this local completion; frontend
changes on `main` automatically trigger the paid-credit AWS deployment workflow.

Keep the original presentation/viva material at `docs/presentation-guide.html`. Unrelated local
`.DS_Store` files were left alone and must not be staged. Never stage local env files or credentials.
