import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateActive, isAdmin } from "./admin.mjs";

// A PAIR# item projected to what scanActivePairings returns.
function pair({ status = "active", turn = "A", choices = [], userA = null, userB = null } = {}) {
  return { pk: "PAIR#x", game: { status, turn, choices }, userA, userB };
}

test("isAdmin: allowlist match on sub", () => {
  assert.equal(isAdmin("s1", "s1,s2"), true);
  assert.equal(isAdmin("s2", " s1 , s2 "), true); // tolerates whitespace
  assert.equal(isAdmin("s3", "s1,s2"), false);
});

test("isAdmin: empty env or missing sub denies", () => {
  assert.equal(isAdmin("s1", ""), false);
  assert.equal(isAdmin("s1", undefined), false);
  assert.equal(isAdmin(null, "s1"), false);
  assert.equal(isAdmin(undefined, "s1"), false);
});

test("aggregateActive: empty input → zeros", () => {
  const a = aggregateActive([]);
  assert.equal(a.gamesInProgress, 0);
  assert.equal(a.recentPairings, 0);
  assert.equal(a.distinctActiveUsers, 0);
  assert.deepEqual(a.activeByTurn, { A: 0, B: 0, done: 0 });
  assert.deepEqual(a.topChoicesInPlay, []);
});

test("aggregateActive: only active games count as in-progress; all pairings counted", () => {
  const a = aggregateActive([
    pair({ status: "active", turn: "A" }),
    pair({ status: "complete", turn: "done" }),
    pair({ status: "active", turn: "B" }),
  ]);
  assert.equal(a.gamesInProgress, 2);
  assert.equal(a.recentPairings, 3);
  assert.deepEqual(a.activeByTurn, { A: 1, B: 1, done: 0 });
});

test("aggregateActive: turn 'done' bucketed; unknown turn falls to done", () => {
  const a = aggregateActive([
    pair({ status: "active", turn: "done" }),
    pair({ status: "active", turn: "Z" }), // unknown → done
  ]);
  assert.deepEqual(a.activeByTurn, { A: 0, B: 0, done: 2 });
});

test("aggregateActive: distinct users dedup across seats and games, nulls ignored", () => {
  const a = aggregateActive([
    pair({ userA: "u1", userB: "u2" }),
    pair({ userA: "u1", userB: null }), // u1 repeats
    pair({ userA: "u3", userB: "u3" }), // same user both seats
    pair({ status: "complete", userA: "u9", userB: "u9" }), // not active → ignored
  ]);
  assert.equal(a.distinctActiveUsers, 3); // u1, u2, u3
});

test("aggregateActive: topChoicesInPlay honors k-anon floor", () => {
  const items = [
    pair({ choices: ["Pizza", "Sushi", "Tacos", "Ramen"] }),
    pair({ choices: ["Pizza", "Sushi", "Burgers", "Pho"] }),
    pair({ choices: ["Pizza", "Salad", "Curry", "BBQ"] }),
  ];
  // Pizza in 3 games, Sushi in 2, others in 1.
  const floor3 = aggregateActive(items, { choiceFloor: 3 });
  assert.deepEqual(floor3.topChoicesInPlay, [{ label: "Pizza", count: 3 }]);

  const floor2 = aggregateActive(items, { choiceFloor: 2 });
  assert.deepEqual(floor2.topChoicesInPlay, [
    { label: "Pizza", count: 3 },
    { label: "Sushi", count: 2 },
  ]);
});

test("aggregateActive: a repeated label within one game counts once", () => {
  const a = aggregateActive(
    [pair({ choices: ["Pizza", "pizza", "PIZZA", "Tacos"] })],
    { choiceFloor: 1 }
  );
  const pizza = a.topChoicesInPlay.find((c) => c.label.toLowerCase() === "pizza");
  assert.equal(pizza.count, 1);
});
