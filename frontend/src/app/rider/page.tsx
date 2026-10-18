"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Button, Card, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { CITY_CENTER, haversineKm, inr } from "@/lib/format";
import { getSocket, useSocketEvent } from "@/lib/socket";
import type { Offer, Order } from "@/lib/types";

interface RiderMe {
  id: number;
  name: string;
  vehicle: string | null;
  rating: number | null;
  deliveries: number;
  earnings: number;
  online: boolean;
  active_order: Order | null;
  offer: Offer | null;
}

type PosMode = "demo" | "gps";
const DRIVE_KMH = 120; // demo auto-drive is sped up so a trip takes ~1 minute

function RiderApp() {
  const [me, setMe] = useState<RiderMe | null>(null);
  const [pos, setPos] = useState<[number, number]>(CITY_CENTER);
  const [heading, setHeading] = useState(0);
  const [mode, setMode] = useState<PosMode>("demo");
  const [autoDrive, setAutoDrive] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const posRef = useRef(pos);
  posRef.current = pos;
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const m = await api<RiderMe>("/riders/me");
    setMe(m);
    if (m.offer) setOffer(m.offer);
    return m;
  }, []);

  useEffect(() => {
    // Start somewhere plausible near the city centre
    setPos([CITY_CENTER[0] + (Math.random() - 0.5) * 0.04, CITY_CENTER[1] + (Math.random() - 0.5) * 0.04]);
    refresh().catch(() => {});
  }, [refresh]);

  const job = me?.active_order ?? null;
  const target: [number, number] | null = job
    ? job.status === "picked_up" ? [job.drop_lat, job.drop_lng] : [job.pickup_lat, job.pickup_lng]
    : null;

  // Stream GPS every 2 s while online
  useEffect(() => {
    if (!me?.online) return;
    const s = getSocket();
    const t = setInterval(() => {
      const [lat, lng] = posRef.current;
      s.emit("rider:location", { lat, lng, heading, speed: autoDrive ? 25 : 0 });
    }, 2000);
    return () => clearInterval(t);
  }, [me?.online, heading, autoDrive]);

  // Real device GPS
  useEffect(() => {
    if (mode !== "gps" || !navigator.geolocation) return;
    const w = navigator.geolocation.watchPosition(
      (p) => {
        setPos([p.coords.latitude, p.coords.longitude]);
        if (p.coords.heading) setHeading(p.coords.heading);
      },
      () => setMsg("Location permission denied, switched to demo mode"),
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(w);
  }, [mode]);

  // Demo auto-drive towards the current target
  useEffect(() => {
    if (!autoDrive || !target || mode !== "demo") return;
    const t = setInterval(() => {
      setPos((p) => {
        const d = haversineKm(p, target);
        const step = (DRIVE_KMH / 3600) * 1;
        if (d <= step) return target;
        const f = step / d;
        setHeading(((Math.atan2(target[1] - p[1], target[0] - p[0]) * 180) / Math.PI + 360) % 360);
        return [p[0] + (target[0] - p[0]) * f, p[1] + (target[1] - p[1]) * f];
      });
    }, 1000);
    return () => clearInterval(t);
  }, [autoDrive, target?.[0], target?.[1], mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useSocketEvent<Offer>("job:offer", useCallback((o: Offer) => {
    setOffer(o);
    try { new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=").play().catch(() => {}); } catch { /* ignore */ }
  }, []));
  useSocketEvent<{ order_id: number }>("job:offer_closed", useCallback((d: { order_id: number }) => {
    setOffer((o) => (o && o.order.id === d.order_id ? null : o));
  }, []));
  useSocketEvent<Order>("order:update", useCallback((o: Order) => {
    setMe((m) => {
      if (!m) return m;
      if (m.active_order?.id === o.id) {
        if (o.status === "cancelled") setMsg(`Order #${o.id} was cancelled by the customer`);
        return { ...m, active_order: o.status === "assigned" || o.status === "picked_up" ? o : null };
      }
      return m;
    });
    setOffer((cur) => (cur && cur.order.id === o.id && o.status !== "pending" ? null : cur));
  }, []));

  // Offer countdown
  useEffect(() => {
    if (!offer) return;
    const deadline = offer.expires_at ? offer.expires_at * 1000 : Date.now() + offer.expires_in * 1000;
    const tick = () => {
      const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s === 0) setOffer(null);
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [offer]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const toggleOnline = () =>
    run(async () => {
      if (me?.online) await api("/riders/me/offline", { method: "POST" });
      else {
        await api("/riders/me/online", { method: "POST", body: { lat: pos[0], lng: pos[1] } });
        getSocket().emit("rider:location", { lat: pos[0], lng: pos[1], heading });
      }
      await refresh();
    });

  const accept = () =>
    run(async () => {
      if (!offer) return;
      const o = await api<Order>(`/riders/offers/${offer.order.id}/accept`, { method: "POST" });
      setOffer(null);
      setMe((m) => (m ? { ...m, active_order: o } : m));
      setAutoDrive(mode === "demo");
    }).finally(() => setOffer(null));

  const reject = () =>
    run(async () => {
      if (!offer) return;
      setOffer(null);
      await api(`/riders/offers/${offer.order.id}/reject`, { method: "POST" });
    });

  const pickup = () =>
    run(async () => {
      if (!job) return;
      const o = await api<Order>(`/riders/orders/${job.id}/pickup`, { method: "POST" });
      setMe((m) => (m ? { ...m, active_order: o } : m));
    });

  const deliver = (file?: File) =>
    run(async () => {
      if (!job) return;
      let pod_key: string | undefined;
      if (file) {
        const up = await api<{ upload_url: string; key: string; headers: Record<string, string> }>("/uploads/pod", {
          method: "POST", body: { order_id: job.id, content_type: file.type || "image/jpeg" },
        });
        // Direct browser -> S3 upload with the presigned URL
        const res = await fetch(up.upload_url, { method: "PUT", body: file, headers: up.headers });
        if (!res.ok) throw new ApiError(res.status, "Photo upload failed");
        pod_key = up.key;
      }
      await api(`/riders/orders/${job.id}/deliver`, { method: "POST", body: { pod_key } });
      setAutoDrive(false);
      setMsg(`Delivered! You earned ${inr(job.price * 0.8)}`);
      await refresh();
    });

  const markers = useMemo(() => {
    const m: MapMarker[] = [{ id: "me", kind: me?.online ? "rider-busy" : "me", lat: pos[0], lng: pos[1], heading, label: "You" }];
    if (job) {
      m.push({ id: "p", kind: "pickup", lat: job.pickup_lat, lng: job.pickup_lng, label: job.pickup_address });
      m.push({ id: "d", kind: "drop", lat: job.drop_lat, lng: job.drop_lng, label: job.drop_address });
    }
    if (offer) m.push({ id: "op", kind: "pickup", lat: offer.order.pickup_lat, lng: offer.order.pickup_lng, label: "Offered pickup" });
    return m;
  }, [pos, heading, job, offer, me?.online]);

  const distToTarget = target ? haversineKm(pos, target) : null;
  const arrived = distToTarget !== null && distToTarget < 0.15;

  if (!me) return <div className="grid h-screen place-items-center"><Spinner className="h-8 w-8 text-brand-600" /></div>;

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="scrollbar-thin w-full shrink-0 space-y-4 overflow-y-auto border-r border-slate-200 bg-white p-5 lg:w-[400px]">
          <Card className={`p-5 ${me.online ? "bg-brand-600 text-white ring-brand-700" : ""}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className={`text-sm ${me.online ? "text-brand-100" : "text-slate-500"}`}>You are</div>
                <div className="text-2xl font-bold">{me.online ? (job ? "On a delivery" : "Online") : "Offline"}</div>
              </div>
              <button
                onClick={toggleOnline}
                disabled={busy || (me.online && !!job)}
                className={`relative h-9 w-16 rounded-full transition ${me.online ? "bg-white/30" : "bg-slate-300"} disabled:opacity-50`}
                aria-label="Toggle online"
              >
                <span className={`absolute top-1 h-7 w-7 rounded-full bg-white shadow transition-all ${me.online ? "left-8" : "left-1"}`} />
              </button>
            </div>
            {!me.online && <p className="mt-2 text-sm text-slate-500">Go online to start receiving delivery requests nearby.</p>}
          </Card>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Card className="p-3"><div className="text-lg font-semibold">{me.deliveries}</div><div className="text-xs text-slate-500">Deliveries</div></Card>
            <Card className="p-3"><div className="text-lg font-semibold">{inr(me.earnings)}</div><div className="text-xs text-slate-500">Earned</div></Card>
            <Card className="p-3"><div className="text-lg font-semibold">★ {me.rating?.toFixed(1) ?? "-"}</div><div className="text-xs text-slate-500">Rating</div></Card>
          </div>

          {msg && <div className="rounded-xl bg-slate-900 px-4 py-3 text-sm text-white">{msg}</div>}

          {job && (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Order #{job.id}</div>
                <div className="text-sm font-semibold text-brand-700">{inr(job.price * 0.8)}</div>
              </div>
              <div className="space-y-2 text-sm">
                <div className={`flex gap-2 ${job.status === "assigned" ? "font-semibold" : "text-slate-400 line-through"}`}><span className="text-emerald-600">●</span>{job.pickup_address}</div>
                <div className={`flex gap-2 ${job.status === "picked_up" ? "font-semibold" : "text-slate-500"}`}><span className="text-rose-600">●</span>{job.drop_address}</div>
              </div>
              {job.package_note && <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">📦 {job.package_note}</div>}
              {distToTarget !== null && (
                <div className="text-xs text-slate-500">
                  {arrived ? "You've arrived" : `${distToTarget.toFixed(2)} km to ${job.status === "picked_up" ? "drop-off" : "pickup"}`}
                </div>
              )}
              {mode === "demo" && !arrived && (
                <Button variant="secondary" className="w-full" onClick={() => setAutoDrive(!autoDrive)}>
                  {autoDrive ? "⏸ Pause auto-drive" : "▶ Auto-drive (demo)"}
                </Button>
              )}
              {job.status === "assigned" ? (
                <Button className="w-full py-3" disabled={busy} onClick={pickup}>Confirm pickup</Button>
              ) : (
                <>
                  <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => e.target.files?.[0] && deliver(e.target.files[0])} />
                  <Button className="w-full py-3" disabled={busy} onClick={() => fileRef.current?.click()}>
                    {busy ? <Spinner className="h-4 w-4" /> : "📸 Photo & complete delivery"}
                  </Button>
                  <button className="w-full text-xs text-slate-500 hover:text-slate-800" disabled={busy} onClick={() => deliver()}>
                    Complete without photo
                  </button>
                </>
              )}
            </Card>
          )}

          <Card className="p-4 text-sm">
            <div className="mb-2 font-semibold">Location source</div>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              {(["demo", "gps"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded-lg py-1.5 text-xs font-medium ${mode === m ? "bg-white shadow" : "text-slate-500"}`}>
                  {m === "demo" ? "Demo (click map)" : "Device GPS"}
                </button>
              ))}
            </div>
            {mode === "demo" && <p className="mt-2 text-xs text-slate-500">Click anywhere on the map to move yourself.</p>}
          </Card>
        </aside>

        <main className="relative h-[45vh] lg:h-auto lg:flex-1">
          <MapView
            center={pos}
            zoom={14}
            markers={markers}
            onMapClick={mode === "demo" ? (lat, lng) => setPos([lat, lng]) : undefined}
            fitTo={job ? [pos, [job.pickup_lat, job.pickup_lng], [job.drop_lat, job.drop_lng]] : [pos]}
            fitKey={job ? `job${job.id}${job.status}` : "idle"}
            lines={target ? [{ id: "nav", points: [pos, target], color: "#6366f1" }] : []}
          />
        </main>
      </div>

      {offer && (
        <div className="fixed inset-0 z-[3000] grid place-items-end bg-black/40 p-4 sm:place-items-center">
          <div className="w-full max-w-md animate-[fadeIn_.2s_ease-out] overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="h-1.5 bg-slate-100">
              <div className="h-full bg-amber-500 transition-all duration-300" style={{ width: `${(secondsLeft / (offer.expires_in || 20)) * 100}%` }} />
            </div>
            <div className="space-y-4 p-6">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-amber-600">New delivery request</div>
                  <div className="mt-1 text-3xl font-bold">{inr(offer.order.price * 0.8)}</div>
                  <div className="text-sm text-slate-500">
                    {offer.order.distance_km} km trip{offer.distance_to_pickup_km !== undefined ? ` · ${offer.distance_to_pickup_km} km to pickup` : ""}
                  </div>
                </div>
                <div className="grid h-14 w-14 place-items-center rounded-full bg-amber-50 text-xl font-bold tabular-nums text-amber-700 ring-4 ring-amber-100">{secondsLeft}</div>
              </div>
              <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm">
                <div className="flex gap-2"><span className="text-emerald-600">●</span>{offer.order.pickup_address}</div>
                <div className="flex gap-2"><span className="text-rose-600">●</span>{offer.order.drop_address}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="secondary" disabled={busy} onClick={reject} className="py-3">Decline</Button>
                <Button disabled={busy} onClick={accept} className="py-3">Accept</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <RequireRole roles={["rider"]}><RiderApp /></RequireRole>;
}
