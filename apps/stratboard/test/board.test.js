import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_ITEMS, MAX_STEPS, blankBoard, cleanBoard, createHistory, decodeBoard, encodeBoard,
  fromPlan, history, reduce,
} from "../src/lib/board.js";
import { generatePlan } from "../src/lib/plan.js";
import { buildHash, parseHash } from "../src/lib/share.js";

const { maps, agents } = JSON.parse(
  readFileSync(new URL("../src/data/snapshot.json", import.meta.url)),
);
const mapIds = maps.map((m) => m.id);
const agent = { type: "agent", agentId: "jett", team: "ally", x: 100, y: 200 };

test("add assigns fresh ids and move/update/remove target one item", () => {
  let b = blankBoard("ascent");
  b = reduce(b, { type: "add", item: agent });
  b = reduce(b, { type: "add", item: { type: "text", x: 1, y: 2, text: "hi", color: "#ece8e1" } });
  assert.deepEqual(b.steps[0].items.map((i) => i.id), ["i1", "i2"]);
  b = reduce(b, { type: "move", id: "i1", dx: 10, dy: -5 });
  assert.deepEqual([b.steps[0].items[0].x, b.steps[0].items[0].y], [110, 195]);
  b = reduce(b, { type: "update", id: "i2", patch: { text: "bye", id: "hack", type: "agent" } });
  assert.deepEqual(b.steps[0].items[1], { type: "text", x: 1, y: 2, text: "bye", color: "#ece8e1", id: "i2" });
  b = reduce(b, { type: "remove", id: "i1" });
  assert.deepEqual(b.steps[0].items.map((i) => i.id), ["i2"]);
});

test("moving a path shifts every point", () => {
  let b = reduce(blankBoard("ascent"), { type: "add", item: { type: "path", points: [[0, 0], [10, 10]], color: "#ece8e1", arrow: true } });
  b = reduce(b, { type: "move", id: "i1", dx: 5, dy: 5 });
  assert.deepEqual(b.steps[0].items[0].points, [[5, 5], [15, 15]]);
});

test("addStep copies the current step after it; removeStep keeps at least one", () => {
  let b = reduce(blankBoard("ascent"), { type: "add", item: agent });
  b = reduce(b, { type: "addStep", step: 0 });
  assert.equal(b.steps.length, 2);
  assert.deepEqual(b.steps[1].items, b.steps[0].items);
  b = reduce(b, { type: "move", step: 1, id: "i1", dx: 50, dy: 0 });
  assert.equal(b.steps[0].items[0].x, 100, "copy is independent");
  b = reduce(b, { type: "removeStep", step: 0 });
  b = reduce(b, { type: "removeStep", step: 0 });
  assert.equal(b.steps.length, 1);
  for (let i = 0; i < MAX_STEPS + 3; i++) b = reduce(b, { type: "addStep", step: 0 });
  assert.equal(b.steps.length, MAX_STEPS);
});

test("out-of-range steps and no-op moves return the same board", () => {
  const b = blankBoard("ascent");
  assert.equal(reduce(b, { type: "add", step: 3, item: agent }), b);
  assert.equal(reduce(b, { type: "move", id: "i1", dx: 0, dy: 0 }), b);
  assert.equal(reduce(b, { type: "nonsense" }), b);
});

test("history undoes, redoes, and drops the redo stack on a new edit", () => {
  let h = createHistory(blankBoard("ascent"));
  h = history(h, { type: "add", item: agent });
  h = history(h, { type: "add", item: agent });
  assert.equal(h.present.steps[0].items.length, 2);
  h = history(h, { type: "undo" });
  assert.equal(h.present.steps[0].items.length, 1);
  h = history(h, { type: "redo" });
  assert.equal(h.present.steps[0].items.length, 2);
  h = history(h, { type: "undo" });
  h = history(h, { type: "setMap", map: "bind" });
  assert.equal(h.future.length, 0);
  assert.equal(h.present.map, "bind");
  h = history(h, { type: "undo" });
  assert.equal(h.present.map, "ascent", "map change is undoable");
  const same = history(h, { type: "move", id: "zzz", dx: 0, dy: 0 });
  assert.equal(same, h, "no-op edits don't add history");
});

test("fromPlan places all five agents with arrows to their targets", () => {
  for (const map of maps) {
    const plan = generatePlan({ map, agents, side: "attack", seed: 7 });
    const board = fromPlan(plan);
    const items = board.steps[0].items;
    assert.equal(board.map, map.id);
    assert.equal(items.filter((i) => i.type === "agent").length, 5);
    const arrows = items.filter((i) => i.type === "path");
    assert.ok(arrows.every((a) => a.arrow && a.points.length === 2));
    assert.equal(board.steps[0].name, plan.strat.name);
  }
});

test("cleanBoard rebuilds items from known fields and rejects junk", () => {
  const raw = {
    map: "ascent",
    steps: [{
      name: "x".repeat(100),
      items: [
        { type: "agent", agentId: "jett", team: "villain", x: "12", y: 1e9, icon: "https://evil" },
        { type: "ability", agentId: "sova", slot: "Ultimate", x: 0, y: 0 },
        { type: "path", points: [[0, 0]], color: "red" },
        { type: "path", points: [[0, 0], [1, 1], "bad"], color: "url(javascript:x)" },
        { type: "text", x: 0, y: 0, text: "" },
        { type: "script" },
        null,
      ],
    }],
  };
  const b = cleanBoard(raw, mapIds);
  const items = b.steps[0].items;
  assert.equal(b.steps[0].name.length, 40);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { type: "agent", agentId: "jett", team: "ally", x: 12, y: 1200, id: "i1" });
  assert.deepEqual(items[1].points, [[0, 0], [1, 1]]);
  assert.equal(items[1].color, "#ece8e1");
  assert.equal(cleanBoard({ ...raw, map: "nowhere" }, mapIds), null);
  assert.equal(cleanBoard({ map: "ascent", steps: "nope" }, mapIds), null);
});

test("cleanBoard caps items per step", () => {
  const items = Array.from({ length: MAX_ITEMS + 50 }, () => agent);
  assert.equal(cleanBoard({ map: "ascent", steps: [{ name: "a", items }] }, mapIds).steps[0].items.length, MAX_ITEMS);
});

test("encode/decode round-trips a board", async () => {
  const plan = generatePlan({ map: maps[0], agents, side: "defense", seed: 3 });
  let board = fromPlan(plan);
  board = reduce(board, { type: "addStep", step: 0 });
  const code = await encodeBoard(board);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  // Ids aren't encoded; decoding renumbers them.
  const content = (b) => ({
    map: b.map,
    steps: b.steps.map((s) => ({ name: s.name, items: s.items.map(({ id, ...rest }) => rest) })),
  });
  assert.deepEqual(content(await decodeBoard(code, mapIds)), content(board));
});

test("decodeBoard returns null for garbage and oversized payloads", async () => {
  assert.equal(await decodeBoard("not-a-board", mapIds), null);
  // ~5 MB of zeros compresses to a few KB; the streaming cap must reject it.
  const bomb = new Uint8Array(5_000_000).fill(32);
  const stream = new Blob([bomb]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const code = Buffer.from(bytes).toString("base64url");
  assert.equal(await decodeBoard(code, mapIds), null);
});

test("board hash keeps only a well-formed share code", () => {
  assert.deepEqual(parseHash("#board?d=abc_-9"), { view: "board", d: "abc_-9" });
  assert.deepEqual(parseHash("#board?d=<script>"), { view: "board", d: null });
  assert.equal(buildHash({ view: "board", d: null }), "#board");
  assert.equal(buildHash({ view: "board", d: "xyz" }), "#board?d=xyz");
});
