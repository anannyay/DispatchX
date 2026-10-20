const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(name, globals = {}) {
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, `../src/lib/${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function("exports", ...Object.keys(globals), output)(exports, ...Object.values(globals));
  return exports;
}

test("unchanged booking retries retain the key; editing the request creates a new identity", () => {
  const { bookingAttempt } = load("booking");
  let generated = 0;
  const key = () => `test-request-${++generated}`;
  const original = bookingAttempt(null, { pickup: 1, drop: 2 }, key);
  assert.equal(bookingAttempt(original, { pickup: 1, drop: 2 }, key), original);
  assert.equal(generated, 1);
  const edited = bookingAttempt(original, { pickup: 1, drop: 3 }, key);
  assert.notEqual(edited.key, original.key);
  assert.equal(generated, 2);
});

test("API retries after token refresh preserve the exact idempotency header and payload", async () => {
  let session = { access_token: "fixture-expired", refresh_token: "fixture-refresh", user: { id: 1 } };
  const requests = [];
  const { api } = load("api", {
    process: { env: {} }, window: { location: { href: "" } },
    localStorage: { getItem: () => JSON.stringify(session), setItem: (_, value) => { session = JSON.parse(value); } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === "/api/auth/refresh") return { ok: true, json: async () => ({ ...session, access_token: "fixture-renewed" }) };
      return requests.length === 1 ? { status: 401 } : { ok: true, status: 201, json: async () => ({ id: 9 }) };
    },
  });
  assert.deepEqual(await api("/orders", { method: "POST", body: { note: "parcel" }, idempotencyKey: "test-order-attempt" }), { id: 9 });
  const bookings = requests.filter((request) => request.url === "/api/orders");
  assert.equal(bookings.length, 2);
  assert.equal(bookings[0].options.headers["Idempotency-Key"], "test-order-attempt");
  assert.equal(bookings[1].options.headers["Idempotency-Key"], "test-order-attempt");
  assert.equal(bookings[0].options.body, bookings[1].options.body);
  assert.equal(bookings[1].options.headers.Authorization, "Bearer fixture-renewed");
});
