"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/Navbar";
import { Button, Input, Spinner } from "@/components/ui";
import { homeFor, useAuth } from "@/lib/auth";

const DEMOS = [
  { label: "Customer", email: "customer@dispatchx.dev" },
  { label: "Rider", email: "rider@dispatchx.dev" },
  { label: "Dispatcher", email: "dispatch@dispatchx.dev" },
];

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const u = await login(creds?.email ?? email, creds?.password ?? password);
      router.push(homeFor(u.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo /></div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200">
          <h1 className="text-xl font-semibold">Welcome back</h1>
          <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <Input label="Password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">{busy ? <Spinner className="h-4 w-4" /> : "Log in"}</Button>
          <p className="text-center text-sm text-slate-500">
            New here? <Link href="/register" className="font-medium text-brand-600 hover:underline">Create an account</Link>
          </p>
        </form>
        <div className="mt-6">
          <div className="mb-2 text-center text-xs font-medium uppercase tracking-wider text-slate-400">Quick demo login</div>
          <div className="grid grid-cols-3 gap-2">
            {DEMOS.map((d) => (
              <button
                key={d.email}
                disabled={busy}
                onClick={() => submit(undefined, { email: d.email, password: "dispatchx123" })}
                className="rounded-xl bg-white px-2 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
