"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bike, Package, Radar } from "lucide-react";
import { Wordmark } from "@/components/Navbar";
import { Button, Input, Spinner } from "@/components/ui";
import { homeFor, useAuth } from "@/lib/auth";

const DEMOS = [
  { label: "Customer", email: "customer@dispatchx.dev", icon: Package },
  { label: "Rider", email: "rider@dispatchx.dev", icon: Bike },
  { label: "Dispatcher", email: "dispatch@dispatchx.dev", icon: Radar },
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
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-k-canvas px-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-6"><Wordmark /></div>
        <form onSubmit={submit} className="k-panel space-y-4 p-5">
          <div>
            <h1 className="text-base font-semibold text-k-hi">Sign in</h1>
            <p className="text-xs text-k-label">Use your account or a demo role below.</p>
          </div>
          <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <Input label="Password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {error && <p className="text-xs text-k-err">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">{busy ? <Spinner /> : "Sign in"}</Button>
          <p className="text-center text-xs text-k-label">
            No account? <Link href="/register" className="text-k-accent hover:underline">Create one</Link>
          </p>
        </form>
        <div className="mt-4">
          <div className="k-label mb-2">Demo roles</div>
          <div className="grid grid-cols-3 gap-2">
            {DEMOS.map(({ label, email: demo, icon: Icon }) => (
              <button
                key={demo}
                disabled={busy}
                onClick={() => submit(undefined, { email: demo, password: "dispatchx123" })}
                className="flex flex-col items-center gap-1.5 rounded border border-k-line bg-k-side py-3 text-xs font-medium text-k-text transition hover:border-k-accent hover:text-k-hi"
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
