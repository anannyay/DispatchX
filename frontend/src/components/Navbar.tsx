"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useSocket } from "@/lib/socket";

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-lg">⚡</span>
      <span className={`text-lg font-bold tracking-tight ${dark ? "text-white" : "text-slate-900"}`}>
        Dispatch<span className="text-brand-500">X</span>
      </span>
    </Link>
  );
}

export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium" title={connected ? "Real-time connected" : "Reconnecting"}>
      <span className="relative flex h-2.5 w-2.5">
        {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-500" : "bg-slate-400"}`} />
      </span>
      <span className={connected ? "text-emerald-600" : "text-slate-500"}>{connected ? "Live" : "Offline"}</span>
    </span>
  );
}

export default function Navbar({ dark = false, children }: { dark?: boolean; children?: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  return (
    <header className={`sticky top-0 z-[1000] border-b ${dark ? "border-white/10 bg-ink-900" : "border-slate-200 bg-white/90 backdrop-blur"}`}>
      <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Logo dark={dark} />
          {children}
        </div>
        <div className="flex items-center gap-4">
          <LiveDot connected={connected} />
          {user && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <div className={`text-sm font-medium ${dark ? "text-white" : "text-slate-900"}`}>{user.name}</div>
                <div className="text-xs capitalize text-slate-500">{user.role}</div>
              </div>
              <button onClick={logout} className={`rounded-lg px-2.5 py-1.5 text-sm ${dark ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"}`}>
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
