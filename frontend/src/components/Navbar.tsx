"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useSocket } from "@/lib/socket";

export function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <rect x="1" y="1" width="18" height="18" rx="3" fill="none" stroke="#1FBAD6" strokeWidth="1.5" />
        <path d="M5 13.5 9 9l2.5 2.5L15 6.5" fill="none" stroke="#1FBAD6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="15" cy="6.5" r="1.6" fill="#1FBAD6" />
      </svg>
      <span className="text-sm font-semibold tracking-tight text-k-hi">DispatchX</span>
    </Link>
  );
}

export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.08em]" title={connected ? "Real-time connected" : "Reconnecting"}>
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-k-ok shadow-[0_0_6px_#2EC27E]" : "bg-k-label"}`} />
      <span className={connected ? "text-k-text" : "text-k-label"}>{connected ? "Live" : "Offline"}</span>
    </span>
  );
}

export interface NavItem { href: string; label: string; external?: boolean }

export default function Navbar({ items = [] }: { items?: NavItem[] }) {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  const path = usePathname();
  return (
    <header className="sticky top-0 z-[1000] flex h-12 shrink-0 items-center justify-between border-b border-k-line bg-k-side px-4">
      <div className="flex h-full items-center gap-6">
        <Wordmark />
        <nav className="hidden h-full items-center md:flex">
          {items.map((i) =>
            i.external ? (
              <a key={i.href} href={i.href} target="_blank" rel="noreferrer" className="k-tab">{i.label}</a>
            ) : (
              <Link key={i.href} href={i.href} className={`k-tab ${path === i.href ? "k-tab-active" : ""}`}>{i.label}</Link>
            ),
          )}
        </nav>
      </div>
      <div className="flex items-center gap-5">
        <LiveDot connected={connected} />
        {user && (
          <div className="flex items-center gap-3 border-l border-k-line pl-4">
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-sm font-medium text-k-hi">{user.name}</div>
              <div className="text-2xs uppercase tracking-[0.08em] text-k-label">{user.role}</div>
            </div>
            <button onClick={logout} title="Log out" className="rounded p-1.5 text-k-label hover:bg-k-panel hover:text-k-hi">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
