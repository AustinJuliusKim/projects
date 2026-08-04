// @vitest-environment node
/**
 * The production schema, executed by the production wasm build of SQLite —
 * in-memory, in Node. The VFS differs from the browser's OPFS pool, but SQL
 * semantics don't, and this is the same .wasm the deployed app ships.
 */

import { describe, expect, it } from 'vitest'

// The exact file the worker executes, via the same ?raw import — Vitest runs
// imports through Vite, so this works in the node environment too.
import SCHEMA from '../../../webapp/schema.sql?raw'
import { initSchema, wrapDb, transaction, type Database } from './db'

async function openDb(): Promise<Database & { close(): void; selectObjects(sql: string): Record<string, unknown>[] }> {
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
  const sqlite3 = await sqlite3InitModule()
  return wrapDb(new sqlite3.oo1.DB(':memory:') as never) as never
}

describe('schema on sqlite-wasm', () => {
  it('initializes idempotently and stamps version 1', async () => {
    const db = await openDb()
    try {
      expect(initSchema(db, SCHEMA)).toBe(1)
      // Second run must be a no-op, not an error — the app reopens the same
      // OPFS file on every boot.
      expect(initSchema(db, SCHEMA)).toBe(1)
      expect(db.selectValue('SELECT count(*) FROM schema_version')).toBe(1)
    } finally {
      db.close()
    }
  })

  it('never declares a money column as REAL', async () => {
    // Port of webapp/db.py money_columns + its test: REAL money would
    // reintroduce exactly the float drift the whole stack exists to prevent.
    const db = await openDb()
    try {
      initSchema(db, SCHEMA)
      const tables = db
        .selectObjects("SELECT name FROM sqlite_master WHERE type='table'")
        .map((r) => r.name as string)
      const offenders: string[] = []
      for (const table of tables) {
        for (const col of db.selectObjects(`PRAGMA table_info(${table})`)) {
          const name = col.name as string
          const decl = String(col.type ?? '').toUpperCase()
          if (/(cents|price|cost|fee|amount|value)/i.test(name) && decl === 'REAL') {
            offenders.push(`${table}.${name}`)
          }
        }
      }
      expect(offenders).toEqual([])
    } finally {
      db.close()
    }
  })

  it('supports the transaction discipline every mutation will use', async () => {
    const db = await openDb()
    try {
      initSchema(db, SCHEMA)
      expect(() =>
        transaction(db, () => {
          db.exec(
            "INSERT INTO operations (kind, summary, affected, inverse, created_at) " +
              "VALUES ('test', 'x', 0, '[]', '2026-07-30T00:00:00+00:00')",
          )
          throw new Error('abort')
        }),
      ).toThrow('abort')
      expect(db.selectValue('SELECT count(*) FROM operations')).toBe(0)
    } finally {
      db.close()
    }
  })
})
