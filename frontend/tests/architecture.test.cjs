const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

// Use the project's existing TypeScript compiler; no test framework dependency.
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const filename = path.resolve(__dirname, `../src/lib/${name}.ts`);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => id.startsWith("./") ? load(id.slice(2)) : require(id);
  modules.set(name, mod);
  mod._compile(output, filename);
  return mod.exports;
}

const { LAYERS, NODE_WIDTH, NODE_HEIGHT } = load("architecture");
const { initialSelection, readSelection, selectionPath } = load("architecture-state");
const read = (query) => readSelection(new URLSearchParams(query));
const root = path.resolve(__dirname, "../..");

test("all four layers have unique, source-backed components within the canvas", () => {
  assert.deepEqual(LAYERS.map((layer) => layer.id), ["services", "docker", "kubernetes", "aws"]);
  for (const layer of LAYERS) {
    assert.equal(new Set(layer.nodes.map((node) => node.id)).size, layer.nodes.length);
    for (const node of layer.nodes) {
      assert.ok(node.label && node.purpose && node.facts.length, node.id);
      const [source, anchor] = node.source.split("#");
      assert.ok(!path.isAbsolute(source) && !source.split("/").includes(".."));
      assert.ok(fs.statSync(path.join(root, source)).isFile(), source);
      if (anchor) {
        assert.match(anchor, /^L\d+(-L\d+)?$/);
        const lastLine = Number(anchor.split("L").at(-1));
        assert.ok(lastLine <= fs.readFileSync(path.join(root, source), "utf8").split("\n").length);
      }
      assert.ok(node.x >= 0 && node.x + NODE_WIDTH <= 1040, node.id);
      assert.ok(node.y >= 0 && node.y + NODE_HEIGHT <= 620, node.id);
    }
  }
});

test("connections and walkthrough steps reference real components in their layer", () => {
  for (const layer of LAYERS) {
    const ids = new Set(layer.nodes.map((node) => node.id));
    const edges = new Set();
    for (const edge of layer.connections) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to), `${layer.id}: ${edge.from} → ${edge.to}`);
      assert.notEqual(edge.from, edge.to);
      assert.ok(!edges.has(`${edge.from}:${edge.to}`), "duplicate edge");
      edges.add(`${edge.from}:${edge.to}`);
      for (const point of edge.via ?? []) {
        assert.ok(point.every(Number.isFinite));
        assert.ok(point[0] >= 0 && point[0] <= 1040 && point[1] >= 0 && point[1] <= 620);
      }
    }
    assert.equal(new Set(layer.walkthroughs.map((walk) => walk.id)).size, layer.walkthroughs.length);
    for (const walk of layer.walkthroughs) {
      assert.ok(walk.steps.length > 1);
      for (const step of walk.steps) {
        assert.ok(step.title && step.body && step.nodes.length);
        assert.ok(step.nodes.every((id) => ids.has(id)), `${layer.id}/${walk.id}: ${step.title}`);
      }
    }
  }
});

test("every default component can be inspected", () => {
  for (const layer of LAYERS) {
    const state = initialSelection(layer.id);
    assert.ok(layer.nodes.some((node) => node.id === state.node));
    assert.equal(state.flow, null);
    assert.equal(state.step, 0);
  }
});

test("empty and invalid links fall back safely without treating input as markup", () => {
  for (const query of ["", "layer=nope&node=missing", "layer=%3Cscript%3E&flow=bad&step=NaN"]) {
    assert.deepEqual(read(query), initialSelection());
  }
  assert.deepEqual(read("layer=aws&node=api&flow=gps&step=3"), initialSelection("aws"));
});

test("component links round-trip every component in every layer", () => {
  for (const layer of LAYERS) for (const node of layer.nodes) {
    const state = { ...initialSelection(layer.id), node: node.id };
    assert.deepEqual(read(new URL(selectionPath(state), "http://localhost").search), state);
  }
});

test("walkthrough links round-trip every step, using human-readable one-based numbering", () => {
  for (const layer of LAYERS) for (const flow of layer.walkthroughs) {
    flow.steps.forEach((_, step) => {
      const state = { ...initialSelection(layer.id), flow: flow.id, step };
      const url = new URL(selectionPath(state), "http://localhost");
      assert.equal(url.searchParams.get("step"), String(step + 1));
      assert.deepEqual(read(url.search), state);
    });
  }
});

test("invalid and out-of-range steps cannot crash playback", () => {
  const prefix = "layer=services&flow=gps&step=";
  for (const invalid of ["0", "-3", "NaN", "Infinity", "1.5", "9007199254740992"]) {
    assert.equal(read(prefix + invalid).step, 0, invalid);
  }
  assert.equal(read(prefix + "999").step, 2);
  assert.equal(read("layer=services&node=redis&step=99").step, 0);
  assert.equal(read("layer=services&flow=gps").step, 0);
});
