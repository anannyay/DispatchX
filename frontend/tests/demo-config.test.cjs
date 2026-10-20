const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/lib/demo-config.ts");
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const {
  DEFAULT_BASE_URL, DEMO_FIELDS, DEMO_PRESETS, DEMO_WALKTHROUGH, demoTime,
  presetDraft, validateBaseUrl, validateDemoConfig, quoteShellArgument, generateDemoCommands,
} = mod.exports;

test("presentation presets match the requested finite workloads exactly", () => {
  assert.equal(DEFAULT_BASE_URL, "http://localhost:8000");
  assert.deepEqual(DEMO_PRESETS.map(({ label, values }) => ({ label, values })), [
    { label: "Explain", values: { riders: 5, customers: 5, ordersPerMin: 1, acceptRate: 1, radiusKm: 3, speedup: 10, duration: 300 } },
    { label: "Busy fleet", values: { riders: 20, customers: 5, ordersPerMin: 6, acceptRate: 0.85, radiusKm: 3, speedup: 10, duration: 300 } },
    { label: "Failure/retry", values: { riders: 3, customers: 5, ordersPerMin: 2, acceptRate: 0, radiusKm: 3, speedup: 10, duration: 240 } },
  ]);
  for (const preset of DEMO_PRESETS) assert.equal(validateDemoConfig(presetDraft(preset.id)).valid, true);
});

test("edits do not mutate presets; reset restores numbers and keeps the chosen URL", () => {
  const edited = presetDraft("busy", "https://demo.example.test");
  edited.riders = "99";
  edited.acceptRate = "invalid";
  const reset = presetDraft("busy", edited.baseUrl);
  assert.equal(reset.baseUrl, edited.baseUrl);
  assert.equal(reset.riders, "20");
  assert.equal(reset.acceptRate, "0.85");
  assert.equal(presetDraft("busy").riders, "20");
  assert.notEqual(reset, edited);
});

const bounds = {
  riders: [1, 100, true], customers: [1, 30, true], ordersPerMin: [0, 30, false],
  acceptRate: [0, 1, false], duration: [60, 900, false], radiusKm: [1, 10, false], speedup: [1, 20, false],
};
for (const [key, [min, max, integer]] of Object.entries(bounds)) {
  test(`${key}: accepts inclusive bounds; rejects missing, non-finite and out-of-bounds values`, () => {
    for (const value of [min, max]) {
      const result = validateDemoConfig({ ...presetDraft("explain"), [key]: String(value) });
      assert.equal(result.valid, true, `${key}=${value}`);
      assert.equal(result.config[key], value);
    }
    for (const value of ["", " ", "NaN", "Infinity", "-Infinity", "1e309", "0x10", "1;printf INJECTED", String(min - 0.01), String(max + 0.01), ...(integer ? ["1.5"] : [])]) {
      const result = generateDemoCommands({ ...presetDraft("explain"), [key]: value });
      assert.equal(result.valid, false, `${key}=${value}`);
      assert.ok(result.errors[key]);
      assert.equal(result.commands, null, "never retain a previously valid command");
    }
  });
}

test("fractional simulator parameters and numeric notation are serialized as finite numbers", () => {
  const result = generateDemoCommands({
    ...presetDraft("explain"), riders: "1e1", customers: "02", ordersPerMin: ".5", acceptRate: ".85",
    duration: "60.5", radiusKm: "1.25", speedup: "+2.5",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.config, { baseUrl: "http://localhost:8000/", riders: 10, customers: 2, ordersPerMin: 0.5, acceptRate: 0.85, duration: 60.5, radiusKm: 1.25, speedup: 2.5 });
  assert.equal(result.commands.seed, "docker compose exec api python -m app.seed --riders 10 --customers 2");
  const zero = generateDemoCommands({ ...presetDraft("explain"), ordersPerMin: "0", acceptRate: "0" });
  assert.equal(zero.valid, true);
  assert.match(zero.commands.posix, /--orders-per-min '0'/);
});

test("base URL accepts absolute HTTP(S), ports, IPv6 and encoded path characters", () => {
  for (const url of [
    "http://localhost:8000", "https://demo.example.test", "https://demo.example.test:8443/root/",
    "http://[::1]:8000", "HTTP://LOCALHOST:8000", "https://demo.example.test/path%20with%20spaces",
    "https://demo.example.test/a%3Fb%23c%40d", "https://demo.example.test/o'reilly",
  ]) {
    const result = validateBaseUrl(url);
    assert.equal(result.error, undefined, url);
    assert.equal(result.value, new URL(url).href);
  }
});

test("base URL rejects credentials, queries/fragments including empty delimiters, and parser repairs", () => {
  for (const url of [
    "", "localhost:8000", "/api", "//localhost:8000", "https:localhost", "http:///localhost", "http://",
    "ftp://localhost", "javascript:alert(1)", "file:///tmp/test", "http://localhost:99999",
    "http://user:password@localhost", "https://user@localhost", "http://@localhost", "http://user%40x@localhost",
    "http://localhost?", "http://localhost#", "http://localhost?x=1", "http://localhost/#fragment",
    " http://localhost", "http://localhost ", "http://local\nhost", "http://local\thost", "http://localhost/\rtest",
    "http://localhost/\u0000test", "http://localhost/\u007ftest", "http://localhost/path with spaces",
    "http://localhost\\other", "https://localhost/\\@other", "http://[broken",
  ]) {
    assert.ok(validateBaseUrl(url).error, JSON.stringify(url));
    const result = generateDemoCommands({ ...presetDraft("explain"), baseUrl: url });
    assert.equal(result.commands, null);
    assert.ok(result.errors.baseUrl);
  }
});

test("reports every invalid field together and refuses both simulator and seed commands", () => {
  const result = generateDemoCommands({ ...presetDraft("explain"), baseUrl: "https://user@localhost", riders: "0", customers: "31", duration: "0" });
  assert.equal(result.commands, null);
  assert.deepEqual(Object.keys(result.errors).sort(), ["baseUrl", "customers", "duration", "riders"]);
});

test("seed commands match selected account counts for every preset and custom settings", () => {
  for (const preset of DEMO_PRESETS) {
    const result = generateDemoCommands(presetDraft(preset.id));
    assert.equal(result.commands.seed, `docker compose exec api python -m app.seed --riders ${preset.values.riders} --customers ${preset.values.customers}`);
  }
  const result = generateDemoCommands({ ...presetDraft("busy"), baseUrl: "https://remote.example.test", riders: "100", customers: "30" });
  assert.equal(result.commands.seed, "docker compose exec api python -m app.seed --riders 100 --customers 30");
  assert.doesNotMatch(result.commands.seed, /remote|base-url/);
});

test("emitted flags are the actual argparse options and defaults retain the documented simulator behavior", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../simulator/simulator.py"), "utf8");
  const seed = fs.readFileSync(path.resolve(__dirname, "../../backend/app/seed.py"), "utf8");
  const flags = [...source.matchAll(/ap\.add_argument\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(DEMO_FIELDS.map(({ flag }) => flag), ["--riders", "--customers", "--orders-per-min", "--accept-rate", "--duration", "--radius-km", "--speedup"]);
  for (const flag of ["--base-url", ...DEMO_FIELDS.map(({ flag }) => flag)]) assert.ok(flags.includes(flag), flag);
  assert.match(seed, /ap\.add_argument\("--riders", type=int/);
  assert.match(seed, /ap\.add_argument\("--customers", type=int/);
  assert.match(source, /"--city", choices=CITIES, default="bangalore"/);
  assert.match(source, /"--tick", type=float, default=2\.0/);
  assert.match(source, /"--ramp", type=float, default=0\.05/);
  assert.match(source, /"--start-index", type=int, default=1/);
});

// Deliberately restricted PowerShell grammar: fixed bare command/flag words and
// single-quoted literals only. Fail on ANY unquoted operator or expression.
// This checks the complete generated command, not just a quote-helper snapshot.
function powerShellWords(command) {
  const words = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === " ") { i++; continue; }
    if (command[i] === "'") {
      i++;
      let word = "", closed = false;
      while (i < command.length) {
        const char = command[i++];
        if (/[\u2018\u2019']/.test(char)) {
          if (command[i] === char) { word += char; i++; }
          else { closed = true; break; }
        } else word += char;
      }
      assert.ok(closed, "unterminated literal");
      assert.ok(i === command.length || command[i] === " ", "literal must end at an argument boundary");
      words.push(word);
    } else {
      const match = /^[A-Za-z0-9_./-]+/.exec(command.slice(i));
      assert.ok(match, `unquoted shell syntax at ${command.slice(i)}`);
      words.push(match[0]);
      i += match[0].length;
      assert.ok(i === command.length || command[i] === " ", "bare argument must end at a boundary");
    }
  }
  return words;
}

const injectionUrls = [
  "http://localhost:8000/o'reilly",
  "http://localhost:8000/a';printf${IFS}INJECTED;'",
  "http://localhost:8000/$(printf${IFS}INJECTED)",
  'http://localhost:8000/$(Write-Output%20INJECTED);&|<>"`',
  "http://localhost:8000/‘quoted’/unicode/雪",
  "http://localhost:8000/%27%22%60%24%28%29%0A%5C",
  "http://localhost:8000/a&b|c;d(e){f}[$HOME]*!",
];

function expectedArgs(url) {
  return ["simulator/simulator.py", "--base-url", new URL(url).href, "--riders", "5", "--customers", "5", "--orders-per-min", "1", "--accept-rate", "1", "--duration", "300", "--radius-km", "3", "--speedup", "10"];
}

test("PowerShell commands preserve malicious-looking URLs as one literal argument", () => {
  for (const url of injectionUrls) {
    const result = generateDemoCommands({ ...presetDraft("explain"), baseUrl: url });
    assert.equal(result.valid, true, url);
    assert.deepEqual(powerShellWords(result.commands.powershell), ["python", ...expectedArgs(url)]);
    assert.ok(!/[\r\n]/.test(result.commands.powershell), "one-line command");
  }
  assert.deepEqual(powerShellWords(`python ${quoteShellArgument("a'b‘c’d$HOME;$(test)", "powershell")}`), ["python", "a'b‘c’d$HOME;$(test)"]);
  assert.equal(quoteShellArgument("o'reilly", "powershell"), "'o''reilly'");
});

test("POSIX commands survive actual shell parsing without expansion, splitting or injection", { skip: process.platform === "win32" }, () => {
  // Intercept python with an argument-echoing shell function: no simulator,
  // accounts, HTTP, Docker or file writes are performed by these commands.
  const intercept = `python() { command "$DISPATCHX_TEST_NODE" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; `;
  for (const url of injectionUrls) {
    const { commands } = generateDemoCommands({ ...presetDraft("explain"), baseUrl: url });
    const run = spawnSync("/bin/sh", ["-c", intercept + commands.posix], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, DISPATCHX_TEST_NODE: process.execPath },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(run.stdout), expectedArgs(url));
  }
  assert.equal(quoteShellArgument("o'reilly", "posix"), "'o'\"'\"'reilly'");
});

test("walkthrough fills exactly eight minutes in the requested sequence without gaps", () => {
  assert.deepEqual(DEMO_WALKTHROUGH.map(({ id }) => id), ["responsibilities", "delivery", "docker", "kubernetes", "aws", "signals", "evidence"]);
  let end = 0;
  for (const step of DEMO_WALKTHROUGH) {
    assert.equal(step.start, end);
    assert.ok(step.end > step.start);
    assert.ok(step.click && step.say && step.observe && step.href);
    end = step.end;
  }
  assert.equal(end, 480);
  assert.equal(demoTime(0), "00:00");
  assert.equal(demoTime(end), "08:00");
});
