import { clock } from "@/lib/format";
import type { Order } from "@/lib/types";

const STEPS: { key: keyof Order; label: string }[] = [
  { key: "created_at", label: "Order placed" },
  { key: "assigned_at", label: "Rider assigned" },
  { key: "picked_up_at", label: "Picked up" },
  { key: "delivered_at", label: "Delivered" },
];

export default function Timeline({ order }: { order: Order }) {
  const cancelled = order.status === "cancelled";
  const current = STEPS.findIndex((s) => !order[s.key]);
  return (
    <ol className="space-y-0">
      {STEPS.map((s, i) => {
        const at = order[s.key] as string | null;
        const done = !!at;
        const active = !cancelled && i === current;
        return (
          <li key={s.key} className="relative flex gap-3 pb-4 last:pb-0">
            {i < STEPS.length - 1 && (
              <span className={`absolute left-[4px] top-3 h-full w-px ${done ? "bg-k-accent" : "bg-k-line"}`} />
            )}
            <span className={`relative mt-1 h-[9px] w-[9px] shrink-0 rounded-full border-2 ${
              done ? "border-k-accent bg-k-accent" : active ? "border-k-accent bg-k-side" : "border-k-line bg-k-side"
            }`}>
              {active && <span className="absolute -inset-1 animate-ping rounded-full border border-k-accent" />}
            </span>
            <div className="flex flex-1 items-baseline justify-between">
              <span className={`text-sm ${done || active ? "text-k-hi" : "text-k-label"}`}>{s.label}</span>
              <span className="font-mono text-xs text-k-label">{at ? clock(at) : active ? "in progress" : ""}</span>
            </div>
          </li>
        );
      })}
      {cancelled && <li className="pt-2 text-sm text-k-err">Order cancelled</li>}
    </ol>
  );
}
