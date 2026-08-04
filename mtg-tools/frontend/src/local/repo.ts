/**
 * Queries over the stored collection — port of `webapp/repo.py`.
 *
 * SQL strings are copied verbatim (table-qualified fragments and all); the
 * only translation is the binding plumbing. One genuinely subtle carry-over:
 * Python's `round()` is half-even, so every rounding site here goes through
 * `roundHalfEven` — `Math.round` would drift on exact .5 ties (e.g. a $1.50
 * band total at the 47% cash rate), and both runtimes compute the same IEEE
 * doubles, so matching the tie rule makes the results identical.
 */

import type { Database } from './db'

export type FilterValues = Record<string, unknown>

type Transform = ((v: unknown) => unknown) | null

/** Python round(): ties to even. Inputs here are non-negative. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** Python round(x, 2), for the doubles both runtimes share. */
function round2(x: number): number {
  return roundHalfEven(x * 100) / 100
}

const dollarsToCents = (v: unknown) => {
  const dollars = Number(v)
  if (Number.isNaN(dollars)) throw new Error(`could not convert string to float: '${String(v)}'`)
  return roundHalfEven(dollars * 100)
}

const strictInt = (v: unknown) => {
  if (!/^-?\d+$/.test(String(v).trim())) {
    throw new Error(`invalid literal for int() with base 10: '${String(v)}'`)
  }
  return parseInt(String(v), 10)
}

//: keyword -> [SQL fragment, value transform]. Names match binders.filters.
export const FILTERS: Record<string, [string, Transform]> = {
  price_min: ['h.price_cents >= ?', dollarsToCents],
  price_max: ['h.price_cents <= ?', dollarsToCents],
  qty_min: ['h.quantity >= ?', strictInt],
  edition: ['h.edition = ?', String],
  rarity: ['h.rarity = ?', String],
  language: ['h.language = ?', String],
  condition: ['h.condition = ?', String],
  foil: [
    'h.foil = ?',
    (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0),
  ],
  title_contains: ['LOWER(h.title) LIKE ?', (v) => `%${String(v).toLowerCase()}%`],
  set_contains: ['LOWER(h.set_name) LIKE ?', (v) => `%${String(v).toLowerCase()}%`],
  unpriced: ['h.price_cents IS NULL', null],
  verdict: ["COALESCE(v.verdict, 'undecided') = ?", String],
}

export const SORTS: Record<string, string> = {
  title: 'h.title COLLATE NOCASE',
  edition: 'h.edition COLLATE NOCASE',
  rarity: 'h.rarity',
  quantity: 'h.quantity',
  price: 'h.price_cents',
  total: '(COALESCE(h.price_cents, 0) * h.quantity)',
  updated: 'h.updated_at',
}

export const DEFAULT_SORT = 'total'

export interface Page {
  rows: Record<string, unknown>[]
  totalRows: number
  page: number
  perPage: number
  sort: string
  direction: string
  pages: number
}

function where(
  filters: FilterValues | undefined,
  spec: Record<string, [string, Transform]>,
): [string, unknown[]] {
  const clauses: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === null || value === undefined || value === '') continue
    const entry = spec[key]
    if (!entry) throw new Error(`unknown filter '${key}'`)
    const [fragment, transform] = entry
    clauses.push(fragment)
    if (transform !== null) {
      // name_contains binds the same value twice (product and raw name).
      const bound = transform(value)
      const count = fragment.split('?').length - 1
      for (let i = 0; i < count; i++) params.push(bound)
    }
  }
  return [clauses.length ? clauses.join(' AND ') : '1=1', params]
}

const BASE = `
FROM holdings h
LEFT JOIN verdicts v ON v.subject_kind = 'holding' AND v.subject_id = h.id
WHERE {where}
`

// --- sealed ------------------------------------------------------------------

export const SEALED_FILTERS: Record<string, [string, Transform]> = {
  price_min: ['s.price_cents >= ?', dollarsToCents],
  price_max: ['s.price_cents <= ?', dollarsToCents],
  qty_min: ['s.quantity >= ?', strictInt],
  set_code: ['s.set_code = ?', String],
  year: ['s.release_year = ?', String],
  condition: ['s.condition = ?', String],
  unpriced: ['s.price_cents IS NULL', null],
  unresolved: ['s.resolved = 0', null],
  name_contains: [
    '(LOWER(s.product_name) LIKE ? OR LOWER(s.raw_name) LIKE ?)',
    (v) => `%${String(v).toLowerCase()}%`,
  ],
  verdict: ["COALESCE(v.verdict, 'undecided') = ?", String],
}

export const SEALED_SORTS: Record<string, string> = {
  name: "COALESCE(NULLIF(s.product_name,''), s.raw_name) COLLATE NOCASE",
  set: 's.set_code COLLATE NOCASE',
  year: 's.release_year',
  quantity: 's.quantity',
  price: 's.price_cents',
  total: '(COALESCE(s.price_cents, 0) * s.quantity)',
  updated: 's.updated_at',
}

const SEALED_BASE = `
FROM sealed s
LEFT JOIN verdicts v ON v.subject_kind = 'sealed' AND v.subject_id = s.id
WHERE {where}
`

function paginate(
  db: Database,
  base: string,
  select: string,
  whereClause: string,
  params: unknown[],
  order: string,
  idColumn: string,
  options: { sort: string; direction: string; page: number; perPage: number },
): Page {
  const direction = String(options.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const page = Math.max(1, Math.trunc(options.page))
  const perPage = Math.max(1, Math.min(500, Math.trunc(options.perPage)))

  const body = base.replace('{where}', whereClause)
  const totalRows = Number(
    db.selectValue(`SELECT COUNT(*) AS n ${body}`, params as unknown[]),
  )
  const rows = db.selectObjects(
    `${select} ${body} ORDER BY ${order} ${direction}, ${idColumn} ASC LIMIT ? OFFSET ?`,
    [...params, perPage, (page - 1) * perPage],
  )
  return {
    rows,
    totalRows,
    page,
    perPage,
    sort: options.sort,
    direction: direction.toLowerCase(),
    pages: Math.max(1, Math.ceil(totalRows / perPage)),
  }
}

export function queryHoldings(
  db: Database,
  filters?: FilterValues,
  options: Partial<{ sort: string; direction: string; page: number; perPage: number }> = {},
): Page {
  const sort = options.sort ?? DEFAULT_SORT
  const [whereClause, params] = where(filters, FILTERS)
  return paginate(
    db,
    BASE,
    "SELECT h.*, COALESCE(v.verdict, 'undecided') AS verdict",
    whereClause,
    params,
    SORTS[sort] ?? SORTS[DEFAULT_SORT],
    'h.id',
    { sort, direction: options.direction ?? 'desc', page: options.page ?? 1, perPage: options.perPage ?? 50 },
  )
}

export function querySealed(
  db: Database,
  filters?: FilterValues,
  options: Partial<{ sort: string; direction: string; page: number; perPage: number }> = {},
): Page {
  const sort = options.sort ?? 'total'
  const [whereClause, params] = where(filters, SEALED_FILTERS)
  return paginate(
    db,
    SEALED_BASE,
    "SELECT s.*, COALESCE(v.verdict, 'undecided') AS verdict",
    whereClause,
    params,
    SEALED_SORTS[sort] ?? SEALED_SORTS['total'],
    's.id',
    { sort, direction: options.direction ?? 'desc', page: options.page ?? 1, perPage: options.perPage ?? 50 },
  )
}

export function matchingIds(db: Database, filters?: FilterValues): number[] {
  const [whereClause, params] = where(filters, FILTERS)
  const body = BASE.replace('{where}', whereClause)
  return db.selectObjects(`SELECT h.id ${body}`, params).map((r) => r.id as number)
}

export function sealedMatchingIds(db: Database, filters?: FilterValues): number[] {
  const [whereClause, params] = where(filters, SEALED_FILTERS)
  const body = SEALED_BASE.replace('{where}', whereClause)
  return db.selectObjects(`SELECT s.id ${body}`, params).map((r) => r.id as number)
}

export interface Totals {
  rows: number
  quantity: number
  value_cents: number
  unpriced: number
}

export function totals(db: Database, filters?: FilterValues): Totals {
  const [whereClause, params] = where(filters, FILTERS)
  const body = BASE.replace('{where}', whereClause)
  const row = db.selectObject(
    'SELECT COUNT(*) AS rows, ' +
      'COALESCE(SUM(h.quantity), 0) AS quantity, ' +
      'COALESCE(SUM(COALESCE(h.price_cents, 0) * h.quantity), 0) AS value_cents, ' +
      'SUM(CASE WHEN h.price_cents IS NULL THEN h.quantity ELSE 0 END) AS unpriced ' +
      body,
    params,
  )!
  return {
    rows: row.rows as number,
    quantity: row.quantity as number,
    value_cents: row.value_cents as number,
    unpriced: (row.unpriced as number | null) ?? 0,
  }
}

export interface SealedTotals extends Totals {
  cost_cents: number
  unresolved: number
}

export function sealedTotals(db: Database, filters?: FilterValues): SealedTotals {
  const [whereClause, params] = where(filters, SEALED_FILTERS)
  const body = SEALED_BASE.replace('{where}', whereClause)
  const row = db.selectObject(
    'SELECT COUNT(*) AS rows, ' +
      'COALESCE(SUM(s.quantity), 0) AS quantity, ' +
      'COALESCE(SUM(COALESCE(s.price_cents, 0) * s.quantity), 0) AS value_cents, ' +
      'SUM(CASE WHEN s.price_cents IS NULL THEN s.quantity ELSE 0 END) AS unpriced, ' +
      'COALESCE(SUM(COALESCE(s.cost_basis_cents, 0) * s.quantity), 0) AS cost_cents, ' +
      'SUM(CASE WHEN s.resolved = 0 THEN 1 ELSE 0 END) AS unresolved ' +
      body,
    params,
  )!
  return {
    rows: row.rows as number,
    quantity: row.quantity as number,
    value_cents: row.value_cents as number,
    unpriced: (row.unpriced as number | null) ?? 0,
    cost_cents: row.cost_cents as number,
    unresolved: (row.unresolved as number | null) ?? 0,
  }
}

export function sealedByYear(db: Database, filters?: FilterValues) {
  const [whereClause, params] = where(filters, SEALED_FILTERS)
  const body = SEALED_BASE.replace('{where}', whereClause)
  return db.selectObjects(
    "SELECT COALESCE(NULLIF(s.release_year,''), '—') AS year, " +
      'SUM(s.quantity) AS qty, ' +
      'SUM(COALESCE(s.price_cents,0) * s.quantity) AS cents, ' +
      'SUM(CASE WHEN s.price_cents IS NULL THEN s.quantity ELSE 0 END) AS unpriced ' +
      `${body} GROUP BY year ORDER BY year`,
    params,
  )
}

export function sealedDistinct(db: Database, column: string): string[] {
  if (!['set_code', 'release_year', 'condition'].includes(column)) {
    throw new Error(`cannot enumerate '${column}'`)
  }
  return db
    .selectObjects(
      `SELECT DISTINCT ${column} AS v FROM sealed WHERE ${column} != '' ` +
        `ORDER BY ${column} COLLATE NOCASE`,
    )
    .map((r) => r.v as string)
}

//: The Card Kingdom bands from binders.aggregate.CK_TIERS, restated in cents.
export const TIER_BANDS: Array<[string, string, number, number, number]> = [
  ['prime', '$20+', 2000, 60, 75],
  ['mid', '$5–$19.99', 500, 47, 62],
  ['bulk', 'Under $5', 0, 20, 25],
]

export function tierBreakdown(db: Database, filters?: FilterValues) {
  const [whereClause, params] = where(filters, FILTERS)
  const body = BASE.replace('{where}', whereClause)

  const caseSql = TIER_BANDS.filter(([, , floor]) => floor > 0)
    .map(([key, , floor]) => `WHEN COALESCE(h.price_cents, 0) >= ${floor} THEN '${key}'`)
    .join(' ')
  const found = new Map(
    db
      .selectObjects(
        `SELECT CASE ${caseSql} ELSE 'bulk' END AS band, ` +
          'SUM(h.quantity) AS qty, ' +
          'SUM(COALESCE(h.price_cents, 0) * h.quantity) AS cents ' +
          `${body} GROUP BY band`,
        params,
      )
      .map((r) => [r.band as string, r]),
  )

  return TIER_BANDS.map(([key, label, , cashPct, creditPct]) => {
    const row = found.get(key)
    const cents = ((row?.cents as number | null) ?? 0) || 0
    return {
      tier: key,
      label,
      quantity: ((row?.qty as number | null) ?? 0) || 0,
      marketCents: cents,
      // Sum the band, then apply its rate once and round — applying per card
      // would round hundreds of times and drift from what the CLI reports.
      cashCents: roundHalfEven((cents * cashPct) / 100),
      creditCents: roundHalfEven((cents * creditPct) / 100),
      cashPct,
      creditPct,
    }
  })
}

export function concentration(db: Database, filters?: FilterValues) {
  const [whereClause, params] = where(filters, FILTERS)
  const body = BASE.replace('{where}', whereClause)
  const values = db
    .selectObjects(
      `SELECT COALESCE(h.price_cents,0) * h.quantity AS cents ${body} ` +
        'AND h.price_cents IS NOT NULL ORDER BY cents DESC',
      params,
    )
    .map((r) => r.cents as number)
    .filter((cents) => cents > 0)

  const total = values.reduce((a, b) => a + b, 0)
  if (values.length < 2 || total <= 0) {
    return { points: [], marks: [], pricedRows: values.length }
  }

  const points = []
  const marks = []
  const wanted = [50, 80, 90]
  let nextMark = 0
  let running = 0
  for (let index = 1; index <= values.length; index++) {
    running += values[index - 1]
    const pct = (running / total) * 100
    points.push({
      n: index,
      rowPct: round2((index / values.length) * 100),
      valuePct: round2(pct),
    })
    while (nextMark < wanted.length && pct >= wanted[nextMark]) {
      marks.push({ valuePct: wanted[nextMark], rows: index })
      nextMark += 1
    }
  }
  return { points, marks, pricedRows: values.length }
}

export function topSets(db: Database, filters?: FilterValues, limit = 12) {
  const [whereClause, params] = where(filters, FILTERS)
  const body = BASE.replace('{where}', whereClause)
  const rows = db.selectObjects(
    "SELECT COALESCE(NULLIF(h.set_name,''), h.edition) AS name, " +
      'SUM(h.quantity) AS qty, ' +
      'SUM(COALESCE(h.price_cents,0) * h.quantity) AS cents ' +
      `${body} GROUP BY name ORDER BY cents DESC`,
    params,
  )

  const out = rows.slice(0, limit).map((r) => ({
    name: r.name as string,
    quantity: r.qty as number,
    cents: r.cents as number,
    other: false,
  }))
  const tail = rows.slice(limit)
  if (tail.length) {
    out.push({
      name: `Other (${tail.length} sets)`,
      quantity: tail.reduce((a, r) => a + (r.qty as number), 0),
      cents: tail.reduce((a, r) => a + (r.cents as number), 0),
      other: true,
    })
  }
  return out
}

export function raritySplit(db: Database, filters?: FilterValues) {
  const [whereClause, params] = where(filters, FILTERS)
  const body = BASE.replace('{where}', whereClause)
  const order: Record<string, number> = { mythic: 0, rare: 1, uncommon: 2, common: 3 }
  return db
    .selectObjects(
      "SELECT COALESCE(NULLIF(h.rarity,''), 'unknown') AS name, " +
        'SUM(h.quantity) AS qty, ' +
        `SUM(COALESCE(h.price_cents,0) * h.quantity) AS cents ${body} GROUP BY name`,
      params,
    )
    .map((r) => ({ name: r.name as string, quantity: r.qty as number, cents: r.cents as number }))
    .sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9))
}

export function distinctValues(db: Database, column: string): string[] {
  if (!['edition', 'rarity', 'language', 'condition', 'set_name'].includes(column)) {
    throw new Error(`cannot enumerate '${column}'`)
  }
  return db
    .selectObjects(
      `SELECT DISTINCT ${column} AS v FROM holdings ` +
        `WHERE ${column} != '' ORDER BY ${column} COLLATE NOCASE`,
    )
    .map((r) => r.v as string)
}

//: What each subject kind is called in SQL. Bulk actions (phase 4) consult
//: this rather than hardcoding table names.
export const SUBJECTS = {
  holding: {
    table: 'holdings',
    filters: FILTERS,
    matchingIds,
    nameSql: 'title',
    extraNameSql: 'edition',
  },
  sealed: {
    table: 'sealed',
    filters: SEALED_FILTERS,
    matchingIds: sealedMatchingIds,
    nameSql: "COALESCE(NULLIF(product_name,''), raw_name)",
    extraNameSql: 'set_code',
  },
} as const
