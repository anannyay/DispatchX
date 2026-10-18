// OpenStreetMap Nominatim (free, no key). Biased to the demo city.
const VIEWBOX = "77.40,13.15,77.80,12.80";

export interface Place {
  label: string;
  lat: number;
  lng: number;
}

export async function searchPlaces(q: string): Promise<Place[]> {
  if (q.trim().length < 3) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=in&viewbox=${VIEWBOX}&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    return rows.map((r) => ({ label: r.display_name.split(",").slice(0, 3).join(","), lat: +r.lat, lng: +r.lon }));
  } catch {
    return [];
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const fallback = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&lat=${lat}&lon=${lng}`, {
      headers: { "Accept-Language": "en" },
    });
    const j = (await res.json()) as { display_name?: string };
    return j.display_name ? j.display_name.split(",").slice(0, 3).join(",") : fallback;
  } catch {
    return fallback;
  }
}
