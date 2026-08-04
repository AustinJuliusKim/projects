/**
 * Bulk edits over a selection — port of `webapp/bulk.py`.
 *
 * The two safety properties carry over: one transaction + one undo entry, and
 * the selection resolved here from ids or filters, never from a count the
 * client sent.
 *
 * The percent price-adjust is the one float-forbidden site: Python does
 * `Decimal(price) * ((100 + pct) / 100)` quantized HALF_UP. The port keeps it
 * exact with BigInt rational arithmetic — pct parsed as P/10^s, so the update
 * is round_half_up(price * (100·10^s + P) / (100·10^s)) with no doubles
 * anywhere. A generated Python oracle fixture pins the equivalence.
 */

import { now, toCents, type Database } from './db'
import * as ops from './operations'
import * as repo from './repo'

export class BulkError extends Error {}

//: Hard ceiling. Not a performance limit — a tripwire.
export const MAX_ROWS = 10_000

type Kind = keyof typeof repo.SUBJECTS

function subject(kind: string) {
  const spec = repo.SUBJECTS[kind as Kind]
  if (!spec) throw new BulkError(`'${kind}' is not a bulk subject`)
  return spec
}

export function resolveSelection(
  db: Database,
  options: {
    ids?: number[]
    filters?: repo.FilterValues
    selectAll?: boolean
    kind?: string
  },
): number[] {
  const kind = options.kind ?? 'holding'
  const spec = subject(kind)
  let found: number[]
  if (options.selectAll) {
    found = spec.matchingIds(db, options.filters ?? {})
  } else {
    found = (options.ids ?? []).map((i) => Math.trunc(Number(i)))
    if (found.length) {
      const placeholders = found.map(() => '?').join(',')
      found = db
        .selectObjects(
          `SELECT id FROM ${spec.table} WHERE id IN (${placeholders})`,
          found,
        )
        .map((r) => r.id as number)
    }
  }

  if (!found.length) throw new BulkError('Nothing was selected.')
  if (found.length > MAX_ROWS) {
    throw new BulkError(
      `${found.length.toLocaleString('en-US')} rows is more than this is meant to touch at once ` +
        `(${MAX_ROWS.toLocaleString('en-US')} max). Narrow the filter.`,
    )
  }
  return found
}

// --- the actions -------------------------------------------------------------

type ActionRun = (
  db: Database,
  ids: number[],
  value: unknown,
  stamp: string,
  kind: string,
) => string

function setVerdict(db: Database, ids: number[], value: unknown, stamp: string, kind: string) {
  if (value !== 'keep' && value !== 'sell' && value !== 'undecided') {
    throw new BulkError(`'${value}' is not a verdict`)
  }
  for (const subjectId of ids) {
    if (value === 'undecided') {
      db.exec({
        sql: 'DELETE FROM verdicts WHERE subject_kind=? AND subject_id=?',
        bind: [kind, subjectId],
      })
    } else {
      db.exec({
        sql:
          'INSERT INTO verdicts (subject_kind, subject_id, verdict, decided_at) ' +
          'VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (subject_kind, subject_id) ' +
          'DO UPDATE SET verdict = excluded.verdict, decided_at = excluded.decided_at',
        bind: [kind, subjectId, value, stamp],
      })
    }
  }
  return `Set verdict to ${value}`
}

function setColumn(column: string, coerce: (v: unknown) => unknown, label: string): ActionRun {
  return (db, ids, value, stamp, kind) => {
    const coerced = coerce(value)
    const table = subject(kind).table
    const placeholders = ids.map(() => '?').join(',')
    db.exec({
      sql:
        `UPDATE ${table} SET ${column} = ?, version = version + 1, updated_at = ? ` +
        `WHERE id IN (${placeholders})`,
      bind: [coerced, stamp, ...ids],
    })
    return `${label} ${value}`
  }
}

/** Parse a percentage the way `Decimal(str(value))` would (sans exponents),
 * as an exact [numerator, scale] pair. */
export function parsePercent(value: unknown): { negative: boolean; digits: bigint; pow: bigint; text: string } {
  const text = String(value).trim()
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text)
  if (!match) throw new BulkError(`'${value}' is not a percentage`)
  const whole = match[2] ?? ''
  const frac = match[3] ?? match[4] ?? ''
  const digits = BigInt((whole || '0') + frac)
  const pow = 10n ** BigInt(frac.length)
  // str(Decimal) canonical form, for the summary: strip leading zeros (keep
  // one before the point), keep the fraction exactly as typed.
  const cleanWhole = (whole || '0').replace(/^0+(?=\d)/, '')
  const body = frac.length ? `${cleanWhole}.${frac}` : cleanWhole
  return { negative: match[1] === '-' && digits !== 0n, digits, pow, text: body }
}

function adjustPrice(db: Database, ids: number[], value: unknown, stamp: string, kind: string) {
  const pct = parsePercent(value)
  // pct <= -100 ⟺ negative and digits >= 100·10^scale
  if (pct.negative && pct.digits >= 100n * pct.pow) {
    throw new BulkError('That would make every price zero or negative.')
  }

  // factor = (100 + pct) / 100 = (100·10^s ± digits) / (100·10^s)
  const den = 100n * pct.pow
  const num = pct.negative ? den - pct.digits : den + pct.digits

  const table = subject(kind).table
  const rows = db.selectObjects(
    `SELECT id, price_cents FROM ${table} ` +
      `WHERE id IN (${ids.map(() => '?').join(',')}) AND price_cents IS NOT NULL`,
    ids,
  )
  for (const row of rows) {
    const scaled = BigInt(row.price_cents as number) * num
    const quotient = scaled / den
    const remainder = scaled % den
    // ROUND_HALF_UP on non-negative values: away from zero at the tie.
    const updated = Number(remainder * 2n >= den ? quotient + 1n : quotient)
    db.exec({
      sql:
        `UPDATE ${table} SET price_cents = ?, version = version + 1, updated_at = ? ` +
        'WHERE id = ?',
      bind: [Math.max(0, updated), stamp, row.id],
    })
  }
  return `Adjusted prices by ${pct.negative ? '-' : '+'}${pct.text}%`
}

function deleteRows(db: Database, ids: number[], _value: unknown, _stamp: string, kind: string) {
  const table = subject(kind).table
  const placeholders = ids.map(() => '?').join(',')
  db.exec({
    sql: `DELETE FROM verdicts WHERE subject_kind=? AND subject_id IN (${placeholders})`,
    bind: [kind, ...ids],
  })
  db.exec({ sql: `DELETE FROM ${table} WHERE id IN (${placeholders})`, bind: ids })
  return 'Deleted'
}

export function priceCents(value: unknown): number {
  let cents: number | null
  try {
    cents = toCents(value as string)
  } catch {
    // Deliberate divergence: Python's to_cents lets InvalidOperation escape
    // here (a 500 on garbage input). A clean 400 is strictly better and the
    // UI never sends garbage; the parity gate scripts don't exercise it.
    throw new BulkError('Enter a price.')
  }
  if (cents === null) throw new BulkError('Enter a price.')
  if (cents < 0) throw new BulkError('A price cannot be negative.')
  return cents
}

interface ActionSpec {
  label: string
  run: ActionRun
  needsValue: boolean
  destructive?: boolean
  touches: string[]
  kinds: string[]
}

export const ACTIONS: Record<string, ActionSpec> = {
  verdict: {
    label: 'Set verdict',
    run: setVerdict,
    needsValue: true,
    touches: ['verdicts'],
    kinds: ['holding', 'sealed'],
  },
  condition: {
    label: 'Set condition',
    run: setColumn('condition', String, 'Set condition to'),
    needsValue: true,
    touches: ['SUBJECT'],
    kinds: ['holding', 'sealed'],
  },
  language: {
    label: 'Set language',
    run: setColumn('language', String, 'Set language to'),
    needsValue: true,
    touches: ['SUBJECT'],
    kinds: ['holding'],
  },
  price: {
    label: 'Set price',
    run: setColumn('price_cents', priceCents, 'Set price to'),
    needsValue: true,
    touches: ['SUBJECT'],
    kinds: ['holding', 'sealed'],
  },
  adjust_price: {
    label: 'Adjust price by %',
    run: adjustPrice,
    needsValue: true,
    touches: ['SUBJECT'],
    kinds: ['holding', 'sealed'],
  },
  cost_basis: {
    label: 'Set cost basis',
    run: setColumn('cost_basis_cents', priceCents, 'Set cost basis to'),
    needsValue: true,
    touches: ['SUBJECT'],
    // Sealed only: singles have no per-card basis to set.
    kinds: ['sealed'],
  },
  delete: {
    label: 'Delete',
    run: deleteRows,
    needsValue: false,
    destructive: true,
    touches: ['SUBJECT', 'verdicts'],
    kinds: ['holding', 'sealed'],
  },
}

// --- preview and apply -------------------------------------------------------

export function preview(db: Database, ids: number[], kind = 'holding', limit = 5) {
  const spec = subject(kind)
  const head = ids.slice(0, limit)
  const sample = db.selectObjects(
    `SELECT ${spec.nameSql} AS title, ${spec.extraNameSql} AS edition, quantity, price_cents ` +
      `FROM ${spec.table} WHERE id IN (${head.map(() => '?').join(',')}) ` +
      'ORDER BY (COALESCE(price_cents,0)*quantity) DESC',
    head,
  )
  const totals = db.selectObject(
    'SELECT COALESCE(SUM(quantity),0) AS qty, ' +
      'COALESCE(SUM(COALESCE(price_cents,0)*quantity),0) AS value ' +
      `FROM ${spec.table} WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )!
  return {
    count: ids.length,
    quantity: totals.qty as number,
    value_cents: totals.value as number,
    sample,
    more: Math.max(0, ids.length - limit),
  }
}

export function applyAction(
  db: Database,
  action: string,
  ids: number[],
  value: unknown = null,
  kind = 'holding',
): { affected: number; summary: string } {
  const spec = ACTIONS[action]
  if (!spec) throw new BulkError(`'${action}' is not a bulk action`)
  if (!spec.kinds.includes(kind)) {
    throw new BulkError(`${spec.label} does not apply to ${kind} rows.`)
  }
  if (spec.needsValue && (value === null || value === undefined || value === '')) {
    throw new BulkError(`${spec.label} needs a value.`)
  }

  const spec2 = subject(kind)
  const stamp = now()
  const tables = spec.touches.map((t) => (t === 'SUBJECT' ? spec2.table : t))

  // Snapshot before mutating — the same ordering mistake that made the first
  // version of import-commit unreversible.
  const before: Record<string, ops.RowDict[]> = {}
  for (const table of tables) {
    before[table] = ops.snapshotRows(
      db,
      table,
      table !== 'verdicts' ? ids : ids.map((i) => [kind, i] as [string, number]),
    )
  }

  const summary = spec.run(db, ids, value, stamp, kind)

  ops.record(db, `bulk_${action}`, `${summary} on ${ids.length} row(s)`, {
    before,
    // A verdict set where none existed is an insert; recording the keys lets
    // undo delete them rather than leave an orphan behind.
    created: tables.includes('verdicts')
      ? { verdicts: newVerdictKeys(db, ids, before, kind) }
      : undefined,
    affected: ids.length,
  })
  return { affected: ids.length, summary }
}

function newVerdictKeys(
  db: Database,
  ids: number[],
  before: Record<string, ops.RowDict[]>,
  kind: string,
): Array<Array<string | number>> {
  const had = new Set((before.verdicts ?? []).map((row) => row.subject_id as number))
  const nowHas = new Set(
    db
      .selectObjects(
        'SELECT subject_id FROM verdicts WHERE subject_kind=? ' +
          `AND subject_id IN (${ids.map(() => '?').join(',')})`,
        [kind, ...ids],
      )
      .map((r) => r.subject_id as number),
  )
  return [...nowHas]
    .filter((i) => !had.has(i))
    .sort((a, b) => a - b)
    .map((i) => [kind, i])
}
