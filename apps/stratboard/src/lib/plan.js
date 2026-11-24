// Generates a random but playable round plan from map callouts and agent kits.
// Everything is drawn from one seeded RNG, so (map, side, comp, twist, seed)
// always reproduces the same plan.
import { createRng } from "./rng.js";
import { midRoute, siteLayout } from "./geometry.js";
import { drawChallenge } from "./roulette.js";

export const ROLES = ["Duelist", "Controller", "Initiator", "Sentinel"];

export function pickComp(rng, agents, mode = "standard") {
  const used = new Set();
  const take = (pool) => {
    const agent = rng.pick(pool.filter((a) => !used.has(a.id)));
    if (agent) used.add(agent.id);
    return agent;
  };
  if (mode === "random") return Array.from({ length: 5 }, () => take(agents)).filter(Boolean);
  const comp = ROLES.map((role) => take(agents.filter((a) => a.role === role)));
  comp.push(take(agents));
  return comp.filter(Boolean).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
}

// Hands out list items in order, wrapping when the list runs out.
function cycler(list) {
  let i = 0;
  return () => (list.length ? list[i++ % list.length] : undefined);
}

// A controller's signature (E, "Ability2") is its smoke, the only safe pick
// for a "cut vision" job. Other roles can use any non-ultimate.
function chooseAbility(agent, rng) {
  if (agent.role === "Controller") {
    const signature = agent.abilities.find((a) => a.slot === "Ability2");
    if (signature) return signature;
  }
  return rng.pick(agent.abilities) ?? null;
}

function player(agent, rng) {
  return {
    agentId: agent.id,
    agent: agent.name,
    role: agent.role,
    icon: agent.icon,
    ability: chooseAbility(agent, rng),
    at: null,
    target: null,
    job: "",
  };
}

const abilityName = (p) => p.ability?.name ?? "your utility";

const ATTACK_STRATS = {
  execute: { name: "Fast execute", summary: (c) => `All five hit ${c.site} together through ${c.entry}.` },
  split: { name: "Split", summary: (c) => `Pinch ${c.site} from ${c.entry} and ${c.mid}.` },
  fake: { name: "Fake", summary: (c) => `Show utility at ${c.fakeSite}, then rotate and hit ${c.site}.` },
  default: { name: "Default", summary: (c) => `Spread out, take map control, and hit ${c.site} late.` },
};

const DEFENSE_SETUPS = {
  standard: { name: "Standard", summary: (c) => `Spread across the map and rotate to whichever site gets hit. ${c.site} gets the extra player.` },
  stack: { name: "Stack", summary: (c) => `Four players stack ${c.site}; one plays info on the other side.` },
  aggressive: { name: "Aggressive info", summary: (c) => `Two players push out of ${c.site} for early picks, the rest hold.` },
  retake: { name: "Retake", summary: (c) => `Leave ${c.site} light, let them plant, and retake it together.` },
};

function attackJob(p, ctx) {
  switch (p.role) {
    case "Duelist":
      return `Entry first through ${p.at.name} and take space on ${p.target.name}. Open with ${abilityName(p)}.`;
    case "Controller":
      return `Cut vision on ${p.target.name} with ${abilityName(p)} from ${p.at.name}.`;
    case "Initiator":
      return `Clear ${p.target.name} with ${abilityName(p)} before the entry from ${p.at.name}.`;
    default:
      return `Watch the flank at ${p.at.name} with ${abilityName(p)} ready, then trail the team onto ${ctx.site}.`;
  }
}

function planAttack(rng, map, players) {
  const site = rng.pick(map.sites);
  const layout = siteLayout(map, site);
  const mid = midRoute(map, site);
  const otherSites = map.sites.filter((s) => s !== site);
  const keys = Object.keys(ATTACK_STRATS).filter(
    (k) => (k !== "split" || mid.length) && (k !== "fake" || otherSites.length),
  );
  const key = rng.pick(keys);
  const entries = rng.shuffle(layout.entries);
  const positions = rng.shuffle(layout.positions.filter((c) => c !== layout.site));
  const nextTarget = cycler(positions.length ? positions : [layout.site]);
  const ctx = { site: `${site} Site`, entry: entries[0].name };

  for (const p of players) {
    p.target = p.role === "Duelist" ? layout.site : nextTarget();
    p.at = entries[0];
  }

  if (key === "execute") {
    const nextEntry = cycler(entries);
    for (const p of players) p.at = p.role === "Sentinel" ? (mid[0] ?? entries[0]) : nextEntry();
  } else if (key === "split") {
    ctx.mid = mid[0].name;
    // Duelist leads the main entry; the rest split by alternating.
    players.forEach((p, i) => { p.at = p.role === "Duelist" || i % 2 === 0 ? entries[0] : mid[0]; });
  } else if (key === "fake") {
    const fakeSite = rng.pick(otherSites);
    const fakeEntries = siteLayout(map, fakeSite).entries;
    ctx.fakeSite = `${fakeSite} Site`;
    const fakers = rng.shuffle(players.filter((p) => p.role !== "Duelist")).slice(0, 2);
    for (const p of players) p.at = fakers.includes(p) ? rng.pick(fakeEntries) : entries[0];
    for (const p of fakers) {
      p.target = p.at;
      p.job = `Fake ${ctx.fakeSite}: use ${abilityName(p)} at ${p.at.name}, then rotate to ${ctx.site}.`;
    }
  } else {
    const spread = cycler(
      rng.shuffle([...entries, ...mid.slice(0, 2), ...otherSites.map((s) => siteLayout(map, s).entries[0])]),
    );
    for (const p of players) p.at = spread();
    for (const p of players) {
      if (p.role !== "Duelist") continue;
      p.job = `Take control of ${p.at.name} early, then lead the late hit onto ${ctx.site}. Save ${abilityName(p)} for the entry.`;
    }
  }

  for (const p of players) if (!p.job) p.job = attackJob(p, ctx);
  const spots = rng.shuffle(positions.length > 1 ? positions : [...positions, ...entries]);
  const postPlant = spots.length > 1
    ? `After the plant, crossfire the spike from ${spots[0].name} and ${spots[1].name}.`
    : `After the plant, hold the spike from ${spots[0].name}.`;
  return { site, key, strat: ATTACK_STRATS[key], ctx, postPlant };
}

function defenseJob(p, ctx) {
  switch (p.role) {
    case "Sentinel":
      return `Anchor ${p.at.zone} from ${p.at.name}. Set ${abilityName(p)} to slow the push.`;
    case "Controller":
      return `Play ${p.at.name} and delay any push into ${p.target.name} with ${abilityName(p)}.`;
    case "Initiator":
      return `Hold ${p.at.name}. Get early info on ${p.target.name} with ${abilityName(p)}.`;
    default:
      return `Take an early angle on ${p.target.name}, then fall back to ${p.at.name}. Keep ${abilityName(p)} to escape.`;
  }
}

function planDefense(rng, map, players) {
  const site = rng.pick(map.sites);
  const key = rng.pick(Object.keys(DEFENSE_SETUPS));
  const ctx = { site: `${site} Site` };
  const hasMid = map.callouts.some((c) => c.zone === "Mid");
  const others = map.sites.filter((s) => s !== site);

  let zones;
  if (key === "stack") zones = [site, site, site, site, rng.pick(others)];
  else if (key === "retake") zones = [site, ...others, ...(hasMid ? ["Mid"] : []), ...others, ...others].slice(0, 5);
  else zones = [site, site, ...(hasMid ? ["Mid"] : []), ...others, ...others].slice(0, 5);
  while (zones.length < 5) zones.push(rng.pick(map.sites));

  // Sentinels anchor the focus site; the rest fill the remaining zones.
  const ordered = [...players].sort((a, b) => (b.role === "Sentinel") - (a.role === "Sentinel"));
  const holds = {};
  const entriesOf = (zone) =>
    zone === "Mid" ? midRoute(map, site).slice(-2) : siteLayout(map, zone).entries;
  ordered.forEach((p, i) => {
    const zone = zones[i];
    if (!holds[zone]) {
      const spots = zone === "Mid"
        ? map.callouts.filter((c) => c.zone === "Mid")
        : siteLayout(map, zone).positions;
      holds[zone] = cycler(rng.shuffle(spots));
    }
    p.at = holds[zone]();
    p.target = rng.pick(entriesOf(zone)) ?? p.at;
  });

  if (key === "aggressive") {
    const pushers = ordered.filter((p) => p.at.zone === site).slice(0, 2);
    for (const p of pushers) {
      p.at = p.target;
      p.job = `Push out to ${p.at.name} for an early pick with ${abilityName(p)}, then fall back to ${ctx.site}.`;
    }
  }
  if (key === "retake") {
    for (const p of ordered) {
      if (p.at.zone === site) p.job = `Play off-site at ${p.at.name} with ${abilityName(p)}. Stay alive and call the plant.`;
      else p.job = `Hold ${p.at.name}. When they commit to ${ctx.site}, retake together using ${abilityName(p)}.`;
    }
  }
  for (const p of players) if (!p.job) p.job = defenseJob(p, ctx);
  return { site, key, strat: DEFENSE_SETUPS[key], ctx, postPlant: null };
}

export function generatePlan({ map, agents, side, seed, comp = "standard", twist = false }) {
  const rng = createRng(seed);
  const resolvedSide = side === "attack" || side === "defense" ? side : rng.pick(["attack", "defense"]);
  const players = pickComp(rng, agents, comp).map((a) => player(a, rng));
  const result = resolvedSide === "attack" ? planAttack(rng, map, players) : planDefense(rng, map, players);
  return {
    seed,
    mapId: map.id,
    side: resolvedSide,
    site: result.site,
    strat: { key: result.key, name: result.strat.name, summary: result.strat.summary(result.ctx) },
    players,
    postPlant: result.postPlant,
    twist: twist ? drawChallenge(rng, resolvedSide) : null,
  };
}
