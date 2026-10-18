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
    <ol className="relative space-y-4">
      {STEPS.map((s, i) => {
        const at = order[s.key] as string | null;
        const done = !!at;
        const active = !cancelled && i === current;
        return (
          <li key={s.key} className="flex items-start gap-3">
            <div className="relative flex flex-col items-center">
              <span className={`relative z-10 grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${
                done ? "bg-brand-500 text-white" : active ? "bg-white text-brand-600 ring-2 ring-brand-500" : "bg-slate-200 text-slate-500"
              }`}>
                {done ? "✓" : i + 1}
                {active && <span className="absolute inset-0 animate-pulseRing rounded-full ring-2 ring-brand-400" />}
              </span>
              {i < STEPS.length - 1 && <span className={`absolute top-6 h-6 w-0.5 ${done ? "bg-brand-500" : "bg-slate-200"}`} />}
            </div>
            <div className="-mt-0.5">
              <div className={`text-sm font-medium ${done || active ? "text-slate-900" : "text-slate-400"}`}>{s.label}</div>
              <div className="text-xs text-slate-500">{at ? clock(at) : active ? "In progress…" : ""}</div>
            </div>
          </li>
        );
      })}
      {cancelled && <li className="text-sm font-medium text-rose-600">Order cancelled</li>}
    </ol>
  );
}
