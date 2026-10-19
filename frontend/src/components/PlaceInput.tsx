"use client";

import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { searchPlaces, type Place } from "@/lib/geocode";

export default function PlaceInput({
  label, color, value, active, onFocus, onPick,
}: {
  label: string;
  color: string;
  value: string;
  active: boolean;
  onFocus: () => void;
  onPick: (p: Place) => void;
}) {
  const [q, setQ] = useState(value);
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setQ(value), [value]);

  function onChange(v: string) {
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setResults(await searchPlaces(v));
      setOpen(true);
    }, 450);
  }

  return (
    <div className="relative">
      <div className={`flex items-center gap-2.5 rounded border px-3 py-2 transition-colors ${active ? "border-k-accent bg-k-panel" : "border-transparent bg-k-panel hover:bg-k-hover"}`}>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <div className="min-w-0 flex-1">
          <div className="k-label">{label}</div>
          <input
            value={q}
            onFocus={onFocus}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Search address or click the map"
            className="w-full truncate border-0 bg-transparent p-0 text-sm text-k-hi outline-none placeholder:text-k-label"
          />
        </div>
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-[1500] mt-1 w-full overflow-hidden rounded border border-k-line bg-k-side shadow-2xl">
          {results.map((r) => (
            <li key={`${r.lat}${r.lng}`}>
              <button type="button" onMouseDown={() => { onPick(r); setOpen(false); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-k-text hover:bg-k-panel hover:text-k-hi">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-k-label" />
                <span className="truncate">{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
