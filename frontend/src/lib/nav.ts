import type { NavItem } from "@/components/Navbar";

export const DISPATCH_NAV: NavItem[] = [
  { href: "/dispatch", label: "Operations" },
  { href: "/dispatch/cluster", label: "Cluster" },
  { href: "/grafana/", label: "Grafana", external: true },
];
