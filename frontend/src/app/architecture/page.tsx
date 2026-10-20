import type { Metadata } from "next";
import CloudExplorer from "@/components/architecture/CloudExplorer";
import "./explorer.css";

export const metadata: Metadata = {
  title: "Cloud explorer · DispatchX",
  description: "Explore DispatchX services, Docker containers, Kubernetes orchestration, and AWS architecture through interactive walkthroughs.",
};

export default function ArchitecturePage() {
  return <CloudExplorer />;
}
