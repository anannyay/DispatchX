// Real local backend + three independent browser sessions. Only external address
// lookup is stubbed; auth, quotes, dispatch, sockets, GPS, uploads and orders are real.
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const base = process.env.BASE_URL || "http://localhost:3000";
const apiBase = process.env.API_BASE_URL || base;
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Local test stacks only");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(apiBase).hostname), "Local API only");
const pickup = { display_name: "Demo pickup, Bengaluru", lat: "12.9716", lon: "77.5946" };
const drop = { display_name: "Demo drop, Bengaluru", lat: "12.9750", lon: "77.6000" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/be8AAAAASUVORK5CYII=", "base64");
const errors = [];

async function main() {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
  const sessions = [];
  try {
    async function role(name) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ["geolocation"] });
      sessions.push(context);
      await context.route("https://nominatim.openstreetmap.org/**", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(new URL(route.request().url()).pathname === "/reverse" ? pickup : [new URL(route.request().url()).searchParams.get("q")?.includes("drop") ? drop : pickup]),
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
      await page.goto(`${base}/login`);
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForURL(new RegExp(name === "Dispatcher" ? "/dispatch$" : `/${name.toLowerCase()}$`));
      return page;
    }
    async function visible(locator) { await locator.waitFor({ state: "visible" }); }
    async function api(page, path) {
      return page.evaluate(async ({ apiBase, path }) => {
        const session = JSON.parse(localStorage.getItem("fp_auth"));
        const response = await fetch(`${apiBase}/api${path}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
        return { status: response.status, body: await response.json() };
      }, { apiBase, path });
    }
    async function book(customer) {
      await customer.goto(`${base}/customer`);
      const inputs = customer.getByPlaceholder("Search address or click the map");
      await inputs.nth(0).fill("Demo pickup");
      await customer.getByRole("button", { name: pickup.display_name, exact: true }).click();
      await inputs.nth(1).fill("Demo drop");
      await customer.getByRole("button", { name: drop.display_name, exact: true }).click();
      await visible(customer.getByRole("button", { name: /Book delivery ·/ }));
      const response = customer.waitForResponse((res) => new URL(res.url()).pathname === "/api/orders" && res.request().method() === "POST");
      await customer.getByRole("button", { name: /Book delivery/ }).click();
      const created = await response;
      assert.ok(created.ok(), "booking must succeed against the real API");
      const order = await created.json();
      await customer.waitForURL(`**/customer/orders/${order.id}`);
      return order.id;
    }

    const dispatch = await role("Dispatcher");
    const rider = await role("Rider");
    const customer = await role("Customer");
    await visible(rider.getByRole("button", { name: "Toggle online", exact: true }));
    const before = await api(rider, "/riders/me");
    assert.equal(before.status, 200);
    assert.equal(before.body.active_order, null, "Use an idle local demo rider; do not run the simulator during this test");
    await rider.getByRole("button", { name: "Device GPS", exact: true }).click();
    await rider.getByText("Waiting for device location…", { exact: true }).waitFor({ state: "hidden" });
    if (!before.body.online) await rider.getByRole("button", { name: "Toggle online", exact: true }).click();
    await visible(rider.getByText("Online, accepting jobs", { exact: true }));
    await visible(rider.getByText("Live", { exact: true }));
    console.log("PASS real demo logins and rider WebSocket/GPS setup");

    const id = await book(customer);
    await visible(rider.getByText("New delivery request", { exact: true }));
    await rider.getByRole("button", { name: "Accept", exact: true }).click();
    await visible(customer.getByText("Heading to pickup", { exact: true }));
    await dispatch.getByRole("button", { name: /^active/i }).click();
    await visible(dispatch.getByRole("row").filter({ hasText: `#${id}` }));
    console.log(`PASS customer booked #${id}; rider accepted; dispatcher and customer updated live`);

    const gps = customer.waitForResponse((response) => new URL(response.url()).pathname === `/api/orders/${id}`);
    await customer.reload();
    const current = await (await gps).json();
    assert.equal(current.status, "assigned");
    assert.ok(current.rider_id, "assignment persisted in MySQL");
    await rider.getByRole("button", { name: "Confirm pickup", exact: true }).click();
    await visible(customer.getByText("Heading to drop-off", { exact: true }));
    await visible(rider.getByRole("button", { name: "Photo & complete delivery", exact: true }));
    await rider.locator('input[type="file"]').setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: png });
    await visible(rider.getByRole("status").filter({ hasText: "Delivered! You earned" }));
    await visible(customer.getByRole("img", { name: "Proof of delivery", exact: true }));
    const saved = await api(customer, `/orders/${id}`);
    assert.equal(saved.body.status, "delivered");
    assert.ok(saved.body.pod_key);
    await customer.reload();
    await visible(customer.getByRole("img", { name: "Proof of delivery", exact: true }));
    assert.ok(await customer.getByRole("img", { name: "Proof of delivery" }).evaluate((image) => image.complete && image.naturalWidth > 0), "saved photo is readable");
    const audit = await api(customer, `/orders/${id}/events`);
    for (const status of ["status.pending", "status.assigned", "status.picked_up", "status.delivered"]) assert.ok(audit.body.some((event) => event.type === status), status);
    await dispatch.getByRole("button", { name: /^recent/i }).click();
    await visible(dispatch.getByRole("row").filter({ hasText: `#${id}` }));
    console.log("PASS pickup, photo upload, delivery, audit trail and read-back after reload");

    await rider.getByRole("button", { name: "Toggle online", exact: true }).click();
    const cancelled = await book(customer);
    customer.once("dialog", (dialog) => dialog.accept());
    await customer.getByRole("button", { name: "Cancel order", exact: true }).click();
    await visible(customer.getByText("Cancelled", { exact: true }));
    assert.equal((await api(customer, `/orders/${cancelled}`)).body.status, "cancelled");
    assert.equal((await api(customer, "/admin/infra")).status, 403, "customer cannot inspect staff infrastructure");
    console.log("PASS cancellation persists and customer access to staff infrastructure is rejected");
    assert.deepEqual(errors, [], "no uncaught JavaScript errors in the three consoles");
    console.log("REAL BROWSER DELIVERY PASSED (local backend; address lookup and device coordinates are controlled)");
  } finally {
    for (const context of sessions) await context.close();
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
