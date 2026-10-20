import type { User } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const KEY = "fp_auth";

export interface Session {
  access_token: string;
  refresh_token: string;
  user: User;
}

export function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let refreshing: Promise<Session | null> | null = null;

async function refreshSession(): Promise<Session | null> {
  const s = loadSession();
  if (!s) return null;
  refreshing ??= fetch(`${API_URL}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  })
    .then(async (r) => {
      if (!r.ok) return null;
      const next = (await r.json()) as Session;
      saveSession(next);
      return next;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string } = {},
): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const send = (token?: string) =>
    fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send(auth ? loadSession()?.access_token : undefined);
  if (res.status === 401 && auth) {
    const next = await refreshSession();
    if (next) res = await send(next.access_token);
    else {
      saveSession(null);
      if (typeof window !== "undefined") window.location.href = "/login";
    }
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? j.detail[0]?.msg : msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
