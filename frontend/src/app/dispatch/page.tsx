"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Stat, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { CITY_CENTER, haversineKm, inr, parseUtc, timeAgo } from "@/lib/format";
import { useSocketEvent } from "@/lib/socket";
import type { FleetRider, Order, RiderLocation, Stats } from "@/lib/types";

type Tab = "attention" | "pending" | "active" | "recent";
interface LogLine { at: number; msg: string; level?: "info" | "warning" | "critical"; order_id?: number }

const ACTIVE = new Set(["assigned", "picked_up"]);

function ControlRoom() {
  const [riders, setRiders] = useState<Record<number, FleetRider>>({});
  const [orders, setOrders] = useState<Record<number, Order>>({});
  const [stats, setStats] = useState<Stats | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [alerts, setAlerts] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<Tab>("attention");
  const [selected, setSelected] = useState<number | null>(null);
  const [showAvailableOnly, setShowAvailableOnly] = useState(false);
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
    loadFleet().catch(() => {});
    loadOrders().catch(() => {});
    loadStats();
    const s = setInterval(loadStats, 4000);
    const f = setInterval(() => loadFleet().catch(() => {}), 20000);
    return () => { clearInterval(s); clearInterval(f); };
  }, [loadFleet, loadOrders, loadStats]);

  // GPS pings arrive at up to hundreds/sec: buffer them and repaint once a second
  useSocketEvent<RiderLocation>("fleet:location", useCallback((l: RiderLocation) => { pending.current[l.rider_id] = l; }, []));
  useEffect(() => {
    const t = setInterval(() => {
      const batch = pending.current;
      if (Object.keys(batch).length === 0) return;
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
      else if (d.lat !== undefined && d.lng !== undefined) next[d.rider_id] = { ...next[d.rider_id], rider_id: d.rider_id, name: d.name, lat: d.lat, lng: d.lng, heading: 0, order_id: null, available: true };
      return next;
    });
  }, []));

  const pushLog = useCallback((l: LogLine) => setLog((prev) => [l, ...prev].slice(0, 80)), []);

  useSocketEvent<Order>("order:update", useCallback((o: Order) => {
    setOrders((prev) => ({ ...prev, [o.id]: o }));
    pushLog({ at: Date.now(), msg: `Order #${o.id} → ${o.status.replace("_", " ")}${o.rider_name ? ` (${o.rider_name})` : ""}`, order_id: o.id });
  }, [pushLog]));
  useSocketEvent<LogLine>("dispatch:log", useCallback((l: LogLine) => pushLog({ ...l, at: Date.now() }), [pushLog]));
  useSocketEvent<LogLine>("dispatch:alert", useCallback((l: LogLine) => {
    const line = { ...l, at: Date.now() };
    setAlerts((prev) => [line, ...prev].slice(0, 20));
    pushLog(line);
  }, [pushLog]));

  const orderList = useMemo(() => Object.values(orders).sort((a, b) => b.id - a.id), [orders]);
  const riderList = useMemo(() => Object.values(riders), [riders]);
  const tabs: Record<Tab, Order[]> = useMemo(() => ({
    attention: orderList.filter((o) => o.status === "unassigned" || (o.status === "pending" && Date.now() - parseUtc(o.created_at).getTime() > 60_000)),
    pending: orderList.filter((o) => o.status === "pending"),
    active: orderList.filter((o) => ACTIVE.has(o.status)),
    recent: orderList.filter((o) => o.status === "delivered" || o.status === "cancelled").slice(0, 50),
  }), [orderList]);

  const sel = selected ? orders[selected] : null;

  const markers = useMemo(() => {
    const m: MapMarker[] = [];
    for (const r of riderList) {
      if (showAvailableOnly && r.order_id) continue;
      m.push({
        id: `r${r.rider_id}`, lat: r.lat, lng: r.lng, heading: r.heading,
        kind: r.order_id ? "rider-busy" : r.offer ? "rider-offer" : "rider",
        label: `${r.name ?? "Rider"} #${r.rider_id}${r.order_id ? ` · order #${r.order_id}` : " · available"}`,
        highlight: !!sel && sel.rider_id === r.rider_id,
        onClick: r.order_id ? () => setSelected(r.order_id) : undefined,
      });
    }
    for (const o of orderList) {
      if (o.status === "pending" || o.status === "unassigned") {
        m.push({ id: `o${o.id}`, kind: "order", lat: o.pickup_lat, lng: o.pickup_lng, highlight: o.status === "unassigned", label: `Order #${o.id} waiting`, onClick: () => setSelected(o.id) });
      }
    }
    if (sel) {
      m.push({ id: "sp", kind: "pickup", lat: sel.pickup_lat, lng: sel.pickup_lng, label: sel.pickup_address });
      m.push({ id: "sd", kind: "drop", lat: sel.drop_lat, lng: sel.drop_lng, label: sel.drop_address });
    }
    return m;
  }, [riderList, orderList, sel, showAvailableOnly]);

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
    try { await fn(); pushLog({ at: Date.now(), msg: ok }); } catch (e) { pushLog({ at: Date.now(), msg: e instanceof Error ? e.message : "Action failed", level: "warning" }); }
  }

  const s = stats;
  const bs = s?.orders_by_status ?? {};
  const fitPts = useMemo<[number, number][] | undefined>(() => (sel ? [[sel.pickup_lat, sel.pickup_lng], [sel.drop_lat, sel.drop_lng]] : undefined), [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-screen flex-col bg-ink-900 text-slate-200">
      <Navbar dark>
        <nav className="hidden items-center gap-1 text-xs font-medium md:flex">
          <span className="rounded-md bg-white/10 px-2.5 py-1.5 text-white">Control room</span>
          <Link href="/dispatch/cluster" className="rounded-md px-2.5 py-1.5 text-slate-400 hover:bg-white/5 hover:text-white">Cluster view</Link>
          <a href="/grafana/" target="_blank" rel="noreferrer" className="rounded-md px-2.5 py-1.5 text-slate-400 hover:bg-white/5 hover:text-white">Grafana ↗</a>
        </nav>
      </Navbar>
      <div className="grid grid-cols-2 gap-2 border-b border-white/5 p-3 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Riders online" value={s?.riders_online ?? "–"} />
        <Stat label="Available" value={s?.riders_available ?? "–"} tone="good" />
        <Stat label="Waiting" value={(bs.pending ?? 0) + (bs.unassigned ?? 0)} tone={(bs.unassigned ?? 0) > 0 ? "bad" : (bs.pending ?? 0) > 5 ? "warn" : "default"} />
        <Stat label="In progress" value={(bs.assigned ?? 0) + (bs.picked_up ?? 0)} />
        <Stat label="Avg assign" value={s?.avg_assign_seconds != null ? `${s.avg_assign_seconds}s` : "–"} hint={s?.p95_assign_seconds != null ? `p95 ${s.p95_assign_seconds}s` : undefined} tone="good" />
        <Stat label="Delivered / hr" value={s?.delivered_last_hour ?? "–"} hint={s?.avg_delivery_minutes ? `avg ${s.avg_delivery_minutes} min` : undefined} />
        <Stat label="Revenue 24h" value={s ? inr(s.revenue_24h) : "–"} />
        <Stat label="SLA breaches" value={s?.sla_breaches_active ?? 0} tone={(s?.sla_breaches_active ?? 0) > 0 ? "bad" : "good"} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="relative h-[50vh] lg:h-auto lg:flex-1">
          <MapView dark center={CITY_CENTER} zoom={12} markers={markers} fitTo={fitPts} fitKey={sel?.id}
            lines={sel ? [{ id: "sel", points: [[sel.pickup_lat, sel.pickup_lng], [sel.drop_lat, sel.drop_lng]], color: "#f59e0b", dashed: true }] : []} />
          <div className="absolute bottom-4 left-4 z-[500] space-y-1.5 rounded-xl bg-ink-900/90 p-3 text-xs ring-1 ring-white/10 backdrop-blur">
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-emerald-500 bg-white" />Available</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-amber-500 bg-white" />Offer pending</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-indigo-500 bg-white" />On delivery</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-amber-500" />Order waiting</div>
            <label className="flex cursor-pointer items-center gap-2 border-t border-white/10 pt-1.5">
              <input type="checkbox" checked={showAvailableOnly} onChange={(e) => setShowAvailableOnly(e.target.checked)} className="rounded border-slate-600 bg-ink-800 text-brand-500" />
              Available only
            </label>
          </div>
        </main>

        <aside className="flex w-full shrink-0 flex-col border-l border-white/5 lg:w-[440px]">
          {alerts.length > 0 && (
            <div className="max-h-32 space-y-1 overflow-y-auto border-b border-white/5 bg-rose-950/40 p-3 scrollbar-thin">
              {alerts.slice(0, 5).map((a, i) => (
                <button key={i} onClick={() => a.order_id && setSelected(a.order_id)} className={`block w-full text-left text-xs ${a.level === "critical" ? "text-rose-300" : "text-amber-300"}`}>
                  ⚠ {a.msg} <span className="text-slate-500">· {new Date(a.at).toLocaleTimeString()}</span>
                </button>
              ))}
            </div>
          )}

          {sel && (
            <div className="space-y-3 border-b border-white/5 bg-ink-800 p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-white">Order #{sel.id}</div>
                <div className="flex items-center gap-2"><StatusBadge status={sel.status} /><button onClick={() => setSelected(null)} className="text-slate-500 hover:text-white">✕</button></div>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                <div><span className="text-emerald-500">●</span> {sel.pickup_address}</div>
                <div><span className="text-rose-500">●</span> {sel.drop_address}</div>
                <div>{sel.customer_name} · {sel.distance_km} km · {inr(sel.price)} · placed {timeAgo(sel.created_at)} · {sel.dispatch_attempts} dispatch attempts</div>
                {sel.rider_name && <div>Rider: <span className="text-slate-200">{sel.rider_name}</span></div>}
              </div>
              <div className="flex flex-wrap gap-2">
                {(sel.status === "unassigned" || sel.status === "pending" || sel.status === "assigned") && (
                  <button onClick={() => action(() => api(`/admin/orders/${sel.id}/redispatch`, { method: "POST" }), `Order #${sel.id} sent back to auto-dispatch`)}
                    className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/15">↻ Re-dispatch</button>
                )}
                {(sel.status === "unassigned" || sel.status === "pending") && (() => {
                  const n = nearestAvailable(sel);
                  return n ? (
                    <button onClick={() => action(() => api(`/admin/orders/${sel.id}/assign`, { method: "POST", body: { rider_id: n.rider.rider_id } }), `Order #${sel.id} force-assigned to ${n.rider.name}`)}
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                      Assign {n.rider.name} ({n.km.toFixed(1)} km)
                    </button>
                  ) : <span className="text-xs text-slate-500">No available riders</span>;
                })()}
                {sel.status !== "delivered" && sel.status !== "cancelled" && sel.status !== "picked_up" && (
                  <button onClick={() => action(() => api(`/orders/${sel.id}/cancel`, { method: "POST" }), `Order #${sel.id} cancelled`)}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/10">Cancel</button>
                )}
                <Link href={`/customer/orders/${sel.id}`} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-400 hover:bg-white/5">Open tracking →</Link>
              </div>
            </div>
          )}

          <div className="flex border-b border-white/5 text-xs font-semibold">
            {(["attention", "pending", "active", "recent"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2.5 capitalize ${tab === t ? "border-b-2 border-brand-500 text-white" : "text-slate-500 hover:text-slate-300"}`}>
                {t === "attention" ? "⚠ Attention" : t} <span className="ml-1 rounded bg-white/10 px-1.5">{tabs[t].length}</span>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {tabs[tab].length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">{tab === "attention" ? "All clear. Nothing needs attention." : "No orders here."}</div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {tabs[tab].map((o) => (
                    <tr key={o.id} onClick={() => setSelected(o.id)} className={`cursor-pointer border-b border-white/5 hover:bg-white/5 ${selected === o.id ? "bg-white/5" : ""}`}>
                      <td className="py-2 pl-4 font-mono text-slate-400">#{o.id}</td>
                      <td className="max-w-[160px] truncate py-2 text-slate-300">{o.pickup_address}</td>
                      <td className="py-2 text-slate-500">{timeAgo(o.created_at)}</td>
                      <td className="py-2 pr-4 text-right"><StatusBadge status={o.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="h-48 shrink-0 border-t border-white/5 bg-black/30">
            <div className="flex items-center justify-between px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <span>Live dispatch log</span>
              {s && <span className="normal-case tracking-normal">offers {s.offers.sent} · accepted {s.offers.accepted} · declined {s.offers.rejected} · expired {s.offers.expired}</span>}
            </div>
            <ul className="h-36 overflow-y-auto px-4 pb-2 font-mono text-[11px] scrollbar-thin">
              {log.map((l, i) => (
                <li key={i} className={l.level === "critical" ? "text-rose-400" : l.level === "warning" ? "text-amber-400" : "text-slate-400"}>
                  <span className="text-slate-600">{new Date(l.at).toLocaleTimeString()}</span> {l.msg}
                </li>
              ))}
              {log.length === 0 && <li className="text-slate-600">Waiting for activity… (start the simulator)</li>}
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
