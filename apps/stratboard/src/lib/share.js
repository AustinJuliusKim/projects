// Shareable state lives in the URL hash, e.g. #plan?map=ascent&side=attack&seed=42.
// Unknown or malformed values fall back to defaults instead of throwing.

const SIDES = ["attack", "defense", "random"];
const COMPS = ["standard", "random"];
const ROULETTE_SIDES = ["any", "attack", "defense"];

const parseSeed = (v) => (/^\d+$/.test(v ?? "") ? Number(v) >>> 0 : null);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function parseHash(hash) {
  const [view, query = ""] = hash.replace(/^#/, "").split("?");
  const q = new URLSearchParams(query);
  if (view === "roulette") {
    return {
      view: "roulette",
      side: oneOf(q.get("side"), ROULETTE_SIDES, "any"),
      seed: parseSeed(q.get("seed")),
    };
  }
  return {
    view: "plan",
    map: q.get("map") || null,
    side: oneOf(q.get("side"), SIDES, "random"),
    comp: oneOf(q.get("comp"), COMPS, "standard"),
    twist: q.get("twist") === "1",
    seed: parseSeed(q.get("seed")),
  };
}

export function buildHash(state) {
  const q = new URLSearchParams();
  if (state.view === "roulette") {
    q.set("side", state.side);
  } else {
    if (state.map) q.set("map", state.map);
    q.set("side", state.side);
    q.set("comp", state.comp);
    if (state.twist) q.set("twist", "1");
  }
  if (state.seed != null) q.set("seed", String(state.seed));
  return `#${state.view}?${q}`;
}
