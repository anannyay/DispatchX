"use client";

import { useEffect, useRef, useState } from "react";
import { searchPlaces, type Place } from "@/lib/geocode";

export default function PlaceInput({
  label, dot, value, active, onFocus, onPick,
}: {
  label: string;
  dot: string;
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
      <div className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset transition ${active ? "ring-2 ring-brand-500 bg-brand-50/40" : "ring-slate-300 bg-white"}`}>
        <span className={`h-3 w-3 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</div>
          <input
            value={q}
            onFocus={onFocus}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Search or click on the map"
            className="w-full truncate border-0 bg-transparent p-0 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-0"
          />
        </div>
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-[1500] mt-1 w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
          {results.map((r) => (
            <li key={`${r.lat}${r.lng}`}>
              <button
                type="button"
                onMouseDown={() => {
                  onPick(r);
                  setOpen(false);
                }}
                className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
