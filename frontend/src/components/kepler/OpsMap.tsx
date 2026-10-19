"use client";

/**
 * Live operations map on kepler.gl.
 *
 * Four in-memory datasets are kept in sync with the dispatcher state:
 *   riders   point layer, coloured by state (available / offer / delivering)
 *   trips    arc layer, pickup → drop for orders in progress
 *   waiting  point layer, pickups still waiting for a rider
 *   demand   hexbin aggregation of every recent pickup
 * Changes are pushed with kepler's addToDataset(..., {upsertBy: "id"}) and
 * removeFromDataset({field, values}), so rows update in place instead of the
 * map being rebuilt on every GPS ping.
 */
import KeplerGl from "@kepler.gl/components";
import { addDataToMap, addToDataset, removeFromDataset, wrapTo } from "@kepler.gl/actions";
import { useEffect, useRef, useState } from "react";
import { Provider, useSelector } from "react-redux";
import type { FleetRider, Order } from "@/lib/types";
import { CITY_CENTER } from "@/lib/format";
import { keplerStore, type KeplerRoot } from "./store";

const MAP_ID = "ops";
const ACTIVE = new Set(["assigned", "picked_up"]);
const WAITING = new Set(["pending", "unassigned"]);

type Row = (string | number | null)[];
const riderState = (r: FleetRider) => (r.order_id ? "delivering" : r.offer ? "offer" : "available");
const riderRow = (r: FleetRider): Row => [String(r.rider_id), r.name ?? `Rider ${r.rider_id}`, riderState(r), r.order_id ?? null, r.lat, r.lng];
const tripRow = (o: Order): Row => [String(o.id), o.status, o.rider_name ?? "", o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng, o.price, o.distance_km];
const waitRow = (o: Order): Row => [String(o.id), o.status, o.pickup_address, o.pickup_lat, o.pickup_lng, o.price];
const demandRow = (o: Order): Row => [String(o.id), o.pickup_lat, o.pickup_lng, o.price];

const dispatch = (a: unknown) => keplerStore.dispatch(wrapTo(MAP_ID, a as never) as never);
// kepler assigns ordinal colours to the *sorted* domain, so pass pairs in sorted order
const custom = (name: string, map: [string, string][]) => ({
  name, type: "custom", category: "Custom", colors: map.map((m) => m[1]), colorMap: map,
});

function initialConfig(riders: FleetRider[], orders: Order[]) {
  return addDataToMap({
    datasets: [
      {
        info: { id: "demand", label: "Demand (pickups)" },
        data: {
          fields: [{ name: "id", type: "string" }, { name: "lat", type: "real" }, { name: "lng", type: "real" }, { name: "price", type: "real" }],
          rows: orders.map(demandRow),
        },
      },
      {
        info: { id: "trips", label: "Active trips" },
        data: {
          fields: [
            { name: "id", type: "string" }, { name: "status", type: "string" }, { name: "rider", type: "string" },
            { name: "pickup_lat", type: "real" }, { name: "pickup_lng", type: "real" },
            { name: "drop_lat", type: "real" }, { name: "drop_lng", type: "real" },
            { name: "price", type: "real" }, { name: "distance_km", type: "real" },
          ],
          rows: orders.filter((o) => ACTIVE.has(o.status)).map(tripRow),
        },
      },
      {
        info: { id: "waiting", label: "Waiting for rider" },
        data: {
          fields: [
            { name: "id", type: "string" }, { name: "status", type: "string" }, { name: "pickup", type: "string" },
            { name: "lat", type: "real" }, { name: "lng", type: "real" }, { name: "price", type: "real" },
          ],
          rows: orders.filter((o) => WAITING.has(o.status)).map(waitRow),
        },
      },
      {
        info: { id: "riders", label: "Riders" },
        data: {
          fields: [
            { name: "id", type: "string" }, { name: "name", type: "string" }, { name: "state", type: "string" },
            { name: "order_id", type: "integer" }, { name: "lat", type: "real" }, { name: "lng", type: "real" },
          ],
          rows: riders.map(riderRow),
        },
      },
    ],
    options: { centerMap: false, readOnly: false, autoCreateLayers: false },
    config: {
      version: "v1",
      config: {
        visState: {
          layerBlending: "normal",
          layers: [
            {
              id: "riders-pt", type: "point",
              config: {
                dataId: "riders", label: "Riders", isVisible: true, color: [31, 186, 214],
                columns: { lat: "lat", lng: "lng" },
                visConfig: { radius: 14, opacity: 1, outline: true, thickness: 2, strokeColor: [14, 17, 22], filled: true,
                  colorRange: custom("Rider state", [["available", "#1FBAD6"], ["delivering", "#A08CF5"], ["offer", "#F0B429"]]) },
              },
              visualChannels: { colorField: { name: "state", type: "string" }, colorScale: "ordinal" },
            },
            {
              id: "waiting-pt", type: "point",
              config: {
                dataId: "waiting", label: "Waiting for rider", isVisible: true, color: [240, 180, 41],
                columns: { lat: "lat", lng: "lng" },
                visConfig: { radius: 18, opacity: 1, outline: true, thickness: 2, strokeColor: [14, 17, 22], filled: true,
                  colorRange: custom("Waiting", [["pending", "#F0B429"], ["unassigned", "#F25F5C"]]) },
              },
              visualChannels: { colorField: { name: "status", type: "string" }, colorScale: "ordinal" },
            },
            {
              id: "trips-arc", type: "arc",
              config: {
                dataId: "trips", label: "Active trips", isVisible: true, color: [160, 140, 245],
                columns: { lat0: "pickup_lat", lng0: "pickup_lng", lat1: "drop_lat", lng1: "drop_lng" },
                visConfig: { opacity: 0.85, thickness: 2, targetColor: [242, 95, 92] },
              },
            },
            {
              id: "demand-hex", type: "hexagon",
              config: {
                dataId: "demand", label: "Demand density", columns: { lat: "lat", lng: "lng" }, isVisible: true,
                visConfig: {
                  opacity: 0.35, worldUnitSize: 0.6, coverage: 0.92, enable3d: false,
                  colorRange: { name: "Demand", type: "sequential", category: "Custom", colors: ["#1b2a3a", "#1d4559", "#1d6478", "#1a8597", "#1FBAD6"] },
                },
              },
            },
          ],
          interactionConfig: {
            tooltip: {
              enabled: true,
              compareMode: false,
              compareType: "absolute",
              fieldsToShow: {
                riders: [{ name: "name", format: null }, { name: "state", format: null }, { name: "order_id", format: null }],
                trips: [{ name: "id", format: null }, { name: "status", format: null }, { name: "rider", format: null }, { name: "price", format: null }],
                waiting: [{ name: "id", format: null }, { name: "status", format: null }, { name: "pickup", format: null }],
                demand: [{ name: "price", format: null }],
              },
            },
          },
        },
        mapState: { latitude: CITY_CENTER[0], longitude: CITY_CENTER[1], zoom: 11.6, pitch: 0, bearing: 0 },
        mapStyle: { styleType: "dark-matter" },
      },
    },
  });
}

function sync(dataId: string, next: Map<string, Row>, prev: Map<string, Row>) {
  const changed: Row[] = [];
  next.forEach((row, id) => {
    const old = prev.get(id);
    if (!old || old.some((v, i) => v !== row[i])) changed.push(row);
  });
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  if (changed.length) dispatch(addToDataset(dataId, changed, { upsertBy: "id" }));
  if (removed.length) dispatch(removeFromDataset(dataId, { field: "id", values: removed }));
}

function Map({ riders, orders, width, height, onSelectOrder }: {
  riders: FleetRider[]; orders: Order[]; width: number; height: number; onSelectOrder?: (id: number) => void;
}) {
  const loaded = useRef(false);
  const last = useRef<Record<string, Map<string, Row>>>({});
  const clicked = useSelector((s: KeplerRoot) => (s.keplerGl as Record<string, { visState?: { clicked?: { object?: unknown; layer?: { props?: { dataId?: string } } } } }>)[MAP_ID]?.visState?.clicked);

  // Build the map once we have the first snapshot
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    dispatch(initialConfig(riders, orders));
    last.current = {
      riders: new globalThis.Map(riders.map((r) => [String(r.rider_id), riderRow(r)])),
      trips: new globalThis.Map(orders.filter((o) => ACTIVE.has(o.status)).map((o) => [String(o.id), tripRow(o)])),
      waiting: new globalThis.Map(orders.filter((o) => WAITING.has(o.status)).map((o) => [String(o.id), waitRow(o)])),
      demand: new globalThis.Map(orders.map((o) => [String(o.id), demandRow(o)])),
    };
  }, [riders, orders]);

  // Push incremental changes
  useEffect(() => {
    if (!loaded.current) return;
    const next = {
      riders: new globalThis.Map(riders.map((r) => [String(r.rider_id), riderRow(r)])),
      trips: new globalThis.Map(orders.filter((o) => ACTIVE.has(o.status)).map((o) => [String(o.id), tripRow(o)])),
      waiting: new globalThis.Map(orders.filter((o) => WAITING.has(o.status)).map((o) => [String(o.id), waitRow(o)])),
      demand: new globalThis.Map(orders.map((o) => [String(o.id), demandRow(o)])),
    };
    for (const id of Object.keys(next) as (keyof typeof next)[]) {
      sync(id, next[id], last.current[id] ?? new globalThis.Map());
    }
    last.current = next;
  }, [riders, orders]);

  // Clicking an order on the map selects it in the dispatcher panel. The row
  // index refers to kepler's own data container, so read the id from there.
  useEffect(() => {
    const obj = clicked?.object as { index?: number } | undefined;
    const dataId = clicked?.layer?.props?.dataId;
    if (!onSelectOrder || typeof obj?.index !== "number" || (dataId !== "trips" && dataId !== "waiting")) return;
    const state = keplerStore.getState().keplerGl as unknown as Record<string, {
      visState: { datasets: Record<string, { dataContainer?: { valueAt: (r: number, c: number) => unknown } }> };
    }>;
    const id = state[MAP_ID]?.visState.datasets[dataId]?.dataContainer?.valueAt(obj.index, 0);
    if (id != null) onSelectOrder(Number(id));
  }, [clicked, onSelectOrder]);

  return (
    <KeplerGl
      id={MAP_ID}
      width={width}
      height={height}
      mapboxApiAccessToken=""
      appName="DispatchX"
      deckGlProps={{ deviceProps: { debug: false } }}
    />
  );
}

export default function OpsMap(props: { riders: FleetRider[]; orders: Order[]; onSelectOrder?: (id: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="absolute inset-0">
      {size.width > 0 && (
        <Provider store={keplerStore}>
          <Map {...props} width={size.width} height={size.height} />
        </Provider>
      )}
    </div>
  );
}
