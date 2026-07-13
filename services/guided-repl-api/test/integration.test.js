/**
 * Real-Postgres integration suite, gated on TEST_DATABASE_URL (skipped in
 * normal runs/CI without a database). Applies the migrations to the target
 * database, then exercises the pg-backed repo: user upsert, anon merge,
 * append-only wallet trigger + GDPR delete escape hatch.
 *
 *   TEST_DATABASE_URL=postgres://…/guided_repl_test node --test test/integration.test.js
 *
 * The target database is DROPPED-equivalent: tables are removed at setup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_URL = process.env.TEST_DATABASE_URL;
const gated = { skip: DB_URL ? false : "TEST_DATABASE_URL not set" };

const __dirname = dirname(fileURLToPath(import.meta.url));

test("pg repo: migrate, verify tx, merge, wallet trigger", gated, async () => {
  const { createPool, withTransaction } = await import("../src/db.js");
  const { createRepo } = await import("../src/repo.js");

  const pool = createPool(DB_URL);
  try {
    // Clean slate, then run the real migration runner.
    await pool.query(
      "DROP TABLE IF EXISTS schema_migrations, wallet_ledger, sessions, events, progress, leads, users CASCADE",
    );
    await pool.query("DROP VIEW IF EXISTS wallet_balances");
    await pool.query("DROP FUNCTION IF EXISTS wallet_ledger_append_only CASCADE");
    execFileSync(process.execPath, [join(__dirname, "..", "scripts", "migrate.js")], {
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: "pipe",
    });

    const repo = createRepo(pool);
    const anonId = "11111111-2222-4333-8444-555555555555";
    const authUid = "99999999-8888-4777-8666-555555555555";

    // Anonymous progress + lead exist pre-account.
    await repo.upsertProgress({ ownerType: "anon", ownerId: anonId, lessonId: "l1", status: "completed" });
    await repo.upsertLead({ anonId, email: "ada@example.com", consent: true, source: "l1-capture-email" });

    // Verify-flow transaction: user + session + merge + event.
    const { user } = await repo.withTransaction(async (tx) => {
      const { user, created } = await tx.createUser({ authUid, email: "ada@example.com" });
      assert.equal(created, true);
      await tx.createSession({ tokenHash: "hash1", userId: user.id, expiresAt: new Date(Date.now() + 60_000) });
      await tx.mergeAnon(anonId, user.id);
      await tx.insertEvents([{ ownerType: "user", ownerId: user.id, kind: "account_created" }]);
      return { user };
    });

    const progress = await repo.listProgress({ ownerType: "user", ownerId: user.id });
    assert.equal(progress.length, 1);
    assert.equal(progress[0].status, "completed");
    const lead = (await pool.query("SELECT claimed_by FROM leads WHERE anon_id = $1", [anonId])).rows[0];
    assert.equal(lead.claimed_by, user.id);
    assert.ok(await repo.findSession("hash1"));

    // createUser is idempotent by email.
    const again = await repo.createUser({ authUid, email: "ada@example.com" });
    assert.equal(again.created, false);
    assert.equal(again.user.id, user.id);

    // Wallet: append-only trigger blocks UPDATE/DELETE…
    await pool.query("INSERT INTO wallet_ledger (user_id, type, amount_cents, ref) VALUES ($1, 'topup', 500, 'test')", [user.id]);
    assert.equal(await repo.walletBalance(user.id), 500);
    await assert.rejects(() => pool.query("UPDATE wallet_ledger SET amount_cents = 1"), /append-only/);
    await assert.rejects(() => pool.query("DELETE FROM wallet_ledger"), /append-only/);

    // …except inside the GDPR account-deletion transaction.
    await withTransaction(pool, (client) => createRepo({ query: client.query.bind(client) }).deleteAccountData(user.id));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM wallet_ledger")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 0);
    const events = await pool.query("SELECT owner_id FROM events");
    assert.ok(events.rows.length > 0);
    assert.ok(events.rows.every((r) => r.owner_id === null));
  } finally {
    await pool.end();
  }
});
