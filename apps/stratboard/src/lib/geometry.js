// Classifies callouts by where they sit between the two spawns, so the plan
// generator works on any map the API returns without hand-written routes.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Board/minimap drawings use a 0..1000 square over the minimap image.
export const BOARD_SIZE = 1000;

// Board positions for players, in board units. Players sharing a callout fan
// out in a small ring of radius ~r so none hide the others.
export function fanOut(players, r) {
  const groups = new Map();
  players.forEach((p, i) => {
    if (!groups.has(p.at.name)) groups.set(p.at.name, []);
    groups.get(p.at.name).push(i);
  });
  const out = [];
  for (const idx of groups.values()) {
    idx.forEach((i, k) => {
      const { at } = players[i];
      const spread = idx.length > 1 ? r * 1.25 : 0;
      const angle = (k / idx.length) * Math.PI * 2 - Math.PI / 2;
      out[i] = {
        x: at.x * BOARD_SIZE + Math.cos(angle) * spread,
        y: at.y * BOARD_SIZE + Math.sin(angle) * spread,
      };
    });
  }
  return out;
}

// Minimap art fills only the middle of its image, so views frame the callouts
// (plus a margin) instead of the whole square.
// The margin covers art past the outermost callouts (Ascent's attacker side).
export function mapFrame(map, pad = 120) {
  const xs = map.callouts.map((c) => c.x * BOARD_SIZE);
  const ys = map.callouts.map((c) => c.y * BOARD_SIZE);
  const x = Math.max(0, Math.min(...xs) - pad);
  const y = Math.max(0, Math.min(...ys) - pad);
  return {
    x,
    y,
    w: Math.min(BOARD_SIZE, Math.max(...xs) + pad) - x,
    h: Math.min(BOARD_SIZE, Math.max(...ys) + pad) - y,
  };
}

export function spawns(map) {
  const find = (zone) => map.callouts.find((c) => c.zone === zone && c.region === "Spawn");
  return { attack: find("Attacker Side"), defense: find("Defender Side") };
}

// 0 = on top of the attacker spawn, 1 = on top of the defender spawn.
export function attackBias(map, callout) {
  const { attack, defense } = spawns(map);
  const a = dist(callout, attack);
  const d = dist(callout, defense);
  return a + d === 0 ? 0.5 : a / (a + d);
}

const byBias = (map) => (a, b) => attackBias(map, a) - attackBias(map, b);

// Straight-line distance misreads a few sites where the walking route bends
// (Bind's teleporter side, Pearl's A Main). These name the real approaches.
export const ENTRY_OVERRIDES = {
  ascent: { A: ["A Lobby", "A Main"] },
  bind: { A: ["A Lobby", "A Short"], B: ["B Long", "B Short"] },
  pearl: { A: ["A Restaurant", "A Main"] },
};

// Splits a site's callouts into attacker approaches and hold positions.
// Approaches sit nearer attacker spawn than the site does (at most a third of
// the zone). A site with none, like Haven B, is approached from the nearest
// Mid callouts instead.
export function siteLayout(map, site) {
  const inSite = map.callouts.filter((c) => c.zone === site).sort(byBias(map));
  const target = inSite.find((c) => c.region === "Site") ?? inSite[inSite.length - 1];
  const limit = Math.max(1, Math.ceil(inSite.length / 3));
  const override = (ENTRY_OVERRIDES[map.id]?.[site] ?? [])
    .map((name) => inSite.find((c) => c.name === name))
    .filter(Boolean);
  let entries = override.length
    ? override
    : inSite
      .filter((c) => c !== target && attackBias(map, c) < attackBias(map, target))
      .slice(0, limit);
  const positions = inSite.filter((c) => !entries.includes(c));
  if (!entries.length) {
    entries = map.callouts
      .filter((c) => c.zone === "Mid")
      .sort((a, b) => dist(a, target) - dist(b, target))
      .slice(0, 2);
  }
  if (!entries.length) entries = [inSite[0]];
  return { entries, positions, site: target };
}

// Mid callouts ordered by distance to the target site, nearest first. Maps
// without a Mid zone (Bind, Fracture, Lotus) fall back to other sites' links.
export function midRoute(map, site) {
  const target = siteLayout(map, site).site;
  let mid = map.callouts.filter((c) => c.zone === "Mid");
  if (!mid.length) mid = map.callouts.filter((c) => c.region === "Link" && c.zone !== site);
  return mid.sort((a, b) => dist(a, target) - dist(b, target));
}
