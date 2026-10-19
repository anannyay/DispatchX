"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/Navbar";
import { Button, Input, Spinner } from "@/components/ui";
import { homeFor, useAuth } from "@/lib/auth";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "", role: "customer" as "customer" | "rider" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("role") === "rider") setForm((f) => ({ ...f, role: "rider" }));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const u = await register({ ...form, phone: form.phone || undefined });
      router.push(homeFor(u.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-k-canvas px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6"><Wordmark /></div>
        <form onSubmit={submit} className="k-panel space-y-4 p-5">
          <h1 className="text-base font-semibold text-k-hi">Create account</h1>
          <div className="grid grid-cols-2 rounded bg-k-panel p-0.5">
            {(["customer", "rider"] as const).map((r) => (
              <button type="button" key={r} onClick={() => setForm({ ...form, role: r })}
                className={`rounded-[2px] py-1.5 text-xs font-semibold transition ${form.role === r ? "bg-k-hover text-k-hi" : "text-k-label hover:text-k-text"}`}>
                {r === "customer" ? "Customer" : "Rider"}
              </button>
            ))}
          </div>
          <Input label="Full name" required minLength={2} value={form.name} onChange={set("name")} />
          <Input label="Email" type="email" required value={form.email} onChange={set("email")} />
          <Input label="Phone (optional)" value={form.phone} onChange={set("phone")} />
          <Input label="Password" type="password" required minLength={6} value={form.password} onChange={set("password")} />
          {error && <p className="text-xs text-k-err">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">{busy ? <Spinner /> : "Create account"}</Button>
          <p className="text-center text-xs text-k-label">
            Already registered? <Link href="/login" className="text-k-accent hover:underline">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
