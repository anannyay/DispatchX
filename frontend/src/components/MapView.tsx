"use client";

import dynamic from "next/dynamic";
import type { MapProps } from "./Map";

// Leaflet touches `window`, so it is loaded only in the browser
const Map = dynamic(() => import("./Map"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-slate-200" />,
});

export default function MapView(props: MapProps) {
  return <Map {...props} />;
}
export type { MapMarker, MapLine } from "./Map";
