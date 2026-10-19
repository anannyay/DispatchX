"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { api } from "@/lib/api";
import type { InfraNode, InfraSnapshot, InfraTask } from "@/lib/types";

const SERVICE_COLORS: Record<string, string> = {
  api: "#818cf8",
  web: "#34d399",
  worker: "#fbbf24",
  beat: "#94a3b8",
  consumer: "#22d3ee",
  monitoring: "#f472b6",
  mysql: "#fb923c",
  redis: "#f87171",
};
const colorFor = (s: string) => SERVICE_COLORS[s] ?? "#a78bfa";

const PLATFORM_LABEL = {
  ecs: { name: "Amazon ECS on EC2", node: "EC2 instance", task: "task", icon: "🟧" },
  kubernetes: { name: "Kubernetes", node: "node", task: "pod", icon: "☸️" },
  none: { name: "Local", node: "host", task: "container", icon: "🐳" },
} as const;

function age(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function Bar({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const color = pct > 85 ? "bg-rose-500" : pct > 65 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div>
      <div className="flex justify-between text-[11px] text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums">{used}/{total} {unit} · {pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TaskChip({ t, onClick, selected }: { t: InfraTask; onClick: () => void; selected: boolean }) {
  const dying = t.status === "STOPPED" || t.status === "STOPPING" || t.status === "DEACTIVATING" || t.desired === "STOPPED";
  const starting = !dying && t.status !== "RUNNING";
  const fresh = !dying && t.started_at && Date.now() - new Date(t.started_at).getTime() < 60_000;
  const c = colorFor(t.service);
  return (
    <button
      onClick={onClick}
      title={`${t.service} · ${t.status} · ${t.id}`}
      className={`group relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ring-1 transition-all duration-500
        ${dying ? "bg-rose-950/60 opacity-60 ring-rose-500/60" : "bg-white/[0.04] ring-white/10 hover:bg-white/[0.08]"}
        ${selected ? "ring-2 ring-white" : ""} ${fresh ? "animate-[fadeIn_.4s_ease-out]" : ""}`}
      style={{ borderLeft: `3px solid ${dying ? "#f43f5e" : c}` }}
    >
      {fresh && <span className="absolute -right-1 -top-1 rounded bg-emerald-500 px-1 text-[9px] font-bold text-white">NEW</span>}
      <span className={`h-2 w-2 shrink-0 rounded-full ${dying ? "bg-rose-500" : starting ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`} />
      <span className="min-w-0">
        <span className="block font-semibold text-slate-100">{t.service}</span>
        <span className="block font-mono text-[10px] text-slate-500">
          {t.id.slice(0, 8)} · {dying ? t.status.toLowerCase() : starting ? t.status.toLowerCase() : age(t.started_at)}
        </span>
      </span>
    </button>
  );
}

function NodeCard({ n, kind, selected, onSelect }: {
  n: InfraNode; kind: InfraSnapshot["platform"]; selected: string | null; onSelect: (t: InfraTask) => void;
}) {
  const unitCpu = kind === "kubernetes" ? "m" : "units";
  const fresh = n.started_at && Date.now() - new Date(n.started_at).getTime() < 180_000;
  return (
    <div className={`rounded-2xl bg-ink-800 p-4 ring-1 transition-all duration-700 ${fresh ? "ring-emerald-500/60 shadow-[0_0_30px_-8px_rgba(16,185,129,.6)]" : "ring-white/10"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">{kind === "kubernetes" ? "☸️" : "🖥️"}</span>
            <span className="truncate font-mono text-sm font-semibold text-white">{n.name ?? n.id.slice(0, 12)}</span>
            {fresh && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">SCALED OUT</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            {n.zone && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300">{n.zone}</span>}
            {n.instance_type && <span className="rounded bg-white/10 px-1.5 py-0.5 text-slate-300">{n.instance_type}</span>}
            <span className={`rounded px-1.5 py-0.5 ${n.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>{n.status.toLowerCase()}</span>
            <span className="text-slate-500">up {age(n.started_at)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums text-white">{n.tasks.filter((t) => t.status === "RUNNING").length}</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{kind === "kubernetes" ? "pods" : "tasks"}</div>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <Bar label="CPU reserved" used={n.cpu_used} total={n.cpu_total} unit={unitCpu} />
        <Bar label="Memory reserved" used={n.mem_used} total={n.mem_total} unit="MiB" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {n.tasks
          .slice()
          .sort((a, b) => a.service.localeCompare(b.service))
          .map((t) => <TaskChip key={t.id} t={t} selected={selected === t.id} onClick={() => onSelect(t)} />)}
        {n.tasks.length === 0 && <div className="col-span-full rounded-lg border border-dashed border-white/10 p-3 text-center text-xs text-slate-500">No containers yet</div>}
      </div>
    </div>
  );
}

function ClusterView() {
  const [snap, setSnap] = useState<InfraSnapshot | null>(null);
  const [selected, setSelected] = useState<InfraTask | null>(null);
  const [toast, setToast] = useState("");
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnap(await api<InfraSnapshot>("/admin/infra"));
    } catch {
      /* keep last snapshot */
    }
  }, []);

  useEffect(() => {
    load();
    if (paused) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, paused]);

  // keep the detail panel in sync with the latest snapshot
  const current = selected && snap ? snap.nodes.flatMap((n) => n.tasks).find((t) => t.id === selected.id) ?? selected : null;

  async function kill(t: InfraTask) {
    if (!confirm(`Chaos test: stop ${t.service} ${snap?.platform === "kubernetes" ? "pod" : "task"} ${t.id.slice(0, 8)}?\nThe orchestrator should replace it automatically.`)) return;
    try {
      await api(`/admin/infra/tasks/${t.id}/stop`, { method: "POST" });
      setToast(`Stopped ${t.service} ${t.id.slice(0, 8)}. Watch the replacement start…`);
      setTimeout(() => setToast(""), 6000);
      load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to stop");
    }
  }

  const kind = snap?.platform ?? "none";
  const label = PLATFORM_LABEL[kind];
  const allTasks = snap?.nodes.flatMap((n) => n.tasks) ?? [];
  const running = allTasks.filter((t) => t.status === "RUNNING").length;
  const services = [...new Set(allTasks.map((t) => t.service))];

  return (
    <div className="flex min-h-screen flex-col bg-ink-900 text-slate-200">
      <Navbar dark>
        <nav className="hidden items-center gap-1 text-xs font-medium md:flex">
          <Link href="/dispatch" className="rounded-md px-2.5 py-1.5 text-slate-400 hover:bg-white/5 hover:text-white">Control room</Link>
          <span className="rounded-md bg-white/10 px-2.5 py-1.5 text-white">Cluster view</span>
          <a href="/grafana/" target="_blank" rel="noreferrer" className="rounded-md px-2.5 py-1.5 text-slate-400 hover:bg-white/5 hover:text-white">Grafana ↗</a>
        </nav>
      </Navbar>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 px-6 py-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <span>{label.icon}</span> {label.name}
            {snap?.cluster && <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono normal-case tracking-normal text-slate-400">{snap.cluster}</span>}
          </div>
          <h1 className="mt-1 text-2xl font-bold text-white">Live container cluster</h1>
          <p className="text-sm text-slate-400">
            Every box is a real {label.node}; every chip is a running Docker container group ({label.task}). Click one to run a chaos test.
          </p>
        </div>
        <div className="flex items-center gap-6">
          {[
            [snap?.nodes.length ?? "–", label.node + "s"],
            [running, kind === "kubernetes" ? "pods running" : "tasks running"],
            [services.length, "services"],
          ].map(([v, l]) => (
            <div key={String(l)} className="text-right">
              <div className="text-3xl font-bold tabular-nums text-white">{v}</div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500">{l}</div>
            </div>
          ))}
          <button onClick={() => setPaused(!paused)} className="rounded-lg bg-white/5 px-3 py-2 text-xs font-semibold ring-1 ring-white/10 hover:bg-white/10">
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </div>

      {snap?.services && snap.services.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-white/5 px-6 py-3">
          {snap.services.map((s) => {
            const ok = s.running >= s.desired && s.pending === 0;
            return (
              <div key={s.name} className="flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-2 pr-3 text-xs ring-1 ring-white/10">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorFor(s.name) }} />
                <span className="font-semibold text-slate-100">{s.name}</span>
                <span className={`tabular-nums ${ok ? "text-emerald-400" : "text-amber-400"}`}>{s.running}/{s.desired}</span>
                {s.pending > 0 && <span className="animate-pulse text-amber-400">+{s.pending} starting</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 xl:flex-row">
        <main className="flex-1">
          {snap?.error && <div className="mb-4 rounded-xl bg-rose-950/50 p-4 text-sm text-rose-300 ring-1 ring-rose-500/30">Platform API error: {snap.error}</div>}
          {!snap ? (
            <div className="grid h-64 place-items-center text-slate-500">Loading cluster…</div>
          ) : kind === "none" ? (
            <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center">
              <div className="text-4xl">🐳</div>
              <div className="mt-3 font-semibold text-white">Running under Docker Compose</div>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
                The live cluster view appears when DispatchX runs on Amazon ECS (AWS deployment) or Kubernetes (<code>k8s/</code>).
              </p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {snap.nodes.map((n) => (
                <NodeCard key={n.id} n={n} kind={kind} selected={current?.id ?? null} onSelect={setSelected} />
              ))}
            </div>
          )}
        </main>

        <aside className="w-full shrink-0 space-y-4 xl:w-96">
          {current && (
            <div className="rounded-2xl bg-ink-800 p-4 ring-1 ring-white/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: colorFor(current.service) }} />
                  <span className="font-semibold text-white">{current.service}</span>
                </div>
                <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-white">✕</button>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-y-1.5 text-xs">
                <dt className="text-slate-500">ID</dt><dd className="col-span-2 truncate font-mono text-slate-300">{current.id}</dd>
                <dt className="text-slate-500">Status</dt><dd className="col-span-2 text-slate-300">{current.status.toLowerCase()} (desired {current.desired.toLowerCase()})</dd>
                <dt className="text-slate-500">Health</dt><dd className="col-span-2 text-slate-300">{current.health.toLowerCase()}</dd>
                <dt className="text-slate-500">Containers</dt><dd className="col-span-2 text-slate-300">{current.containers.join(", ")}</dd>
                <dt className="text-slate-500">Reserved</dt><dd className="col-span-2 text-slate-300">{current.cpu} CPU · {current.memory} MiB</dd>
                <dt className="text-slate-500">Uptime</dt><dd className="col-span-2 text-slate-300">{age(current.started_at)}</dd>
                {current.stopped_reason && (<><dt className="text-slate-500">Stopped</dt><dd className="col-span-2 text-rose-300">{current.stopped_reason}</dd></>)}
              </dl>
              {current.status === "RUNNING" && current.desired !== "STOPPED" && (
                <button onClick={() => kill(current)} className="mt-4 w-full rounded-xl bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700">
                  💥 Kill this {kind === "kubernetes" ? "pod" : "container"} (chaos test)
                </button>
              )}
            </div>
          )}

          <div className="rounded-2xl bg-ink-800 p-4 ring-1 ring-white/10">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Scheduler events</div>
            <ul className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-xs scrollbar-thin">
              {(snap?.events ?? []).map((e, i) => (
                <li key={i} className="border-l-2 border-white/10 pl-2">
                  <div className="text-[10px] text-slate-500">{e.at ? new Date(e.at).toLocaleTimeString() : ""}</div>
                  <div className="text-slate-300">{e.message}</div>
                </li>
              ))}
              {snap && snap.events.length === 0 && <li className="text-slate-500">No recent events</li>}
            </ul>
          </div>

          <div className="rounded-2xl bg-ink-800 p-4 text-xs ring-1 ring-white/10">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Legend</div>
            <div className="grid grid-cols-2 gap-1.5">
              {services.map((s) => (
                <div key={s} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: colorFor(s) }} />{s}</div>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-slate-400">
              <div><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-400" />running · <span className="mx-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />starting · <span className="mx-1.5 inline-block h-2 w-2 rounded-full bg-rose-500" />stopping</div>
            </div>
          </div>
        </aside>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[2000] -translate-x-1/2 rounded-xl bg-white px-4 py-3 text-sm font-medium text-slate-900 shadow-xl">{toast}</div>
      )}
    </div>
  );
}

export default function Page() {
  return <RequireRole roles={["dispatcher", "admin"]}><ClusterView /></RequireRole>;
}
