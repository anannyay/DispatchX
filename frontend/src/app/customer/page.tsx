"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, MousePointerClick } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import PlaceInput from "@/components/PlaceInput";
import RequireRole from "@/components/RequireRole";
import Toasts from "@/components/Toasts";
import { Button, Empty, Spinner, StatusBadge } from "@/components/ui";
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
    if (pickup) m.push({ id: "p", kind: "pickup", lat: pickup.lat, lng: pickup.lng, label: pickup.label });
    if (drop) m.push({ id: "d", kind: "drop", lat: drop.lat, lng: drop.lng, label: drop.label });
    return m;
  }, [pickup, drop]);
  const fit = useMemo(() => markers.map((m) => [m.lat, m.lng] as [number, number]), [markers]);
  const active = orders?.filter((o) => ACTIVE.has(o.status)) ?? [];
  const past = orders?.filter((o) => !ACTIVE.has(o.status)) ?? [];

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="w-full shrink-0 overflow-y-auto border-r border-k-line bg-k-side k-scroll lg:w-[380px]">
          <section className="space-y-3 border-b border-k-line p-4">
            <div className="k-label">New delivery</div>
            <PlaceInput label="Pickup" color="#1FBAD6" value={pickup?.label ?? ""} active={editing === "pickup"} onFocus={() => setEditing("pickup")} onPick={(p) => { setPickup(p); setEditing("drop"); }} />
            <PlaceInput label="Drop" color="#F25F5C" value={drop?.label ?? ""} active={editing === "drop"} onFocus={() => setEditing("drop")} onPick={setDrop} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Package description (optional)" maxLength={200} className="k-input" />
            <div className="grid grid-cols-3 divide-x divide-k-line rounded border border-k-line">
              {[
                ["Distance", quote ? `${quote.distance_km} km` : "–"],
                ["ETA", quote ? `${Math.round(quote.eta_minutes)} min` : "–"],
                ["Fare", quote ? inr(quote.price) : "–"],
              ].map(([k, v]) => (
                <div key={k} className="px-3 py-2">
                  <div className="k-label">{k}</div>
                  <div className="mt-0.5 font-mono text-base text-k-hi">{v}</div>
                </div>
              ))}
            </div>
            {error && <p className="text-xs text-k-err">{error}</p>}
            <Button onClick={placeOrder} disabled={!pickup || !drop || busy} size="lg" className="w-full">
              {busy ? <Spinner /> : <>Book delivery{quote ? ` · ${inr(quote.price)}` : ""}<ArrowRight className="h-4 w-4" /></>}
            </Button>
          </section>

          <section className="p-4">
            <div className="k-label mb-2">Active</div>
            {orders === null ? <Spinner className="h-4 w-4 text-k-label" /> : active.length === 0 ? (
              <Empty title="No active deliveries">Booked orders appear here with live status.</Empty>
            ) : (
              <div className="overflow-hidden rounded border border-k-line">{active.map((o) => <OrderRow key={o.id} o={o} />)}</div>
            )}
            {past.length > 0 && (
              <>
                <div className="k-label mb-2 mt-5">History</div>
                <div className="overflow-hidden rounded border border-k-line">{past.slice(0, 12).map((o) => <OrderRow key={o.id} o={o} />)}</div>
              </>
            )}
          </section>
        </aside>
        <main className="relative min-h-[50vh] flex-1">
          <MapView center={CITY_CENTER} zoom={12} markers={markers} onMapClick={onMapClick} fitTo={fit} fitKey={fit.length === 2 ? `${pickup?.lat}${drop?.lat}` : undefined}
            lines={pickup && drop ? [{ id: "route", points: [[pickup.lat, pickup.lng], [drop.lat, drop.lng]], dashed: true }] : []} />
          <div className="pointer-events-none absolute left-3 top-3 z-[500] flex items-center gap-2 rounded border border-k-line bg-k-side/95 px-3 py-1.5 text-xs text-k-text">
            <MousePointerClick className="h-3.5 w-3.5 text-k-label" />
            Click the map to set the <span className={editing === "pickup" ? "text-k-accent" : "text-k-err"}>{editing}</span> location
          </div>
        </main>
      </div>
      <Toasts />
    </div>
  );
}

function OrderRow({ o }: { o: Order }) {
  return (
    <Link href={`/customer/orders/${o.id}`} className="block border-b border-k-line px-3 py-2.5 last:border-0 hover:bg-k-panel">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-k-text">#{o.id}</span>
        <StatusBadge status={o.status} />
      </div>
      <div className="mt-1 truncate text-sm text-k-hi">{o.drop_address}</div>
      <div className="mt-0.5 flex justify-between text-xs text-k-label">
        <span className="truncate pr-2">from {o.pickup_address}</span>
        <span className="shrink-0 font-mono">{inr(o.price)} · {timeAgo(o.created_at)}</span>
      </div>
    </Link>
  );
}

export default function Page() {
  return <RequireRole roles={["customer", "admin"]}><CustomerHome /></RequireRole>;
}
