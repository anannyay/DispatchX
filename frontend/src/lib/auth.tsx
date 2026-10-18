"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, loadSession, saveSession, type Session } from "./api";
import type { Role, User } from "./types";

interface AuthCtx {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (data: { name: string; email: string; password: string; phone?: string; role: Role }) => Promise<User>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function homeFor(role: Role) {
  return role === "rider" ? "/rider" : role === "customer" ? "/customer" : "/dispatch";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(loadSession()?.user ?? null);
    setReady(true);
  }, []);

  const accept = useCallback((s: Session) => {
    saveSession(s);
    setUser(s.user);
    return s.user;
  }, []);

  const login = useCallback(
    async (email: string, password: string) =>
      accept(await api<Session>("/auth/login", { method: "POST", body: { email, password }, auth: false })),
    [accept],
  );

  const register = useCallback(
    async (data: { name: string; email: string; password: string; phone?: string; role: Role }) =>
      accept(await api<Session>("/auth/register", { method: "POST", body: data, auth: false })),
    [accept],
  );

  const logout = useCallback(() => {
    saveSession(null);
    setUser(null);
    window.location.href = "/login";
  }, []);

  return <Ctx.Provider value={{ user, ready, login, register, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
