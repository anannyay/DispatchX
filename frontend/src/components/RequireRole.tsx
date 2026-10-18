"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { homeFor, useAuth } from "@/lib/auth";
import type { Role } from "@/lib/types";
import { Spinner } from "./ui";

export default function RequireRole({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const router = useRouter();
  const allowed = !!user && roles.includes(user.role);

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (!roles.includes(user.role)) router.replace(homeFor(user.role));
  }, [ready, user, roles, router]);

  if (!ready || !allowed) {
    return (
      <div className="grid h-screen place-items-center text-brand-600">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  return <>{children}</>;
}
