// Optional real-browser checks. Uses external Playwright + an installed Chrome;
// never logs in to a real backend, sends mutations, or changes cloud resources.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const base = process.env.BASE_URL || "http://127.0.0.1:3200";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "Use a local preview only");
const data = {};
new Function("exports", ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/lib/architecture.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(data);
const errors = [], mutations = [];
let checks = 0;
async function check(name, fn) { await fn(); console.log(`PASS ${name}`); checks++; }
async function visible(locator) { await locator.waitFor({ state: "visible" }); }
async function screenshot(page, name) {
  if (process.env.SCREENSHOT_DIR) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: true });
  }
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page overflow");
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (!["GET", "HEAD"].includes(request.method())) { mutations.push(request.url()); return route.abort(); }
      if (url.origin !== new URL(base).origin) return route.abort();
      return route.continue();
    });
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await check("landing page reaches the public explorer without a backend", async () => {
      await page.goto(base);
      await noOverflow(page);
      await screenshot(page, "dispatchx-home-desktop");
      await page.getByRole("link", { name: "Explore the architecture", exact: true }).click();
      await visible(page.getByRole("heading", { name: "See the system behind every delivery." }));
      assert.equal(await page.getByRole("tab", { name: /Services/ }).getAttribute("aria-selected"), "true");
    });
    for (const layer of data.LAYERS) {
      await check(`${layer.label}: every component has an inspector and source link`, async () => {
        await page.getByRole("tab", { name: new RegExp(layer.label) }).click();
        await page.getByRole("button", { name: "Diagram view", exact: true }).click();
        for (const node of layer.nodes) {
          await page.getByRole("button", { name: `Inspect ${node.label}`, exact: true }).click();
          await visible(page.getByRole("heading", { name: node.label, exact: true }));
          assert.equal(await page.locator(".explorer-source-link").getAttribute("href"), data.SOURCE_ROOT + node.source);
          assert.equal(new URL(page.url()).searchParams.get("node"), node.id);
        }
        await page.evaluate(() => document.fonts.ready);
        const clipped = await page.locator(".explorer-node").evaluateAll((nodes) => nodes.flatMap((node) => {
          const rect = node.querySelector(".explorer-node-bg").getBBox();
          return [...node.querySelectorAll("text")].filter((text) => {
            const box = text.getBBox();
            return box.x < rect.x || box.x + box.width > rect.x + rect.width || box.y + box.height > rect.y + rect.height;
          }).map((text) => text.textContent);
        }));
        assert.deepEqual(clipped, [], "node text must fit inside its component");
        await noOverflow(page);
        await screenshot(page, `dispatchx-${layer.id}-desktop`);
      });
      for (const flow of layer.walkthroughs) {
        await check(`${layer.label}: ${flow.title} traverses every step and replays`, async () => {
          await page.getByRole("button", { name: flow.title, exact: true }).click();
          assert.ok(await page.getByRole("button", { name: "Previous step", exact: true }).isDisabled());
          for (let i = 0; i < flow.steps.length; i++) {
            await visible(page.getByRole("heading", { name: flow.steps[i].title, exact: true }));
            assert.equal(await page.locator(".explorer-node.is-active").count(), flow.steps[i].nodes.length);
            if (i < flow.steps.length - 1) await page.getByRole("button", { name: "Next step", exact: true }).click();
          }
          assert.ok(await page.getByRole("button", { name: "Next step", exact: true }).isDisabled());
          await page.getByRole("button", { name: "Replay", exact: true }).click();
          await visible(page.getByRole("heading", { name: flow.steps[0].title, exact: true }));
          await page.getByRole("button", { name: "Pause", exact: true }).click();
        });
      }
    }
    await check("component and walkthrough links restore after reload; malformed links are safe", async () => {
      await page.goto(`${base}/architecture?layer=services&node=redis`);
      await visible(page.getByRole("heading", { name: "Redis", exact: true }));
      await page.reload();
      await visible(page.getByRole("heading", { name: "Redis", exact: true }));
      await page.goto(`${base}/architecture?layer=aws&flow=request&step=3`);
      await visible(page.getByRole("heading", { name: data.LAYERS[3].walkthroughs[0].steps[2].title, exact: true }));
      await page.goto(`${base}/architecture?layer=invalid&node=bad&flow=gps&step=NaN`);
      await visible(page.getByRole("heading", { name: "A rider sends a location", exact: true }));
    });
    await check("keyboard layer navigation and browser back/forward restore the selected layer", async () => {
      const first = page.getByRole("tab", { name: /Services/ });
      await first.focus();
      await page.keyboard.press("ArrowRight");
      await visible(page.getByRole("heading", { name: "Package once. Run each role separately." }));
      await page.keyboard.press("End");
      await visible(page.getByRole("heading", { name: "From the edge to the data tier." }));
      await page.goBack();
      await visible(page.getByRole("heading", { name: "Package once. Run each role separately." }));
      await page.goForward();
      await visible(page.getByRole("heading", { name: "From the edge to the data tier." }));
    });
    await check("playback advances at the selected pace and pause stops the timer", async () => {
      await page.clock.install();
      await page.goto(`${base}/architecture?layer=services&flow=gps&step=1`);
      await visible(page.getByRole("heading", { name: "A rider sends a location" }));
      await page.getByLabel("Step interval").selectOption("5000");
      await page.getByRole("button", { name: "Play walkthrough", exact: true }).click();
      await page.clock.fastForward(5100);
      await visible(page.getByRole("heading", { name: "Update shared rider state" }));
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.clock.fastForward(20000);
      await visible(page.getByRole("heading", { name: "Update shared rider state" }));
      await page.getByRole("button", { name: "Play walkthrough", exact: true }).click();
      await page.clock.fastForward(5100);
      await visible(page.getByRole("button", { name: "Replay", exact: true }));
      assert.equal(new URL(page.url()).searchParams.get("step"), "3");
    });
    await check("presentation view exits with Escape; copying has a permission-safe fallback", async () => {
      await page.getByRole("button", { name: "Enter presentation view" }).click();
      assert.ok(await page.locator(".explorer-intro").isHidden());
      await page.keyboard.press("Escape");
      assert.ok(await page.locator(".explorer-intro").isVisible());
      await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("Permission denied")) }));
      await page.getByRole("button", { name: "Copy view link", exact: true }).click();
      await visible(page.getByLabel("View link", { exact: true }));
      assert.match(await page.getByLabel("View link", { exact: true }).inputValue(), /layer=services&flow=gps&step=3/);
      await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: (value) => { window.copiedView = value; return Promise.resolve(); } }));
      await page.getByRole("button", { name: "Copy view link", exact: true }).click();
      await visible(page.getByRole("status").filter({ hasText: "View link copied" }));
      assert.match(await page.evaluate(() => window.copiedView), /layer=services&flow=gps&step=3/);
    });
    await check("deployment comparison stays collapsed until requested", async () => {
      const details = page.locator(".explorer-comparison");
      assert.equal(await details.getAttribute("open"), null);
      await details.locator("summary").click();
      await visible(page.getByRole("table"));
      assert.match(await details.innerText(), /does not deploy to EKS/);
    });
    for (const width of [320, 390, 768, 1024]) {
      await check(`responsive ${width}px: no page overflow and every layer is reachable`, async () => {
        const mobile = await context.newPage();
        await mobile.setViewportSize({ width, height: 844 });
        await mobile.goto(base);
        await noOverflow(mobile);
        await mobile.goto(`${base}/architecture?layer=aws`);
        await visible(mobile.getByRole("heading", { name: "From the edge to the data tier." }));
        if (width <= 620) assert.equal(await mobile.getByRole("button", { name: "List view", exact: true }).getAttribute("aria-pressed"), "true");
        for (const layer of data.LAYERS) {
          await mobile.getByRole("tab", { name: new RegExp(layer.label) }).click();
          await mobile.getByLabel("Inspect component", { exact: true }).selectOption(layer.nodes.at(-1).id);
          await visible(mobile.getByRole("heading", { name: layer.nodes.at(-1).label, exact: true }));
          await noOverflow(mobile);
        }
        await screenshot(mobile, `dispatchx-mobile-${width}`);
        await mobile.close();
      });
    }
    await check("a signed-in customer returns to their console, not another login", async () => {
      await page.evaluate(() => localStorage.setItem("fp_auth", JSON.stringify({ user: { id: 1, name: "Browser fixture", role: "customer" }, access_token: "fixture-only", refresh_token: "fixture-only" })));
      await page.goto(`${base}/architecture`);
      await visible(page.getByRole("link", { name: "My console", exact: true }));
      assert.equal(await page.getByRole("link", { name: "My console", exact: true }).getAttribute("href"), "/customer");
    });
    await page.close();
    const cluster = await context.newPage();
    await cluster.addInitScript(() => localStorage.setItem("fp_auth", JSON.stringify({ user: { id: 2, name: "Browser fixture", role: "dispatcher" }, access_token: "fixture-only", refresh_token: "fixture-only" })));
    let mode = "error";
    const empty = { platform: "none", cluster: null, nodes: [], services: [], events: [] };
    const snapshot = {
      ...empty, platform: "ecs", cluster: "browser-fixture",
      nodes: [{ id: "node-fixture", name: "Fixture instance", zone: "test-zone", status: "ACTIVE", cpu_total: 1024, cpu_used: 256, mem_total: 2048, mem_used: 512, started_at: null,
        tasks: [{ id: "task-fixture", service: "api", status: "RUNNING", desired: "RUNNING", health: "HEALTHY", cpu: 256, memory: 512, containers: ["api"], started_at: null }] }],
      services: [{ name: "api", running: 1, desired: 2, pending: 1 }],
    };
    await cluster.route("**/api/admin/infra", (route) => route.fulfill({
      status: mode === "error" ? 503 : 200, contentType: "application/json",
      body: JSON.stringify(mode === "error" ? { detail: "Fixture unavailable" } : mode === "none" ? empty : mode === "platform-error" ? { ...empty, platform: "ecs", error: "Fixture permissions unavailable" } : snapshot),
    }));
    await check("cluster failures show unknown measurements; retry recognizes an unconfigured platform", async () => {
      await cluster.goto(`${base}/dispatch/cluster`);
      await visible(cluster.getByText("Cluster snapshot unavailable", { exact: true }));
      assert.ok(!(await cluster.locator("main").innerText()).includes("No workloads scheduled"));
      mode = "none";
      await cluster.getByRole("button", { name: "Retry now" }).click();
      await visible(cluster.getByText("No orchestrator detected", { exact: true }).last());
      await noOverflow(cluster);
    });
    await check("cluster inspection retains the last good snapshot and disables chaos while stale", async () => {
      mode = "valid";
      await cluster.reload();
      await visible(cluster.getByText("Fixture instance", { exact: true }));
      await cluster.getByRole("button").filter({ hasText: "task-fix" }).click();
      const chaos = cluster.getByRole("button", { name: /Chaos test: stop this task/ });
      await visible(chaos);
      await cluster.getByRole("button", { name: "Pause", exact: true }).click();
      assert.ok(await chaos.isDisabled());
      mode = "platform-error";
      await cluster.getByRole("button", { name: "Resume", exact: true }).click();
      await visible(cluster.getByRole("status").filter({ hasText: "Fixture permissions unavailable" }));
      await visible(cluster.getByText("Fixture instance", { exact: true }));
      assert.ok(await chaos.isDisabled());
      assert.match(await cluster.getByRole("status").innerText(), /last successful snapshot/);
      await cluster.setViewportSize({ width: 390, height: 844 });
      await noOverflow(cluster);
      await screenshot(cluster, "dispatchx-cluster-stale-fixture");
    });
    await cluster.close();
    await check("mobile operations keeps extra metrics and the dispatch log accessible", async () => {
      const operations = await context.newPage();
      await operations.setViewportSize({ width: 390, height: 844 });
      await operations.addInitScript(() => localStorage.setItem("fp_auth", JSON.stringify({ user: { id: 2, name: "Browser fixture", role: "dispatcher" }, access_token: "fixture-only", refresh_token: "fixture-only" })));
      await operations.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
        new URL(route.request().url()).pathname.endsWith("/admin/stats")
          ? { orders_by_status: {}, riders_online: 0, riders_available: 0, delivered_last_hour: 0, avg_assign_seconds: null, p95_assign_seconds: null, avg_delivery_minutes: null, revenue_24h: 0, sla_breaches_active: 0, offers: { accepted: 0, sent: 0, rejected: 0, expired: 0 } }
          : []
      ) }));
      await operations.goto(`${base}/dispatch`);
      await visible(operations.getByText("Nothing needs attention.", { exact: true }));
      const metrics = operations.getByRole("button", { name: "More metrics", exact: true });
      assert.equal(await metrics.getAttribute("aria-expanded"), "false");
      await metrics.click();
      await visible(operations.getByText("Revenue 24h", { exact: true }));
      const log = operations.locator("details");
      assert.equal(await log.getAttribute("open"), null);
      await log.locator("summary").click();
      await visible(operations.getByText("Waiting for activity. Start the simulator to see live dispatch.", { exact: true }));
      await noOverflow(operations);
      await screenshot(operations, "dispatchx-operations-mobile-fixture");
      await operations.close();
    });
    await check("no JavaScript page errors or mutation requests during exploration", async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(mutations, []);
    });
    console.log(`${checks} browser checks passed (real Chrome, local preview; no live backend).`);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
