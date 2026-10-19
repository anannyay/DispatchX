"use client";

import { Bell } from "lucide-react";
import { useCallback, useState } from "react";
import { useSocketEvent } from "@/lib/socket";
import type { Notification } from "@/lib/types";

interface Toast extends Notification {
  key: number;
}

/** Customer notifications pushed by the notify worker over Socket.IO. */
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
        <div key={t.key} className="pointer-events-auto flex animate-fadeIn gap-3 rounded border border-k-line bg-k-side p-3 shadow-2xl">
          <Bell className="mt-0.5 h-4 w-4 shrink-0 text-k-accent" />
          <div>
            <div className="text-sm font-semibold text-k-hi">{t.title}</div>
            <div className="text-xs text-k-text">{t.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
