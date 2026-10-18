"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import Timeline from "@/components/Timeline";
import Toasts from "@/components/Toasts";
import { Button, Card, Spinner, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { clock, haversineKm, inr } from "@/lib/format";
import { getSocket, useSocketEvent } from "@/lib/socket";
import type { Order, OrderEvent, RiderLocation } from "@/lib/types";

function Tracking() {
  const { id } = useParams<{ id: string }>();
  const orderId = Number(id);
  const [order, setOrder] = useState<Order | null>(null);
  const [rider, setRider] = useState<{ lat: number; lng: number; heading: number } | null>(null);
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [pod, setPod] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState("");

  const loadEvents = useCallback(() => {
    api<OrderEvent[]>(`/orders/${orderId}/events`).then(setEvents).catch(() => {});
  }, [orderId]);

  useEffect(() => {
    api<Order>(`/orders/${orderId}`)
      .then((o) => {
        setOrder(o);
        if (o.rider_location) setRider(o.rider_location);
      })
      .catch((e) => setError(e.message));
    loadEvents();
  }, [orderId, loadEvents]);

  // Join the order's room, and re-join after any reconnect
  useEffect(() => {
    const s = getSocket();
    const join = () => s.emit("order:subscribe", { order_id: orderId });
    join();
    s.on("connect", join);
    return () => {
      s.off("connect", join);
      s.emit("order:unsubscribe", { order_id: orderId });
    };
  }, [orderId]);

  useSocketEvent<Order>("order:update", useCallback((o: Order) => {
    if (o.id !== orderId) return;
    setOrder(o);
    loadEvents();
  }, [orderId, loadEvents]));

  useSocketEvent<RiderLocation>("rider:location", useCallback((l: RiderLocation) => {
    if (l.order_id === orderId || l.order_id === null) setRider({ lat: l.lat, lng: l.lng, heading: l.heading });
  }, [orderId]));

  useEffect(() => {
    if (order?.pod_key) api<{ url: string }>(`/uploads/pod/${order.id}`).then((r) => setPod(r.url)).catch(() => {});
  }, [order?.pod_key, order?.id]);

  const live = order && (order.status === "assigned" || order.status === "picked_up");
  const target: [number, number] | null = order
    ? order.status === "picked_up" ? [order.drop_lat, order.drop_lng] : [order.pickup_lat, order.pickup_lng]
    : null;
  const remainingKm = live && rider && target ? haversineKm([rider.lat, rider.lng], target) * 1.3 : null;
  const liveEta = remainingKm !== null ? Math.max(1, Math.round((remainingKm / 22) * 60)) : null;

  const markers = useMemo(() => {
    if (!order) return [];
    const m: MapMarker[] = [
      { id: "p", kind: "pickup", lat: order.pickup_lat, lng: order.pickup_lng, label: order.pickup_address },
      { id: "d", kind: "drop", lat: order.drop_lat, lng: order.drop_lng, label: order.drop_address },
    ];
    if (rider && live) m.push({ id: "r", kind: "rider-busy", lat: rider.lat, lng: rider.lng, heading: rider.heading, label: order.rider_name ?? "Rider", highlight: true });
    return m;
  }, [order, rider, live]);

  // Re-frame when the order changes phase, including the rider once one is assigned
  const hasRider = !!rider && !!live;
  const fitPts = useMemo<[number, number][]>(() => {
    if (!order) return [];
    const pts: [number, number][] = [[order.pickup_lat, order.pickup_lng], [order.drop_lat, order.drop_lng]];
    if (rider && live) pts.push([rider.lat, rider.lng]);
    return pts;
  }, [order?.id, order?.status, hasRider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel() {
    if (!order || !confirm("Cancel this order?")) return;
    try {
      setOrder(await api<Order>(`/orders/${order.id}/cancel`, { method: "POST" }));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not cancel");
    }
  }

  if (error) return <div className="p-10 text-center text-rose-600">{error}</div>;
  if (!order) return <div className="grid h-screen place-items-center"><Spinner className="h-8 w-8 text-brand-600" /></div>;

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="scrollbar-thin w-full shrink-0 space-y-4 overflow-y-auto border-r border-slate-200 bg-white p-5 lg:w-[400px]">
          <Link href="/customer" className="text-sm text-slate-500 hover:text-slate-900">← All orders</Link>
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">Order #{order.id}</h1>
            <StatusBadge status={order.status} />
          </div>

          {order.status === "pending" && (
            <Card className="flex items-center gap-3 bg-amber-50 p-4 ring-amber-200">
              <span className="relative flex h-10 w-10 items-center justify-center">
                <span className="absolute h-full w-full animate-ping rounded-full bg-amber-300 opacity-60" />
                <span className="relative text-xl">🔍</span>
              </span>
              <div className="text-sm"><div className="font-semibold text-amber-900">Finding the nearest rider</div><div className="text-amber-700">Usually takes a few seconds</div></div>
            </Card>
          )}
          {order.status === "unassigned" && (
            <Card className="bg-rose-50 p-4 text-sm text-rose-800 ring-rose-200">All riders nearby are busy. Our dispatch team has been alerted and will assign one shortly.</Card>
          )}

          {order.rider_name && (
            <Card className="flex items-center gap-3 p-4">
              <div className="grid h-11 w-11 place-items-center rounded-full bg-brand-100 text-xl">🛵</div>
              <div className="flex-1">
                <div className="font-semibold">{order.rider_name}</div>
                <div className="text-xs text-slate-500">{order.status === "picked_up" ? "Heading to drop-off" : order.status === "assigned" ? "Heading to pickup" : "Your rider"}</div>
              </div>
              {liveEta !== null && <div className="text-right"><div className="text-2xl font-bold text-brand-700">{liveEta}</div><div className="text-xs text-slate-500">min away</div></div>}
            </Card>
          )}

          <Card className="p-4"><Timeline order={order} /></Card>

          <Card className="space-y-2 p-4 text-sm">
            <div className="flex gap-2"><span className="text-emerald-600">●</span><span className="text-slate-700">{order.pickup_address}</span></div>
            <div className="flex gap-2"><span className="text-rose-600">●</span><span className="text-slate-700">{order.drop_address}</span></div>
            <div className="flex justify-between border-t border-slate-100 pt-2 text-slate-600">
              <span>{order.distance_km} km{order.package_note ? ` · ${order.package_note}` : ""}</span>
              <span className="font-semibold text-slate-900">{inr(order.price)}</span>
            </div>
          </Card>

          {pod && (
            <Card className="p-4">
              <div className="mb-2 text-sm font-semibold">Proof of delivery</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pod} alt="Proof of delivery" className="max-h-60 w-full rounded-lg object-cover" />
            </Card>
          )}

          {(order.status === "pending" || order.status === "assigned" || order.status === "unassigned") && (
            <Button variant="secondary" onClick={cancel} className="w-full">Cancel order</Button>
          )}

          <div>
            <button onClick={() => setShowLog(!showLog)} className="text-xs font-medium text-slate-500 hover:text-slate-800">
              {showLog ? "Hide" : "Show"} system event log ({events.length})
            </button>
            {showLog && (
              <ul className="mt-2 space-y-1 rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-300">
                {events.map((e) => (
                  <li key={e.id}><span className="text-slate-500">{clock(e.created_at)}</span> <span className="text-emerald-400">{e.type}</span> {e.data && Object.keys(e.data).length > 0 && <span className="text-slate-500">{JSON.stringify(e.data)}</span>}</li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        <main className="relative h-[45vh] lg:h-auto lg:flex-1">
          <MapView center={[order.pickup_lat, order.pickup_lng]} markers={markers} fitTo={fitPts} fitKey={`${order.id}-${order.status}-${hasRider}`}
            lines={[
              { id: "trip", points: [[order.pickup_lat, order.pickup_lng], [order.drop_lat, order.drop_lng]], color: "#94a3b8", dashed: true },
              ...(rider && live && target ? [{ id: "live", points: [[rider.lat, rider.lng], target] as [number, number][], color: "#6366f1" }] : []),
            ]} />
        </main>
      </div>
      <Toasts />
    </div>
  );
}

export default function Page() {
  return <RequireRole roles={["customer", "admin", "dispatcher"]}><Tracking /></RequireRole>;
}
