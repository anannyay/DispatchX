export type Role = "customer" | "rider" | "dispatcher" | "admin";
export type OrderStatus = "pending" | "assigned" | "picked_up" | "delivered" | "cancelled" | "unassigned";

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
}

export interface Order {
  id: number;
  customer_id: number;
  rider_id: number | null;
  status: OrderStatus;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  drop_address: string;
  drop_lat: number;
  drop_lng: number;
  package_note: string | null;
  distance_km: number;
  price: number;
  eta_minutes: number;
  dispatch_attempts: number;
  pod_key: string | null;
  created_at: string;
  assigned_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  rider_name: string | null;
  customer_name: string | null;
  rider_location?: { lat: number; lng: number; heading: number };
}

export interface RiderLocation {
  rider_id: number;
  lat: number;
  lng: number;
  heading: number;
  speed?: number;
  order_id: number | null;
  available?: boolean;
  name?: string | null;
  ts?: number;
}

export interface FleetRider extends RiderLocation {
  vehicle?: string;
  rating?: number;
  offer?: string | null;
  last_seen_s?: number;
}

export interface Quote {
  distance_km: number;
  price: number;
  eta_minutes: number;
}

export interface OrderEvent {
  id: number;
  type: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface Notification {
  title: string;
  body: string;
  order_id?: number;
  at: string;
}

export interface Stats {
  orders_by_status: Partial<Record<OrderStatus, number>>;
  orders_last_hour: number;
  delivered_last_hour: number;
  revenue_24h: number;
  riders_online: number;
  riders_available: number;
  avg_assign_seconds: number | null;
  p95_assign_seconds: number | null;
  avg_delivery_minutes: number | null;
  sla_breaches_active: number;
  offers: { sent: number; accepted: number; rejected: number; expired: number };
}

export interface Offer {
  order: Order;
  distance_to_pickup_km?: number;
  expires_in: number;
  expires_at?: number;
}
