// @vitest-environment node
/**
 * Port of the undo-log intent from tests_webapp/test_core.py TestUndo,
 * exercised at the operations layer (the importer/bulk callers arrive in
 * later phases). Same wasm SQLite, same schema, same discipline: every
 * mutation snapshots first, records in the same transaction, and undo puts
 * back byte-identical rows.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import SCHEMA from '../../../webapp/schema.sql?raw'
import { initSchema, wrapDb, transaction, type Database } from './db'
import {
  UndoLookupError,
  latestUndoable,
  recent,
  record,
  snapshotRows,
  undoOperation,
} from './operations'

type Db = Database & { close(): void }

async function openDb(): Promise<Db> {
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
  const sqlite3 = await sqlite3InitModule()
  const db = wrapDb(new sqlite3.oo1.DB(':memory:') as never) as Db
  initSchema(db, SCHEMA)
  return db
}

function insertHolding(db: Database, identity: string, title: string, cents: number | null) {
  db.exec({
    sql:
      'INSERT INTO holdings (identity, title, quantity, price_cents, created_at, updated_at) ' +
      "VALUES (?, ?, 3, ?, '2026-07-30T00:00:00+00:00', '2026-07-30T00:00:00+00:00')",
    bind: [identity, title, cents],
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

describe('the undo log', () => {
  let db: Db
  beforeEach(async () => {
    db = await openDb()
  })

  it('reverses an update exactly, byte for byte', () => {
    const id = insertHolding(db, 'a foil', 'Mox Amber', 7517)
    const original = db.selectObject('SELECT * FROM holdings WHERE id = ?', [id])

    transaction(db, () => {
      const before = snapshotRows(db, 'holdings', [id])
      db.exec({ sql: 'UPDATE holdings SET price_cents = 9999, quantity = 1 WHERE id = ?', bind: [id] })
      record(db, 'bulk_price', 'Set price on 1 row', { before: { holdings: before }, affected: 1 })
    })
    expect(db.selectValue('SELECT price_cents FROM holdings WHERE id = ?', [id])).toBe(9999)

    transaction(db, () => undoOperation(db))
    expect(db.selectObject('SELECT * FROM holdings WHERE id = ?', [id])).toEqual(original)
  })

  it('reverses a delete by restoring the row', () => {
    const id = insertHolding(db, 'b normal', 'Llanowar Elves', 35)

    transaction(db, () => {
      const before = snapshotRows(db, 'holdings', [id])
      db.exec({ sql: 'DELETE FROM holdings WHERE id = ?', bind: [id] })
      record(db, 'bulk_delete', 'Deleted 1 row', { before: { holdings: before }, affected: 1 })
    })
    expect(db.selectValue('SELECT count(*) FROM holdings')).toBe(0)

    transaction(db, () => undoOperation(db))
    expect(db.selectValue('SELECT title FROM holdings WHERE id = ?', [id])).toBe('Llanowar Elves')
  })

  it('reverses an insert into a deletion — the composite-PK verdicts case', () => {
    const id = insertHolding(db, 'c normal', 'Doubling Season', 3604)

    transaction(db, () => {
      db.exec({
        sql:
          "INSERT INTO verdicts (subject_kind, subject_id, verdict, decided_at) " +
          "VALUES ('holding', ?, 'sell', '2026-07-30T00:00:00+00:00')",
        bind: [id],
      })
      record(db, 'verdict', 'Marked 1 row sell', {
        created: { verdicts: [['holding', id]] },
        affected: 1,
      })
    })
    expect(db.selectValue('SELECT count(*) FROM verdicts')).toBe(1)

    transaction(db, () => undoOperation(db))
    expect(db.selectValue('SELECT count(*) FROM verdicts')).toBe(0)
    // The holding itself is untouched — only the operation's own trail reverts.
    expect(db.selectValue('SELECT count(*) FROM holdings')).toBe(1)
  })

  it('is strictly newest-first, with the explanatory error', () => {
    const id = insertHolding(db, 'd normal', 'Sneak Attack', 1200)
    const first = transaction(db, () => {
      const before = snapshotRows(db, 'holdings', [id])
      db.exec({ sql: 'UPDATE holdings SET quantity = 5 WHERE id = ?', bind: [id] })
      return record(db, 'edit', 'first edit', { before: { holdings: before } })
    })
    transaction(db, () => {
      const before = snapshotRows(db, 'holdings', [id])
      db.exec({ sql: 'UPDATE holdings SET quantity = 7 WHERE id = ?', bind: [id] })
      record(db, 'edit', 'second edit', { before: { holdings: before } })
    })

    expect(() => transaction(db, () => undoOperation(db, first))).toThrow(
      /not the most recent change/,
    )
    // The refused undo changed nothing.
    expect(db.selectValue('SELECT quantity FROM holdings WHERE id = ?', [id])).toBe(7)
  })

  it('undoing twice walks back two steps', () => {
    const id = insertHolding(db, 'e normal', 'Holistic Wisdom', 4696)
    for (const quantity of [5, 7]) {
      transaction(db, () => {
        const before = snapshotRows(db, 'holdings', [id])
        db.exec({ sql: 'UPDATE holdings SET quantity = ? WHERE id = ?', bind: [quantity, id] })
        record(db, 'edit', `set quantity ${quantity}`, { before: { holdings: before } })
      })
    }
    transaction(db, () => undoOperation(db))
    expect(db.selectValue('SELECT quantity FROM holdings WHERE id = ?', [id])).toBe(5)
    transaction(db, () => undoOperation(db))
    expect(db.selectValue('SELECT quantity FROM holdings WHERE id = ?', [id])).toBe(3)
    expect(latestUndoable(db)).toBeNull()
    expect(() => transaction(db, () => undoOperation(db))).toThrow(UndoLookupError)
  })

  it('a failed action leaves no operation behind', () => {
    const id = insertHolding(db, 'f normal', 'Grizzly Bears', 200)
    expect(() =>
      transaction(db, () => {
        const before = snapshotRows(db, 'holdings', [id])
        db.exec({ sql: 'UPDATE holdings SET quantity = 0 WHERE id = ?', bind: [id] })
        record(db, 'edit', 'doomed edit', { before: { holdings: before } })
        throw new Error('constraint failed downstream')
      }),
    ).toThrow('constraint failed downstream')
    expect(db.selectValue('SELECT count(*) FROM operations')).toBe(0)
    expect(db.selectValue('SELECT quantity FROM holdings WHERE id = ?', [id])).toBe(3)
  })

  it('refuses tables outside the undoable set', () => {
    expect(() => snapshotRows(db, 'operations', [1])).toThrow('is not undoable')
    expect(() =>
      record(db, 'x', 'x', { before: { schema_version: [] } as never }),
    ).toThrow('is not undoable')
  })

  it('recent() lists newest first and marks reverted entries', () => {
    const id = insertHolding(db, 'g normal', 'Oracle', 100)
    transaction(db, () => {
      const before = snapshotRows(db, 'holdings', [id])
      db.exec({ sql: 'UPDATE holdings SET quantity = 9 WHERE id = ?', bind: [id] })
      record(db, 'edit', 'the edit', { before: { holdings: before } })
    })
    transaction(db, () => undoOperation(db))

    const log = recent(db)
    expect(log).toHaveLength(1)
    expect(log[0].summary).toBe('the edit')
    expect(log[0].reverted).toBe(true)
    expect(log[0].revertedAt).not.toBeNull()
  })
})
