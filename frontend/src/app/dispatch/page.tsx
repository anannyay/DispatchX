"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertTriangle, ExternalLink, RotateCcw, UserCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Button, KV, Metric, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { haversineKm, inr, parseUtc, timeAgo } from "@/lib/format";
import { DISPATCH_NAV } from "@/lib/nav";
import { useSocketEvent } from "@/lib/socket";
import type { FleetRider, Order, RiderLocation, Stats } from "@/lib/types";

// kepler.gl is WebGL + window-bound: load it in the browser only
const OpsMap = dynamic(() => import("@/components/kepler/OpsMap"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-k-label">Loading map engine…</div>,
});

type Tab = "attention" | "waiting" | "active" | "recent";
interface LogLine { at: number; msg: string; level?: "info" | "warning" | "critical"; order_id?: number }
const ACTIVE = new Set(["assigned", "picked_up"]);

function ControlRoom() {
  const [riders, setRiders] = useState<Record<number, FleetRider>>({});
  const [orders, setOrders] = useState<Record<number, Order>>({});
  const [ready, setReady] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [alerts, setAlerts] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<Tab>("attention");
  const [selected, setSelected] = useState<number | null>(null);
  const pending = useRef<Record<number, RiderLocation>>({});

  const loadFleet = useCallback(async () => {
    const list = await api<FleetRider[]>("/admin/fleet");
    setRiders(Object.fromEntries(list.map((r) => [r.rider_id, r])));
  }, []);
  const loadOrders = useCallback(async () => {
    const list = await api<Order[]>("/orders?limit=200");
    setOrders(Object.fromEntries(list.map((o) => [o.id, o])));
  }, []);
  const loadStats = useCallback(() => api<Stats>("/admin/stats").then(setStats).catch(() => {}), []);

  useEffect(() => {
    Promise.allSettled([loadFleet(), loadOrders()]).then(() => setReady(true));
    loadStats();
    const s = setInterval(loadStats, 4000);
    const f = setInterval(() => loadFleet().catch(() => {}), 20000);
    return () => { clearInterval(s); clearInterval(f); };
  }, [loadFleet, loadOrders, loadStats]);

  // GPS pings can arrive hundreds of times a second: buffer and apply once a second
  useSocketEvent<RiderLocation>("fleet:location", useCallback((l: RiderLocation) => { pending.current[l.rider_id] = l; }, []));
  useEffect(() => {
    const t = setInterval(() => {
      const batch = pending.current;
      if (!Object.keys(batch).length) return;
      pending.current = {};
      setRiders((prev) => {
        const next = { ...prev };
        for (const l of Object.values(batch)) next[l.rider_id] = { ...next[l.rider_id], ...l, last_seen_s: 0 };
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useSocketEvent<{ rider_id: number; online: boolean; name?: string; lat?: number; lng?: number }>("fleet:rider", useCallback((d) => {
    setRiders((prev) => {
      const next = { ...prev };
      if (!d.online) delete next[d.rider_id];
      else if (d.lat !== undefined && d.lng !== undefined)
        next[d.rider_id] = { ...next[d.rider_id], rider_id: d.rider_id, name: d.name, lat: d.lat, lng: d.lng, heading: 0, order_id: null, available: true };
      return next;
    });
  }, []));

  const pushLog = useCallback((l: LogLine) => setLog((prev) => [l, ...prev].slice(0, 120)), []);
  useSocketEvent<Order>("order:update", useCallback((o: Order) => {
    setOrders((prev) => ({ ...prev, [o.id]: o }));
    pushLog({ at: Date.now(), msg: `#${o.id} ${o.status.replace("_", " ")}${o.rider_name ? ` · ${o.rider_name}` : ""}`, order_id: o.id });
  }, [pushLog]));
  useSocketEvent<LogLine>("dispatch:log", useCallback((l: LogLine) => pushLog({ ...l, at: Date.now() }), [pushLog]));
  useSocketEvent<LogLine>("dispatch:alert", useCallback((l: LogLine) => {
    const line = { ...l, at: Date.now() };
    setAlerts((prev) => [line, ...prev].slice(0, 20));
    pushLog(line);
  }, [pushLog]));

  const orderList = useMemo(() => Object.values(orders).sort((a, b) => b.id - a.id), [orders]);
  const riderList = useMemo(() => Object.values(riders).filter((r) => typeof r.lat === "number"), [riders]);
  const tabs: Record<Tab, Order[]> = useMemo(() => ({
    attention: orderList.filter((o) => o.status === "unassigned" || (o.status === "pending" && Date.now() - parseUtc(o.created_at).getTime() > 60_000)),
    waiting: orderList.filter((o) => o.status === "pending"),
    active: orderList.filter((o) => ACTIVE.has(o.status)),
    recent: orderList.filter((o) => o.status === "delivered" || o.status === "cancelled").slice(0, 60),
  }), [orderList]);
  const sel = selected ? orders[selected] : null;

  const nearestAvailable = useCallback((o: Order) => {
    let best: FleetRider | null = null;
    let bestD = Infinity;
    for (const r of riderList) {
      if (r.order_id || r.offer) continue;
      const d = haversineKm([r.lat, r.lng], [o.pickup_lat, o.pickup_lng]);
      if (d < bestD) { best = r; bestD = d; }
    }
    return best ? { rider: best, km: bestD } : null;
  }, [riderList]);

  async function action(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); pushLog({ at: Date.now(), msg: ok }); }
    catch (e) { pushLog({ at: Date.now(), msg: e instanceof Error ? e.message : "Action failed", level: "warning" }); }
  }

  const s = stats;
  const bs = s?.orders_by_status ?? {};
  const waiting = (bs.pending ?? 0) + (bs.unassigned ?? 0);
  const nearest = sel && (sel.status === "unassigned" || sel.status === "pending") ? nearestAvailable(sel) : null;

  return (
    <div className="flex h-screen flex-col">
      <Navbar items={DISPATCH_NAV} />

      <div className="flex shrink-0 divide-x divide-k-line overflow-x-auto border-b border-k-line bg-k-side">
        <Metric label="Riders online" value={s?.riders_online ?? "–"} />
        <Metric label="Available" value={s?.riders_available ?? "–"} tone="good" />
        <Metric label="Waiting" value={waiting} tone={(bs.unassigned ?? 0) > 0 ? "bad" : waiting > 5 ? "warn" : "default"} />
        <Metric label="In progress" value={(bs.assigned ?? 0) + (bs.picked_up ?? 0)} />
        <Metric label="Assign time" value={s?.avg_assign_seconds != null ? `${s.avg_assign_seconds}s` : "–"} sub={s?.p95_assign_seconds != null ? `p95 ${s.p95_assign_seconds}s` : "avg"} />
        <Metric label="Delivered / h" value={s?.delivered_last_hour ?? "–"} sub={s?.avg_delivery_minutes ? `avg ${s.avg_delivery_minutes} min` : undefined} />
        <Metric label="Revenue 24h" value={s ? inr(s.revenue_24h) : "–"} />
        <Metric label="SLA breaches" value={s?.sla_breaches_active ?? 0} tone={(s?.sla_breaches_active ?? 0) > 0 ? "bad" : "default"} />
        <Metric label="Offers" value={s ? `${s.offers.accepted}/${s.offers.sent}` : "–"} sub={s ? `${s.offers.rejected} declined · ${s.offers.expired} expired` : undefined} />
      </div>

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 bg-[#0e1116]">
          {ready && <OpsMap riders={riderList} orders={orderList} onSelectOrder={setSelected} />}
        </main>

        <aside className="flex w-[380px] shrink-0 flex-col border-l border-k-line bg-k-side">
          {alerts.length > 0 && (
            <div className="max-h-28 shrink-0 space-y-1 overflow-y-auto border-b border-k-line px-3 py-2 k-scroll">
              {alerts.slice(0, 5).map((a, i) => (
                <button key={i} onClick={() => a.order_id && setSelected(a.order_id)} className="flex w-full items-start gap-2 text-left text-xs">
                  <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${a.level === "critical" ? "text-k-err" : "text-k-warn"}`} />
                  <span className="text-k-hi">{a.msg}</span>
                  <span className="ml-auto shrink-0 font-mono text-2xs text-k-label">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </button>
              ))}
            </div>
          )}

          {sel && (
            <div className="shrink-0 border-b border-k-line px-3 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-k-hi">#{sel.id}</span>
                  <StatusBadge status={sel.status} />
                </div>
                <button onClick={() => setSelected(null)} className="rounded p-1 text-k-label hover:bg-k-panel hover:text-k-hi"><X className="h-3.5 w-3.5" /></button>
              </div>
              <dl className="mt-2 divide-y divide-k-line/60">
                <KV k="Pickup" v={sel.pickup_address} />
                <KV k="Drop" v={sel.drop_address} />
                <KV k="Customer" v={sel.customer_name} />
                <KV k="Rider" v={sel.rider_name ?? "–"} />
                <KV k="Fare · distance" v={`${inr(sel.price)} · ${sel.distance_km} km`} mono />
                <KV k="Placed · attempts" v={`${timeAgo(sel.created_at)} · ${sel.dispatch_attempts}`} mono />
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                {nearest && (
                  <Button size="sm" onClick={() => action(() => api(`/admin/orders/${sel.id}/assign`, { method: "POST", body: { rider_id: nearest.rider.rider_id } }), `#${sel.id} assigned to ${nearest.rider.name}`)}>
                    <UserCheck className="h-3.5 w-3.5" /> Assign {nearest.rider.name} · {nearest.km.toFixed(1)} km
                  </Button>
                )}
                {(sel.status === "unassigned" || sel.status === "pending" || sel.status === "assigned") && (
                  <Button size="sm" variant="secondary" onClick={() => action(() => api(`/admin/orders/${sel.id}/redispatch`, { method: "POST" }), `#${sel.id} returned to auto-dispatch`)}>
                    <RotateCcw className="h-3.5 w-3.5" /> Re-dispatch
                  </Button>
                )}
                {sel.status !== "delivered" && sel.status !== "cancelled" && sel.status !== "picked_up" && (
                  <Button size="sm" variant="ghost" className="text-k-err" onClick={() => action(() => api(`/orders/${sel.id}/cancel`, { method: "POST" }), `#${sel.id} cancelled`)}>Cancel</Button>
                )}
                <Link href={`/customer/orders/${sel.id}`} className="ml-auto inline-flex items-center gap-1 text-xs text-k-label hover:text-k-hi">
                  Tracking <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          )}

          <div className="flex shrink-0 border-b border-k-line px-1">
            {(["attention", "waiting", "active", "recent"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex h-9 flex-1 items-center justify-center gap-1.5 border-b-2 text-xs font-medium capitalize ${tab === t ? "border-k-accent text-k-hi" : "border-transparent text-k-label hover:text-k-text"}`}>
                {t}
                <span className={`font-mono text-2xs ${t === "attention" && tabs[t].length ? "text-k-err" : "text-k-label"}`}>{tabs[t].length}</span>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto k-scroll">
            {tabs[tab].length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-k-label">{tab === "attention" ? "Nothing needs attention." : "No orders."}</div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {tabs[tab].map((o) => (
                    <tr key={o.id} onClick={() => setSelected(o.id)}
                      className={`cursor-pointer border-b border-k-line/50 hover:bg-k-panel ${selected === o.id ? "bg-k-panel" : ""}`}>
                      <td className="py-2 pl-3 font-mono text-k-text">#{o.id}</td>
                      <td className="max-w-[140px] truncate py-2 text-k-hi">{o.pickup_address}</td>
                      <td className="py-2 text-right font-mono text-k-label">{timeAgo(o.created_at)}</td>
                      <td className="py-2 pl-3 pr-3 text-right"><StatusBadge status={o.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="h-44 shrink-0 border-t border-k-line">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="k-label">Dispatch log</span>
              <span className="font-mono text-2xs text-k-label">{riderList.length} riders tracked</span>
            </div>
            <ul className="h-[calc(100%-28px)] overflow-y-auto px-3 pb-2 font-mono text-2xs leading-5 k-scroll">
              {log.map((l, i) => (
                <li key={i} className={`truncate ${l.level === "critical" ? "text-k-err" : l.level === "warning" ? "text-k-warn" : "text-k-text"}`}>
                  <span className="text-k-label">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span> {l.msg}
                </li>
              ))}
              {log.length === 0 && <li className="text-k-label">Waiting for activity. Start the simulator to see live dispatch.</li>}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function Page() {
  return <RequireRole roles={["dispatcher", "admin"]}><ControlRoom /></RequireRole>;
}
