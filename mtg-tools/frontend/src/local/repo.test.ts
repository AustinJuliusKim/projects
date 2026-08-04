// @vitest-environment node
/**
 * The read side, ported intent from tests_webapp/test_api.py's collection,
 * insights and sealed suites — exercised through the endpoint layer
 * (makeRoutes) so the tested surface is the exact JSON the UI receives.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import SCHEMA from '../../../webapp/schema.sql?raw'
import { initSchema, wrapDb, type Database } from './db'
import { ApiFailure } from './errors'
import { makeRoutes } from './endpoints'
import { roundHalfEven } from './repo'

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

let holdingSeq = 0
function holding(
  db: Database,
  fields: Partial<{
    title: string
    edition: string
    setName: string
    rarity: string
    foil: number
    quantity: number
    cents: number | null
  }> = {},
): number {
  holdingSeq += 1
  db.exec({
    sql:
      'INSERT INTO holdings (identity, title, edition, set_name, rarity, foil, quantity, price_cents, created_at, updated_at) ' +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${T}, ${T})`,
    bind: [
      `card-${holdingSeq} normal`,
      fields.title ?? `Card ${holdingSeq}`,
      fields.edition ?? 'SB1',
      fields.setName ?? 'Synthetic Block 1',
      fields.rarity ?? 'common',
      fields.foil ?? 0,
      fields.quantity ?? 1,
      fields.cents ?? null,
    ],
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

let sealedSeq = 0
function sealedRow(
  db: Database,
  fields: Partial<{
    rawName: string
    productName: string
    setCode: string
    year: string
    quantity: number
    cents: number | null
    basis: number | null
    resolved: number
  }> = {},
): number {
  sealedSeq += 1
  db.exec({
    sql:
      'INSERT INTO sealed (identity, raw_name, product_name, set_code, release_year, quantity, price_cents, cost_basis_cents, resolved, created_at, updated_at) ' +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${T}, ${T})`,
    bind: [
      `deck-${sealedSeq}`,
      fields.rawName ?? `Raw Deck ${sealedSeq}`,
      fields.productName ?? '',
      fields.setCode ?? 'SB1',
      fields.year ?? '2024',
      fields.quantity ?? 1,
      fields.cents ?? null,
      fields.basis ?? null,
      fields.resolved ?? 1,
    ],
  })
  return Number(db.selectValue('SELECT last_insert_rowid()'))
}

describe('collection reads', () => {
  let db: Db
  let routes: Routes
  beforeEach(async () => {
    db = await openDb()
    routes = routesFor(db)
  })

  it('rejects an unknown filter with the exact server error', () => {
    expect(() => routes.collection({ filters: { prices_min: '10' } })).toThrow(ApiFailure)
    try {
      routes.collection({ filters: { prices_min: '10' } })
    } catch (error) {
      const failure = error as ApiFailure
      expect(failure.status).toBe(400)
      expect(failure.code).toBe('bad-filter')
      expect(failure.message).toContain('Unknown filter(s): prices_min')
      expect(failure.message).toContain('Available:')
      expect(failure.message).toContain('price_min')
    }
  })

  it('scoped totals reflect the filter; grand totals never do', () => {
    holding(db, { rarity: 'mythic', quantity: 2, cents: 7500 })
    holding(db, { rarity: 'common', quantity: 4, cents: 35 })
    const page = routes.collection({ filters: { rarity: 'mythic' } })
    expect(page.totals.quantity).toBe(2)
    expect(page.totals.valueCents).toBe(15000)
    expect(page.totals.value).toBe('$150.00')
    expect(page.grandTotals.quantity).toBe(6)
    expect(page.grandTotals.valueCents).toBe(15140)
  })

  it('an unpriced card is unpriced, not free — and counted by quantity', () => {
    holding(db, { quantity: 3, cents: null })
    holding(db, { quantity: 1, cents: 500 })
    const page = routes.collection({})
    expect(page.grandTotals.unpriced).toBe(3)
    expect(page.grandTotals.valueCents).toBe(500)
    const unpricedRow = page.rows.find((r) => r.priceCents === null)!
    expect(unpricedRow.price).toBe('—')
    expect(unpricedRow.totalCents).toBeNull()
  })

  it('paginates with the default most-valuable-stack-first sort', () => {
    holding(db, { title: 'Cheap', quantity: 1, cents: 100 })
    holding(db, { title: 'Chase', quantity: 1, cents: 9000 })
    holding(db, { title: 'Middle', quantity: 2, cents: 1000 })
    const page = routes.collection({ opts: { perPage: 2 } })
    expect(page.pages).toBe(2)
    expect(page.totalRows).toBe(3)
    expect(page.rows.map((r) => r.title)).toEqual(['Chase', 'Middle'])
    const second = routes.collection({ opts: { perPage: 2, page: 2 } })
    expect(second.rows.map((r) => r.title)).toEqual(['Cheap'])
  })

  it('filters foil the way the query string spells it', () => {
    holding(db, { title: 'Shiny', foil: 1, cents: 100 })
    holding(db, { title: 'Plain', foil: 0, cents: 100 })
    const page = routes.collection({ filters: { foil: 'true' } })
    expect(page.rows.map((r) => r.title)).toEqual(['Shiny'])
  })

  it('facets enumerate what exists', () => {
    holding(db, { edition: 'AAA', rarity: 'rare' })
    holding(db, { edition: 'BBB', rarity: 'mythic' })
    const page = routes.collection({})
    expect(page.facets.editions).toEqual(['AAA', 'BBB'])
    expect(page.facets.rarities).toEqual(['mythic', 'rare'])
  })
})

describe('insights', () => {
  let db: Db
  let routes: Routes
  beforeEach(async () => {
    db = await openDb()
    routes = routesFor(db)
  })

  it('bands tier totals and rounds rates half-even like Python', () => {
    holding(db, { quantity: 1, cents: 2000 }) // prime floor exactly
    holding(db, { quantity: 1, cents: 150 }) // bulk: 150 * 47%... no — bulk is 20/25
    const tiers = routes.insights({}).tiers
    const prime = tiers.find((t) => t.tier === 'prime')!
    expect(prime.marketCents).toBe(2000)
    expect(prime.cashCents).toBe(1200)
    expect(prime.creditCents).toBe(1500)
    const bulk = tiers.find((t) => t.tier === 'bulk')!
    // 150 * 25% = 37.5 — Python round() is half-even, so 38 (37 is odd).
    expect(bulk.creditCents).toBe(roundHalfEven(37.5))
    expect(bulk.creditCents).toBe(38)
    // 150 * 20% = 30 exactly.
    expect(bulk.cashCents).toBe(30)
  })

  it('folds the set tail into an honest Other bucket', () => {
    for (let i = 1; i <= 14; i++) {
      holding(db, { setName: `Set ${String(i).padStart(2, '0')}`, cents: (15 - i) * 100 })
    }
    const sets = routes.insights({}).sets
    expect(sets).toHaveLength(13)
    const other = sets[sets.length - 1]
    expect(other.other).toBe(true)
    expect(other.name).toBe('Other (2 sets)')
    expect(other.cents).toBe(100 + 200)
  })

  it('orders rarity mythic-first regardless of value', () => {
    holding(db, { rarity: 'common', cents: 99999 })
    holding(db, { rarity: 'mythic', cents: 1 })
    const rarity = routes.insights({}).rarity
    expect(rarity.map((r) => r.name)).toEqual(['mythic', 'common'])
  })

  it('marks concentration thresholds on priced rows only', () => {
    holding(db, { cents: 9000 })
    holding(db, { cents: 500 })
    holding(db, { cents: 500 })
    holding(db, { cents: null }) // must not flatten the curve
    const conc = routes.insights({}).concentration
    expect(conc.pricedRows).toBe(3)
    // Richest row alone is 90% of value: it carries the 50/80/90 marks.
    expect(conc.marks).toEqual([
      { valuePct: 50, rows: 1 },
      { valuePct: 80, rows: 1 },
      { valuePct: 90, rows: 1 },
    ])
  })
})

describe('sealed reads', () => {
  let db: Db
  let routes: Routes
  beforeEach(async () => {
    db = await openDb()
    routes = routesFor(db)
  })

  it('name_contains searches product and raw names alike', () => {
    sealedRow(db, { rawName: 'necron dynasties', productName: '' })
    sealedRow(db, { rawName: 'x', productName: 'Forces of the Imperium [40K]' })
    sealedRow(db, { rawName: 'plain deck' })
    const byRaw = routes.sealed({ filters: { name_contains: 'necron' } })
    expect(byRaw.totalRows).toBe(1)
    const byProduct = routes.sealed({ filters: { name_contains: 'imperium' } })
    expect(byProduct.totalRows).toBe(1)
  })

  it('gain is null without a cost basis — never zero', () => {
    sealedRow(db, { cents: 5000, basis: null })
    sealedRow(db, { cents: 5000, basis: 3000, quantity: 2 })
    const rows = routes.sealed({}).rows
    const noBasis = rows.find((r) => r.costBasisCents === null)!
    expect(noBasis.gainCents).toBeNull()
    expect(noBasis.gain).toBe('—')
    const withBasis = rows.find((r) => r.costBasisCents !== null)!
    expect(withBasis.costBasisCents).toBe(6000)
    expect(withBasis.gainCents).toBe(4000)
  })

  it('totals carry cost, unresolved and quantity-weighted unpriced', () => {
    sealedRow(db, { cents: null, quantity: 3, resolved: 0 })
    sealedRow(db, { cents: 2000, basis: 1000, quantity: 2 })
    const totals = routes.sealed({}).grandTotals
    expect(totals.unpriced).toBe(3)
    expect(totals.unresolved).toBe(1)
    expect(totals.costCents).toBe(2000)
    expect(totals.valueCents).toBe(4000)
  })

  it('groups by year with an em-dash bucket for the yearless', () => {
    sealedRow(db, { year: '2020', cents: 1000 })
    sealedRow(db, { year: '', cents: 500 })
    const byYear = routes.sealedInsights({}).byYear
    expect(byYear.map((y) => y.year)).toEqual(['2020', '—'])
  })

  it('rejects unknown sealed filters strictly', () => {
    expect(() => routes.sealed({ filters: { rarity: 'mythic' } })).toThrow(
      /Unknown filter\(s\): rarity/,
    )
  })
})

describe('bulk actions metadata', () => {
  it('scopes actions to the subject kind', async () => {
    const db = await openDb()
    const routes = routesFor(db)
    const holdingKeys = routes.bulkActions({ kind: 'holding' }).map((a) => a.key)
    expect(holdingKeys).toContain('language')
    expect(holdingKeys).not.toContain('cost_basis')
    const sealedKeys = routes.bulkActions({ kind: 'sealed' }).map((a) => a.key)
    expect(sealedKeys).toContain('cost_basis')
    expect(sealedKeys).not.toContain('language')
    expect(() => routes.bulkActions({ kind: 'binder' })).toThrow("'binder' is not a bulk subject")
  })
})

describe('imported-database compatibility', () => {
  it('refuses a future schema version with the init_db message', async () => {
    const db = await openDb()
    db.exec('UPDATE schema_version SET version = 99')
    expect(() => initSchema(db, SCHEMA)).toThrow(
      'database is schema v99, this build expects v1 — no migration path is defined yet',
    )
  })
})
