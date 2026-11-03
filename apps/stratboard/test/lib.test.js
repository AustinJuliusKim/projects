import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/lib/rng.js";
import { normalizeAgents, normalizeMaps, slug, toMinimap } from "../src/lib/data.js";
import { CHALLENGES, challengesFor, drawChallenge } from "../src/lib/roulette.js";
import { buildHash, parseHash } from "../src/lib/share.js";

test("rng is deterministic and in range", () => {
  const a = createRng(7);
  const b = createRng(7);
  for (let i = 0; i < 100; i++) {
    const n = a.next();
    assert.equal(n, b.next());
    assert.ok(n >= 0 && n < 1);
  }
  assert.deepEqual(createRng(3).shuffle([1, 2, 3, 4]).sort(), [1, 2, 3, 4]);
  assert.equal(createRng(3).pick([]), undefined);
});

test("slug handles agent names with punctuation", () => {
  assert.equal(slug("KAY/O"), "kay-o");
  assert.equal(slug("Brimstone"), "brimstone");
});

test("minimap transform swaps world axes", () => {
  const map = { xMultiplier: 2, yMultiplier: 3, xScalarToAdd: 0.1, yScalarToAdd: 0.2 };
  assert.deepEqual(toMinimap(map, { x: 1, y: 10 }), { x: 20.1, y: 3.2 });
});

const apiMap = (name, callouts, tactical = "A/B Sites") => ({
  displayName: name,
  tacticalDescription: tactical,
  displayIcon: "icon",
  listViewIcon: "list",
  xMultiplier: 0.0001, yMultiplier: -0.0001, xScalarToAdd: 0.5, yScalarToAdd: 0.5,
  callouts: callouts.map(([zone, region, x = 0, y = 0]) => ({
    superRegionName: zone, regionName: region, location: { x, y, z: 0 },
  })),
});

test("normalizeMaps keeps site maps with both spawns and names callouts", () => {
  const maps = normalizeMaps([
    apiMap("Duel", [["Mid", "Water"]], null),
    apiMap("NoSpawn", [["A", "Site"]]),
    apiMap("Zeta", [
      ["Attacker Side", "Spawn"], ["Defender Side", "Spawn"],
      ["B", "Site"], ["A", "Main"], ["A", "Main"], ["Mid", "Top"],
    ]),
  ]);
  assert.equal(maps.length, 1);
  const [m] = maps;
  assert.equal(m.id, "zeta");
  assert.deepEqual(m.sites, ["A", "B"]);
  assert.deepEqual(m.callouts.map((c) => c.name), ["Spawn", "Spawn", "B Site", "A Main", "Mid Top"]);
});

test("normalizeAgents drops non-playable agents and ultimates", () => {
  const agents = normalizeAgents([
    { displayName: "Sova", isPlayableCharacter: true, displayIcon: "i", role: { displayName: "Initiator" },
      abilities: [
        { slot: "Ability1", displayName: "Shock Bolt" },
        { slot: "Ultimate", displayName: "Hunter's Fury" },
        { slot: "Passive", displayName: "x" },
      ] },
    { displayName: "Dummy", isPlayableCharacter: false, role: null, abilities: [] },
  ]);
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0].abilities.map((a) => a.name), ["Shock Bolt"]);
});

test("challenges have unique ids and respect side", () => {
  assert.equal(new Set(CHALLENGES.map((c) => c.id)).size, CHALLENGES.length);
  assert.ok(challengesFor("attack").every((c) => c.side !== "defense"));
  assert.equal(challengesFor("any").length, CHALLENGES.length);
});

test("drawChallenge avoids excluded ids until the pool is exhausted", () => {
  const rng = createRng(1);
  const pool = challengesFor("defense");
  const seen = [];
  for (let i = 0; i < pool.length; i++) seen.push(drawChallenge(rng, "defense", seen).id);
  assert.equal(new Set(seen).size, pool.length);
  assert.ok(drawChallenge(rng, "defense", seen));
});

test("hash round-trips and tolerates junk", () => {
  const plan = { view: "plan", map: "ascent", side: "attack", comp: "random", twist: true, seed: 42 };
  assert.deepEqual(parseHash(buildHash(plan)), plan);
  const roulette = { view: "roulette", side: "defense", seed: 9 };
  assert.deepEqual(parseHash(buildHash(roulette)), roulette);
  assert.deepEqual(parseHash("#plan?side=sideways&seed=-3"), {
    view: "plan", map: null, side: "random", comp: "standard", twist: false, seed: null,
  });
  assert.equal(parseHash("").view, "plan");
});
