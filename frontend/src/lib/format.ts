import type { OrderStatus } from "./types";

export const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

// API timestamps are naive UTC
export const parseUtc = (s: string) => new Date(s.endsWith("Z") ? s : `${s}Z`);

export function timeAgo(s: string) {
  const sec = Math.max(0, (Date.now() - parseUtc(s).getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return parseUtc(s).toLocaleDateString();
}

export const clock = (s: string) => parseUtc(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Finding rider",
  assigned: "Rider on the way",
  picked_up: "In transit",
  delivered: "Delivered",
  cancelled: "Cancelled",
  unassigned: "Needs attention",
};

export const STATUS_STYLE: Record<OrderStatus, string> = {
  pending: "bg-amber-50 text-amber-700 ring-amber-200",
  assigned: "bg-sky-50 text-sky-700 ring-sky-200",
  picked_up: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  delivered: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  cancelled: "bg-slate-100 text-slate-600 ring-slate-200",
  unassigned: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function haversineKm(a: [number, number], b: [number, number]) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const CITY_CENTER: [number, number] = [12.9716, 77.5946];
