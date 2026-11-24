import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePlan, pickComp, ROLES } from "../src/lib/plan.js";
import { ENTRY_OVERRIDES, siteLayout, attackBias } from "../src/lib/geometry.js";
import { createRng } from "../src/lib/rng.js";

const { maps, agents } = JSON.parse(
  readFileSync(new URL("../src/data/snapshot.json", import.meta.url)),
);

test("same inputs give the same plan", () => {
  const map = maps[0];
  const a = generatePlan({ map, agents, side: "attack", seed: 1234 });
  const b = generatePlan({ map, agents, side: "attack", seed: 1234 });
  assert.deepEqual(a, b);
});

test("standard comp has one of each role plus a flex, all unique", () => {
  for (let seed = 0; seed < 50; seed++) {
    const comp = pickComp(createRng(seed), agents, "standard");
    assert.equal(comp.length, 5);
    assert.equal(new Set(comp.map((a) => a.id)).size, 5);
    for (const role of ROLES) assert.ok(comp.some((a) => a.role === role), `missing ${role}`);
  }
});

test("every map and side produces five fully-specified players", () => {
  for (const map of maps) {
    for (const side of ["attack", "defense"]) {
      for (let seed = 0; seed < 40; seed++) {
        const plan = generatePlan({ map, agents, side, seed, twist: true });
        assert.equal(plan.side, side);
        assert.ok(map.sites.includes(plan.site));
        assert.equal(plan.players.length, 5, `${map.name} ${side} ${seed}`);
        for (const p of plan.players) {
          assert.ok(p.at?.name, `${map.name} ${side} ${seed}: no position`);
          assert.ok(p.job && !p.job.includes("undefined"), `${map.name}: bad job "${p.job}"`);
        }
        assert.ok(!plan.strat.summary.includes("undefined"), plan.strat.summary);
        assert.ok(plan.twist?.id);
        if (side === "attack") assert.ok(plan.postPlant && !plan.postPlant.includes("undefined"));
      }
    }
  }
});

test("entry overrides name real callouts", () => {
  for (const [id, sites] of Object.entries(ENTRY_OVERRIDES)) {
    const map = maps.find((m) => m.id === id);
    assert.ok(map, `no map ${id}`);
    for (const [site, names] of Object.entries(sites)) {
      assert.deepEqual(siteLayout(map, site).entries.map((c) => c.name), names);
    }
  }
});

test("derived site entries are nearer attacker spawn than the site itself", () => {
  for (const map of maps) {
    for (const s of map.sites) {
      const { entries, site } = siteLayout(map, s);
      assert.ok(entries.length, `${map.name} ${s} has no entries`);
      if (ENTRY_OVERRIDES[map.id]?.[s]) continue;
      for (const e of entries) {
        assert.ok(attackBias(map, e) < attackBias(map, site), `${map.name}: ${e.name} behind ${site.name}`);
      }
    }
  }
});

test("controllers always get their signature smoke", () => {
  for (let seed = 0; seed < 30; seed++) {
    const plan = generatePlan({ map: maps[0], agents, side: "attack", seed });
    for (const p of plan.players.filter((x) => x.role === "Controller")) {
      const agent = agents.find((a) => a.id === p.agentId);
      assert.equal(p.ability.name, agent.abilities.find((a) => a.slot === "Ability2").name);
    }
  }
});

test("random side resolves to attack or defense", () => {
  const sides = new Set();
  for (let seed = 0; seed < 30; seed++) sides.add(generatePlan({ map: maps[0], agents, side: "random", seed }).side);
  assert.deepEqual([...sides].sort(), ["attack", "defense"]);
});
