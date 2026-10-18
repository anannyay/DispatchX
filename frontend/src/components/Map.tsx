"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";

export type MarkerKind = "pickup" | "drop" | "rider" | "rider-busy" | "rider-offer" | "me" | "order";

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  kind: MarkerKind;
  label?: string;
  heading?: number;
  onClick?: () => void;
  highlight?: boolean;
}

export interface MapLine {
  id: string;
  points: [number, number][];
  color?: string;
  dashed?: boolean;
}

export interface MapProps {
  center: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  lines?: MapLine[];
  onMapClick?: (lat: number, lng: number) => void;
  fitTo?: [number, number][];
  fitKey?: string | number;
  dark?: boolean;
  className?: string;
}

const PIN = (color: string, glyph: string) =>
  `<div class="fp-pin" style="--c:${color}"><span>${glyph}</span></div>`;

function iconFor(m: MapMarker) {
  switch (m.kind) {
    case "pickup":
      return L.divIcon({ className: "", html: PIN("#10b981", "A"), iconSize: [30, 40], iconAnchor: [15, 38] });
    case "drop":
      return L.divIcon({ className: "", html: PIN("#ef4444", "B"), iconSize: [30, 40], iconAnchor: [15, 38] });
    case "order":
      return L.divIcon({
        className: "",
        html: `<div class="fp-order ${m.highlight ? "fp-order-hot" : ""}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
    case "me":
      return L.divIcon({
        className: "fp-smooth",
        html: `<div class="fp-me"><i></i></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
    default: {
      const color = m.kind === "rider" ? "#10b981" : m.kind === "rider-offer" ? "#f59e0b" : "#6366f1";
      return L.divIcon({
        className: "fp-smooth",
        html: `<div class="fp-rider ${m.highlight ? "fp-rider-hl" : ""}" style="--c:${color}">
                 <div class="fp-arrow" style="transform:rotate(${m.heading ?? 0}deg)"></div>
                 <span>🛵</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
    }
  }
}

function ClickHandler({ onMapClick }: { onMapClick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onMapClick?.(e.latlng.lat, e.latlng.lng) });
  return null;
}

function Fit({ points, fitKey }: { points?: [number, number][]; fitKey?: string | number }) {
  const map = useMap();
  useEffect(() => {
    if (!points || points.length === 0) return;
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 14));
    else map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map]);
  return null;
}

function MarkerItem({ m }: { m: MapMarker }) {
  // Re-create the icon only when its look changes, not on every position update
  const icon = useMemo(() => iconFor(m), [m.kind, m.heading, m.highlight]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Marker
      position={[m.lat, m.lng]}
      icon={icon}
      eventHandlers={m.onClick ? { click: m.onClick } : undefined}
      zIndexOffset={m.kind.startsWith("rider") || m.kind === "me" ? 500 : 0}
    >
      {m.label && <Tooltip direction="top" offset={[0, -14]}>{m.label}</Tooltip>}
    </Marker>
  );
}

export default function Map({
  center, zoom = 13, markers = [], lines = [], onMapClick, fitTo, fitKey, dark, className,
}: MapProps) {
  const tiles = dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
  return (
    <MapContainer center={center} zoom={zoom} className={className ?? "h-full w-full"} zoomControl={false}>
      <TileLayer
        url={tiles}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
      />
      <ClickHandler onMapClick={onMapClick} />
      <Fit points={fitTo} fitKey={fitKey} />
      {lines.map((l) => (
        <Polyline
          key={l.id}
          positions={l.points}
          pathOptions={{ color: l.color ?? "#10b981", weight: 4, opacity: 0.8, dashArray: l.dashed ? "6 8" : undefined }}
        />
      ))}
      {markers.map((m) => (
        <MarkerItem key={m.id} m={m} />
      ))}
    </MapContainer>
  );
}
