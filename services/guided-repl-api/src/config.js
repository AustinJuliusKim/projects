/**
 * Environment-derived configuration. Every deployment knob lives here so
 * the Supabase→Aurora swap is a connection-string + adapter change, never a
 * code change (Accounts & Progress Spec portability discipline #1).
 */

/**
 * @typedef {object} ApiConfig
 * @property {string} databaseUrl
 * @property {string} supabaseUrl
 * @property {string} supabaseServiceRoleKey
 * @property {number} sessionTtlDays
 * @property {string} cookieSecret
 * @property {string} publicOrigin site origin for CORS + magic-link redirects
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ApiConfig}
 */
export function loadConfig(env = process.env) {
  return {
    databaseUrl: env.DATABASE_URL ?? "",
    supabaseUrl: env.SUPABASE_URL ?? "",
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    sessionTtlDays: Number.parseInt(env.SESSION_TTL_DAYS ?? "30", 10),
    cookieSecret: env.COOKIE_SECRET ?? "",
    publicOrigin: env.PUBLIC_ORIGIN ?? "https://learn.austinjuliuskim.com",
  };
}
