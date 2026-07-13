/**
 * Plain `pg` pool + transaction helper. No ORM, no Supabase client — the
 * database is treated as plain managed Postgres so migration is a
 * connection-string swap (portability discipline #1).
 */

import pg from "pg";

/**
 * @param {string} databaseUrl
 * @returns {pg.Pool}
 */
export function createPool(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

/**
 * Runs `fn` inside BEGIN/COMMIT with rollback on throw.
 *
 * @template T
 * @param {pg.Pool} pool
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
