/**
 * Usage → USD conversion from the settings.yaml pricing table.
 *
 * Cache token rates follow the Claude API's standard multipliers relative to
 * the input price: writes bill at 1.25x (5-minute TTL), reads at 0.1x.
 */

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * @typedef {object} Usage
 * @property {number} [input_tokens]
 * @property {number} [output_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 */

/**
 * Converts one usage record to USD given a single model's pricing entry.
 *
 * @param {Usage} usage
 * @param {{inputPerMTok: number, outputPerMTok: number}} price
 * @returns {number} cost in USD
 */
export function usageToUsd(usage, price) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const perTokIn = price.inputPerMTok / 1e6;
  const perTokOut = price.outputPerMTok / 1e6;
  return (
    input * perTokIn +
    cacheWrite * perTokIn * CACHE_WRITE_MULTIPLIER +
    cacheRead * perTokIn * CACHE_READ_MULTIPLIER +
    output * perTokOut
  );
}

/**
 * Converts a usage record to USD for a model id, using the settings pricing
 * table. Unknown model ids are a hard error (config.js guarantees coverage
 * for configured roles; this guards ad-hoc --model-<role> overrides).
 *
 * @param {Usage} usage
 * @param {string} modelId
 * @param {Record<string, {inputPerMTok: number, outputPerMTok: number}>} pricingTable
 * @returns {number}
 */
export function costForModel(usage, modelId, pricingTable) {
  const price = pricingTable[modelId];
  if (!price) {
    throw new Error(`No pricing entry for model "${modelId}" — add it to foundry/settings.yaml`);
  }
  return usageToUsd(usage, price);
}
