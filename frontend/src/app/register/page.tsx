"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Navbar";
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
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo /></div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200">
          <h1 className="text-xl font-semibold">Create your account</h1>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
            {(["customer", "rider"] as const).map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => setForm({ ...form, role: r })}
                className={`rounded-lg py-2 text-sm font-medium transition ${form.role === r ? "bg-white shadow text-slate-900" : "text-slate-500"}`}
              >
                {r === "customer" ? "📦 I want to send" : "🛵 I want to ride"}
              </button>
            ))}
          </div>
          <Input label="Full name" required minLength={2} value={form.name} onChange={set("name")} />
          <Input label="Email" type="email" required value={form.email} onChange={set("email")} />
          <Input label="Phone (optional)" value={form.phone} onChange={set("phone")} />
          <Input label="Password" type="password" required minLength={6} value={form.password} onChange={set("password")} />
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">{busy ? <Spinner className="h-4 w-4" /> : "Create account"}</Button>
          <p className="text-center text-sm text-slate-500">
            Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:underline">Log in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
