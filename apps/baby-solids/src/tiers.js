/**
 * Evidence-tier presentation, in a plain module so the renderer and the test
 * that guards it read the same object.
 *
 * This started as a literal inside FoodView with a duplicate copy in the test.
 * Adding two tiers left the test asserting against the stale copy — it failed,
 * correctly, but for the wrong reason. A badge map that can drift from the
 * vocabulary it renders is how an unrecognised tier ends up silently falling
 * back to a neutral grey "Source" badge, which is precisely the case where the
 * label matters most.
 *
 * The keys here must stay in sync with `evidenceTiers` in content/enums.yaml;
 * test/uiContract.test.js asserts exactly that against the YAML.
 */

/** @type {Record<string, [label: string, color: string]>} */
export const TIER_LABEL = {
  guideline: ["Guideline", "teal"],
  retired_guideline: ["Retired guideline", "orange"],
  trial: ["Trial", "blue"],
  reference: ["Reference data", "cyan"],
  expert_opinion: ["Expert opinion", "grape"],
  common_practice: ["Common practice", "gray"],
};

/**
 * @param {string} tier
 * @returns {[label: string, color: string]}
 */
export function tierBadge(tier) {
  return TIER_LABEL[tier] ?? ["Source", "gray"];
}
