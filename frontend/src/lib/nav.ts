import type { NavItem } from "@/components/Navbar";

export const DISPATCH_NAV: NavItem[] = [
  { href: "/dispatch", label: "Operations" },
  { href: "/dispatch/system", label: "System signals" },
  { href: "/architecture", label: "Cloud explorer" },
  { href: "/dispatch/cluster", label: "Live cluster" },
  { href: "/grafana/", label: "Grafana", external: true },
];
