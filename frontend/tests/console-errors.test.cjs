const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Run the actual page components with controlled hooks, requests and device callbacks.
// This checks async state transitions, not DOM layout or React's own scheduler.
function consoleHarness(name, { geolocation } = {}) {
  const requests = [], geocodes = [], slots = [], effects = [], events = new Map();
  const timers = new Map();
  let cursor = 0, dirty = true, mounted = true, tree, timerId = 0, lateWrites = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => {
        if (!mounted) { lateWrites++; return; }
        const value = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const i = cursor++;
      return slots[i] ??= { current: initial };
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        const old = slots[i];
        slots[i] = { deps, cleanup: old?.cleanup, effect: fn };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const pending = (list, details) => new Promise((resolve, reject) => list.push({ ...details, resolve, reject }));
  const stubs = {
    react: hooks,
    "next/navigation": { useRouter: () => ({ push() {} }) },
    "next/link": "Link",
    "lucide-react": Object.fromEntries(["ArrowRight", "MousePointerClick", "Camera", "Check", "Crosshair", "Navigation", "Pause", "Play"].map((key) => [key, key])),
    "@/components/ui": { Button: "Button", Empty: "Empty", Spinner: "Spinner", StatusBadge: "StatusBadge" },
    "@/lib/api": { api: (url, options) => pending(requests, { url, options }), ApiError: Error },
    "@/lib/format": { CITY_CENTER: [12.97, 77.59], inr: (n) => `INR ${n}`, timeAgo: () => "now", haversineKm: () => 1 },
    "@/lib/geocode": { reverseGeocode: (lat, lng) => pending(geocodes, { lat, lng }) },
    "@/lib/socket": {
      getSocket: () => ({ emit() {} }),
      useSocketEvent: (event, callback) => hooks.useEffect(() => {
        events.set(event, callback);
        return () => events.delete(event);
      }, [event, callback]),
    },
  };
  for (const component of ["MapView", "Navbar", "PlaceInput", "RequireRole", "Toasts"]) stubs[`@/components/${component}`] = component;
  const filename = path.join(__dirname, `../src/app/${name}/page.tsx`);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", "navigator", "setInterval", "clearInterval", output)(
    (id) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      assert.equal(id, "react/jsx-runtime", `Unexpected dependency: ${id}`);
      return require(id);
    }, mod, mod.exports, { geolocation },
    (fn) => { timers.set(++timerId, fn); return timerId; }, (id) => timers.delete(id),
  );
  const Component = mod.exports.default().props.children.type;
  function render() {
    for (let count = 0; dirty; count++) {
      assert.ok(count < 30, "render must settle");
      dirty = false;
      cursor = 0;
      tree = Component();
      for (const effect of effects.splice(0)) effect();
    }
  }
  function nodes(node) {
    if (node == null || typeof node === "boolean") return [];
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
    return [node, ...(node.props ? nodes(node.props.children) : [])];
  }
  const text = (node = tree) => nodes(node).filter((n) => typeof n === "string" || typeof n === "number").join(" ");
  const find = (type, predicate = () => true) => {
    const result = nodes(tree).find((n) => n.type === type && predicate(n.props));
    assert.ok(result, `Missing ${type} in: ${text()}`);
    return result.props;
  };
  const button = (label) => {
    const result = nodes(tree).find((n) => ["Button", "button"].includes(n.type) && text(n).includes(label));
    assert.ok(result, `Missing button ${label} in: ${text()}`);
    return result.props;
  };
  render();
  return {
    requests, geocodes, text, find, button, render,
    pick(label, place) { find("PlaceInput", (p) => p.label === label).onPick(place); render(); },
    click(label) { const props = button(label); assert.ok(!props.disabled); const result = props.onClick(); render(); return result; },
    event(name, data) { events.get(name)?.(data); render(); },
    replayEffects() {
      // React Strict Mode replays setup/cleanup on mount; the first request may still finish.
      for (const slot of slots) if (slot?.effect) slot.cleanup?.();
      for (const slot of slots) if (slot?.effect) slot.cleanup = slot.effect();
      render();
    },
    async settle() {
      // Drain promise chains, including catch/finally and any resulting effects.
      for (let i = 0; i < 12; i++) { await Promise.resolve(); render(); }
    },
    unmount() { for (const slot of slots) if (slot?.effect) slot.cleanup?.(); mounted = false; },
    get lateWrites() { return lateWrites; },
  };
}

const pickup = { label: "Pickup A", lat: 12.97, lng: 77.59 };
const drop = { label: "Drop B", lat: 13.01, lng: 77.63 };
const quote = (price) => ({ price, distance_km: price / 10, eta_minutes: 12 });
const rider = (overrides = {}) => ({ id: 1, name: "Test rider", online: false, active_order: null, offer: null, deliveries: 0, earnings: 0, rating: 5, vehicle: null, ...overrides });
const offer = (id) => ({ order: { id, status: "pending", price: 100, distance_km: 2, pickup_lat: 12.97, pickup_lng: 77.59, pickup_address: "Pickup", drop_address: "Drop" }, expires_in: 20, expires_at: Date.now() / 1000 + 20 });
const quoteRequests = (h) => h.requests.filter((r) => r.url === "/orders/quote");

test("customer initial failure is retryable and only a successful empty list shows no deliveries", async () => {
  const h = consoleHarness("customer");
  assert.match(h.text(), /Loading deliveries/);
  h.requests[0].reject(new Error("Orders unavailable"));
  await h.settle();
  assert.match(h.text(), /Could not load deliveries/);
  assert.match(h.text(), /Orders unavailable/);
  assert.doesNotMatch(h.text(), /No active deliveries/);
  h.click("Retry deliveries");
  assert.match(h.text(), /Loading deliveries/);
  h.requests[1].resolve([]);
  await h.settle();
  assert.equal(h.find("Empty").title, "No active deliveries");
  assert.doesNotMatch(h.text(), /Orders unavailable|Loading deliveries/);
});

test("customer quote ignores an older success and clears previous values while loading", async () => {
  const h = consoleHarness("customer");
  h.pick("Pickup", pickup);
  h.pick("Drop", drop);
  const old = quoteRequests(h)[0];
  assert.match(h.text(), /Calculating quote/);
  h.pick("Drop", { ...drop, label: "Drop C", lng: 77.65 });
  const latest = quoteRequests(h)[1];
  latest.resolve(quote(200));
  await h.settle();
  assert.match(h.text(), /INR 200/);
  old.resolve(quote(100));
  await h.settle();
  assert.match(h.text(), /INR 200/);
  assert.doesNotMatch(h.text(), /INR 100/);
  h.pick("Drop", { ...drop, lng: 77.66 });
  assert.doesNotMatch(h.text(), /INR 200/);
  assert.match(h.text(), /Calculating quote/);
});

test("an older quote failure cannot clear a newer successful fare", async () => {
  const h = consoleHarness("customer");
  h.pick("Pickup", pickup);
  h.pick("Drop", drop);
  h.pick("Drop", { ...drop, lng: 77.65 });
  quoteRequests(h)[1].resolve(quote(200));
  await h.settle();
  quoteRequests(h)[0].reject(new Error("Obsolete error"));
  await h.settle();
  assert.match(h.text(), /INR 200/);
  assert.doesNotMatch(h.text(), /Obsolete error|Calculating quote/);
});

test("customer quote ignores an older failure without ending the latest loading state", async () => {
  const h = consoleHarness("customer");
  h.pick("Pickup", pickup);
  h.pick("Drop", drop);
  h.pick("Drop", { ...drop, lng: 77.65 });
  quoteRequests(h)[0].reject(new Error("Old failure"));
  await h.settle();
  assert.match(h.text(), /Calculating quote/);
  assert.doesNotMatch(h.text(), /Old failure/);
  quoteRequests(h)[1].resolve(quote(200));
  await h.settle();
  assert.match(h.text(), /INR 200/);
});

test("failed quotes clear the fare and can retry the selected route", async () => {
  const h = consoleHarness("customer");
  h.pick("Pickup", pickup);
  h.pick("Drop", drop);
  quoteRequests(h)[0].resolve(quote(100));
  await h.settle();
  h.pick("Drop", { ...drop, lng: 77.65 });
  quoteRequests(h)[1].reject(new Error("Route unavailable"));
  await h.settle();
  assert.match(h.text(), /Route unavailable/);
  assert.doesNotMatch(h.text(), /INR 100|Calculating quote/);
  h.click("Retry quote");
  const retry = quoteRequests(h)[2];
  assert.equal(retry.options.body.drop.lng, 77.65);
  retry.resolve(quote(250));
  await h.settle();
  assert.match(h.text(), /INR 250/);
  assert.doesNotMatch(h.text(), /Route unavailable/);
});

test("quote failure preserves the existing ability to book with the selected route", async () => {
  const h = consoleHarness("customer");
  h.pick("Pickup", pickup);
  h.pick("Drop", drop);
  quoteRequests(h)[0].reject(new Error("Quote unavailable"));
  await h.settle();
  h.click("Book delivery");
  const booking = h.requests.find((r) => r.url === "/orders");
  assert.equal(booking.options.method, "POST");
  assert.deepEqual(booking.options.body, {
    pickup: { address: pickup.label, lat: pickup.lat, lng: pickup.lng },
    drop: { address: drop.label, lat: drop.lat, lng: drop.lng },
    package_note: null,
  });
});

test("a failure with an empty message still shows a retry, not an empty order list", async () => {
  const h = consoleHarness("customer");
  h.requests[0].reject(new Error(""));
  await h.settle();
  assert.match(h.text(), /Could not load deliveries/);
  assert.ok(h.button("Retry deliveries"));
});

test("an incomplete route cannot resurrect an in-flight quote", async () => {
  const h = consoleHarness("customer");
  h.pick("Pickup", pickup);
  h.pick("Drop", drop);
  h.pick("Drop", null);
  quoteRequests(h)[0].resolve(quote(100));
  await h.settle();
  assert.doesNotMatch(h.text(), /INR 100|Calculating quote/);
  assert.ok(h.button("Book delivery").disabled);
});

test("map reverse geocoding cannot rename a newer same-latitude selection", async () => {
  const h = consoleHarness("customer");
  h.find("MapView").onMapClick(12.97, 77.59);
  h.render();
  h.find("PlaceInput", (p) => p.label === "Pickup").onFocus();
  h.render();
  h.find("MapView").onMapClick(12.97, 77.65);
  h.render();
  h.geocodes[0].resolve("Older address");
  await h.settle();
  assert.notEqual(h.find("PlaceInput", (p) => p.label === "Pickup").value, "Older address");
  h.geocodes[1].resolve("Current address");
  await h.settle();
  assert.equal(h.find("PlaceInput", (p) => p.label === "Pickup").value, "Current address");
});

test("rider initial failure exits loading and retries successfully", async () => {
  const h = consoleHarness("rider");
  assert.match(h.text(), /Loading rider console/);
  h.requests[0].reject(new Error("Rider unavailable"));
  await h.settle();
  assert.match(h.text(), /Rider console unavailable/);
  assert.match(h.text(), /Rider unavailable/);
  assert.doesNotMatch(h.text(), /Loading rider console/);
  h.click("Retry");
  assert.match(h.text(), /Loading rider console/);
  h.requests[1].resolve(rider());
  await h.settle();
  assert.match(h.text(), /Offline/);
  assert.doesNotMatch(h.text(), /Rider unavailable|Loading rider console/);
});

for (const name of ["customer", "rider"]) {
  test(`${name} ignores superseded initial successes and failures after effect replay`, async () => {
    for (const staleFailure of [false, true]) {
      const h = consoleHarness(name);
      h.replayEffects();
      assert.equal(h.requests.length, 2);
      h.requests[1].resolve(name === "customer" ? [] : rider());
      await h.settle();
      if (staleFailure) h.requests[0].reject(new Error("Obsolete failure"));
      else h.requests[0].resolve(name === "customer" ? [{ id: 99, status: "delivered" }] : rider({ online: true }));
      await h.settle();
      if (name === "customer") assert.doesNotMatch(h.text(), /History/);
      else assert.match(h.text(), /Offline/);
      assert.doesNotMatch(h.text(), /Obsolete failure|Loading/);
    }
  });
}

test("rider refresh resets a missing offer and retains usable data on refresh failure", async () => {
  const h = consoleHarness("rider");
  h.requests[0].resolve(rider({ offer: offer(10) }));
  await h.settle();
  assert.match(h.text(), /New delivery request/);
  h.find("button", (p) => p["aria-label"] === "Toggle online").onClick();
  h.requests[1].resolve({});
  await h.settle();
  assert.equal(h.requests[2].url, "/riders/me");
  h.requests[2].resolve(rider({ online: true }));
  await h.settle();
  assert.doesNotMatch(h.text(), /New delivery request/);
  h.find("button", (p) => p["aria-label"] === "Toggle online").onClick();
  h.requests[3].resolve({});
  await h.settle();
  h.requests[4].reject(new Error("Refresh unavailable"));
  await h.settle();
  assert.match(h.text(), /Refresh unavailable/);
  assert.match(h.text(), /Online, accepting jobs/);
  h.click("Retry");
  h.requests[5].resolve(rider());
  await h.settle();
  assert.match(h.text(), /Offline/);
  assert.doesNotMatch(h.text(), /Refresh unavailable/);
});

test("a rider refresh cannot erase an offer received after the request started", async () => {
  const h = consoleHarness("rider");
  h.event("job:offer", offer(22));
  h.requests[0].resolve(rider({ online: true }));
  await h.settle();
  assert.match(h.text(), /New delivery request/);
});

test("a rider refresh cannot resurrect an offer closed while the request was pending", async () => {
  const h = consoleHarness("rider");
  h.event("job:offer_closed", { order_id: 22 });
  h.requests[0].resolve(rider({ online: true, offer: offer(22) }));
  await h.settle();
  assert.doesNotMatch(h.text(), /New delivery request/);
});

test("denied GPS falls back to demo controls, clears the watch and ignores late callbacks", async () => {
  let success, failure, cleared;
  const h = consoleHarness("rider", { geolocation: {
    watchPosition(ok, fail) { success = ok; failure = fail; return 42; },
    clearWatch(id) { cleared = id; },
  } });
  h.requests[0].resolve(rider());
  await h.settle();
  h.click("Device GPS");
  assert.match(h.text(), /Waiting for device location/);
  assert.equal(h.find("MapView").onMapClick, undefined);
  failure({ code: 1 });
  await h.settle();
  assert.match(h.text(), /permission denied.*demo mode/);
  assert.doesNotMatch(h.text(), /Waiting for device location/);
  assert.equal(h.button("Demo (click map)")["aria-pressed"], true);
  assert.equal(typeof h.find("MapView").onMapClick, "function");
  assert.equal(cleared, 42);
  const position = h.find("MapView").center;
  success({ coords: { latitude: 0, longitude: 0, heading: 0 } });
  await h.settle();
  assert.deepEqual(h.find("MapView").center, position);
});

test("unsupported GPS falls back instead of stranding the rider in device mode", async () => {
  const h = consoleHarness("rider");
  h.requests[0].resolve(rider());
  await h.settle();
  h.click("Device GPS");
  assert.match(h.text(), /not supported.*demo mode/);
  assert.equal(typeof h.find("MapView").onMapClick, "function");
});

test("GPS timeout uses accurate fallback feedback; successful GPS accepts north heading", async () => {
  let success, failure;
  const h = consoleHarness("rider", { geolocation: {
    watchPosition(ok, fail) { success = ok; failure = fail; return 1; }, clearWatch() {},
  } });
  h.requests[0].resolve(rider());
  await h.settle();
  h.click("Device GPS");
  success({ coords: { latitude: 13, longitude: 78, heading: 90 } });
  await h.settle();
  success({ coords: { latitude: 13.1, longitude: 78.1, heading: 0 } });
  await h.settle();
  assert.equal(h.find("MapView").markers[0].heading, 0);
  failure({ code: 3 });
  await h.settle();
  assert.match(h.text(), /Device location unavailable.*demo mode/);
  assert.doesNotMatch(h.text(), /permission denied/);
});

test("unmounted consoles ignore pending initial and quote responses", async () => {
  const customer = consoleHarness("customer");
  customer.pick("Pickup", pickup);
  customer.pick("Drop", drop);
  customer.unmount();
  customer.requests[0].resolve([]);
  quoteRequests(customer)[0].resolve(quote(100));
  const driver = consoleHarness("rider");
  driver.unmount();
  driver.requests[0].reject(new Error("Late failure"));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(customer.lateWrites, 0);
  assert.equal(driver.lateWrites, 0);
});
