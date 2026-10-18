"use client";

import Link from "next/link";
import { Logo } from "@/components/Navbar";
import { homeFor, useAuth } from "@/lib/auth";

const FEATURES = [
  { icon: "📍", title: "Live tracking", body: "Watch your rider move on the map in real time over WebSockets." },
  { icon: "⚡", title: "Sub-second dispatch", body: "Redis geo-search matches the best nearby rider the moment you order." },
  { icon: "🔔", title: "Instant updates", body: "Event-driven notifications at every step, from pickup to doorstep." },
  { icon: "📸", title: "Proof of delivery", body: "Photo proof uploaded straight to S3 for every completed drop." },
];

export default function Home() {
  const { user } = useAuth();
  return (
    <div className="min-h-screen bg-ink-900 text-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo dark />
        <div className="flex items-center gap-3">
          {user ? (
            <Link href={homeFor(user.role)} className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold hover:bg-brand-600">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-300 hover:text-white">Log in</Link>
              <Link href="/register" className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold hover:bg-brand-600">Get started</Link>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-16">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-medium text-brand-400 ring-1 ring-brand-500/30">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" /> Real-time on AWS
          </span>
          <h1 className="mt-6 text-5xl font-bold leading-tight tracking-tight sm:text-6xl">
            Anything, anywhere in the city. <span className="text-brand-400">Tracked live.</span>
          </h1>
          <p className="mt-6 text-lg text-slate-400">
            FleetPulse connects customers, delivery riders and dispatchers on one real-time platform:
            instant rider matching, live GPS tracking and an operations control room.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/register" className="rounded-xl bg-brand-500 px-6 py-3 font-semibold hover:bg-brand-600">Send a parcel</Link>
            <Link href="/register?role=rider" className="rounded-xl bg-white/10 px-6 py-3 font-semibold ring-1 ring-white/15 hover:bg-white/15">Ride with us</Link>
          </div>
        </div>

        <div className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl bg-ink-800 p-6 ring-1 ring-white/5">
              <div className="text-2xl">{f.icon}</div>
              <div className="mt-3 font-semibold">{f.title}</div>
              <div className="mt-1 text-sm text-slate-400">{f.body}</div>
            </div>
          ))}
        </div>

        <div className="mt-16 rounded-2xl bg-ink-800 p-6 text-sm text-slate-400 ring-1 ring-white/5">
          <div className="font-semibold text-white">Demo accounts</div>
          <div className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-2">
            <span>customer@fleetpulse.dev</span>
            <span>rider@fleetpulse.dev</span>
            <span>dispatch@fleetpulse.dev</span>
            <span>password: fleetpulse123</span>
          </div>
        </div>
      </main>
    </div>
  );
}
