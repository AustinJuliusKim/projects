import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  applyElimination,
  turnAfter,
  liveIndices,
  otherRole,
  GameError,
} from "./game.mjs";

const CHOICES = ["Pizza", "Tacos", "Sushi", "Ramen"];

test("createGame (A-started) -> B moves first", () => {
  const g = createGame(CHOICES, { startedBy: "A", number: 1 }, 1000);
  assert.deepEqual(g.choices, CHOICES);
  assert.deepEqual(g.eliminated, []);
  assert.equal(g.startedBy, "A");
  assert.equal(g.number, 1);
  assert.equal(g.turn, "B"); // non-starter moves first
  assert.equal(g.status, "active");
  assert.equal(g.winnerIndex, null);
  assert.equal(g.createdAt, 1000);
});

test("createGame (B-started) -> A moves first", () => {
  const g = createGame(CHOICES, { startedBy: "B", number: 2 });
  assert.equal(g.startedBy, "B");
  assert.equal(g.number, 2);
  assert.equal(g.turn, "A"); // non-starter moves first
});

test("createGame defaults to A-started", () => {
  const g = createGame(CHOICES);
  assert.equal(g.startedBy, "A");
  assert.equal(g.turn, "B");
});

test("createGame trims whitespace", () => {
  const g = createGame(["  a ", "b", "c", "d "]);
  assert.deepEqual(g.choices, ["a", "b", "c", "d"]);
});

test("createGame rejects wrong count", () => {
  assert.throws(() => createGame(["a", "b", "c"]), (e) => e.code === "EXACTLY_FOUR");
  assert.throws(() => createGame(["a", "b", "c", "d", "e"]), (e) => e.code === "EXACTLY_FOUR");
});

test("createGame rejects empty/whitespace choices", () => {
  assert.throws(() => createGame(["a", "", "c", "d"]), (e) => e.code === "EMPTY_CHOICE");
  assert.throws(() => createGame(["a", "   ", "c", "d"]), (e) => e.code === "EMPTY_CHOICE");
});

test("createGame rejects bad startedBy", () => {
  assert.throws(() => createGame(CHOICES, { startedBy: "C" }), (e) => e.code === "BAD_ROLE");
});

test("turnAfter (A-started) is B, A, B, done", () => {
  assert.equal(turnAfter(0, "A"), "B");
  assert.equal(turnAfter(1, "A"), "A");
  assert.equal(turnAfter(2, "A"), "B");
  assert.equal(turnAfter(3, "A"), "done");
});

test("turnAfter (B-started) is A, B, A, done", () => {
  assert.equal(turnAfter(0, "B"), "A");
  assert.equal(turnAfter(1, "B"), "B");
  assert.equal(turnAfter(2, "B"), "A");
  assert.equal(turnAfter(3, "B"), "done");
});

test("full A-started flow (B,A,B) produces a single winner", () => {
  let g = createGame(CHOICES, { startedBy: "A" }, 1);
  // B eliminates index 0 (Pizza)
  g = applyElimination(g, "B", 0, 2);
  assert.equal(g.turn, "A");
  assert.equal(g.status, "active");
  assert.deepEqual(liveIndices(g), [1, 2, 3]);

  // A eliminates index 1 (Tacos)
  g = applyElimination(g, "A", 1, 3);
  assert.equal(g.turn, "B");
  assert.equal(g.status, "active");
  assert.deepEqual(liveIndices(g), [2, 3]);

  // B eliminates index 3 (Ramen) -> winner is index 2 (Sushi)
  g = applyElimination(g, "B", 3, 4);
  assert.equal(g.turn, "done");
  assert.equal(g.status, "complete");
  assert.equal(g.winnerIndex, 2);
  assert.equal(g.choices[g.winnerIndex], "Sushi");
  assert.equal(g.eliminated.length, 3);
});

test("full B-started flow (A,B,A) produces a single winner", () => {
  let g = createGame(CHOICES, { startedBy: "B" });
  // A eliminates first
  g = applyElimination(g, "A", 0);
  assert.equal(g.turn, "B");
  // B eliminates
  g = applyElimination(g, "B", 1);
  assert.equal(g.turn, "A");
  // A eliminates final -> winner index 3
  g = applyElimination(g, "A", 2);
  assert.equal(g.status, "complete");
  assert.equal(g.winnerIndex, 3);
});

test("rejects out-of-turn moves (A-started: A can't move first)", () => {
  const g = createGame(CHOICES, { startedBy: "A" });
  assert.throws(() => applyElimination(g, "A", 0), (e) => e.code === "NOT_YOUR_TURN");
});

test("rejects eliminating an already-eliminated index", () => {
  let g = createGame(CHOICES);
  g = applyElimination(g, "B", 0);
  // Now it's A's turn; A tries to eliminate index 0 again
  assert.throws(() => applyElimination(g, "A", 0), (e) => e.code === "ALREADY_ELIMINATED");
});

test("rejects out-of-range index", () => {
  const g = createGame(CHOICES);
  assert.throws(() => applyElimination(g, "B", 4), (e) => e.code === "BAD_INDEX");
  assert.throws(() => applyElimination(g, "B", -1), (e) => e.code === "BAD_INDEX");
  assert.throws(() => applyElimination(g, "B", 1.5), (e) => e.code === "BAD_INDEX");
});

test("rejects bad role", () => {
  const g = createGame(CHOICES);
  assert.throws(() => applyElimination(g, "C", 0), (e) => e.code === "BAD_ROLE");
});

test("rejects moves on a complete game", () => {
  let g = createGame(CHOICES);
  g = applyElimination(g, "B", 0);
  g = applyElimination(g, "A", 1);
  g = applyElimination(g, "B", 2);
  assert.equal(g.status, "complete");
  assert.throws(() => applyElimination(g, "A", 3), (e) => e.code === "GAME_COMPLETE");
});

test("otherRole flips A/B", () => {
  assert.equal(otherRole("A"), "B");
  assert.equal(otherRole("B"), "A");
});

test("applyElimination does not mutate the input", () => {
  const g = createGame(CHOICES);
  const before = JSON.stringify(g);
  applyElimination(g, "B", 0);
  assert.equal(JSON.stringify(g), before);
});

test("GameError carries a code", () => {
  const e = new GameError("X", "msg");
  assert.equal(e.code, "X");
  assert.equal(e.message, "msg");
});
