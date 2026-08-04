// @vitest-environment node
/**
 * Phase 4 mutations: bulk actions and the sale lifecycle, ported intent from
 * tests_webapp — plus the adjust-price oracle: 2,010 (cents, pct) cases whose
 * expected values were computed by Python's actual Decimal/ROUND_HALF_UP
 * expression and committed as a fixture. The BigInt port must match every one.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import SCHEMA from '../../../webapp/schema.sql?raw'
import ORACLE from './__fixtures__/adjust-price-oracle.json'
import { initSchema, wrapDb, type Database } from './db'
import { ApiFailure } from './errors'
import { makeRoutes } from './endpoints'
import { BulkError, applyAction, parsePercent, resolveSelection } from './bulk'

type Db = Database & { close(): void }
type Routes = ReturnType<typeof makeRoutes>

const T = "'2026-07-30T00:00:00+00:00'"

async function openDb(): Promise<Db> {
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
  const sqlite3 = await sqlite3InitModule()
  const db = wrapDb(new sqlite3.oo1.DB(':memory:') as never) as Db
  initSchema(db, SCHEMA)
  return db
}

function routesFor(db: Db): Routes {
  return makeRoutes({
    db: () => db,
    vfs: () => 'memory',
    schemaVersion: () => 1,
    importDatabase: () => Promise.reject(new Error('not under test')),
    exportDb: () => null,
  })
}

let seq = 0
function holding(db: Database, cents: number | null, quantity = 1): number {
  seq += 1
  db.exec({
    sql:
      'INSERT INTO holdings (identity, title, quantity, price_cents, created_at, updated_at) ' +
      `VALUES (?, ?, ?, ?, ${T}, ${T})`,
    bind: [`card-${seq}`, `Card ${seq}`, quantity, cents],
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

function sealedRow(db: Database, cents: number | null, basis: number | null, quantity = 1): number {
  seq += 1
  db.exec({
    sql:
      'INSERT INTO sealed (identity, raw_name, quantity, price_cents, cost_basis_cents, resolved, created_at, updated_at) ' +
      `VALUES (?, ?, ?, ?, ?, 1, ${T}, ${T})`,
    bind: [`deck-${seq}`, `Deck ${seq}`, quantity, cents, basis],
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

describe('adjust_price matches the Python Decimal oracle', () => {
  it('agrees on all generated cases, ties included', async () => {
    const db = await openDb()
    const byPct = new Map<string, Array<[number, number]>>()
    for (const [cents, pct, expected] of ORACLE.cases as [number, string, number][]) {
      byPct.set(pct, [...(byPct.get(pct) ?? []), [cents, expected]])
    }
    for (const [pct, cases] of byPct) {
      const ids = cases.map(([cents]) => holding(db, cents))
      const result = applyAction(db, 'adjust_price', ids, pct)
      const expectedSummary = (ORACLE.summaries as Record<string, string>)[pct]
      if (expectedSummary !== undefined) expect(result.summary).toBe(expectedSummary)
      cases.forEach(([, expected], i) => {
        expect(
          db.selectValue('SELECT price_cents FROM holdings WHERE id = ?', [ids[i]]),
          `pct=${pct} case ${i}`,
        ).toBe(expected)
      })
    }
  })

  it('refuses -100% and worse, and non-percentages', async () => {
    const db = await openDb()
    const id = holding(db, 100)
    expect(() => applyAction(db, 'adjust_price', [id], '-100')).toThrow(
      'zero or negative',
    )
    expect(() => applyAction(db, 'adjust_price', [id], 'lots')).toThrow(BulkError)
    expect(parsePercent('2.5').text).toBe('2.5')
    expect(parsePercent('.5').text).toBe('0.5')
  })

  it('skips unpriced rows instead of inventing a price', async () => {
    const db = await openDb()
    const priced = holding(db, 1000)
    const unpriced = holding(db, null)
    applyAction(db, 'adjust_price', [priced, unpriced], '10')
    expect(db.selectValue('SELECT price_cents FROM holdings WHERE id = ?', [priced])).toBe(1100)
    expect(db.selectValue('SELECT price_cents FROM holdings WHERE id = ?', [unpriced])).toBeNull()
  })
})

describe('bulk selection and actions', () => {
  let db: Db
  let routes: Routes
  beforeEach(async () => {
    db = await openDb()
    routes = routesFor(db)
  })

  it('resolves selectAll from filters, not from the page', () => {
    holding(db, 5000)
    holding(db, 50)
    const ids = resolveSelection(db, {
      selectAll: true,
      filters: { price_min: '10' },
      kind: 'holding',
    })
    expect(ids).toHaveLength(1)
    expect(() => resolveSelection(db, { ids: [], kind: 'holding' })).toThrow(
      'Nothing was selected.',
    )
  })

  it('drops stale ids by re-checking the table', () => {
    const alive = holding(db, 100)
    const ids = resolveSelection(db, { ids: [alive, 99999], kind: 'holding' })
    expect(ids).toEqual([alive])
  })

  it('verdict bulk sets, previews, and undoes exactly', () => {
    const a = holding(db, 1000)
    const b = holding(db, 2000)
    // b already had a keep verdict — undo must restore it, not delete it.
    db.exec({
      sql: `INSERT INTO verdicts (subject_kind, subject_id, verdict, decided_at) VALUES ('holding', ?, 'keep', ${T})`,
      bind: [b],
    })

    const previewBody = routes.bulkPreview({ kind: 'holding', ids: [a, b] })
    expect(previewBody.count).toBe(2)
    expect(previewBody.valueCents).toBe(3000)

    routes.bulkApply({ kind: 'holding', ids: [a, b], action: 'verdict', value: 'sell' })
    expect(db.selectValue("SELECT COUNT(*) FROM verdicts WHERE verdict='sell'")).toBe(2)

    routes.undo()
    expect(db.selectValue('SELECT COUNT(*) FROM verdicts')).toBe(1)
    expect(
      db.selectValue('SELECT verdict FROM verdicts WHERE subject_id = ?', [b]),
    ).toBe('keep')
  })

  it('delete removes rows and verdicts, and undo brings both back', () => {
    const id = holding(db, 750, 3)
    routes.bulkApply({ kind: 'holding', ids: [id], action: 'verdict', value: 'sell' })
    const snapshotHolding = db.selectObject('SELECT * FROM holdings WHERE id = ?', [id])
    routes.bulkApply({ kind: 'holding', ids: [id], action: 'delete' })
    expect(db.selectValue('SELECT COUNT(*) FROM holdings')).toBe(0)
    expect(db.selectValue('SELECT COUNT(*) FROM verdicts')).toBe(0)

    routes.undo()
    expect(db.selectObject('SELECT * FROM holdings WHERE id = ?', [id])).toEqual(snapshotHolding)
    expect(db.selectValue('SELECT verdict FROM verdicts WHERE subject_id = ?', [id])).toBe('sell')
  })

  it('cost_basis applies to sealed only; language to holdings only', () => {
    const s = sealedRow(db, 5000, null)
    routes.bulkApply({ kind: 'sealed', ids: [s], action: 'cost_basis', value: '30.00' })
    expect(db.selectValue('SELECT cost_basis_cents FROM sealed WHERE id = ?', [s])).toBe(3000)
    expect(() =>
      routes.bulkApply({ kind: 'sealed', ids: [s], action: 'language', value: 'en' }),
    ).toThrow(/does not apply to sealed rows/)
  })
})

describe('the sale lifecycle', () => {
  let db: Db
  let routes: Routes
  beforeEach(async () => {
    db = await openDb()
    routes = routesFor(db)
  })

  function markSell(kind: string, id: number) {
    routes.bulkApply({ kind, ids: [id], action: 'verdict', value: 'sell' })
  }

  it('queue is driven by verdicts and carries any open sale', () => {
    const h = holding(db, 3000, 2)
    const s = sealedRow(db, 18000, 3500)
    markSell('holding', h)
    markSell('sealed', s)
    let queue = routes.salesQueue()
    expect(queue.map((q) => q.kind)).toEqual(['sealed', 'holding'])
    expect(queue[0].costBasisCents).toBe(3500)
    expect(queue.every((q) => q.sale === null)).toBe(true)

    routes.listForSale({ kind: 'holding', id: h })
    queue = routes.salesQueue()
    expect(queue.find((q) => q.kind === 'holding')!.sale!.status).toBe('listed')
  })

  it('listing defaults to full quantity at market, refuses a double-list', () => {
    const h = holding(db, 1250, 4)
    markSell('holding', h)
    const { saleId } = routes.listForSale({ kind: 'holding', id: h })
    const sale = db.selectObject('SELECT * FROM sales WHERE id = ?', [saleId])!
    expect(sale.quantity).toBe(4)
    expect(sale.listed_cents).toBe(5000)
    expect(() => routes.listForSale({ kind: 'holding', id: h })).toThrow(/already listed/)
  })

  it('a sealed sale computes net and realized gain; singles gain stays null', () => {
    const s = sealedRow(db, 20000, 12000)
    markSell('sealed', s)
    const { saleId } = routes.listForSale({ kind: 'sealed', id: s })
    const result = routes.recordSale({ saleId, sold: '210.00', fees: '21.00', shipping: '9.00' })
    expect(result.netCents).toBe(18000)
    expect(result.realizedGainCents).toBe(6000)
    expect(result.removedFromCollection).toBe(true)
    expect(db.selectValue('SELECT COUNT(*) FROM sealed')).toBe(0)

    const h = holding(db, 5000)
    markSell('holding', h)
    const second = routes.listForSale({ kind: 'holding', id: h })
    const hResult = routes.recordSale({ saleId: second.saleId, sold: '50.00' })
    expect(hResult.realizedGainCents).toBeNull()
    expect(hResult.net).toBe('$50.00')
    expect(hResult.realizedGain).toBe('—')
  })

  it('a partial sale decrements quantity and keeps the row', () => {
    const h = holding(db, 1000, 5)
    markSell('holding', h)
    const { saleId } = routes.listForSale({ kind: 'holding', id: h, quantity: 2 })
    const result = routes.recordSale({ saleId, sold: '20.00' })
    expect(result.removedFromCollection).toBe(false)
    expect(db.selectValue('SELECT quantity FROM holdings WHERE id = ?', [h])).toBe(3)
  })

  it('undo of a full sale restores the subject and sale — but not the verdict (ported quirk)', () => {
    const h = holding(db, 4000)
    markSell('holding', h)
    const { saleId } = routes.listForSale({ kind: 'holding', id: h })
    routes.recordSale({ saleId, sold: '40.00' })
    expect(db.selectValue('SELECT COUNT(*) FROM holdings')).toBe(0)

    routes.undo()
    expect(db.selectValue('SELECT COUNT(*) FROM holdings')).toBe(1)
    expect(db.selectValue('SELECT status FROM sales WHERE id = ?', [saleId])).toBe('listed')
    // webapp/sales.py snapshots the verdict after deleting it; the port keeps
    // that behavior so the parity gate can't diverge.
    expect(db.selectValue('SELECT COUNT(*) FROM verdicts')).toBe(0)
  })

  it('summary aggregates sold and listed, counting how many gains are known', () => {
    const s = sealedRow(db, 10000, 6000)
    const h = holding(db, 3000)
    markSell('sealed', s)
    markSell('holding', h)
    const sale1 = routes.listForSale({ kind: 'sealed', id: s })
    routes.recordSale({ saleId: sale1.saleId, sold: '100.00', fees: '10.00' })
    routes.listForSale({ kind: 'holding', id: h })

    const body = routes.salesSummary()
    expect(body.soldCount).toBe(1)
    expect(body.grossCents).toBe(10000)
    expect(body.costsCents).toBe(1000)
    expect(body.netCents).toBe(9000)
    expect(body.realizedGainCents).toBe(3000)
    expect(body.gainKnownFor).toBe(1)
    expect(body.listedCount).toBe(1)
    expect(body.listedCents).toBe(3000)
    expect(body.net).toBe('$90.00')
  })

  it('a fully-sold subject keeps its name in the sale record', () => {
    const h = holding(db, 2000)
    markSell('holding', h)
    const { saleId } = routes.listForSale({ kind: 'holding', id: h })
    routes.recordSale({ saleId, sold: '20.00' })
    const rows = routes.sales({}) as Array<Record<string, unknown>>
    expect(rows[0].name).toContain('Card')
    expect(rows[0].status).toBe('sold')
  })

  it('cancel refuses a sold sale and 400s bad statuses', () => {
    const h = holding(db, 2000)
    markSell('holding', h)
    const { saleId } = routes.listForSale({ kind: 'holding', id: h })
    routes.recordSale({ saleId, sold: '20.00' })
    expect(() => routes.cancelSale({ saleId })).toThrow(/undo it from History/)
    try {
      routes.sales({ status: 'vanished' })
    } catch (error) {
      expect((error as ApiFailure).code).toBe('bad-status')
    }
  })
})
