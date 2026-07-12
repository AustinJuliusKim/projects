/**
 * All SQL lives here, behind plain functions. `createRepo(pool)` returns the
 * interface app.js consumes; `repo.withTransaction(fn)` yields a tx-scoped
 * repo bound to one client (used by the verify flow's user-upsert + session
 * + anon-merge, which must be ONE transaction).
 *
 * Tests stub this interface in-memory — app.js never sees `pg` directly.
 */

import { withTransaction } from "./db.js";

/**
 * @param {{query: (text: string, values?: unknown[]) => Promise<{rows: any[]}>}} db pool or client
 * @param {import("pg").Pool|null} pool the underlying pool (null for tx-scoped repos)
 */
function makeRepo(db, pool) {
  return {
    /** @param {string} authUid */
    async findUserByAuthUid(authUid) {
      const { rows } = await db.query("SELECT * FROM users WHERE auth_uid = $1", [authUid]);
      return rows[0] ?? null;
    },

    /** @param {string} email */
    async findUserByEmail(email) {
      const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
      return rows[0] ?? null;
    },

    /** @param {string} id */
    async getUser(id) {
      const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [id]);
      return rows[0] ?? null;
    },

    /**
     * Upserts by email (magic-link identity): attaches auth_uid to a
     * pre-existing user with the same email. Returns {user, created}.
     *
     * @param {{authUid: string, email: string}} params
     */
    async createUser({ authUid, email }) {
      const { rows } = await db.query(
        `INSERT INTO users (auth_uid, email) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET auth_uid = EXCLUDED.auth_uid
         RETURNING *, (xmax = 0) AS created`,
        [authUid, email],
      );
      const { created, ...user } = rows[0];
      return { user, created };
    },

    /** @param {string} id @param {{name?: string|null, marketingConsent?: boolean}} fields */
    async updateUser(id, { name, marketingConsent }) {
      const { rows } = await db.query(
        `UPDATE users SET
           name = COALESCE($2, name),
           marketing_consent = COALESCE($3, marketing_consent)
         WHERE id = $1 RETURNING *`,
        [id, name ?? null, marketingConsent ?? null],
      );
      return rows[0] ?? null;
    },

    /** @param {{anonId: string, name?: string|null, email?: string|null, consent: boolean, source: string}} lead */
    async upsertLead({ anonId, name, email, consent, source }) {
      const { rows } = await db.query(
        `INSERT INTO leads (anon_id, name, email, consent, source)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [anonId, name ?? null, email ?? null, consent, source],
      );
      return rows[0];
    },

    /** @param {{ownerType: "anon"|"user", ownerId: string, lessonId: string, status: string, assertions?: object}} p */
    async upsertProgress({ ownerType, ownerId, lessonId, status, assertions }) {
      const { rows } = await db.query(
        `INSERT INTO progress (owner_type, owner_id, lesson_id, status, assertions, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (owner_type, owner_id, lesson_id)
         DO UPDATE SET status = EXCLUDED.status, assertions = EXCLUDED.assertions, updated_at = now()
         RETURNING *`,
        [ownerType, ownerId, lessonId, status, JSON.stringify(assertions ?? {})],
      );
      return rows[0];
    },

    /** @param {{ownerType: "anon"|"user", ownerId: string}} owner */
    async listProgress({ ownerType, ownerId }) {
      const { rows } = await db.query(
        `SELECT lesson_id, status, assertions, updated_at
         FROM progress WHERE owner_type = $1 AND owner_id = $2 ORDER BY lesson_id`,
        [ownerType, ownerId],
      );
      return rows;
    },

    /** @param {Array<{ownerType: "anon"|"user", ownerId: string|null, kind: string, payload?: object}>} events */
    async insertEvents(events) {
      for (const e of events) {
        await db.query(
          "INSERT INTO events (owner_type, owner_id, kind, payload) VALUES ($1, $2, $3, $4)",
          [e.ownerType, e.ownerId ?? null, e.kind, JSON.stringify(e.payload ?? {})],
        );
      }
    },

    /**
     * Claims an anonymous identity for a user: fresher progress rows win per
     * lesson, events are reassigned, leads are marked claimed. Call on a
     * tx-scoped repo (the verify flow's single transaction).
     *
     * @param {string} anonId
     * @param {string} userId
     */
    async mergeAnon(anonId, userId) {
      // Drop whichever side is stale when both owners have the same lesson…
      await db.query(
        `DELETE FROM progress p USING progress u
         WHERE p.owner_type = 'anon' AND p.owner_id = $1
           AND u.owner_type = 'user' AND u.owner_id = $2
           AND u.lesson_id = p.lesson_id AND u.updated_at >= p.updated_at`,
        [anonId, userId],
      );
      await db.query(
        `DELETE FROM progress u USING progress p
         WHERE u.owner_type = 'user' AND u.owner_id = $2
           AND p.owner_type = 'anon' AND p.owner_id = $1
           AND p.lesson_id = u.lesson_id AND p.updated_at > u.updated_at`,
        [anonId, userId],
      );
      // …then move the surviving anon rows across.
      await db.query(
        `UPDATE progress SET owner_type = 'user', owner_id = $2
         WHERE owner_type = 'anon' AND owner_id = $1`,
        [anonId, userId],
      );
      await db.query(
        `UPDATE events SET owner_type = 'user', owner_id = $2
         WHERE owner_type = 'anon' AND owner_id = $1`,
        [anonId, userId],
      );
      await db.query("UPDATE leads SET claimed_by = $2 WHERE anon_id = $1", [anonId, userId]);
    },

    /** @param {string} userId @returns {Promise<number>} balance in cents */
    async walletBalance(userId) {
      const { rows } = await db.query(
        "SELECT balance_cents FROM wallet_balances WHERE user_id = $1",
        [userId],
      );
      return Number(rows[0]?.balance_cents ?? 0);
    },

    /** @param {{tokenHash: string, userId: string, expiresAt: Date}} session */
    async createSession({ tokenHash, userId, expiresAt }) {
      await db.query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
        [tokenHash, userId, expiresAt],
      );
    },

    /** @param {string} tokenHash @returns unexpired session or null */
    async findSession(tokenHash) {
      const { rows } = await db.query(
        "SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > now()",
        [tokenHash],
      );
      return rows[0] ?? null;
    },

    /** @param {string} tokenHash */
    async deleteSession(tokenHash) {
      await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    },

    /** Full data export for GET /api/account/export. @param {string} userId */
    async exportAccount(userId) {
      const user = await this.getUser(userId);
      const progress = await this.listProgress({ ownerType: "user", ownerId: userId });
      const { rows: events } = await db.query(
        "SELECT kind, payload, created_at FROM events WHERE owner_type = 'user' AND owner_id = $1 ORDER BY id",
        [userId],
      );
      const { rows: leads } = await db.query(
        "SELECT name, email, consent, source, created_at FROM leads WHERE claimed_by = $1 ORDER BY created_at",
        [userId],
      );
      const { rows: ledger } = await db.query(
        "SELECT type, amount_cents, ref, created_at FROM wallet_ledger WHERE user_id = $1 ORDER BY id",
        [userId],
      );
      return { user, progress, events, leads, walletLedger: ledger };
    },

    /**
     * GDPR purge: PII rows deleted, events retained anonymized. Must run in
     * a transaction — app.gdpr_delete is transaction-local, and it is the
     * only thing the wallet_ledger append-only trigger honors for DELETE.
     *
     * @param {string} userId
     */
    async deleteAccountData(userId) {
      await db.query("SELECT set_config('app.gdpr_delete', 'on', true)");
      await db.query("DELETE FROM wallet_ledger WHERE user_id = $1", [userId]);
      await db.query("DELETE FROM progress WHERE owner_type = 'user' AND owner_id = $1", [userId]);
      await db.query("UPDATE events SET owner_id = NULL WHERE owner_type = 'user' AND owner_id = $1", [userId]);
      await db.query("UPDATE leads SET name = NULL, email = NULL WHERE claimed_by = $1", [userId]);
      await db.query("DELETE FROM users WHERE id = $1", [userId]); // sessions cascade
    },

    /**
     * @template T
     * @param {(tx: ReturnType<typeof makeRepo>) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withTransaction(fn) {
      if (!pool) return fn(this); // already inside a transaction
      return withTransaction(pool, (client) => fn(makeRepo(client, null)));
    },
  };
}

/**
 * @param {import("pg").Pool} pool
 */
export function createRepo(pool) {
  return makeRepo(pool, pool);
}
