/**
 * Everything back out — port of `webapp/exporter.py`.
 *
 * CSV quoting matches Python's csv.QUOTE_MINIMAL (quote only when a field
 * contains the delimiter, a quote, or a newline; escape quotes by doubling),
 * money renders as decimal dollars, and the bundle is a real ZIP (fflate,
 * deflate) whose `collection.sqlite` is the actual database image — the
 * anti-lock-in promise, kept.
 *
 * Buylist rates: sum-per-row `cents(total × rate)` exactly as Python does,
 * in pure integer math with half-up at the cent boundary.
 */

import { zipSync } from 'fflate'

import { formatCents, now, type Database } from './db'

export const EXPORTABLE = [
  'holdings', 'sealed', 'verdicts', 'sales', 'price_history', 'imports', 'operations',
] as const

const MONEY_COLUMNS = new Set([
  'price_cents', 'cost_basis_cents', 'listed_cents', 'sold_cents',
  'fees_cents', 'shipping_cents', 'net_cents', 'realized_gain_cents',
])

//: operations.inverse is large and meaningless outside the app.
const OMIT = new Set(['operations.inverse'])

const BUYLIST_COLUMNS = [
  'Name', 'Set name', 'Set code', 'Collector number', 'Foil', 'Quantity',
  'Market each', 'Market total', 'Est. cash', 'Est. credit', 'Language', 'Condition',
]

const CK_SUBMISSION_COLUMNS = ['Card Name', 'Edition', 'Foil', 'Quantity']

const LEDGER_COLUMNS = [
  'Name', 'Set name', 'Set code', 'Collector number', 'Foil', 'Quantity',
  'Condition', 'Language', 'Scryfall ID', 'Acquisition Date', 'Source',
  'Cost Basis', 'Market Value', 'Valuation Date', 'Sold', 'Fees',
  'Net Proceeds', 'Realized Gain/Loss', 'Insurance Flag', 'Photo Ref', 'Notes',
]

const SEALED_COLUMNS = [
  'Name', 'Set', 'Quantity', 'Condition', 'Price', 'Price date', 'Source',
  'Cost basis', 'Notes',
]

//: binders.sealed.TEMPLATE_ROWS, verbatim.
const TEMPLATE_ROWS = [
  ['Sneak Attack', '', '1', 'sealed', '', '', '', '', ''],
  ['Heavenly Inferno', 'CMD', '1', 'sealed', '', '', '', '',
    'a Set is only needed when a name is ambiguous'],
]

// --- CSV plumbing ------------------------------------------------------------

function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function csvRows(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvField).join(',') + '\r\n').join('')
}

function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

// --- tables ------------------------------------------------------------------

export function tableNames(db: Database): string[] {
  const present = new Set(
    db.selectObjects("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name as string),
  )
  return EXPORTABLE.filter((t) => present.has(t))
}

export class NotExportable extends Error {}

export function tableCsv(db: Database, table: string): string {
  if (!(EXPORTABLE as readonly string[]).includes(table)) {
    throw new NotExportable(`'${table}' is not exportable`)
  }
  const columns = db
    .selectObjects(`PRAGMA table_info(${table})`)
    .map((r) => r.name as string)
    .filter((c) => !OMIT.has(`${table}.${c}`))

  // Money columns are relabelled so nobody reads dollars as cents later.
  const header = columns.map((c) => (MONEY_COLUMNS.has(c) ? c.slice(0, -6) : c))
  const rows = db
    .selectObjects(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`)
    .map((row) =>
      columns.map((c) => {
        const value = row[c]
        if (value === null || value === undefined) return ''
        if (MONEY_COLUMNS.has(c)) return dollars(value as number)
        return String(value)
      }),
    )
  return csvRows([header, ...rows])
}

// --- the ledger --------------------------------------------------------------

export function ledgerCsv(db: Database): string {
  const sold = new Map(
    db.selectObjects("SELECT * FROM sales WHERE status = 'sold' ORDER BY sold_at")
      .map((r) => [`${r.subject_kind}|${r.subject_id}`, r]),
  )
  const money = (cents: unknown) =>
    cents === null || cents === undefined ? '' : dollars(cents as number)
  const fees = (sale: Record<string, unknown>) =>
    dollars(((sale.fees_cents as number) || 0) + ((sale.shipping_cents as number) || 0))

  const out: string[][] = []
  for (const row of db.selectObjects(
    "SELECT h.*, COALESCE(v.verdict,'undecided') AS verdict FROM holdings h " +
      "LEFT JOIN verdicts v ON v.subject_kind='holding' AND v.subject_id=h.id " +
      'ORDER BY (COALESCE(h.price_cents,0) * h.quantity) DESC',
  )) {
    const sale = sold.get(`holding|${row.id}`)
    const total = ((row.price_cents as number) || 0) * (row.quantity as number)
    out.push([
      row.title as string, row.set_name as string, row.edition as string,
      row.collector_number as string, row.foil ? 'foil' : '', String(row.quantity),
      row.condition as string, row.language as string, row.scryfall_id as string,
      '', 'singles', '',
      row.price_cents !== null ? dollars(total) : '',
      String(row.updated_at ?? '').slice(0, 10),
      sale ? money(sale.sold_cents) : '', sale ? fees(sale) : '',
      sale ? money(sale.net_cents) : '', sale ? money(sale.realized_gain_cents) : '',
      total >= 5000 ? 'Y' : '', '', sale ? (sale.notes as string) : '',
    ])
  }

  for (const row of db.selectObjects(
    'SELECT * FROM sealed ORDER BY (COALESCE(price_cents,0) * quantity) DESC',
  )) {
    const sale = sold.get(`sealed|${row.id}`)
    const total = ((row.price_cents as number) || 0) * (row.quantity as number)
    out.push([
      (row.product_name as string) || (row.raw_name as string),
      row.set_name as string, row.set_code as string, '', '', String(row.quantity),
      row.condition as string, 'en', '', '', 'sealed',
      row.cost_basis_cents !== null
        ? dollars((row.cost_basis_cents as number) * (row.quantity as number))
        : '',
      row.price_cents !== null ? dollars(total) : '',
      // A sealed price was looked up on a specific day; claiming today's
      // date for it would be false.
      (row.price_date as string) ?? '',
      sale ? money(sale.sold_cents) : '', sale ? fees(sale) : '',
      sale ? money(sale.net_cents) : '', sale ? money(sale.realized_gain_cents) : '',
      total >= 5000 ? 'Y' : '', '',
      [row.notes, sale ? sale.notes : ''].filter(Boolean).join(' · '),
    ])
  }

  // Sold-and-gone rows: a fully-sold item left the tables, but its realized
  // gain is the reason the ledger exists.
  const stillHeld = new Set([
    ...db.selectObjects('SELECT id FROM holdings').map((r) => `holding|${r.id}`),
    ...db.selectObjects('SELECT id FROM sealed').map((r) => `sealed|${r.id}`),
  ])
  for (const [key, sale] of sold) {
    if (stillHeld.has(key)) continue
    out.push([
      (sale.subject_name as string) || '(sold)', '', (sale.subject_set as string) || '',
      '', '', String(sale.quantity), '', '', '', '',
      sale.channel ? `sold · ${sale.channel}` : 'sold',
      money(sale.cost_basis_cents), '', '',
      money(sale.sold_cents), fees(sale), money(sale.net_cents),
      money(sale.realized_gain_cents), '', '', sale.notes as string,
    ])
  }

  return csvRows([LEDGER_COLUMNS, ...out])
}

// --- the buylist -------------------------------------------------------------

//: CK's singles rate bands: floor cents, cash%, credit%.
const CK_RATES: Array<[number, number, number]> = [
  [2000, 60, 75],
  [500, 47, 62],
  [0, 20, 25],
]

function rates(priceCents: number): [number, number] {
  for (const [floor, cash, credit] of CK_RATES) {
    if (priceCents >= floor) return [cash, credit]
  }
  return [0, 0]
}

/** round_half_up(cents · pct / 100) in pure integers. */
function rateCents(cents: number, pct: number): number {
  const n = cents * pct
  const q = Math.floor(n / 100)
  return n % 100 >= 50 ? q + 1 : q
}

export function buylistRows(db: Database, minPriceCents = 100) {
  return db.selectObjects(
    'SELECT h.* FROM holdings h ' +
      "JOIN verdicts v ON v.subject_kind = 'holding' AND v.subject_id = h.id " +
      "LEFT JOIN sales s ON s.subject_kind = 'holding' AND s.subject_id = h.id " +
      "  AND s.status != 'cancelled' " +
      "WHERE v.verdict = 'sell' AND s.id IS NULL " +
      '  AND h.price_cents IS NOT NULL AND h.price_cents >= ? ' +
      'ORDER BY (h.price_cents * h.quantity) DESC',
    [Math.trunc(minPriceCents)],
  )
}

export function buylistCsv(db: Database, minPriceCents = 100): string {
  const rows = buylistRows(db, minPriceCents).map((row) => {
    const price = row.price_cents as number
    const quantity = row.quantity as number
    const total = price * quantity
    const [cashPct, creditPct] = rates(price)
    return [
      row.title, row.set_name, row.edition, row.collector_number,
      row.foil ? 'foil' : '', quantity,
      dollars(price), dollars(total),
      dollars(rateCents(total, cashPct)), dollars(rateCents(total, creditPct)),
      row.language, row.condition,
    ]
  })
  return csvRows([BUYLIST_COLUMNS, ...rows])
}

export function ckSubmissionCsv(db: Database, minPriceCents = 100): string {
  const rows = buylistRows(db, minPriceCents).map((row) => [
    row.title, row.set_name, row.foil ? '1' : '0', row.quantity,
  ])
  return csvRows([CK_SUBMISSION_COLUMNS, ...rows])
}

export function buylistSummary(db: Database, minPriceCents = 100) {
  const rows = buylistRows(db, minPriceCents)
  let market = 0
  let cash = 0
  let credit = 0
  let quantity = 0
  for (const row of rows) {
    const total = (row.price_cents as number) * (row.quantity as number)
    const [cashPct, creditPct] = rates(row.price_cents as number)
    market += total
    cash += rateCents(total, cashPct)
    credit += rateCents(total, creditPct)
    quantity += row.quantity as number
  }
  return {
    rows: rows.length,
    quantity,
    marketCents: market,
    market: formatCents(market),
    cashCents: cash,
    cash: formatCents(cash),
    creditCents: credit,
    credit: formatCents(credit),
    minPriceCents: Math.trunc(minPriceCents),
  }
}

// --- template / manifest / bundle -------------------------------------------

export function templateCsv(): string {
  return csvRows([SEALED_COLUMNS, ...TEMPLATE_ROWS])
}

export function manifest(db: Database): Record<string, unknown> {
  const counts: Record<string, number> = {}
  for (const table of tableNames(db)) {
    counts[table] = Number(db.selectValue(`SELECT COUNT(*) AS n FROM ${table}`))
  }
  const totals = db.selectObject(
    'SELECT COALESCE(SUM(quantity),0) AS qty, ' +
      'COALESCE(SUM(COALESCE(price_cents,0)*quantity),0) AS cents FROM holdings',
  )!
  return {
    exportedAt: now(),
    tool: 'mtg-tools',
    rowCounts: counts,
    singles: {
      quantity: totals.qty,
      valueCents: totals.cents,
      value: formatCents(totals.cents as number),
    },
    notes: [
      'Money columns are decimal dollars; the database stores integer cents.',
      'collection.sqlite is the complete database — the CSVs are a convenience view of it.',
      'operations.inverse is omitted from the CSV; it is app-internal.',
    ],
  }
}

export function bundle(db: Database, dbImage: Uint8Array | null): { filename: string; bytes: Uint8Array } {
  const encoder = new TextEncoder()
  const entries: Record<string, Uint8Array> = {}
  for (const table of tableNames(db)) {
    entries[`csv/${table}.csv`] = encoder.encode(tableCsv(db, table))
  }
  entries['mtg_collection_tracker.csv'] = encoder.encode(ledgerCsv(db))
  // Python's json.dumps(ensure_ascii=True) escapes non-ASCII; match it so the
  // bundle's manifest is byte-identical across backends.
  const manifestJson = JSON.stringify(manifest(db), null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  )
  entries['manifest.json'] = encoder.encode(manifestJson)
  if (dbImage) entries['collection.sqlite'] = dbImage
  const bytes = zipSync(entries, { level: 6 })
  return { filename: `mtg-collection-${now().slice(0, 10)}.zip`, bytes }
}
