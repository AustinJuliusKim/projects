// Pure feature-flag resolution (§10c client side) — React-free so it unit
// tests under node:test. Defaults mirror the PUBLIC flags in
// backend/flags.mjs FLAG_DEFS; keep in sync when public flags change.
export const CLIENT_FLAG_DEFAULTS = Object.freeze({
  release_reveal_card: true,
  release_realtime_subscribe: false,
  release_polling_demoted: false,
});

// State shape: { flags: {name: bool}, hydrated: bool }.
export function initialFlagsState() {
  return { flags: { ...CLIENT_FLAG_DEFAULTS }, hydrated: false };
}

// Merge a getFlags response over the defaults. Unknown server flags are
// carried (forward compat); a malformed payload leaves defaults untouched.
export function hydrateFlagsState(state, fetched) {
  if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) {
    return { ...state, hydrated: true };
  }
  const flags = { ...state.flags };
  for (const [name, value] of Object.entries(fetched)) {
    if (typeof value === "boolean") flags[name] = value;
  }
  return { flags, hydrated: true };
}

// Effective value: server-hydrated when known, caller fallback, then the
// built-in default, then false. Never throws.
export function resolveFlag(state, name, fallback) {
  if (state?.flags && name in state.flags) return state.flags[name];
  if (typeof fallback === "boolean") return fallback;
  return CLIENT_FLAG_DEFAULTS[name] ?? false;
}
