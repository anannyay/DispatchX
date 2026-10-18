"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import PlaceInput from "@/components/PlaceInput";
import RequireRole from "@/components/RequireRole";
import Toasts from "@/components/Toasts";
import { Button, Card, Empty, Spinner, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { CITY_CENTER, inr, timeAgo } from "@/lib/format";
import { reverseGeocode, type Place } from "@/lib/geocode";
import { useSocketEvent } from "@/lib/socket";
import type { Order, Quote } from "@/lib/types";

type Which = "pickup" | "drop";
const ACTIVE = new Set(["pending", "assigned", "picked_up", "unassigned"]);

function CustomerHome() {
  const router = useRouter();
  const [pickup, setPickup] = useState<Place | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const [editing, setEditing] = useState<Which>("pickup");
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Order[]>("/orders?limit=30").then(setOrders).catch(() => setOrders([]));
  }, []);

  // Live status changes for every order this customer owns (user:{id} room)
  const onUpdate = useCallback((o: Order) => {
    setOrders((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((x) => x.id === o.id);
      if (i === -1) return [o, ...prev];
      const next = [...prev];
      next[i] = o;
      return next;
    });
  }, []);
  useSocketEvent<Order>("order:update", onUpdate);

  useEffect(() => {
    setQuote(null);
    if (!pickup || !drop) return;
    api<Quote>("/orders/quote", {
      method: "POST",
      body: { pickup: { address: pickup.label, lat: pickup.lat, lng: pickup.lng }, drop: { address: drop.label, lat: drop.lat, lng: drop.lng } },
    }).then(setQuote).catch(() => setQuote(null));
  }, [pickup, drop]);

  async function onMapClick(lat: number, lng: number) {
    const which = editing;
    const temp = { label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng };
    (which === "pickup" ? setPickup : setDrop)(temp);
    if (which === "pickup") setEditing("drop");
    const label = await reverseGeocode(lat, lng);
    (which === "pickup" ? setPickup : setDrop)((p) => (p && p.lat === lat ? { ...p, label } : p));
  }

  async function placeOrder() {
    if (!pickup || !drop) return;
    setBusy(true);
    setError("");
    try {
      const o = await api<Order>("/orders", {
        method: "POST",
        body: {
          pickup: { address: pickup.label.slice(0, 250), lat: pickup.lat, lng: pickup.lng },
          drop: { address: drop.label.slice(0, 250), lat: drop.lat, lng: drop.lng },
          package_note: note || null,
        },
      });
      router.push(`/customer/orders/${o.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not place order");
      setBusy(false);
    }
  }

  const markers = useMemo(() => {
    const m: MapMarker[] = [];
    if (pickup) m.push({ id: "p", kind: "pickup", lat: pickup.lat, lng: pickup.lng, label: "Pickup" });
    if (drop) m.push({ id: "d", kind: "drop", lat: drop.lat, lng: drop.lng, label: "Drop" });
    return m;
  }, [pickup, drop]);
  const fit = useMemo(() => markers.map((m) => [m.lat, m.lng] as [number, number]), [markers]);

  const active = orders?.filter((o) => ACTIVE.has(o.status)) ?? [];
  const past = orders?.filter((o) => !ACTIVE.has(o.status)) ?? [];

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="scrollbar-thin w-full shrink-0 space-y-5 overflow-y-auto border-r border-slate-200 bg-white p-5 lg:w-[420px]">
          <div>
            <h1 className="text-xl font-semibold">Send a parcel</h1>
            <p className="text-sm text-slate-500">Search an address or click the map to drop pins.</p>
          </div>
          <div className="space-y-2">
            <PlaceInput label="Pickup" dot="bg-emerald-500" value={pickup?.label ?? ""} active={editing === "pickup"} onFocus={() => setEditing("pickup")} onPick={(p) => { setPickup(p); setEditing("drop"); }} />
            <PlaceInput label="Drop" dot="bg-rose-500" value={drop?.label ?? ""} active={editing === "drop"} onFocus={() => setEditing("drop")} onPick={setDrop} />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What are you sending? (optional)"
              maxLength={200}
              className="block w-full rounded-xl border-0 px-3.5 py-2.5 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {quote && (
            <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl bg-slate-50 py-3 text-center ring-1 ring-slate-200">
              <div><div className="text-lg font-semibold">{quote.distance_km} km</div><div className="text-xs text-slate-500">Distance</div></div>
              <div><div className="text-lg font-semibold">~{Math.round(quote.eta_minutes)} min</div><div className="text-xs text-slate-500">ETA</div></div>
              <div><div className="text-lg font-semibold text-brand-700">{inr(quote.price)}</div><div className="text-xs text-slate-500">Fare</div></div>
            </div>
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button onClick={placeOrder} disabled={!pickup || !drop || busy} className="w-full py-3">
            {busy ? <Spinner className="h-4 w-4" /> : quote ? `Book delivery · ${inr(quote.price)}` : "Book delivery"}
          </Button>

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">Active</h2>
            {orders === null ? <Spinner className="h-5 w-5 text-slate-400" /> : active.length === 0 ? (
              <Empty title="No active deliveries">Your live orders will show up here.</Empty>
            ) : (
              <div className="space-y-2">{active.map((o) => <OrderRow key={o.id} o={o} />)}</div>
            )}
          </section>
          {past.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">History</h2>
              <div className="space-y-2">{past.slice(0, 10).map((o) => <OrderRow key={o.id} o={o} />)}</div>
            </section>
          )}
        </aside>
        <main className="relative min-h-[50vh] flex-1">
          <MapView center={CITY_CENTER} zoom={12} markers={markers} onMapClick={onMapClick} fitTo={fit} fitKey={fit.length === 2 ? `${pickup?.lat}${drop?.lat}` : undefined}
            lines={pickup && drop ? [{ id: "route", points: [[pickup.lat, pickup.lng], [drop.lat, drop.lng]], dashed: true, color: "#0f172a" }] : []} />
          <div className="pointer-events-none absolute left-4 top-4 z-[500] rounded-xl bg-white/95 px-3 py-2 text-sm font-medium shadow-card">
            Click the map to set the <span className={editing === "pickup" ? "text-emerald-600" : "text-rose-600"}>{editing}</span> point
          </div>
        </main>
      </div>
      <Toasts />
    </div>
  );
}

function OrderRow({ o }: { o: Order }) {
  return (
    <Link href={`/customer/orders/${o.id}`}>
      <Card className="p-3 transition hover:ring-brand-300">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Order #{o.id}</span>
          <StatusBadge status={o.status} />
        </div>
        <div className="mt-2 space-y-0.5 text-xs text-slate-600">
          <div className="truncate"><span className="text-emerald-600">●</span> {o.pickup_address}</div>
          <div className="truncate"><span className="text-rose-600">●</span> {o.drop_address}</div>
        </div>
        <div className="mt-2 flex justify-between text-xs text-slate-500">
          <span>{timeAgo(o.created_at)}</span>
          <span className="font-medium text-slate-700">{inr(o.price)}</span>
        </div>
      </Card>
    </Link>
  );
}

export default function Page() {
  return <RequireRole roles={["customer", "admin"]}><CustomerHome /></RequireRole>;
}
