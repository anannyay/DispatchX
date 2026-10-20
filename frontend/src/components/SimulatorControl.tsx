"use client";

import { Activity, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

interface SimParams { riders: number; orders_per_min: number; accept_rate: number; duration_s: number }
interface SimStatus {
  state: "idle" | "starting" | "running" | "stopping" | "finished";
  params?: SimParams;
  stats?: { riders_online: number; rider_errors: number; orders_placed: number; order_errors: number; offers: number; accepted: number; delivered: number };
  ends_at?: number;
  started_by?: string;
}

const PRESETS: { name: string; hint: string; p: SimParams }[] = [
  { name: "Calm", hint: "Easy to follow one order at a time", p: { riders: 20, orders_per_min: 4, accept_rate: 0.9, duration_s: 300 } },
  { name: "Busy", hint: "A lively city, riders mostly keep up", p: { riders: 60, orders_per_min: 10, accept_rate: 0.85, duration_s: 300 } },
  { name: "Overload", hint: "More orders than riders: queue builds up", p: { riders: 40, orders_per_min: 30, accept_rate: 0.7, duration_s: 300 } },
];
const LIVE = new Set(["starting", "running", "stopping"]);

function clock(s: number) {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

export default function SimulatorControl() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SimStatus>({ state: "idle" });
  const [p, setP] = useState<SimParams>(PRESETS[1].p);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const refresh = useCallback(async () => {
    try { setStatus(await api<SimStatus>("/admin/simulator")); } catch { /* keep last status */ }
  }, []);
  const live = LIVE.has(status.state);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, live || open ? 2000 : 10000);
    return () => clearInterval(t);
  }, [refresh, live, open]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [live]);

  async function run(fn: () => Promise<SimStatus>) {
    setBusy(true); setError(null);
    try { setStatus(await fn()); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const start = () => run(() => api<SimStatus>("/admin/simulator/start", { method: "POST", body: p }));
  const stop = () => run(() => api<SimStatus>("/admin/simulator/stop", { method: "POST" }));

  const st = status.stats;
  const left = status.ends_at ? status.ends_at - now : 0;
  const num = (k: keyof SimParams, min: number, max: number, step = 1) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP((v) => ({ ...v, [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) * (step === 60 ? 60 : 1) }));

  return (
    <div className="relative flex shrink-0 border-t border-k-line sm:border-l sm:border-t-0">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center justify-center gap-2 px-4 py-2.5 text-xs text-k-text hover:bg-k-panel hover:text-k-hi focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-k-accent">
        {live ? <span className="h-2 w-2 animate-pulse rounded-full bg-k-ok" /> : <Activity size={14} />}
        {status.state === "stopping" ? "Stopping traffic…" : live ? `Simulating · ${clock(left)}` : "Simulate traffic"}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-px w-[min(340px,100vw)] border border-k-line bg-k-side p-3 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="k-label">Traffic simulator</h3>
            <button onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-k-label hover:bg-k-panel hover:text-k-hi"><X className="h-3.5 w-3.5" /></button>
          </div>

          {live ? (
            <div className="space-y-3">
              <p className="text-xs text-k-text">
                {status.params?.riders} virtual riders, ~{status.params?.orders_per_min} orders/min. Runs inside the backend API service and goes through the real API, so everything on the map is live dispatch.
              </p>
              <dl className="grid grid-cols-3 gap-px overflow-hidden rounded border border-k-line bg-k-line text-center">
                {([["Riders", st?.riders_online], ["Orders", st?.orders_placed], ["Delivered", st?.delivered],
                  ["Offers", st?.offers], ["Accepted", st?.accepted], ["Time left", clock(left)]] as [string, React.ReactNode][]).map(([k, v]) => (
                  <div key={k} className="bg-k-side px-2 py-1.5">
                    <dt className="text-2xs text-k-label">{k}</dt>
                    <dd className="font-mono text-sm tabular-nums text-k-hi">{v ?? 0}</dd>
                  </div>
                ))}
              </dl>
              {(st?.rider_errors || st?.order_errors) ? (
                <p className="text-2xs text-k-warn">{st.rider_errors} riders failed to log in · {st.order_errors} order errors</p>
              ) : null}
              <Button variant="danger" size="sm" className="w-full" disabled={busy || status.state === "stopping"} onClick={stop}>
                {busy || status.state === "stopping" ? <Spinner className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                {status.state === "stopping" ? "Finishing open deliveries…" : "Stop simulation"}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-1.5">
                {PRESETS.map((x) => {
                  const on = x.p.riders === p.riders && x.p.orders_per_min === p.orders_per_min && x.p.accept_rate === p.accept_rate;
                  return (
                    <button key={x.name} onClick={() => setP({ ...x.p, duration_s: p.duration_s })} title={x.hint}
                      className={`rounded border px-2 py-1.5 text-xs font-medium ${on ? "border-k-accent text-k-hi" : "border-k-line text-k-text hover:bg-k-panel"}`}>
                      {x.name}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block"><span className="k-label mb-1 block">Riders</span>
                  <input type="number" min={1} max={100} value={p.riders} onChange={num("riders", 1, 100)} className="k-input w-full" /></label>
                <label className="block"><span className="k-label mb-1 block">Orders / min</span>
                  <input type="number" min={0} max={30} value={p.orders_per_min} onChange={num("orders_per_min", 0, 30)} className="k-input w-full" /></label>
                <label className="block"><span className="k-label mb-1 block">Accept rate %</span>
                  <input type="number" min={0} max={100} value={Math.round(p.accept_rate * 100)}
                    onChange={(e) => setP((v) => ({ ...v, accept_rate: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 }))} className="k-input w-full" /></label>
                <label className="block"><span className="k-label mb-1 block">Minutes</span>
                  <input type="number" min={1} max={15} value={p.duration_s / 60} onChange={num("duration_s", 1, 15, 60)} className="k-input w-full" /></label>
              </div>
              {status.state === "finished" && st && (
                <p className="text-2xs text-k-label">Last run: {st.orders_placed} orders, {st.delivered} delivered{status.started_by ? ` · by ${status.started_by}` : ""}</p>
              )}
              {error && <p className="text-2xs text-k-err">{error}</p>}
              <Button size="sm" className="w-full" disabled={busy} onClick={start}>
                {busy ? <Spinner className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} Start simulation
              </Button>
              <p className="text-2xs leading-relaxed text-k-label">Stops on its own after the chosen minutes. Stopping finishes any delivery in progress and takes the riders offline.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
