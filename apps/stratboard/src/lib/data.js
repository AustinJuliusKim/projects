// Normalizes valorant-api.com responses into the shapes the app uses. The same
// functions build the bundled snapshot (scripts/snapshot.mjs) and refresh it
// live in the browser, so the two can't drift.

export const API_BASE = "https://valorant-api.com/v1";
export const SIDE_ZONES = ["Attacker Side", "Defender Side"];
const ABILITY_SLOTS = new Set(["Ability1", "Ability2", "Grenade"]);

export const slug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function calloutName(zone, region) {
  return SIDE_ZONES.includes(zone) ? region : `${zone} ${region}`;
}

// valorant-api's minimap transform swaps the world axes: image x comes from
// world y and image y from world x. Result is 0..1 across the minimap image.
export function toMinimap(map, loc) {
  return {
    x: loc.y * map.xMultiplier + map.xScalarToAdd,
    y: loc.x * map.yMultiplier + map.yScalarToAdd,
  };
}

const round = (n) => Math.round(n * 10000) / 10000;

export function normalizeMaps(apiMaps) {
  const maps = [];
  for (const m of apiMaps) {
    // Team deathmatch and range maps have no site layout.
    if (!m.tacticalDescription || !m.callouts?.length) continue;
    const seen = new Set();
    const callouts = [];
    for (const c of m.callouts) {
      const name = calloutName(c.superRegionName, c.regionName);
      const key = `${c.superRegionName}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { x, y } = toMinimap(m, c.location);
      callouts.push({ name, zone: c.superRegionName, region: c.regionName, x: round(x), y: round(y) });
    }
    const spawn = (zone) => callouts.find((c) => c.zone === zone && c.region === "Spawn");
    if (!spawn("Attacker Side") || !spawn("Defender Side")) continue;
    const sites = [...new Set(callouts.map((c) => c.zone))]
      .filter((z) => /^[A-Z]$/.test(z))
      .sort();
    maps.push({
      id: slug(m.displayName),
      name: m.displayName,
      sites,
      minimap: m.displayIcon,
      splash: m.listViewIcon,
      callouts,
    });
  }
  return maps.sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeAgents(apiAgents) {
  return apiAgents
    .filter((a) => a.isPlayableCharacter && a.role)
    .map((a) => ({
      id: slug(a.displayName),
      name: a.displayName,
      role: a.role.displayName,
      icon: a.displayIcon,
      abilities: a.abilities
        .filter((ab) => ABILITY_SLOTS.has(ab.slot))
        .map((ab) => ({ slot: ab.slot, name: ab.displayName, icon: ab.displayIcon })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchGameData(fetchImpl = fetch) {
  const get = async (path) => {
    const res = await fetchImpl(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()).data;
  };
  const [maps, agents] = await Promise.all([
    get("/maps"),
    get("/agents?isPlayableCharacter=true"),
  ]);
  return { maps: normalizeMaps(maps), agents: normalizeAgents(agents) };
}
