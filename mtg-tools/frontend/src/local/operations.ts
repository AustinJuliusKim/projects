/**
 * The undo log — port of `webapp/operations.py`, semantics preserved line for
 * line (including error messages: the UI shows them, and the parity gate
 * diffs them).
 *
 * The model is an **inverse patch**: every mutating action records, in the
 * same transaction, the row state needed to put things back. Undo replays
 * that state. It stores only the rows an operation touched, which keeps a
 * 400-row bulk edit small and exact.
 */

import { now, type Database } from './db'

/** Only these tables participate. Anything else must be reconstructible from
 * them, so an operation can never leave a half-reversible trail. */
export const UNDOABLE_TABLES = [
  'holdings',
  'sealed',
  'verdicts',
  'sales',
  'imports',
  'staged_rows',
] as const

export type RowKey = number | string | Array<number | string>
export type RowDict = Record<string, unknown>

export interface OperationRecord {
  id: number
  kind: string
  summary: string
  affected: number
  createdAt: string
  revertedAt: string | null
  reverted: boolean
}

/** Undo's "can't do that" — maps to HTTP 409 at the endpoint edge. */
export class UndoLookupError extends Error {}

function toRecord(row: RowDict): OperationRecord {
  return {
    id: row.id as number,
    kind: row.kind as string,
    summary: row.summary as string,
    affected: row.affected as number,
    createdAt: row.created_at as string,
    revertedAt: (row.reverted_at as string | null) ?? null,
    reverted: row.reverted_at !== null && row.reverted_at !== undefined,
  }
}

/** Primary key columns. `verdicts` is the one composite key. */
function pk(table: string): string[] {
  return table === 'verdicts' ? ['subject_kind', 'subject_id'] : ['id']
}

function assertUndoable(table: string): void {
  if (!(UNDOABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`${table} is not undoable`)
  }
}

/**
 * Capture rows exactly as they are now, for later restoration. Call this
 * *before* mutating. Rows that don't exist yet simply aren't captured, which
 * is what makes an insert reverse into a delete.
 */
export function snapshotRows(db: Database, table: string, ids: RowKey[]): RowDict[] {
  assertUndoable(table)
  const keys = pk(table)
  if (!ids.length) return []

  if (keys.length === 1) {
    const placeholders = ids.map(() => '?').join(',')
    return db.selectObjects(
      `SELECT * FROM ${table} WHERE ${keys[0]} IN (${placeholders})`,
      ids as unknown[],
    )
  }

  const rows: RowDict[] = []
  for (const keyTuple of ids) {
    const where = keys.map((k) => `${k} = ?`).join(' AND ')
    const found = db.selectObject(
      `SELECT * FROM ${table} WHERE ${where}`,
      keyTuple as unknown[],
    )
    if (found !== undefined) rows.push(found)
  }
  return rows
}

/**
 * Write one undo entry. Must be called inside the mutation's transaction.
 *
 * `before`  — {table: [row dicts as they were]}; restored on undo.
 * `created` — {table: [primary keys that did not exist before]}; deleted on undo.
 *
 * A row that appears in both is handled correctly: `created` deletes run
 * first, then `before` restores, so an update that also inserted reverses
 * cleanly.
 */
export function record(
  db: Database,
  kind: string,
  summary: string,
  options: {
    before?: Record<string, RowDict[]>
    created?: Record<string, RowKey[]>
    affected?: number
  } = {},
): number {
  const inverse = {
    before: options.before ?? {},
    created: Object.fromEntries(
      Object.entries(options.created ?? {}).map(([table, keys]) => [
        table,
        keys.map((k) => (Array.isArray(k) ? [...k] : k)),
      ]),
    ),
  }
  for (const table of [...Object.keys(inverse.before), ...Object.keys(inverse.created)]) {
    assertUndoable(table)
  }

  db.exec({
    sql:
      'INSERT INTO operations (kind, summary, affected, inverse, created_at) ' +
      'VALUES (?, ?, ?, ?, ?)',
    bind: [kind, summary, options.affected ?? 0, JSON.stringify(inverse), now()],
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

function resolveTarget(db: Database, operationId?: number): OperationRecord {
  const newest = db.selectObject(
    'SELECT * FROM operations WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1',
  )
  if (newest === undefined) throw new UndoLookupError('nothing to undo')
  if (operationId === undefined) return toRecord(newest)

  const row = db.selectObject('SELECT * FROM operations WHERE id = ?', [operationId])
  if (row === undefined) throw new UndoLookupError(`no operation ${operationId}`)
  if (row.reverted_at !== null && row.reverted_at !== undefined) {
    throw new UndoLookupError(`operation ${operationId} is already undone`)
  }
  if (row.id !== newest.id) {
    throw new UndoLookupError(
      `operation ${operationId} is not the most recent change ` +
        `(that is #${newest.id}: ${newest.summary}). ` +
        'Undo works newest-first so the result always matches the log.',
    )
  }
  return toRecord(row)
}

/**
 * Reverse one operation. Defaults to the most recent un-reverted one.
 *
 * Deliberately strict: only the newest un-reverted operation can be undone.
 * Undoing out of order would silently produce a state neither the user nor
 * the log describes.
 */
export function undoOperation(db: Database, operationId?: number): OperationRecord {
  const target = resolveTarget(db, operationId)
  const inverse = JSON.parse(
    db.selectValue('SELECT inverse FROM operations WHERE id = ?', [target.id]) as string,
  ) as { before?: Record<string, RowDict[]>; created?: Record<string, RowKey[]> }

  // Deletes first: an operation that both created and updated rows reverses
  // cleanly only in this order.
  for (const [table, keys] of Object.entries(inverse.created ?? {})) {
    const columns = pk(table)
    for (const key of keys) {
      const values = Array.isArray(key) ? key : [key]
      const where = columns.map((c) => `${c} = ?`).join(' AND ')
      db.exec({ sql: `DELETE FROM ${table} WHERE ${where}`, bind: values })
    }
  }

  for (const [table, rows] of Object.entries(inverse.before ?? {})) {
    for (const row of rows) {
      const columns = Object.keys(row)
      const placeholders = columns.map(() => '?').join(',')
      db.exec({
        sql:
          `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) ` +
          `VALUES (${placeholders})`,
        bind: columns.map((c) => row[c] ?? null),
      })
    }
  }

  db.exec({
    sql: 'UPDATE operations SET reverted_at = ? WHERE id = ?',
    bind: [now(), target.id],
  })
  return target
}

export function recent(db: Database, limit = 25): OperationRecord[] {
  return db
    .selectObjects('SELECT * FROM operations ORDER BY id DESC LIMIT ?', [limit])
    .map(toRecord)
}

export function latestUndoable(db: Database): OperationRecord | null {
  const row = db.selectObject(
    'SELECT * FROM operations WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1',
  )
  return row === undefined ? null : toRecord(row)
}
