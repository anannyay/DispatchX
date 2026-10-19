"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Bike, ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import Timeline from "@/components/Timeline";
import Toasts from "@/components/Toasts";
import { Button, KV, Spinner, StatusBadge } from "@/components/ui";
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
      .then((o) => { setOrder(o); if (o.rider_location) setRider(o.rider_location); })
      .catch((e) => setError(e.message));
    loadEvents();
  }, [orderId, loadEvents]);

  useEffect(() => {
    const s = getSocket();
    const join = () => s.emit("order:subscribe", { order_id: orderId });
    join();
    s.on("connect", join);
    return () => { s.off("connect", join); s.emit("order:unsubscribe", { order_id: orderId }); };
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
    if (rider && live) m.push({ id: "r", kind: "rider-busy", lat: rider.lat, lng: rider.lng, heading: rider.heading, label: order.rider_name ?? "Rider" });
    return m;
  }, [order, rider, live]);

  const hasRider = !!rider && !!live;
  const fitPts = useMemo<[number, number][]>(() => {
    if (!order) return [];
    const pts: [number, number][] = [[order.pickup_lat, order.pickup_lng], [order.drop_lat, order.drop_lng]];
    if (rider && live) pts.push([rider.lat, rider.lng]);
    return pts;
  }, [order?.id, order?.status, hasRider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel() {
    if (!order || !confirm("Cancel this order?")) return;
    try { setOrder(await api<Order>(`/orders/${order.id}/cancel`, { method: "POST" })); }
    catch (e) { alert(e instanceof Error ? e.message : "Could not cancel"); }
  }

  if (error) return <div className="p-10 text-center text-k-err">{error}</div>;
  if (!order) return <div className="grid h-screen place-items-center text-k-label"><Spinner className="h-5 w-5" /></div>;

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="w-full shrink-0 overflow-y-auto border-r border-k-line bg-k-side k-scroll lg:w-[380px]">
          <div className="border-b border-k-line p-4">
            <Link href="/customer" className="inline-flex items-center gap-1 text-xs text-k-label hover:text-k-hi"><ArrowLeft className="h-3 w-3" /> Orders</Link>
            <div className="mt-2 flex items-center justify-between">
              <h1 className="font-mono text-lg font-medium text-k-hi">#{order.id}</h1>
              <StatusBadge status={order.status} />
            </div>
          </div>

          {order.status === "pending" && (
            <div className="flex items-center gap-3 border-b border-k-line bg-k-warn/[0.06] px-4 py-3">
              <Search className="h-4 w-4 animate-pulse text-k-warn" />
              <div className="text-sm"><div className="font-medium text-k-hi">Matching the nearest rider</div><div className="text-xs text-k-label">Offers go out to riders within a few kilometres</div></div>
            </div>
          )}
          {order.status === "unassigned" && (
            <div className="border-b border-k-line bg-k-err/[0.08] px-4 py-3 text-sm text-k-hi">All nearby riders are busy. The dispatch desk has been alerted.</div>
          )}

          {order.rider_name && (
            <div className="flex items-center gap-3 border-b border-k-line px-4 py-3">
              <div className="grid h-9 w-9 place-items-center rounded bg-k-panel"><Bike className="h-4 w-4 text-k-violet" strokeWidth={1.5} /></div>
              <div className="flex-1">
                <div className="text-sm font-medium text-k-hi">{order.rider_name}</div>
                <div className="text-xs text-k-label">{order.status === "picked_up" ? "Heading to drop-off" : order.status === "assigned" ? "Heading to pickup" : "Rider"}</div>
              </div>
              {liveEta !== null && (
                <div className="text-right">
                  <div className="font-mono text-2xl text-k-hi">{liveEta}<span className="ml-0.5 text-xs text-k-label">min</span></div>
                  <div className="k-label">ETA</div>
                </div>
              )}
            </div>
          )}

          <div className="border-b border-k-line p-4"><Timeline order={order} /></div>

          <dl className="divide-y divide-k-line/60 border-b border-k-line px-4 py-2">
            <KV k="Pickup" v={order.pickup_address} />
            <KV k="Drop" v={order.drop_address} />
            <KV k="Distance" v={`${order.distance_km} km`} mono />
            <KV k="Fare" v={inr(order.price)} mono />
            {order.package_note && <KV k="Package" v={order.package_note} />}
          </dl>

          {pod && (
            <div className="border-b border-k-line p-4">
              <div className="k-label mb-2">Proof of delivery</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pod} alt="Proof of delivery" className="max-h-56 w-full rounded object-cover" />
            </div>
          )}

          <div className="space-y-3 p-4">
            {(order.status === "pending" || order.status === "assigned" || order.status === "unassigned") && (
              <Button variant="secondary" onClick={cancel} className="w-full">Cancel order</Button>
            )}
            <button onClick={() => setShowLog(!showLog)} className="flex items-center gap-1 text-xs text-k-label hover:text-k-hi">
              <ChevronDown className={`h-3 w-3 transition ${showLog ? "rotate-180" : ""}`} /> Event log ({events.length})
            </button>
            {showLog && (
              <ul className="space-y-0.5 rounded border border-k-line bg-k-canvas p-2 font-mono text-2xs leading-5">
                {events.map((e) => (
                  <li key={e.id} className="truncate">
                    <span className="text-k-label">{clock(e.created_at)}</span> <span className="text-k-accent">{e.type}</span>{" "}
                    {e.data && Object.keys(e.data).length > 0 && <span className="text-k-label">{JSON.stringify(e.data)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        <main className="relative h-[45vh] lg:h-auto lg:flex-1">
          <MapView center={[order.pickup_lat, order.pickup_lng]} markers={markers} fitTo={fitPts} fitKey={`${order.id}-${order.status}-${hasRider}`}
            lines={[
              { id: "trip", points: [[order.pickup_lat, order.pickup_lng], [order.drop_lat, order.drop_lng]], dashed: true, color: "#6A7485" },
              ...(rider && live && target ? [{ id: "live", points: [[rider.lat, rider.lng], target] as [number, number][], color: "#A08CF5" }] : []),
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
