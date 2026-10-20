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
    context.setDefaultTimeout(10000);
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
    await cluster.addInitScript(() => localStorage.setItem("fp_auth", JSON.stringify({ user: { id: 2, name: "Browser fixture", role: "admin" }, access_token: "fixture-only", refresh_token: "fixture-only" })));
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
      body: JSON.stringify(mode === "error" ? { detail: "Fixture unavailable" } : mode === "none" ? empty : mode === "platform-error" ? { ...empty, platform: "ecs", error: "Fixture permissions unavailable" } : mode === "allowed" ? { ...snapshot, capabilities: { chaos_enabled: true, can_stop_tasks: true } } : snapshot),
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
      assert.ok(await chaos.isDisabled(), "missing capability is fail-closed even for an administrator");
      mode = "allowed";
      await cluster.reload();
      await cluster.getByRole("button").filter({ hasText: "task-fix" }).click();
      await visible(chaos);
      assert.ok(await chaos.isEnabled(), "the permitted fixture is enabled before pause; never click it");
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
    const demo = await context.newPage();
    await check("demo presets generate bounded commands without executing them", async () => {
      await demo.goto(`${base}/demo`);
      await visible(demo.getByRole("heading", { name: "Explain the system. Show the evidence." }));
      assert.match(await demo.getByRole("textbox", { name: "PowerShell simulator command", exact: true }).inputValue(), /--riders '5'.*--duration '300'/);
      await demo.getByRole("combobox", { name: "Preset", exact: true }).selectOption("busy");
      assert.match(await demo.getByRole("textbox", { name: "POSIX simulator command", exact: true }).inputValue(), /--riders '20'.*--orders-per-min '6'/);
      await demo.getByRole("combobox", { name: "Preset", exact: true }).selectOption("failure");
      assert.match(await demo.getByRole("textbox", { name: "POSIX simulator command", exact: true }).inputValue(), /--accept-rate '0'.*--duration '240'/);
      assert.match(await demo.getByRole("textbox", { name: "Seed accounts · local Compose only", exact: true }).inputValue(), /--riders 3 --customers 5$/);
      assert.equal(await demo.locator("#walkthrough ol > li").count(), 7);
    });
    await check("invalid demo settings keep copy controls visible but disabled; reset preserves target", async () => {
      await demo.getByLabel("Simulator base URL", { exact: true }).fill("http://localhost:8000/demo-target");
      await demo.getByLabel(/^Riders ·/).fill("101");
      for (const name of ["Copy PowerShell", "Copy POSIX", "Copy seed command"]) {
        const button = demo.getByRole("button", { name, exact: true });
        await visible(button);
        assert.ok(await button.isDisabled());
      }
      await demo.getByRole("button", { name: "Reset preset", exact: true }).click();
      assert.equal(await demo.getByLabel(/^Riders ·/).inputValue(), "3");
      assert.equal(await demo.getByLabel("Simulator base URL", { exact: true }).inputValue(), "http://localhost:8000/demo-target");
      await demo.getByLabel("Simulator base URL", { exact: true }).fill("file:///not-a-server");
      assert.ok(await demo.getByRole("button", { name: "Copy PowerShell", exact: true }).isDisabled());
      await demo.getByLabel("Simulator base URL", { exact: true }).fill("http://localhost:8000");
      assert.ok(await demo.getByRole("button", { name: "Copy PowerShell", exact: true }).isEnabled());
    });
    await check("demo clipboard refusal selects the persistent command; success copies exact text", async () => {
      await demo.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("Permission denied")) }));
      await demo.getByRole("button", { name: "Copy PowerShell", exact: true }).click();
      await visible(demo.getByRole("status").filter({ hasText: "Clipboard unavailable. Command selected" }));
      const command = demo.getByRole("textbox", { name: "PowerShell simulator command", exact: true });
      assert.ok(await command.evaluate((input) => document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length));
      await demo.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: (value) => { window.copiedCommand = value; return Promise.resolve(); } }));
      await demo.getByRole("button", { name: "Copy PowerShell", exact: true }).click();
      await visible(demo.getByRole("status").filter({ hasText: "Copied. Paste into your terminal when ready." }));
      assert.equal(await demo.evaluate(() => window.copiedCommand), await command.inputValue());
    });
    for (const width of [320, 390, 768, 1440]) {
      await check(`demo ${width}px: configuration, copy, reset and presentation links remain reachable`, async () => {
        await demo.setViewportSize({ width, height: 900 });
        await noOverflow(demo);
        for (const name of ["Reset preset", "Copy PowerShell", "Copy POSIX", "Copy seed command"]) {
          const control = demo.getByRole("button", { name, exact: true });
          await control.scrollIntoViewIfNeeded();
          await visible(control);
          const box = await control.boundingBox();
          assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${name} fits viewport`);
        }
        await screenshot(demo, `dispatchx-demo-${width}`);
      });
    }
    await demo.close();
    const system = await context.newPage();
    // The explorer's accelerated playback clock applies to the whole context.
    // Align it with the fixture server before testing sample freshness.
    await system.clock.setSystemTime(new Date());
    await system.addInitScript(() => localStorage.setItem("fp_auth", JSON.stringify({ user: { id: 2, name: "Browser fixture", role: "dispatcher" }, access_token: "fixture-only", refresh_token: "fixture-only" })));
    let systemMode = "hold", releaseSystem, activeRequests = 0, peakRequests = 0;
    const systemSample = () => ({
      sampled_at: new Date(Date.now() - (systemMode === "stale" ? 30000 : 0)).toISOString(),
      status: systemMode === "degraded" ? "degraded" : "ok", platform: "none",
      dependencies: { database: { status: "ok", latency_ms: 2 }, redis: { status: systemMode === "degraded" ? "error" : "ok", latency_ms: systemMode === "degraded" ? null : 1 } },
      fleet: { online: 5, available: 4 }, orders: { pending: 13, unassigned: 1, active: 2, oldest_pending_age_seconds: 10 },
      queue: { name: "celery", ready: systemMode === "degraded" ? null : 3, scope: "Default Celery ready list only; excludes scheduled/in-flight tasks and AWS SQS queues." },
      dispatch: { offers_sent: 20, offers_accepted: 10, offers_rejected: 2, offers_expired: 1, assignment_p95_seconds: null, samples: 10 },
      worker: { last_maintenance_at: null, age_seconds: null },
      safeguards: { idempotent_booking: true, chaos_enabled: false, can_stop_tasks: false }, booking: { replays: 2, conflicts: 1 },
      errors: systemMode === "degraded" ? ["Redis probe failed; queue measurement is unknown."] : [],
    });
    await system.route("**/api/admin/system", async (route) => {
      activeRequests++;
      peakRequests = Math.max(peakRequests, activeRequests);
      try {
        if (systemMode === "hold") await new Promise((resolve) => { releaseSystem = resolve; });
        await route.fulfill({ status: systemMode === "error" ? 503 : 200, contentType: "application/json", body: JSON.stringify(systemMode === "error" ? { detail: "Fixture temporarily unavailable" } : systemSample()) });
      } finally { activeRequests--; }
    });
    await check("system loading exposes unknowns and persistent pause/retry controls", async () => {
      await system.goto(`${base}/dispatch/system`);
      await visible(system.getByRole("heading", { name: "Live application signals", exact: true }));
      await visible(system.getByText("Application health unknown", { exact: true }));
      await visible(system.getByRole("button", { name: "Pause automatic updates", exact: true }));
      assert.ok(await system.getByRole("button", { name: "Retry now", exact: true }).isDisabled());
      assert.match(await system.locator(".system-metrics").innerText(), /Unknown/);
      await system.waitForFunction(() => document.body.textContent.includes("Request in progress"));
      assert.equal(activeRequests, 1);
      systemMode = "valid";
      releaseSystem();
      await visible(system.getByText("Sample reports: OK", { exact: true }));
      await visible(system.getByText("1 / 60 samples", { exact: true }));
      await system.getByText("Inspect sample values", { exact: true }).click();
      assert.match(await system.getByRole("table").innerText(), /13/);
    });
    await check("system pause, failed refresh and retry retain the previous measurements", async () => {
      await system.getByRole("button", { name: "Pause automatic updates", exact: true }).click();
      await visible(system.getByRole("status").filter({ hasText: /^Paused$/ }));
      await visible(system.getByRole("button", { name: "Retry & resume", exact: true }));
      systemMode = "error";
      await system.getByRole("button", { name: "Retry & resume", exact: true }).click();
      await visible(system.getByRole("status").filter({ hasText: /^Refresh failed$/ }));
      assert.match(await system.locator(".system-metrics").innerText(), /13/);
      await visible(system.getByRole("status").filter({ hasText: "Displayed values belong to the last successful sample" }));
      assert.ok(await system.getByRole("button", { name: "Retry now", exact: true }).isEnabled());
      systemMode = "degraded";
      await system.getByRole("button", { name: "Retry now", exact: true }).click();
      await visible(system.getByRole("heading", { name: "Application reported degraded signals", exact: true }));
      assert.match(await system.locator(".system-metrics").innerText(), /Queue ready\s*Unknown/i);
      await system.getByText("Reported issues (1)", { exact: true }).click();
      await visible(system.getByText("Redis probe failed; queue measurement is unknown.", { exact: true }));
    });
    await check("system stale and offline states do not claim fresh health or hide controls", async () => {
      systemMode = "stale";
      await system.getByRole("button", { name: "Retry now", exact: true }).click();
      await visible(system.getByRole("status").filter({ hasText: /^Stale sample$/ }));
      await visible(system.getByText("Last sample: OK", { exact: true }));
      await context.setOffline(true);
      await visible(system.getByRole("status").filter({ hasText: /^Offline$/ }));
      assert.ok(await system.getByRole("button", { name: "Retry now", exact: true }).isDisabled());
      await visible(system.getByRole("button", { name: "Pause automatic updates", exact: true }));
      systemMode = "valid";
      await context.setOffline(false);
      await visible(system.getByText("Sample reports: OK", { exact: true }));
    });
    await check("system pause/resume drains a slow request instead of overlapping polls", async () => {
      systemMode = "hold";
      await system.getByRole("button", { name: "Retry now", exact: true }).click();
      await system.waitForFunction(() => document.body.textContent.includes("Request in progress"));
      assert.equal(activeRequests, 1);
      for (let i = 0; i < 2; i++) {
        await system.getByRole("button", { name: "Pause automatic updates", exact: true }).click();
        await system.getByRole("button", { name: "Resume automatic updates", exact: true }).click();
      }
      assert.equal(activeRequests, 1);
      systemMode = "valid";
      releaseSystem();
      await system.getByRole("button", { name: "Retry now", exact: true }).waitFor({ state: "visible" });
      await system.waitForFunction(() => ![...document.querySelectorAll("button")].find((button) => button.textContent === "Retry now")?.disabled);
      assert.equal(peakRequests, 1);
    });
    for (const width of [320, 390, 768, 1440]) {
      await check(`system ${width}px: every console destination remains reachable without page overflow`, async () => {
        await system.setViewportSize({ width, height: 900 });
        await noOverflow(system);
        const nav = system.getByRole("navigation", { name: width < 1280 ? "Mobile console navigation" : "Console navigation", exact: true });
        for (const name of ["Operations", "System signals", "Live cluster", "Demo guide", "Cloud explorer"]) {
          const link = nav.getByRole("link", { name, exact: true });
          await link.scrollIntoViewIfNeeded();
          await visible(link);
          const box = await link.boundingBox();
          assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${name} fits viewport`);
        }
        await screenshot(system, `dispatchx-system-${width}`);
      });
    }
    await check("console demo navigation opens the guide and its architecture link", async () => {
      await system.getByRole("navigation", { name: "Console navigation", exact: true }).getByRole("link", { name: "Demo guide", exact: true }).click();
      await visible(system.getByRole("heading", { name: "Explain the system. Show the evidence." }));
      await system.getByRole("navigation", { name: "Demo navigation", exact: true }).getByRole("link", { name: "Architecture", exact: true }).click();
      await visible(system.getByRole("link", { name: "Demo guide", exact: true }));
    });
    await system.close();
    await check("no JavaScript page errors or mutation requests during exploration", async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(mutations, []);
    });
    console.log(`${checks} browser checks passed (real Chrome, local preview; no live backend).`);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
