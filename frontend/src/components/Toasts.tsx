"use client";

import { useCallback, useState } from "react";
import { useSocketEvent } from "@/lib/socket";
import type { Notification } from "@/lib/types";

interface Toast extends Notification {
  key: number;
}

/** Pops up customer notifications pushed by the notify worker over Socket.IO. */
export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const onNote = useCallback((n: Notification) => {
    const key = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { ...n, key }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), 6000);
  }, []);
  useSocketEvent<Notification>("notification", onNote);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.key} className="pointer-events-auto animate-[fadeIn_.2s_ease-out] rounded-xl bg-ink-900 p-4 text-white shadow-xl ring-1 ring-white/10">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="text-brand-400">●</span> {t.title}
          </div>
          <div className="mt-0.5 text-sm text-slate-300">{t.body}</div>
        </div>
      ))}
    </div>
  );
}
