"use client";

import { ArrowRight, Pause, Play, RotateCcw, Server, Skull, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Button, Empty, KV, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { DISPATCH_NAV } from "@/lib/nav";
import type { InfraNode, InfraSnapshot, InfraTask } from "@/lib/types";

// Categorical palette in the kepler.gl family
const SERVICE_COLORS: Record<string, string> = {
  api: "#1FBAD6", web: "#2EC27E", worker: "#F0B429", beat: "#8A94A6", consumer: "#A08CF5",
  monitoring: "#E8798F", mysql: "#F2994A", redis: "#F25F5C", seed: "#6A7485",
};
const colorFor = (s: string) => SERVICE_COLORS[s] ?? "#9AA5B1";

const PLATFORM = {
  ecs: { name: "Amazon ECS on EC2", node: "Container instance", nodes: "Instances", unit: "Task", units: "Tasks" },
  kubernetes: { name: "Kubernetes", node: "Node", nodes: "Nodes", unit: "Pod", units: "Pods" },
  none: { name: "No orchestrator detected", node: "Node", nodes: "Nodes", unit: "Workload", units: "Workloads" },
} as const;

function age(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const dying = (t: InfraTask) => ["STOPPED", "STOPPING", "DEACTIVATING"].includes(t.status) || t.desired === "STOPPED";

function Gauge({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const color = pct > 85 ? "#F25F5C" : pct > 65 ? "#F0B429" : "#1FBAD6";
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="k-label">{label}</span>
        <span className="font-mono text-2xs text-k-text">{used.toLocaleString()} / {total.toLocaleString()} {unit} · {pct}%</span>
      </div>
      <div className="mt-1 h-1 bg-k-panel">
        <div className="h-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function TaskRow({ t, selected, onClick }: { t: InfraTask; selected: boolean; onClick: () => void }) {
  const d = dying(t);
  const starting = !d && t.status !== "RUNNING";
  const fresh = !d && t.started_at && Date.now() - new Date(t.started_at).getTime() < 60_000;
  return (
    <button onClick={onClick}
      className={`grid w-full grid-cols-[10px_1fr_auto_auto] items-center gap-2.5 border-b border-k-line/50 px-3 py-1.5 text-left text-xs transition-colors last:border-0
        ${selected ? "bg-k-hover" : "hover:bg-k-panel"} ${d ? "opacity-50" : ""} ${fresh ? "animate-fadeIn" : ""}`}>
      <span className="h-2 w-2 rounded-[1px]" style={{ background: d ? "#F25F5C" : colorFor(t.service) }} />
      <span className="truncate">
        <span className="font-medium text-k-hi">{t.service}</span>
        <span className="ml-2 font-mono text-2xs text-k-label">{t.id.slice(0, 8)}</span>
      </span>
      {fresh ? <span className="font-mono text-2xs font-semibold text-k-ok">NEW</span> :
        <span className={`font-mono text-2xs ${d ? "text-k-err" : starting ? "text-k-warn" : "text-k-label"}`}>
          {d ? "stopping" : starting ? t.status.toLowerCase() : age(t.started_at)}
        </span>}
      <span className={`h-1.5 w-1.5 rounded-full ${d ? "bg-k-err" : starting ? "animate-pulse bg-k-warn" : "bg-k-ok"}`} />
    </button>
  );
}

function NodePanel({ n, kind, selected, onSelect }: { n: InfraNode; kind: InfraSnapshot["platform"]; selected: string | null; onSelect: (t: InfraTask) => void }) {
  const fresh = n.started_at && Date.now() - new Date(n.started_at).getTime() < 180_000;
  const running = n.tasks.filter((t) => t.status === "RUNNING").length;
  return (
    <section className={`k-panel flex min-w-0 flex-col transition-colors duration-700 ${fresh ? "border-k-ok/70" : ""}`}>
      <header className="flex items-start justify-between gap-3 border-b border-k-line px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Server className="h-3.5 w-3.5 shrink-0 text-k-label" strokeWidth={1.5} />
            <span className="truncate font-mono text-sm text-k-hi">{n.name ?? n.id.slice(0, 12)}</span>
            {fresh && <span className="rounded-[2px] bg-k-ok/15 px-1 font-mono text-2xs font-semibold text-k-ok">SCALED OUT</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-2xs text-k-label">
            {n.zone && <span>{n.zone}</span>}
            {n.instance_type && <span>{n.instance_type}</span>}
            <span className={n.status === "ACTIVE" ? "text-k-ok" : "text-k-err"}>{n.status.toLowerCase()}</span>
            <span>up {age(n.started_at)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-xl text-k-hi">{running}</div>
          <div className="k-label">{PLATFORM[kind].units}</div>
        </div>
      </header>
      <div className="space-y-2 px-3 py-2.5">
        <Gauge label="CPU reserved" used={n.cpu_used} total={n.cpu_total} unit={kind === "kubernetes" ? "m" : "units"} />
        <Gauge label="Memory reserved" used={n.mem_used} total={n.mem_total} unit="MiB" />
      </div>
      <div className="border-t border-k-line">
        {n.tasks.slice().sort((a, b) => a.service.localeCompare(b.service)).map((t) => (
          <TaskRow key={t.id} t={t} selected={selected === t.id} onClick={() => onSelect(t)} />
        ))}
        {n.tasks.length === 0 && <div className="px-3 py-3 text-center text-xs text-k-label">No workloads scheduled</div>}
      </div>
    </section>
  );
}

function ClusterView() {
  const [snap, setSnap] = useState<InfraSnapshot | null>(null);
  const [selected, setSelected] = useState<InfraTask | null>(null);
  const [toast, setToast] = useState("");
  const [paused, setPaused] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [platform, setPlatform] = useState<InfraSnapshot["platform"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const onConnectionChange = () => setOffline(!navigator.onLine);
    onConnectionChange();
    window.addEventListener("online", onConnectionChange);
    window.addEventListener("offline", onConnectionChange);
    return () => {
      mounted.current = false;
      window.removeEventListener("online", onConnectionChange);
      window.removeEventListener("offline", onConnectionChange);
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
      try {
        const next = await api<InfraSnapshot>("/admin/infra");
        if (!active) return;
        setPlatform(next.platform);
        // The backend also reports platform failures in HTTP 200 responses.
        if (next.error) {
          setLoadError(`Platform API error: ${next.error}`);
          return;
        }
        setSnap(next);
        setUpdatedAt(new Date());
        setLoadError("");
      } catch {
        if (active) setLoadError("Could not load the cluster snapshot. Platform health is unknown.");
      } finally {
        if (active) {
          setLoading(false);
          // Wait for completion before polling again; slow requests cannot overlap.
          timer = setTimeout(load, 3000);
        }
      }
    }
    void load();
    return () => {
      active = false; // Ignore responses from before pause, retry, disconnect or unmount.
      clearTimeout(timer);
    };
  }, [paused, offline, refreshKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  function retry() {
    setPaused(false);
    setRefreshKey((key) => key + 1);
  }

  const current = selected && snap ? snap.nodes.flatMap((n) => n.tasks).find((t) => t.id === selected.id) ?? null : null;
  const kind = snap?.platform ?? platform;
  const P = PLATFORM[kind ?? "none"];
  const hasMeasurements = snap !== null && snap.platform !== "none";
  const all = snap?.nodes.flatMap((n) => n.tasks) ?? [];
  const running = all.filter((t) => t.status === "RUNNING").length;
  const updateStatus = offline ? "Offline · updates suspended" : paused ? "Updates paused" :
    loading ? "Fetching snapshot…" : loadError ? "Refresh failed · retrying in 3 seconds" : "Next refresh in 3 seconds";

  async function kill(t: InfraTask) {
    if (!confirm(`Stop ${t.service} ${P.unit.toLowerCase()} ${t.id.slice(0, 8)}? The orchestrator should replace it automatically.`)) return;
    try {
      await api(`/admin/infra/tasks/${t.id}/stop`, { method: "POST" });
      if (!mounted.current) return;
      setToast(`Stopped ${t.service} ${t.id.slice(0, 8)}. Watching for the replacement.`);
      retry();
    } catch (e) {
      if (mounted.current) setToast(e instanceof Error ? e.message : "Failed to stop");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar items={DISPATCH_NAV} />

      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-k-line bg-k-side px-5 py-3">
        <div className="min-w-0">
          <div className="k-label break-words">{kind ? P.name : "Platform not yet detected"}{snap?.cluster ? ` · ${snap.cluster}` : ""}</div>
          <h1 className="mt-0.5 text-base font-semibold text-k-hi">Container cluster snapshots</h1>
          <p className="mt-1 text-xs text-k-label">{updateStatus}{updatedAt ? ` · Last successful response ${updatedAt.toLocaleTimeString()}` : ""}</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-y-3">
          <div className="flex divide-x divide-k-line">
            {[[hasMeasurements ? snap.nodes.length : "–", P.nodes], [hasMeasurements ? running : "–", `${P.units} running`], [hasMeasurements ? snap.services.length : "–", "Services"]].map(([v, l]) => (
              <div key={String(l)} className="px-2 text-right sm:px-4">
                <div className="font-mono text-xl text-k-hi">{v}</div>
                <div className="k-label">{l}</div>
              </div>
            ))}
          </div>
          <div className="pl-2 sm:pl-4">
            <Button size="sm" variant="secondary" onClick={() => setPaused((value) => !value)}>
              {paused ? <><Play className="h-3 w-3" /> Resume</> : <><Pause className="h-3 w-3" /> Pause</>}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-k-line px-5 py-2.5 text-xs">
        <span className="text-k-text">Read-only snapshot inspection: select a task or pod for reported placement and health.</span>
        <Link href={kind && kind !== "none" ? `/architecture?layer=${kind === "kubernetes" ? "kubernetes" : "aws"}` : "/architecture"} className="inline-flex items-center gap-2 text-k-accent hover:underline">Architecture schematic · reference only <ArrowRight size={12} /></Link>
      </div>

      {(loadError || offline || paused) && (
        <div role="status" className="mx-5 mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-k-warn/40 bg-k-warn/10 px-3 py-2 text-xs text-k-text">
          <div className="min-w-0 flex-1 basis-64 break-words">
            {offline ? "Your browser is offline. Cluster updates will resume when connected, unless paused." : loadError || "Automatic updates are paused."}
            {snap ? " Showing the last successful snapshot; it may be outdated." : " No cluster measurements are available."}
            {loadError && !offline && (paused ? " Resume updates or retry to refresh." : " Retrying automatically after each completed request.")}
          </div>
          {loadError && <Button size="sm" variant="secondary" disabled={offline || loading} onClick={retry}>
            {loading ? <Spinner className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
            {loading ? "Retrying…" : paused ? "Retry and resume" : "Retry now"}
          </Button>}
        </div>
      )}

      {hasMeasurements && snap.services.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-k-line px-5 py-2">
          {snap.services.map((s) => {
            const ok = s.running >= s.desired && s.pending === 0;
            return (
              <div key={s.name} className="flex items-center gap-1.5 text-xs">
                <span className="h-2 w-2 rounded-[1px]" style={{ background: colorFor(s.name) }} />
                <span className="text-k-hi">{s.name}</span>
                <span className={`font-mono ${ok ? "text-k-label" : "text-k-warn"}`}>{s.running}/{s.desired}</span>
                {s.pending > 0 && <span className="font-mono text-k-warn">+{s.pending}</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-5 xl:flex-row">
        <main className="min-w-0 flex-1">
          {!snap ? (
            loading && !loadError && !offline ? (
              <div role="status" className="flex h-64 items-center justify-center gap-2 text-xs text-k-label"><Spinner className="h-5 w-5" /> Loading cluster snapshot…</div>
            ) : (
              <Empty title={offline ? "Cluster snapshot unavailable offline" : paused ? "Cluster updates paused" : "Cluster snapshot unavailable"}>
                No successful snapshot has been received. {paused ? "Resume updates to try again." : "Placement and health are unknown."}
              </Empty>
            )
          ) : snap.platform === "none" ? (
            <Empty title="No orchestrator detected">
              The last successful response did not detect ECS or Kubernetes configuration. This does not establish whether containers are running or healthy.
            </Empty>
          ) : snap.nodes.length === 0 ? (
            <Empty title={`No ${P.nodes.toLowerCase()} reported`}>
              This snapshot contains no registered nodes. Service counts and scheduler events may provide more context.
            </Empty>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {snap.nodes.map((n) => <NodePanel key={n.id} n={n} kind={snap.platform} selected={current?.id ?? null} onSelect={setSelected} />)}
            </div>
          )}
        </main>

        <aside className="w-full shrink-0 space-y-4 xl:w-[340px]">
          {selected && !current && <Empty title="Workload no longer in this snapshot">Select another task or pod to inspect its current reported state.</Empty>}
          {current && (
            <section className="k-panel">
              <header className="flex items-center justify-between border-b border-k-line px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-[1px]" style={{ background: colorFor(current.service) }} />
                  <span className="text-sm font-semibold text-k-hi">{current.service}</span>
                  <span className="k-label">{P.unit}</span>
                </div>
                <button aria-label="Close workload inspection" onClick={() => setSelected(null)} className="rounded p-1 text-k-label hover:bg-k-panel hover:text-k-hi"><X className="h-3.5 w-3.5" /></button>
              </header>
              <dl className="divide-y divide-k-line/60 px-3 py-1">
                <KV k="ID" v={current.id} mono />
                <KV k="Status" v={`${current.status.toLowerCase()} → ${current.desired.toLowerCase()}`} />
                <KV k="Health" v={current.health.toLowerCase()} />
                <KV k="Containers" v={current.containers.join(", ")} mono />
                <KV k="Reserved" v={`${current.cpu} cpu · ${current.memory} MiB`} mono />
                <KV k="Uptime" v={age(current.started_at)} mono />
                {current.stopped_reason && <KV k="Stop reason" v={current.stopped_reason} />}
              </dl>
              {current.status === "RUNNING" && current.desired !== "STOPPED" && (
                <div className="border-t border-k-line p-3">
                  <Button variant="danger" className="w-full" disabled={!snap?.capabilities?.can_stop_tasks || offline || paused || loading || !!loadError} onClick={() => kill(current)}>
                    <Skull className="h-3.5 w-3.5" /> Chaos test: stop this {P.unit.toLowerCase()}
                  </Button>
                  <p className="mt-2 text-2xs text-k-label">{snap?.capabilities?.can_stop_tasks
                    ? "This separate action changes the platform. The scheduler should replace the workload to restore its desired count."
                    : "Read-only controls. Chaos tests require an administrator and an explicitly enabled deployment; the public dispatcher demo cannot stop workloads."}</p>
                </div>
              )}
            </section>
          )}

          <section className="k-panel">
            <header className="border-b border-k-line px-3 py-2 k-label">Scheduler events</header>
            <ul className="max-h-[30rem] divide-y divide-k-line/50 overflow-y-auto k-scroll">
              {(hasMeasurements ? snap.events : []).map((e, i) => (
                <li key={i} className="px-3 py-2">
                  <div className="font-mono text-2xs text-k-label">{e.at ? new Date(e.at).toLocaleTimeString([], { hour12: false }) : ""}</div>
                  <div className="break-words text-xs text-k-text">{e.message}</div>
                </li>
              ))}
              {!hasMeasurements ? <li className="px-3 py-3 text-xs text-k-label">Scheduler events unavailable without a platform snapshot.</li> : snap.events.length === 0 && <li className="px-3 py-3 text-xs text-k-label">No recent events reported in this snapshot</li>}
            </ul>
          </section>
        </aside>
      </div>

      {toast && <div className="fixed bottom-4 left-1/2 z-[2000] -translate-x-1/2 rounded border border-k-line bg-k-side px-4 py-2.5 text-sm text-k-hi shadow-2xl">{toast}</div>}
    </div>
  );
}

export default function Page() {
  return <RequireRole roles={["dispatcher", "admin"]}><ClusterView /></RequireRole>;
}
