"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import Navbar from "@/components/Navbar";
import RequireRole from "@/components/RequireRole";
import { Camera, Check, Crosshair, Navigation, Pause, Play } from "lucide-react";
import { Button, Spinner } from "@/components/ui";
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

  if (!me) return <div className="grid h-screen place-items-center text-k-label"><Spinner className="h-5 w-5" /></div>;

  const earning = (o: Order) => inr(o.price * 0.8);

  return (
    <div className="flex h-screen flex-col">
      <Navbar />
      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <aside className="w-full shrink-0 overflow-y-auto border-r border-k-line bg-k-side k-scroll lg:w-[380px]">
          <div className="flex items-center justify-between border-b border-k-line p-4">
            <div>
              <div className="k-label">Status</div>
              <div className="mt-0.5 flex items-center gap-2 text-base font-semibold text-k-hi">
                <span className={`h-2 w-2 rounded-full ${me.online ? (job ? "bg-k-violet" : "bg-k-ok shadow-[0_0_8px_#2EC27E]") : "bg-k-label"}`} />
                {me.online ? (job ? "On delivery" : "Online, accepting jobs") : "Offline"}
              </div>
            </div>
            <button onClick={toggleOnline} disabled={busy || (me.online && !!job)} aria-label="Toggle online"
              className={`relative h-6 w-11 rounded-full transition disabled:opacity-40 ${me.online ? "bg-k-go" : "bg-k-hover"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${me.online ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>

          <div className="grid grid-cols-3 divide-x divide-k-line border-b border-k-line">
            {[["Deliveries", String(me.deliveries)], ["Earned", inr(me.earnings)], ["Rating", me.rating?.toFixed(1) ?? "–"]].map(([k, v]) => (
              <div key={k} className="px-4 py-3">
                <div className="k-label">{k}</div>
                <div className="mt-0.5 font-mono text-lg text-k-hi">{v}</div>
              </div>
            ))}
          </div>

          {msg && <div className="border-b border-k-line bg-k-accent/[0.07] px-4 py-2.5 text-sm text-k-hi">{msg}</div>}

          {job ? (
            <div className="space-y-3 border-b border-k-line p-4">
              <div className="flex items-center justify-between">
                <span className="k-label">Current job</span>
                <span className="font-mono text-sm text-k-hi">#{job.id} · {earning(job)}</span>
              </div>
              <ol className="space-y-2">
                <li className={`flex gap-2.5 text-sm ${job.status === "assigned" ? "text-k-hi" : "text-k-label line-through"}`}>
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-k-accent" />{job.pickup_address}
                </li>
                <li className={`flex gap-2.5 text-sm ${job.status === "picked_up" ? "text-k-hi" : "text-k-text"}`}>
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border-2 border-k-err" />{job.drop_address}
                </li>
              </ol>
              {job.package_note && <div className="rounded bg-k-panel px-3 py-2 text-xs text-k-text">Package: {job.package_note}</div>}
              {distToTarget !== null && (
                <div className="flex items-center gap-1.5 text-xs text-k-label">
                  <Navigation className="h-3 w-3" />
                  {arrived ? "Arrived" : `${distToTarget.toFixed(2)} km to ${job.status === "picked_up" ? "drop-off" : "pickup"}`}
                </div>
              )}
              {mode === "demo" && !arrived && (
                <Button variant="secondary" className="w-full" onClick={() => setAutoDrive(!autoDrive)}>
                  {autoDrive ? <><Pause className="h-3.5 w-3.5" /> Pause auto-drive</> : <><Play className="h-3.5 w-3.5" /> Auto-drive (demo)</>}
                </Button>
              )}
              {job.status === "assigned" ? (
                <Button size="lg" className="w-full" disabled={busy} onClick={pickup}><Check className="h-4 w-4" /> Confirm pickup</Button>
              ) : (
                <>
                  <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => e.target.files?.[0] && deliver(e.target.files[0])} />
                  <Button size="lg" className="w-full" disabled={busy} onClick={() => fileRef.current?.click()}>
                    {busy ? <Spinner /> : <><Camera className="h-4 w-4" /> Photo &amp; complete delivery</>}
                  </Button>
                  <button className="w-full text-xs text-k-label hover:text-k-hi" disabled={busy} onClick={() => deliver()}>Complete without photo</button>
                </>
              )}
            </div>
          ) : (
            me.online ? <div className="border-b border-k-line px-4 py-6 text-center text-xs text-k-label">Waiting for job offers near you…</div> : null
          )}

          <div className="p-4">
            <div className="k-label mb-2">Location source</div>
            <div className="grid grid-cols-2 rounded bg-k-panel p-0.5">
              {(["demo", "gps"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  className={`flex items-center justify-center gap-1.5 rounded-[2px] py-1.5 text-xs font-semibold ${mode === m ? "bg-k-hover text-k-hi" : "text-k-label hover:text-k-text"}`}>
                  {m === "demo" ? "Demo (click map)" : <><Crosshair className="h-3 w-3" /> Device GPS</>}
                </button>
              ))}
            </div>
            {mode === "demo" && <p className="mt-2 text-xs text-k-label">Click anywhere on the map to move.</p>}
          </div>
        </aside>

        <main className="relative h-[45vh] lg:h-auto lg:flex-1">
          <MapView
            center={pos}
            zoom={14}
            markers={markers}
            onMapClick={mode === "demo" ? (lat, lng) => setPos([lat, lng]) : undefined}
            fitTo={job ? [pos, [job.pickup_lat, job.pickup_lng], [job.drop_lat, job.drop_lng]] : [pos]}
            fitKey={job ? `job${job.id}${job.status}` : "idle"}
            lines={target ? [{ id: "nav", points: [pos, target], color: "#A08CF5" }] : []}
          />
        </main>
      </div>

      {offer && (
        <div className="fixed inset-0 z-[3000] grid place-items-end bg-black/50 p-4 sm:place-items-center">
          <div className="w-full max-w-md animate-fadeIn overflow-hidden rounded-md border border-k-line bg-k-side shadow-2xl">
            <div className="h-1 bg-k-panel">
              <div className="h-full bg-k-warn transition-all duration-300" style={{ width: `${(secondsLeft / (offer.expires_in || 20)) * 100}%` }} />
            </div>
            <div className="space-y-4 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="k-label text-k-warn">New delivery request</div>
                  <div className="mt-1 font-mono text-3xl text-k-hi">{earning(offer.order)}</div>
                  <div className="text-xs text-k-label">
                    {offer.order.distance_km} km trip{offer.distance_to_pickup_km !== undefined ? ` · ${offer.distance_to_pickup_km} km to pickup` : ""}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-3xl tabular-nums text-k-warn">{secondsLeft}s</div>
                  <div className="k-label">to respond</div>
                </div>
              </div>
              <ol className="space-y-2 rounded border border-k-line bg-k-canvas p-3 text-sm">
                <li className="flex gap-2.5 text-k-hi"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-k-accent" />{offer.order.pickup_address}</li>
                <li className="flex gap-2.5 text-k-hi"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border-2 border-k-err" />{offer.order.drop_address}</li>
              </ol>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" size="lg" disabled={busy} onClick={reject}>Decline</Button>
                <Button size="lg" disabled={busy} onClick={accept}>Accept</Button>
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
