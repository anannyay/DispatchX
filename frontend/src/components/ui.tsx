import { Loader2 } from "lucide-react";
import { STATUS_LABEL } from "@/lib/format";
import type { OrderStatus } from "@/lib/types";

export const STATUS_COLOR: Record<OrderStatus, string> = {
  pending: "#F0B429",
  assigned: "#1FBAD6",
  picked_up: "#A08CF5",
  delivered: "#2EC27E",
  cancelled: "#6A7485",
  unassigned: "#F25F5C",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const live = status === "pending" || status === "assigned" || status === "picked_up";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-k-hi">
      <span className="relative flex h-1.5 w-1.5">
        {live && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: STATUS_COLOR[status] }} />}
        <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Panel({ children, className = "", title, action }: {
  children: React.ReactNode; className?: string; title?: string; action?: React.ReactNode;
}) {
  return (
    <section className={`k-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-k-line px-3 py-2">
          <h3 className="k-label">{title}</h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  children, variant = "primary", size = "md", className = "", ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "accent"; size?: "sm" | "md" | "lg";
}) {
  const styles = {
    primary: "bg-k-go text-white hover:bg-k-gohover",
    accent: "bg-k-accent text-k-canvas hover:brightness-110",
    secondary: "bg-k-panel text-k-hi hover:bg-k-hover",
    danger: "bg-k-err/90 text-white hover:bg-k-err",
    ghost: "text-k-text hover:bg-k-panel hover:text-k-hi",
  }[variant];
  const sizes = { sm: "h-7 px-2.5 text-xs", md: "h-9 px-3.5 text-sm", lg: "h-11 px-4 text-base" }[size];
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${sizes} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="k-label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-k-label">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const { label, className = "", ...rest } = props;
  const input = <input {...rest} className={`k-input ${className}`} />;
  return label ? <Field label={label}>{input}</Field> : input;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} />;
}

export function Metric({ label, value, sub, tone = "default" }: {
  label: string; value: React.ReactNode; sub?: string; tone?: "default" | "good" | "warn" | "bad";
}) {
  const color = { default: "text-k-hi", good: "text-k-ok", warn: "text-k-warn", bad: "text-k-err" }[tone];
  return (
    <div className="min-w-0 px-4 py-2.5">
      <div className="k-label truncate">{label}</div>
      <div className={`mt-0.5 font-mono text-xl font-medium tabular-nums ${color}`}>{value}</div>
      {sub && <div className="truncate text-2xs text-k-label">{sub}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-k-line px-4 py-6 text-center">
      <div className="text-sm font-medium text-k-hi">{title}</div>
      {children && <div className="mt-1 text-xs text-k-label">{children}</div>}
    </div>
  );
}

export function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-k-label">{k}</dt>
      <dd className={`truncate text-right text-sm text-k-hi ${mono ? "font-mono" : ""}`}>{v}</dd>
    </div>
  );
}
