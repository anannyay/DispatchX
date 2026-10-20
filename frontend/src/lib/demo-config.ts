export const DEFAULT_BASE_URL = "http://localhost:8000";

export const DEMO_FIELDS = [
  { key: "riders", label: "Riders", min: 1, max: 100, integer: true, flag: "--riders", hint: "Virtual rider accounts, starting at 1." },
  { key: "customers", label: "Customers", min: 1, max: 30, integer: true, flag: "--customers", hint: "Virtual customer accounts, starting at 1." },
  { key: "ordersPerMin", label: "Orders / min", min: 0, max: 30, integer: false, flag: "--orders-per-min", hint: "Mean arrival rate, not a guaranteed count. Zero creates no new orders." },
  { key: "acceptRate", label: "Accept probability", min: 0, max: 1, integer: false, flag: "--accept-rate", hint: "0–1 probability per offer. Other offers are rejected or ignored." },
  { key: "duration", label: "Duration (seconds)", min: 60, max: 900, integer: false, flag: "--duration", hint: "Finite run; Ctrl+C stops it early." },
  { key: "radiusKm", label: "Radius (km)", min: 1, max: 10, integer: false, flag: "--radius-km", hint: "Simulator spawn area, not the backend matching radius." },
  { key: "speedup", label: "Movement speedup", min: 1, max: 20, integer: false, flag: "--speedup", hint: "Multiplies rider movement, not order rate or retry timers." },
] as const;

export type NumericField = (typeof DEMO_FIELDS)[number]["key"];
export type DemoConfig = Record<NumericField, number> & { baseUrl: string };
export type DemoDraft = Record<keyof DemoConfig, string>;
export type DemoErrors = Partial<Record<keyof DemoConfig, string>>;
export type Shell = "powershell" | "posix";

export const DEMO_PRESETS = [
  {
    id: "explain", label: "Explain", description: "Small, slow-arriving demo with all offers accepted when a rider is available.",
    values: { riders: 5, customers: 5, ordersPerMin: 1, acceptRate: 1, radiusKm: 3, speedup: 10, duration: 300 },
  },
  {
    id: "busy", label: "Busy fleet", description: "More moving riders and orders. This preset is not a capacity benchmark.",
    values: { riders: 20, customers: 5, ordersPerMin: 6, acceptRate: 0.85, radiusKm: 3, speedup: 10, duration: 300 },
  },
  {
    id: "failure", label: "Failure/retry", description: "Simulated riders reject or ignore every offer to exercise dispatch retries; no infrastructure is stopped.",
    values: { riders: 3, customers: 5, ordersPerMin: 2, acceptRate: 0, radiusKm: 3, speedup: 10, duration: 240 },
  },
] as const;

export type PresetId = (typeof DEMO_PRESETS)[number]["id"];

// A fresh draft makes edits independent of the preset. Reset preserves the target.
export function presetDraft(id: PresetId, baseUrl = DEFAULT_BASE_URL): DemoDraft {
  const preset = DEMO_PRESETS.find((item) => item.id === id) ?? DEMO_PRESETS[0];
  const draft = { baseUrl } as DemoDraft;
  for (const field of DEMO_FIELDS) draft[field.key] = String(preset.values[field.key]);
  return draft;
}

export function validateBaseUrl(value: string): { value: string; error?: never } | { value?: never; error: string } {
  const error = "Use an absolute http:// or https:// URL without credentials, query, fragment, spaces, or backslashes.";
  // URL() otherwise silently fixes several malformed inputs (including newlines
  // and backslashes). Reject them before parsing, including empty ? / # / userinfo.
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\?#]/u.test(value)) return { error };
  const authority = value.slice(value.indexOf("://") + 3).split("/")[0];
  if (!authority || authority.includes("@")) return { error };
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return { error };
    // URL serialization percent-encodes double quotes, backticks and Unicode in
    // paths. This also avoids native-argument quote loss in Windows PowerShell.
    return { value: url.href };
  } catch {
    return { error };
  }
}

export function validateDemoConfig(draft: DemoDraft):
  | { valid: true; config: DemoConfig; errors: DemoErrors }
  | { valid: false; config: null; errors: DemoErrors } {
  const errors: DemoErrors = {};
  const base = validateBaseUrl(draft.baseUrl);
  if (base.error) errors.baseUrl = base.error;
  const config = { baseUrl: base.value ?? "" } as DemoConfig;
  for (const field of DEMO_FIELDS) {
    const raw = draft[field.key].trim();
    const number = Number(raw);
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw);
    if (!decimal || !Number.isFinite(number) || number < field.min || number > field.max || (field.integer && !Number.isInteger(number))) {
      errors[field.key] = `${field.label}: enter ${field.integer ? "a whole number" : "a number"} from ${field.min} to ${field.max}.`;
    } else {
      config[field.key] = number;
    }
  }
  return Object.keys(errors).length ? { valid: false, config: null, errors } : { valid: true, config, errors };
}

// Values are always literal arguments, never interpolated shell expressions.
// PowerShell also recognizes typographic single quotes as string delimiters.
export function quoteShellArgument(value: string, shell: Shell): string {
  return shell === "powershell"
    ? `'${value.replace(/['\u2018\u2019]/g, (quote) => quote + quote)}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function generateDemoCommands(draft: DemoDraft) {
  const validation = validateDemoConfig(draft);
  if (!validation.valid) return { ...validation, commands: null };
  const { config } = validation;
  function simulator(shell: Shell) {
    const quote = (value: string | number) => quoteShellArgument(String(value), shell);
    return `python simulator/simulator.py --base-url ${quote(config.baseUrl)} ${DEMO_FIELDS.map((field) => `${field.flag} ${quote(config[field.key])}`).join(" ")}`;
  }
  return {
    ...validation,
    commands: {
      powershell: simulator("powershell"),
      posix: simulator("posix"),
      // Only validated integers enter this command; it is identical in both shells.
      seed: `docker compose exec api python -m app.seed --riders ${config.riders} --customers ${config.customers}`,
    },
  };
}

export const DEMO_WALKTHROUGH = [
  {
    id: "responsibilities", start: 0, end: 60, title: "Architecture responsibilities",
    href: "/architecture?layer=services&flow=delivery&step=1", link: "Open Services flow",
    click: "Open Services → Follow a delivery. Use Next to trace API, MySQL, event delivery, background handlers and Redis.",
    say: "The API handles requests; MySQL stores orders and history. Redis holds locations, offer locks and pub/sub. Celery handles background work locally; Beat schedules maintenance. These are separate responsibilities in one backend codebase.",
    observe: "The explorer is a source-backed schematic. Its playback explains messages; it does not send orders or measure a running system.",
  },
  {
    id: "delivery", start: 60, end: 210, title: "One real delivery · three browser profiles",
    href: "/login", link: "Open role login",
    click: "01:00–01:30: in three independent profiles, open /login and select Customer, Rider and Dispatcher. Rider: choose Demo (click map), place the rider near the planned pickup, and toggle online. 01:30–02:00: Customer selects pickup/drop on the map or address search, waits for the quote, then clicks Book delivery. Rider clicks Accept before the offer expires. 02:00–03:00: Rider clicks Confirm pickup, then Complete without photo (or Photo & complete delivery). 03:00–03:30: reload the customer tracking page and find the same order under Dispatcher → Recent.",
    say: "This is a real order through the API, database, background matching and Socket.IO. Demo mode supplies simulated coordinates; it does not turn the order into an animation.",
    observe: "Match the order ID across roles: pending → assigned → picked_up → delivered. Customer labels include Heading to pickup and Heading to drop-off. Reload confirms saved state. Stop all simulators beforehand; ordinary tabs share login state. If the flow fails, show the actual error rather than claiming completion.",
  },
  {
    id: "docker", start: 210, end: 270, title: "Docker · images versus running roles",
    href: "/architecture?layer=docker&flow=build&step=1", link: "Open Docker flow",
    click: "Switch to the local terminal. Run docker compose ps and docker compose images, then open Docker → From source to containers. Inspect backend/entrypoint.sh for api, worker and beat commands.",
    say: "An image packages code and dependencies; a container runs a process from it. API, worker and Beat use the same backend source/Dockerfile with different commands; Compose may give them separate image tags. Web has its own image. Volumes hold MySQL and local photos.",
    observe: "Terminal output proves only the containers/images on this Docker host. Under Compose, Live cluster is unavailable by design: its backend inspects ECS or Kubernetes, not the Docker daemon. Compose is not evidence of multi-host failover.",
  },
  {
    id: "kubernetes", start: 270, end: 330, title: "Kubernetes · configured versus observed",
    href: "/architecture?layer=kubernetes", link: "Open Kubernetes layer",
    click: "Open Kubernetes; inspect Deployments, Services and Horizontal Pod Autoscaler. If a kind cluster is already running, use its dispatcher /dispatch/cluster and the explicit kind-dispatchx terminal commands below. Otherwise stay in the schematic.",
    say: "Deployments reconcile desired pod replicas, Services give stable routing, and readiness controls traffic eligibility. CPU-based HPA changes API/worker pod counts on the fixed kind nodes. Beat stays a single scheduler. This is local/CI Kubernetes, not an AWS EKS deployment.",
    observe: "Manifests prove configured intent. Ready pods and HPA readings from the selected kind context prove current state. Unknown metrics or unchanged replica counts are not evidence of autoscaling; animation is not recovery evidence.",
  },
  {
    id: "aws", start: 330, end: 390, title: "AWS · ECS, managed state and SNS/SQS",
    href: "/architecture?layer=aws", link: "Open AWS layer",
    click: "Open AWS; trace CloudFront → ALB → ECS, then inspect RDS, the Redis-compatible cache and SNS/SQS. Use an existing AWS deployment’s authenticated Live cluster only if it is already available.",
    say: "This repository configures ECS on EC2. EKS is AWS’s managed Kubernetes service, a different orchestrator not deployed here. RDS MySQL and ElastiCache Valkey externalize state. SNS fans out events to SQS queues; consumers process them with retries and dead-letter queues. Local/kind uses Celery instead.",
    observe: "Templates establish configuration, not present cloud health. A fresh ECS snapshot establishes observed tasks, not successful failover or exactly-once processing. No AWS resources are created by this page.",
  },
  {
    id: "signals", start: 390, end: 450, title: "System signals · optional bounded load",
    href: "/dispatch/system", link: "Open System signals",
    click: "In the dispatcher profile, open /dispatch/system. Check sample freshness, dependencies, available riders, pending/unassigned orders, Queue ready and Assignment p95; expand Dispatch counters & safeguards. After the manual delivery is finished, optionally paste one generated simulator command in a separate terminal. Compare samples, then press Ctrl+C before 07:30.",
    say: "These are sampled application signals. Queue ready is only the default Celery ready queue, not in-flight work or SQS backlog. Unknown is not zero. Assignment p95 needs its sample count; a small demo cannot establish production capacity.",
    observe: "Record the sample time and actual values before/after, including errors or stale state. No visible change in a short run is a valid observation. Failure/retry rejects or ignores offers; unassigned is eventual, not guaranteed within this minute. Ctrl+C stops new simulated activity, but queued work and saved orders can remain.",
  },
  {
    id: "evidence", start: 450, end: 480, title: "Limitations and evidence",
    href: "#evidence", link: "Review evidence boundary",
    click: "Return here. State which environment was used and which order ID, reload, container output and sample timestamps you actually observed. Confirm the simulator terminal has exited.",
    say: "We demonstrated the recorded behavior only. Movement is simulated and straight-line. Compose is single-host; local/kind Redis has no configured persistent volume. AWS Multi-AZ database/cache options are not defaults. No transactional outbox or exactly-once event delivery is claimed.",
    observe: "Keep observed results separate from source-configured HPA, ECS scaling, managed-state options and retry behavior. Neither preset size nor diagram playback proves throughput, high availability, recovery or a current AWS deployment.",
  },
] as const;

export function demoTime(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
