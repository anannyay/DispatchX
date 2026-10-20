"use client";

import { Activity, ArrowRight, Check, ChevronRight, Clock3, Database, Layers, Pause, Play, RefreshCw, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Button, KV, Metric, Panel } from "@/components/ui";
import { api } from "@/lib/api";
import { DISPATCH_NAV } from "@/lib/nav";
import "./system.css";

// Kept local to this route while the system endpoint is integrated independently.
type Dependency = { status: "ok" | "error"; latency_ms: number | null };
type SystemSnapshot = {
  sampled_at: string;
  status: "ok" | "degraded";
  platform: "ecs" | "kubernetes" | "none";
  dependencies: { database: Dependency; redis: Dependency };
  fleet: { online: number | null; available: number | null };
  orders: { pending: number | null; unassigned: number | null; active: number | null; oldest_pending_age_seconds: number | null };
  queue: { name: "celery"; ready: number | null; scope: string };
  dispatch: {
    offers_sent: number | null; offers_accepted: number | null; offers_rejected: number | null;
    offers_expired: number | null; assignment_p95_seconds: number | null; samples: number | null;
  };
  worker: { last_maintenance_at: string | null; age_seconds: number | null };
  safeguards: { idempotent_booking: boolean; chaos_enabled: boolean; can_stop_tasks: boolean };
  booking: { replays: number | null; conflicts: number | null };
  errors: string[];
};
type HistorySample = { sampledAt: string; receivedAt: number; pending: number | null; ready: number | null };

const POLL_MS = 5_000;
const STALE_MS = POLL_MS * 3; // Display freshness only; not an application-health threshold.
const MAX_HISTORY = 60;
const PLATFORM = { ecs: "ECS on EC2", kubernetes: "Kubernetes", none: "No orchestrator detected" };
const measured = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: number | null | undefined) => measured(value) ? value.toLocaleString() : "Unknown";
const seconds = (value: number | null | undefined) => measured(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} s` : "Unknown";
const flag = (value: boolean | undefined, yes = "Enabled", no = "Disabled") => value === true ? yes : value === false ? no : "Unknown";

function duration(value: number | null | undefined) {
  if (!measured(value)) return "Unknown";
  const s = Math.floor(value);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} m`;
  return `${Math.floor(s / 86400)} d ${Math.floor(s % 86400 / 3600)} h`;
}

function timestamp(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Unknown";
}

function MetricValue({ value, unit }: { value: number | null | undefined; unit?: string }) {
  return measured(value) ? <>{count(value)}{unit && <span className="ml-1 text-sm text-k-text">{unit}</span>}</> :
    <span className="text-base font-normal text-k-text">Unknown</span>;
}

function useSystemSignals() {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [paused, setPaused] = useState(false);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const inFlight = useRef<Promise<SystemSnapshot> | null>(null);

  useEffect(() => {
    const connectionChanged = () => setOffline(!navigator.onLine);
    connectionChanged();
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("online", connectionChanged);
    window.addEventListener("offline", connectionChanged);
    return () => {
      window.clearInterval(clock);
      window.removeEventListener("online", connectionChanged);
      window.removeEventListener("offline", connectionChanged);
    };
  }, []);

  useEffect(() => {
    if (paused || offline || !navigator.onLine) {
      setLoading(false);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      setLoading(true);
      setStartedAt(Date.now());
      try {
        // The shared helper has no AbortSignal. Drain the previous request even
        // across pause/resume or Strict Mode cleanup, before starting another.
        if (inFlight.current) await inFlight.current.catch(() => undefined);
        if (!active) return;
        const request = api<SystemSnapshot>("/admin/system");
        inFlight.current = request;
        let next: SystemSnapshot;
        try {
          next = await request;
        } finally {
          if (inFlight.current === request) inFlight.current = null;
        }
        if (!active) return;
        if (!next || !Number.isFinite(Date.parse(next.sampled_at)) ||
          !["ok", "degraded"].includes(next.status) || !["ecs", "kubernetes", "none"].includes(next.platform) ||
          !next.dependencies?.database || !next.dependencies?.redis || !next.fleet || !next.orders ||
          !next.queue || !next.dispatch || !next.worker || !next.safeguards || !next.booking ||
          !Array.isArray(next.errors) || !next.errors.every((message) => typeof message === "string")) {
          throw new Error("The system endpoint returned an incomplete or invalid sample.");
        }
        const received = Date.now();
        setSnapshot(next);
        setReceivedAt(received);
        setNow(received);
        setError("");
        setHistory((previous) => {
          // Repeated server samples are not new measurements.
          if (previous[previous.length - 1]?.sampledAt === next.sampled_at) return previous;
          return [...previous, {
            sampledAt: next.sampled_at, receivedAt: received,
            pending: measured(next.orders.pending) ? next.orders.pending : null,
            ready: measured(next.queue.ready) ? next.queue.ready : null,
          }].slice(-MAX_HISTORY);
        });
      } catch (cause) {
        if (active) setError((cause instanceof Error && cause.message.trim()) || "Could not reach the system endpoint.");
      } finally {
        if (active) {
          setLoading(false);
          // Completion-based scheduling: slow requests never build up a backlog.
          timer = setTimeout(load, POLL_MS);
        }
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [paused, offline, refreshKey]);

  function retry() {
    setPaused(false);
    setRefreshKey((key) => key + 1);
  }

  return { snapshot, history, receivedAt, now, paused, setPaused, offline, loading, startedAt, error, retry };
}

function DependencySignal({ label, dependency, historical }: { label: string; dependency?: Dependency; historical: boolean }) {
  const state = dependency?.status === "ok" ? "OK" : dependency?.status === "error" ? "Error" : "Unknown";
  const tone = state === "Error" ? "text-k-err" : state === "OK" && !historical ? "text-k-ok" : "text-k-text";
  return (
    <div className="system-dependency">
      {label === "Database" ? <Database size={15} aria-hidden="true" /> : <Layers size={15} aria-hidden="true" />}
      <span className="text-k-hi">{label}</span>
      <span className={`inline-flex items-center gap-1 ${tone}`}>
        {state === "OK" ? <Check size={12} aria-hidden="true" /> : state === "Error" ? <TriangleAlert size={12} aria-hidden="true" /> : null}
        {state}
      </span>
      <span className="font-mono text-xs">{measured(dependency?.latency_ms) ? `${count(dependency.latency_ms)} ms` : "Latency unknown"}</span>
    </div>
  );
}

function Sparkline({ history, field, label, color }: {
  history: HistorySample[]; field: "pending" | "ready"; label: string; color: string;
}) {
  const id = useId();
  const values = history.map((sample) => sample[field]).filter(measured);
  const peak = values.length ? Math.max(...values) : null;
  const latest = history[history.length - 1]?.[field];
  const start = history[0]?.receivedAt ?? 0;
  const span = Math.max(1, (history[history.length - 1]?.receivedAt ?? start) - start);
  const points = history.map((sample, index) => measured(sample[field]) ? {
    x: history.length === 1 ? 6 : 6 + ((sample.receivedAt - start) / span) * 548,
    y: 58 - (sample[field] / Math.max(1, peak ?? 0)) * 48,
    connected: index > 0 && measured(history[index - 1][field]) && sample.receivedAt - history[index - 1].receivedAt <= STALE_MS,
  } : null);
  const path = points.map((point) => point ? `${point.connected ? "L" : "M"}${point.x},${point.y}` : "").join(" ");
  const description = `${values.length} known readings from ${history.length} browser samples. Latest: ${count(latest)}. Peak: ${count(peak)}. Scale starts at zero. Missing readings and sampling interruptions are gaps. Exact values are in the sample history table.`;

  return (
    <figure className="system-trace">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-k-hi"><span className={`h-2 w-2 ${color}`} aria-hidden="true" />{label}</span>
        <span className="font-mono text-xs text-k-text">Latest {count(latest)} <span className="px-1 text-k-label">/</span> Peak {count(peak)}</span>
      </figcaption>
      <svg viewBox="0 0 560 68" className={`system-sparkline ${field === "pending" ? "text-k-accent" : "text-k-violet"}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>{label} · recent history</title>
        <desc id={`${id}-description`}>{description}</desc>
        <path d="M6 58H554" stroke="currentColor" strokeOpacity="0.18" strokeDasharray="3 4" />
        {values.length ? <>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {points.map((point, index) => point && <circle key={index} cx={point.x} cy={point.y} r="2" fill="currentColor" />)}
        </> : <text x="280" y="34" textAnchor="middle" fill="currentColor" className="text-xs">No known readings yet</text>}
      </svg>
    </figure>
  );
}

function RecentHistory({ history }: { history: HistorySample[] }) {
  return (
    <Panel className="min-w-0">
      <header className="system-panel-heading">
        <div><h2 className="text-sm font-semibold text-k-hi">Recent pressure</h2><p className="mt-1 text-xs text-k-text">Pending orders and ready queue backlog</p></div>
        <span className="font-mono text-xs text-k-text">{history.length} / {MAX_HISTORY} samples</span>
      </header>
      <div className="divide-y divide-k-line/60 px-4">
        <Sparkline history={history} field="pending" label="Pending orders" color="bg-k-accent" />
        <Sparkline history={history} field="ready" label="Celery ready" color="bg-k-violet" />
      </div>
      <div className="border-t border-k-line px-4 py-3 text-xs text-k-text">
        <p>Only samples collected in this visit; up to 60, roughly 5 minutes at normal cadence. Each trace has its own zero-to-peak scale. Gaps mean unknown values or interrupted sampling.</p>
        <details className="system-details mt-3">
          <summary><ChevronRight size={14} aria-hidden="true" />Inspect sample values</summary>
          <div className="system-history-table k-scroll" tabIndex={0} role="region" aria-label="Recent sample values; scroll for older samples">
            <table>
              <caption className="sr-only">Server sample times in your local timezone, newest first. Unknown readings are not zero.</caption>
              <thead><tr><th scope="col">Sampled at</th><th scope="col">Pending</th><th scope="col">Queue ready</th></tr></thead>
              <tbody>{history.length ? [...history].reverse().map((sample) => (
                <tr key={`${sample.sampledAt}-${sample.receivedAt}`}><th scope="row"><time dateTime={sample.sampledAt}>{timestamp(sample.sampledAt)}</time></th><td>{count(sample.pending)}</td><td>{count(sample.ready)}</td></tr>
              )) : <tr><td colSpan={3}>No samples received yet.</td></tr>}</tbody>
            </table>
          </div>
        </details>
      </div>
    </Panel>
  );
}

function ScalingExplanation() {
  return (
    <details className="system-details k-panel">
      <summary className="system-disclosure-heading"><ChevronRight size={16} aria-hidden="true" /><span>How scaling differs by environment<small>Repository configuration · not measured autoscaling activity</small></span></summary>
      <div className="border-t border-k-line p-4">
        <div className="grid gap-5 md:grid-cols-3">
          <div><h3 className="text-sm font-semibold text-k-hi">Docker Compose</h3><p className="mt-2 text-sm text-k-text">Runs the application containers on one host. Capacity changes are manual; no automatic replica or host scaling is configured.</p></div>
          <div><h3 className="text-sm font-semibold text-k-hi">Kubernetes · local / CI</h3><p className="mt-2 text-sm text-k-text">CPU-based HPA configures API replicas from 2–8 at 50% CPU and workers from 1–3 at 70%. It changes pod counts on the fixed kind nodes. No node autoscaler is configured.</p></div>
          <div><h3 className="text-sm font-semibold text-k-hi">AWS · ECS on EC2</h3><p className="mt-2 text-sm text-k-text">API tasks target 60% CPU (2–8), workers 70% (1–3). Consumers scale from 1–4 on the dispatch SQS visible-message metric. The capacity provider can add EC2 hosts within its configured limits.</p></div>
        </div>
        <p className="mt-4 border-t border-k-line pt-3 text-xs text-k-text">Beat remains a single scheduler. Kubernetes and ECS are alternative deployments here. This page does not measure replicas, CPU, SQS backlog, or scaling decisions; the Celery queue shown above is a different signal.</p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-3 text-sm">
          <Link href="/architecture" className="system-link">Explore the architecture schematic <ArrowRight size={13} aria-hidden="true" /></Link>
          <Link href="/dispatch/cluster" className="system-link">Inspect live cluster snapshots <ArrowRight size={13} aria-hidden="true" /></Link>
        </div>
      </div>
    </details>
  );
}

function SystemView() {
  const { snapshot: snap, history, receivedAt, now, paused, setPaused, offline, loading, startedAt, error, retry } = useSystemSignals();
  const sampleAge = snap ? (now - Date.parse(snap.sampled_at)) / 1000 : null;
  const clockAhead = sampleAge !== null && sampleAge < -POLL_MS / 1000;
  const stale = receivedAt !== null && (now - receivedAt > STALE_MS || (sampleAge !== null && sampleAge * 1000 > STALE_MS));
  const slow = loading && startedAt !== null && now - startedAt > STALE_MS;
  const historical = paused || offline || !!error || stale || clockAhead;
  const degraded = snap?.status === "degraded" || (snap?.errors.length ?? 0) > 0;
  const state = offline ? "Offline" : paused ? "Paused" : error ? "Refresh failed" : clockAhead ? "Clock difference" : stale ? "Stale sample" : slow ? "Waiting for response" : !snap ? "Connecting" : "Polling";
  const stateTone = offline || error || stale || clockAhead || slow ? "text-k-warn" : paused || !snap ? "text-k-text" : "text-k-accent";
  const sampleState = snap ? `${historical ? "Last sample" : "Sample reports"}: ${degraded ? "degraded" : "OK"}` : "Application health unknown";
  const notice = offline ? "Your browser is offline. Updates resume when the connection returns, unless paused." :
    paused ? "Automatic updates are paused. Resume to collect new samples." :
    error ? `Could not refresh application signals. ${error} Retrying after 5 seconds between completed requests.` :
    clockAhead ? "The server sample time is ahead of this browser. Check the clock difference before judging freshness." :
    stale ? "The latest sample or successful response is more than 15 seconds old. Waiting for a fresh sample." :
    slow ? "The request is taking longer than 15 seconds. Waiting for it to finish before sending another." : "";

  return (
    <div className="system-page min-h-screen">
      <Navbar items={DISPATCH_NAV} />
      <main className="mx-auto w-full max-w-[1440px] space-y-4 px-4 py-5 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="k-label mb-2 flex items-center gap-2"><Activity size={14} className="text-k-accent" aria-hidden="true" />System health · read-only</div>
            <h1 className="text-xl font-semibold tracking-tight text-k-hi">Live application signals</h1>
            <p className="mt-2 max-w-2xl text-sm text-k-text">Sampled dependencies, delivery work, and dispatch activity from the running application.</p>
          </div>
          <nav aria-label="Related system views" className="flex flex-wrap gap-4 pt-1 text-sm">
            <Link href="/architecture" className="system-link">Architecture schematic <ArrowRight size={13} aria-hidden="true" /></Link>
            <Link href="/dispatch/cluster" className="system-link">Live cluster <ArrowRight size={13} aria-hidden="true" /></Link>
          </nav>
        </header>

        <section className="k-panel" aria-label="Sample freshness and dependencies">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span role="status" aria-live="polite" className={`inline-flex items-center gap-2 font-medium ${stateTone}`}><span className="h-1.5 w-1.5 bg-current" aria-hidden="true" />{state}</span>
                <span className={degraded ? "text-k-warn" : snap && !historical ? "text-k-ok" : "text-k-text"}>{sampleState}</span>
              </div>
              <p className="mt-1 text-xs text-k-text">
                {snap ? <>Sampled <time dateTime={snap.sampled_at}>{timestamp(snap.sampled_at)}</time> · {sampleAge !== null && sampleAge >= 0 ? `${duration(sampleAge)} ago` : "server time ahead"}</> : "No successful sample yet."}
                <span className="ml-2">{loading ? "Request in progress…" : "5 s between requests"}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Resume automatic updates" : "Pause automatic updates"}>
                {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{paused ? "Resume" : "Pause"}
              </Button>
              <Button variant="secondary" disabled={loading || offline} onClick={retry}>
                <RefreshCw size={13} className={loading ? "motion-safe:animate-spin" : ""} aria-hidden="true" />{paused ? "Retry & resume" : "Retry now"}
              </Button>
            </div>
          </div>
          <div className="system-dependency-strip">
            <DependencySignal label="Database" dependency={snap?.dependencies.database} historical={historical} />
            <DependencySignal label="Redis" dependency={snap?.dependencies.redis} historical={historical} />
            <div className="system-dependency"><Server size={15} aria-hidden="true" /><span className="text-k-text">Platform</span><span className="text-k-hi">{snap ? PLATFORM[snap.platform] : "Unknown"}</span></div>
          </div>
        </section>

        {notice && <div role="status" className="system-notice"><TriangleAlert size={16} className="shrink-0 text-k-warn" aria-hidden="true" /><p>{notice} {snap ? "Displayed values belong to the last successful sample." : "Measurements remain unknown until a sample arrives."}</p></div>}

        {degraded && <section className="system-notice" aria-label="Reported application issues">
          <TriangleAlert size={16} className="shrink-0 text-k-warn" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-k-hi">{historical ? "Last sample reported degraded signals" : "Application reported degraded signals"}</h2>
            <p className="mt-1">Available measurements are shown; missing readings stay unknown.</p>
            {!!snap?.errors.length && <details className="system-details mt-2"><summary><ChevronRight size={14} aria-hidden="true" />Reported issues ({snap.errors.length})</summary><ul className="mt-2 max-h-40 list-inside list-disc space-y-1 overflow-y-auto break-words k-scroll">{snap.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
          </div>
        </section>}

        <section aria-labelledby="system-metrics-heading">
          <h2 id="system-metrics-heading" className="sr-only">Application measurements at sample time</h2>
          <div className="system-metrics k-panel">
            <Metric label="Available riders" value={<MetricValue value={snap?.fleet.available} />} sub={`${count(snap?.fleet.online)} online`} />
            <Metric label="Pending orders" value={<MetricValue value={snap?.orders.pending} />} sub="Waiting for assignment" />
            <Metric label="Unassigned orders" value={<MetricValue value={snap?.orders.unassigned} />} sub="Need dispatcher attention" />
            <Metric label="Active orders" value={<MetricValue value={snap?.orders.active} />} sub="Assigned or picked up" />
            <Metric label="Queue ready" value={<MetricValue value={snap?.queue.ready} />} sub="Celery default queue only" />
            <Metric label="Assignment p95" value={<MetricValue value={snap?.dispatch.assignment_p95_seconds} unit="s" />} sub={`${count(snap?.dispatch.samples)} assignment samples`} />
          </div>
        </section>

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <RecentHistory history={history} />
          <div className="min-w-0 space-y-4">
            <Panel>
              <header className="system-panel-heading"><h2 className="inline-flex items-center gap-2 text-sm font-semibold text-k-hi"><Clock3 size={15} className="text-k-text" aria-hidden="true" />Work age & maintenance</h2><span className="text-xs text-k-text">At sample time</span></header>
              <div className="grid grid-cols-2 divide-x divide-k-line py-2">
                <Metric label="Oldest pending work" value={<span className={measured(snap?.orders.oldest_pending_age_seconds) ? "" : "text-base font-normal text-k-text"}>{duration(snap?.orders.oldest_pending_age_seconds)}</span>} />
                <Metric label="Maintenance age" value={<span className={measured(snap?.worker.age_seconds) ? "" : "text-base font-normal text-k-text"}>{duration(snap?.worker.age_seconds)}</span>} />
              </div>
              <div className="space-y-2 border-t border-k-line px-4 py-3 text-xs text-k-text">
                <p>Last maintenance: {snap?.worker.last_maintenance_at ? <time dateTime={snap.worker.last_maintenance_at}>{timestamp(snap.worker.last_maintenance_at)}</time> : "Unknown"}.</p>
                <p>These are reported ages, not a worker heartbeat guarantee or an SLO verdict. No healthy-age threshold is assumed.</p>
              </div>
            </Panel>
            <Panel>
              <header className="system-panel-heading"><h2 className="text-sm font-semibold text-k-hi">What this sample covers</h2></header>
              <div className="space-y-3 px-4 py-3 text-sm text-k-text">
                <p><strong className="font-medium text-k-hi">Queue scope.</strong> Ready messages in the default <code className="font-mono text-k-hi">celery</code> queue. Excludes scheduled, reserved, and in-flight tasks, other queues, and SQS. A zero here does not mean all work is complete.</p>
                <p className="break-words text-xs"><span className="text-k-hi">Reported scope: </span>{snap?.queue.scope || "Unknown until a sample arrives."}</p>
                <p>Values are point-in-time observations, not a transactional snapshot or continuous monitoring. Unknown means unavailable, not zero.</p>
                <p className="text-xs">Stale means the sample or last response is over 15 s old (three polling intervals). It describes display freshness, not application health. Times use your browser’s timezone.</p>
              </div>
            </Panel>
          </div>
        </div>

        <details className="system-details k-panel">
          <summary className="system-disclosure-heading"><ChevronRight size={16} aria-hidden="true" /><span>Dispatch counters & safeguards<small>Additional reported signals and read-only configuration</small></span></summary>
          <div className="grid gap-5 border-t border-k-line p-4 md:grid-cols-3">
            <section><h2 className="mb-2 text-sm font-semibold text-k-hi">Offer activity</h2><dl className="divide-y divide-k-line/50">
              <KV k="Sent" v={count(snap?.dispatch.offers_sent)} mono /><KV k="Accepted" v={count(snap?.dispatch.offers_accepted)} mono />
              <KV k="Rejected" v={count(snap?.dispatch.offers_rejected)} mono /><KV k="Expired" v={count(snap?.dispatch.offers_expired)} mono />
            </dl></section>
            <section><h2 className="mb-2 text-sm font-semibold text-k-hi">Booking & assignment</h2><dl className="divide-y divide-k-line/50">
              <KV k="Booking replays" v={count(snap?.booking.replays)} mono /><KV k="Booking conflicts" v={count(snap?.booking.conflicts)} mono />
              <KV k="Assignment p95" v={seconds(snap?.dispatch.assignment_p95_seconds)} mono /><KV k="Assignment samples" v={count(snap?.dispatch.samples)} mono />
            </dl></section>
            <section><h2 className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-k-hi"><ShieldCheck size={14} aria-hidden="true" />Reported safeguards</h2><dl className="divide-y divide-k-line/50">
              <KV k="Idempotent booking" v={flag(snap?.safeguards.idempotent_booking)} /><KV k="Chaos mode" v={flag(snap?.safeguards.chaos_enabled)} />
              <KV k="Task-stop permission" v={flag(snap?.safeguards.can_stop_tasks, "Allowed", "Not allowed")} />
            </dl></section>
            <p className="text-xs text-k-text md:col-span-3">Counters are reported totals, not rates for this visit; they may reset. Assignment p95 uses the reported sample set, not this chart’s time window. Configuration flags describe what the backend reports, not proof that a recovery or scaling action occurred.</p>
          </div>
        </details>

        <ScalingExplanation />
        <footer className="pb-2 text-xs text-k-text">Application signals come from <code className="font-mono">GET /api/admin/system</code>. The architecture explorer is a reference schematic; the live cluster view provides separate infrastructure snapshots.</footer>
      </main>
    </div>
  );
}

export default function Page() {
  return <RequireRole roles={["dispatcher", "admin"]}><SystemView /></RequireRole>;
}
