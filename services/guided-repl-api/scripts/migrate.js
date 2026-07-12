#!/usr/bin/env node
/**
 * Plain SQL migration runner: applies migrations/*.sql in filename order,
 * recording applied names in schema_migrations. Each migration runs in its
 * own transaction.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/migrate.js
 *   node scripts/migrate.js --dry-run     # validate + plan, no connection
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, "..", "migrations");
const dryRun = process.argv.includes("--dry-run");

/** @returns {Array<{name: string, sql: string}>} ordered, validated migrations */
function loadMigrations() {
  const names = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (names.length === 0) {
    throw new Error(`no .sql migrations found in ${migrationsDir}`);
  }
  const migrations = [];
  names.forEach((name, i) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`migration "${name}" does not match NNNN_name.sql`);
    }
    const seq = Number.parseInt(name.slice(0, 4), 10);
    if (seq !== i + 1) {
      throw new Error(`migration "${name}" breaks the sequence (expected ${String(i + 1).padStart(4, "0")}_…)`);
    }
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    if (sql.trim() === "") {
      throw new Error(`migration "${name}" is empty`);
    }
    migrations.push({ name, sql });
  });
  return migrations;
}

async function main() {
  const migrations = loadMigrations();

  if (dryRun) {
    console.log(`migrate --dry-run: ${migrations.length} migration(s) parse clean:`);
    for (const m of migrations) {
      console.log(`  - ${m.name} (${m.sql.length} bytes)`);
    }
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required (or pass --dry-run)");
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    for (const { name, sql } of migrations) {
      if (applied.has(name)) {
        console.log(`skip  ${name} (already applied)`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log(`apply ${name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${err.message}`);
      }
    }
    console.log("migrate: up to date.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`migrate: ${err.message}`);
  process.exit(1);
});
