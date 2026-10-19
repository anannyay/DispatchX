"use client";

import { Pause, Play, Server, Skull, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Button, KV, Spinner } from "@/components/ui";
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
  none: { name: "Docker Compose", node: "Host", nodes: "Hosts", unit: "Container", units: "Containers" },
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
      <div className="flex items-baseline justify-between">
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
    <section className={`k-panel flex flex-col transition-colors duration-700 ${fresh ? "border-k-ok/70" : ""}`}>
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

  const load = useCallback(async () => {
    try { setSnap(await api<InfraSnapshot>("/admin/infra")); } catch { /* keep last snapshot */ }
  }, []);

  useEffect(() => {
    load();
    if (paused) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, paused]);

  const current = selected && snap ? snap.nodes.flatMap((n) => n.tasks).find((t) => t.id === selected.id) ?? selected : null;
  const kind = snap?.platform ?? "none";
  const P = PLATFORM[kind];
  const all = snap?.nodes.flatMap((n) => n.tasks) ?? [];
  const running = all.filter((t) => t.status === "RUNNING").length;
  const services = [...new Set(all.map((t) => t.service))].sort();

  async function kill(t: InfraTask) {
    if (!confirm(`Stop ${t.service} ${P.unit.toLowerCase()} ${t.id.slice(0, 8)}? The orchestrator should replace it automatically.`)) return;
    try {
      await api(`/admin/infra/tasks/${t.id}/stop`, { method: "POST" });
      setToast(`Stopped ${t.service} ${t.id.slice(0, 8)}. Watching for the replacement.`);
      setTimeout(() => setToast(""), 6000);
      load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to stop");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar items={DISPATCH_NAV} />

      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-k-line bg-k-side px-5 py-3">
        <div>
          <div className="k-label">{P.name}{snap?.cluster ? ` · ${snap.cluster}` : ""}</div>
          <h1 className="mt-0.5 text-base font-semibold text-k-hi">Container cluster</h1>
        </div>
        <div className="flex items-center divide-x divide-k-line">
          {[[snap?.nodes.length ?? "–", P.nodes], [running, `${P.units} running`], [services.length, "Services"]].map(([v, l]) => (
            <div key={String(l)} className="px-4 text-right">
              <div className="font-mono text-xl text-k-hi">{v}</div>
              <div className="k-label">{l}</div>
            </div>
          ))}
          <div className="pl-4">
            <Button size="sm" variant="secondary" onClick={() => setPaused(!paused)}>
              {paused ? <><Play className="h-3 w-3" /> Resume</> : <><Pause className="h-3 w-3" /> Pause</>}
            </Button>
          </div>
        </div>
      </div>

      {snap && snap.services.length > 0 && (
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
        <main className="flex-1">
          {snap?.error && <div className="mb-4 rounded border border-k-err/40 bg-k-err/10 px-3 py-2 text-xs text-k-hi">Platform API error: {snap.error}</div>}
          {!snap ? (
            <div className="grid h-64 place-items-center text-k-label"><Spinner className="h-5 w-5" /></div>
          ) : kind === "none" ? (
            <div className="rounded border border-dashed border-k-line p-10 text-center">
              <div className="text-sm font-medium text-k-hi">Running under Docker Compose</div>
              <p className="mx-auto mt-1 max-w-md text-xs text-k-label">The live cluster view appears when DispatchX runs on Amazon ECS (AWS) or Kubernetes (<code className="font-mono">k8s/</code>).</p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {snap.nodes.map((n) => <NodePanel key={n.id} n={n} kind={kind} selected={current?.id ?? null} onSelect={setSelected} />)}
            </div>
          )}
        </main>

        <aside className="w-full shrink-0 space-y-4 xl:w-[340px]">
          {current && (
            <section className="k-panel">
              <header className="flex items-center justify-between border-b border-k-line px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-[1px]" style={{ background: colorFor(current.service) }} />
                  <span className="text-sm font-semibold text-k-hi">{current.service}</span>
                  <span className="k-label">{P.unit}</span>
                </div>
                <button onClick={() => setSelected(null)} className="rounded p-1 text-k-label hover:bg-k-panel hover:text-k-hi"><X className="h-3.5 w-3.5" /></button>
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
                  <Button variant="danger" className="w-full" onClick={() => kill(current)}>
                    <Skull className="h-3.5 w-3.5" /> Chaos test: stop this {P.unit.toLowerCase()}
                  </Button>
                  <p className="mt-2 text-2xs text-k-label">The scheduler replaces it to restore the desired count; traffic shifts to healthy targets meanwhile.</p>
                </div>
              )}
            </section>
          )}

          <section className="k-panel">
            <header className="border-b border-k-line px-3 py-2 k-label">Scheduler events</header>
            <ul className="max-h-[30rem] divide-y divide-k-line/50 overflow-y-auto k-scroll">
              {(snap?.events ?? []).map((e, i) => (
                <li key={i} className="px-3 py-2">
                  <div className="font-mono text-2xs text-k-label">{e.at ? new Date(e.at).toLocaleTimeString([], { hour12: false }) : ""}</div>
                  <div className="text-xs text-k-text">{e.message}</div>
                </li>
              ))}
              {snap && snap.events.length === 0 && <li className="px-3 py-3 text-xs text-k-label">No recent events</li>}
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
