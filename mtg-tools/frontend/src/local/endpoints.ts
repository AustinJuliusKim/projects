/**
 * The route handlers — port of the `webapp/api.py` handler bodies, one named
 * function per route, returning exactly the JSON shapes Flask returns
 * (camelCase, integer cents, preformatted display strings).
 *
 * The worker owns the database and dispatches RPC to these. Handlers stay
 * synchronous (oo1 over SAHPool is sync); only the RPC edge is async.
 */

import { ACTIONS, BulkError, applyAction, preview, resolveSelection } from './bulk'
import { formatCents, setClock, toCents, transaction, type Database } from './db'
import { ApiFailure } from './errors'
import {
  SaleError,
  cancel,
  listForSale,
  recordListing,
  recordSale,
  saleRows,
  summary as salesSummary,
} from './sales'
import {
  BLOCKING,
  DetectionError,
  DuplicateImportError,
  ImportNotFound,
  ImportStateError,
  blockingCount,
  commitImport,
  decodeUpload,
  discardImport,
  importJson,
  issuesFor,
  sha256hex,
  stageImport,
} from './importer'
import { UndoLookupError, latestUndoable, recent, undoOperation } from './operations'
import * as exporter from './exporter'
import * as repo from './repo'

//: Query parameters that are not filters. Anything else must be a known filter.
const NON_FILTER_PARAMS = new Set(['sort', 'dir', 'page', 'perPage'])

interface Query {
  filters: repo.FilterValues
  sort?: string
  direction: string
  page: number
  perPage: number
}

/**
 * Merge and split the client's `{filters, opts}` exactly the way Flask splits
 * a query string: values are stringified (URLSearchParams would have),
 * undefined/''/false are dropped (the http transport's `query()` drops them
 * before they reach the wire), and any unknown key is a 400 — a typo'd filter
 * silently returning the whole collection is how a bulk edit goes wrong.
 */
function parseQuery(
  payload: { filters?: repo.FilterValues; opts?: repo.FilterValues } | undefined,
  spec: Record<string, unknown>,
): Query {
  const merged: Record<string, string> = {}
  for (const source of [payload?.filters, payload?.opts]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined || value === '' || value === false) continue
      merged[key] = String(value)
    }
  }

  const unknown = Object.keys(merged).filter(
    (key) => !(key in spec) && !NON_FILTER_PARAMS.has(key),
  )
  if (unknown.length) {
    const known = Object.keys(spec).sort().join(', ')
    throw new ApiFailure(
      `Unknown filter(s): ${unknown.sort().join(', ')}. Available: ${known}`,
      'bad-filter',
      400,
    )
  }

  const filters: repo.FilterValues = {}
  for (const key of Object.keys(spec)) {
    if (merged[key] !== undefined) filters[key] = merged[key]
  }
  return {
    filters,
    sort: merged.sort,
    direction: merged.dir ?? 'desc',
    page: parseInt(merged.page ?? '1', 10) || 1,
    perPage: parseInt(merged.perPage ?? '50', 10) || 50,
  }
}

function badFilter<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ApiFailure) throw error
    throw new ApiFailure((error as Error).message, 'bad-filter', 400)
  }
}

// --- serializers (api.py's _holding/_sealed_row/_totals, verbatim shapes) ----

function holdingJson(row: Record<string, unknown>) {
  const price = row.price_cents as number | null
  const quantity = row.quantity as number
  const total = price !== null ? price * quantity : null
  return {
    id: row.id,
    title: row.title,
    edition: row.edition,
    setName: row.set_name,
    collectorNumber: row.collector_number,
    rarity: row.rarity,
    foil: Boolean(row.foil),
    quantity,
    priceCents: price,
    totalCents: total,
    price: formatCents(price),
    total: formatCents(total),
    condition: row.condition,
    language: row.language,
    verdict: row.verdict,
  }
}

function sealedJson(row: Record<string, unknown>) {
  const price = row.price_cents as number | null
  const quantity = row.quantity as number
  const total = price !== null ? price * quantity : null
  const basis = row.cost_basis_cents as number | null
  const cost = basis !== null ? basis * quantity : null
  // Gain stays null without a basis — never zero. A fabricated basis lands
  // straight in a tax figure.
  const gain = cost === null || total === null ? null : total - cost
  return {
    id: row.id,
    name: (row.product_name as string) || row.raw_name,
    rawName: row.raw_name,
    setCode: row.set_code,
    setName: row.set_name,
    year: row.release_year,
    quantity,
    priceCents: price,
    totalCents: total,
    price: formatCents(price),
    total: formatCents(total),
    costBasisCents: cost,
    costBasis: formatCents(cost),
    gainCents: gain,
    gain: formatCents(gain),
    priceDate: row.price_date,
    priceSource: row.price_source,
    condition: row.condition,
    resolved: Boolean(row.resolved),
    purchaseUrl: row.purchase_url,
    notes: row.notes,
    verdict: row.verdict,
  }
}

function totalsJson(t: repo.Totals) {
  return {
    rows: t.rows,
    quantity: t.quantity,
    valueCents: t.value_cents,
    value: formatCents(t.value_cents),
    unpriced: t.unpriced,
  }
}

function sealedTotalsJson(t: repo.SealedTotals) {
  return {
    ...totalsJson(t),
    unresolved: t.unresolved,
    costCents: t.cost_cents,
    cost: formatCents(t.cost_cents),
  }
}

/**
 * Body filters for a bulk selection — api.py's `_selection_filters`. POST
 * bodies arrive as raw JSON (booleans and numbers, unlike query strings), so
 * values pass through untouched; only None/''/[] are dropped, and unknown
 * keys are the same strict 400.
 */
function selectionFilters(kind: string, source: Record<string, unknown>): repo.FilterValues {
  const spec = kind === 'sealed' ? repo.SEALED_FILTERS : repo.FILTERS
  const unknown = Object.keys(source).filter((key) => !(key in spec) && !NON_FILTER_PARAMS.has(key))
  if (unknown.length) {
    const known = Object.keys(spec).sort().join(', ')
    throw new ApiFailure(
      `Unknown filter(s): ${unknown.sort().join(', ')}. Available: ${known}`,
      'bad-filter',
      400,
    )
  }
  const out: repo.FilterValues = {}
  for (const key of Object.keys(spec)) {
    const value = source[key]
    if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) {
      out[key] = value
    }
  }
  return out
}

/** api.py's `_cents_or_none`: dollars in, cents out, nonsense rejected. */
function centsOrNone(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  try {
    return toCents(String(value))
  } catch {
    const shown = typeof value === 'string' ? `'${value}'` : String(value)
    throw new ApiFailure(`${shown} is not an amount.`, 'bad-amount', 400)
  }
}

// --- the routes --------------------------------------------------------------

export interface WorkerContext {
  db(): Database
  vfs(): string
  schemaVersion(): number
  importDatabase(bytes: Uint8Array): Promise<{ holdings: number; sealed: number }>
  exportDb(): Uint8Array | null
}

/** api.py's `_min_price_cents`: `?min_price=` dollars, default $1 floor. */
function minPriceCents(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 100
  const text = String(raw).trim()
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text)
  if (!match) {
    throw new ApiFailure(`'${raw}' isn't a price.`, 'bad-min-price', 400)
  }
  if (match[1] === '-') {
    throw new ApiFailure("A minimum price can't be negative.", 'bad-min-price', 400)
  }
  // Python does int(Decimal(raw) * 100) — truncation, not rounding.
  const frac = ((match[3] ?? match[4] ?? '') + '00').slice(0, 2)
  return Number(match[2] ?? '0') * 100 + Number(frac)
}

type QueryPayload = { filters?: repo.FilterValues; opts?: repo.FilterValues }

export function makeRoutes(ctx: WorkerContext) {
  return {
    ping: () => ({ status: 'ok', vfs: ctx.vfs(), schemaVersion: ctx.schemaVersion() }),

    session: () => ({
      csrfToken: '', // no server, no cookies, nothing for CSRF to defend
      database:
        ctx.vfs() === 'opfs-sahpool' ? 'opfs:/collection.db' : ':memory: (nothing persists)',
      undoable: latestUndoable(ctx.db()),
    }),

    history: () => recent(ctx.db(), 50),

    undo: () => {
      try {
        return transaction(ctx.db(), () => undoOperation(ctx.db()))
      } catch (error) {
        if (error instanceof UndoLookupError) {
          throw new ApiFailure(error.message, 'nothing-to-undo', 409)
        }
        throw error
      }
    },

    collection: (payload: QueryPayload) => {
      const q = parseQuery(payload, repo.FILTERS)
      const db = ctx.db()
      const page = badFilter(() =>
        repo.queryHoldings(db, q.filters, {
          sort: q.sort ?? repo.DEFAULT_SORT,
          direction: q.direction,
          page: q.page,
          perPage: q.perPage,
        }),
      )
      return {
        rows: page.rows.map(holdingJson),
        page: page.page,
        perPage: page.perPage,
        pages: page.pages,
        totalRows: page.totalRows,
        sort: page.sort,
        direction: page.direction,
        totals: totalsJson(badFilter(() => repo.totals(db, q.filters))),
        grandTotals: totalsJson(repo.totals(db, {})),
        facets: {
          editions: repo.distinctValues(db, 'edition'),
          rarities: repo.distinctValues(db, 'rarity'),
          conditions: repo.distinctValues(db, 'condition'),
        },
      }
    },

    insights: (payload: QueryPayload) => {
      const q = parseQuery(payload, repo.FILTERS)
      const db = ctx.db()
      return badFilter(() => ({
        concentration: repo.concentration(db, q.filters),
        tiers: repo.tierBreakdown(db, q.filters).map((t) => ({
          ...t,
          market: formatCents(t.marketCents),
          cash: formatCents(t.cashCents),
          credit: formatCents(t.creditCents),
        })),
        sets: repo.topSets(db, q.filters).map((s) => ({ ...s, value: formatCents(s.cents) })),
        rarity: repo.raritySplit(db, q.filters).map((r) => ({ ...r, value: formatCents(r.cents) })),
        totals: totalsJson(repo.totals(db, q.filters)),
      }))
    },

    sealed: (payload: QueryPayload) => {
      const q = parseQuery(payload, repo.SEALED_FILTERS)
      const db = ctx.db()
      const page = badFilter(() =>
        repo.querySealed(db, q.filters, {
          sort: q.sort ?? 'total',
          direction: q.direction,
          page: q.page,
          perPage: q.perPage,
        }),
      )
      return {
        rows: page.rows.map(sealedJson),
        page: page.page,
        perPage: page.perPage,
        pages: page.pages,
        totalRows: page.totalRows,
        sort: page.sort,
        direction: page.direction,
        totals: sealedTotalsJson(badFilter(() => repo.sealedTotals(db, q.filters))),
        grandTotals: sealedTotalsJson(repo.sealedTotals(db, {})),
        facets: {
          sets: repo.sealedDistinct(db, 'set_code'),
          years: repo.sealedDistinct(db, 'release_year'),
          conditions: repo.sealedDistinct(db, 'condition'),
        },
      }
    },

    sealedInsights: (payload: QueryPayload) => {
      const q = parseQuery(payload, repo.SEALED_FILTERS)
      const db = ctx.db()
      return badFilter(() => {
        const totals = repo.sealedTotals(db, q.filters)
        return {
          byYear: repo.sealedByYear(db, q.filters).map((y) => ({
            year: y.year,
            quantity: y.qty,
            cents: y.cents,
            value: formatCents(y.cents as number),
            unpriced: y.unpriced,
          })),
          coverage: {
            priced: totals.quantity - totals.unpriced,
            unpriced: totals.unpriced,
            pricedCents: totals.value_cents,
          },
          totals: sealedTotalsJson(totals),
        }
      })
    },

    bulkActions: (payload: { kind?: string }) => {
      const kind = payload?.kind ?? 'holding'
      if (!(kind in repo.SUBJECTS)) {
        throw new ApiFailure(`'${kind}' is not a bulk subject`, 'bad-kind', 400)
      }
      return Object.entries(ACTIONS)
        .filter(([, spec]) => spec.kinds.includes(kind))
        .map(([key, spec]) => ({
          key,
          label: spec.label,
          needsValue: spec.needsValue,
          destructive: Boolean(spec.destructive),
        }))
    },

    bulkPreview: (payload: Record<string, unknown>) => {
      const kind = (payload?.kind as string) ?? 'holding'
      const db = ctx.db()
      let target: number[]
      try {
        target = resolveSelection(db, {
          ids: payload?.ids as number[] | undefined,
          filters: selectionFilters(kind, (payload?.filters as Record<string, unknown>) ?? {}),
          selectAll: Boolean(payload?.selectAll),
          kind,
        })
      } catch (error) {
        if (error instanceof ApiFailure) throw error
        throw new ApiFailure((error as Error).message, 'bad-selection', 400)
      }
      const p = preview(db, target, kind)
      return {
        count: p.count,
        quantity: p.quantity,
        valueCents: p.value_cents,
        value: formatCents(p.value_cents),
        more: p.more,
        sample: p.sample.map((r) => ({
          title: r.title,
          edition: r.edition,
          quantity: r.quantity,
          price: formatCents(r.price_cents as number | null),
        })),
      }
    },

    bulkApply: (payload: Record<string, unknown>) => {
      const kind = (payload?.kind as string) ?? 'holding'
      const db = ctx.db()
      try {
        // Resolved here, from ids or filters — never from a count the client
        // sent. This is the guarantee a stale filter cannot widen an edit.
        const target = resolveSelection(db, {
          ids: payload?.ids as number[] | undefined,
          filters: selectionFilters(kind, (payload?.filters as Record<string, unknown>) ?? {}),
          selectAll: Boolean(payload?.selectAll),
          kind,
        })
        return transaction(db, () =>
          applyAction(db, (payload?.action as string) ?? '', target, payload?.value, kind),
        )
      } catch (error) {
        if (error instanceof ApiFailure) throw error
        if (error instanceof BulkError) {
          throw new ApiFailure(error.message, 'bulk-failed', 400)
        }
        throw error
      }
    },

    salesQueue: () => listForSale(ctx.db()),

    sales: (payload: { status?: string }) => {
      try {
        return saleRows(ctx.db(), payload?.status)
      } catch (error) {
        if (error instanceof SaleError) throw new ApiFailure(error.message, 'bad-status', 400)
        throw error
      }
    },

    salesSummary: () => {
      const body = salesSummary(ctx.db())
      return {
        ...body,
        gross: formatCents(body.grossCents),
        costs: formatCents(body.costsCents),
        net: formatCents(body.netCents),
        realizedGain: formatCents(body.realizedGainCents),
        listed: formatCents(body.listedCents),
      }
    },

    listForSale: (payload: Record<string, unknown>) => {
      const db = ctx.db()
      try {
        const saleId = transaction(db, () =>
          recordListing(db, (payload?.kind as string) ?? '', Math.trunc(Number(payload?.id ?? 0)), {
            channel: (payload?.channel as string) ?? '',
            listedCents: centsOrNone(payload?.listed),
            quantity: payload?.quantity as number | null | undefined,
            notes: (payload?.notes as string) ?? '',
          }),
        )
        return { saleId }
      } catch (error) {
        if (error instanceof ApiFailure) throw error
        if (error instanceof SaleError) throw new ApiFailure(error.message, 'bad-listing', 400)
        throw error
      }
    },

    recordSale: (payload: Record<string, unknown>) => {
      const db = ctx.db()
      const sold = centsOrNone(payload?.sold)
      if (sold === null) throw new ApiFailure('Enter what it sold for.', 'no-price', 400)
      try {
        const result = transaction(db, () =>
          recordSale(db, Math.trunc(Number(payload?.saleId)), {
            soldCents: sold,
            feesCents: centsOrNone(payload?.fees) ?? 0,
            shippingCents: centsOrNone(payload?.shipping) ?? 0,
            soldAt: payload?.soldAt as string | undefined,
            notes: payload?.notes as string | undefined,
          }),
        )
        return {
          ...result,
          net: formatCents(result.netCents),
          realizedGain: formatCents(result.realizedGainCents),
        }
      } catch (error) {
        if (error instanceof ApiFailure) throw error
        if (error instanceof SaleError) throw new ApiFailure(error.message, 'bad-sale', 400)
        throw error
      }
    },

    cancelSale: (payload: { saleId: number }) => {
      const db = ctx.db()
      try {
        transaction(db, () => cancel(db, Math.trunc(Number(payload?.saleId))))
        return { cancelled: payload.saleId }
      } catch (error) {
        if (error instanceof SaleError) throw new ApiFailure(error.message, 'bad-cancel', 400)
        throw error
      }
    },

    importDatabase: async (payload: { file: File }) => {
      const bytes = new Uint8Array(await payload.file.arrayBuffer())
      const counts = await ctx.importDatabase(bytes)
      return { imported: true, ...counts }
    },

    imports: () =>
      ctx
        .db()
        .selectObjects('SELECT * FROM imports ORDER BY id DESC LIMIT 50')
        .map(importJson),

    upload: async (payload: { file?: File }) => {
      const file = payload?.file
      if (!file || !file.name) throw new ApiFailure('Choose a CSV first.', 'no-file', 400)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const digest = await sha256hex(bytes)
      const text = decodeUpload(bytes)
      const db = ctx.db()
      try {
        const [importId, kind] = transaction(db, () =>
          stageImport(db, file.name, text, digest),
        )
        return { importId, kind }
      } catch (error) {
        if (error instanceof DetectionError) {
          throw new ApiFailure(error.message, 'unrecognized', 400)
        }
        if (error instanceof DuplicateImportError) {
          throw new ApiFailure(error.message, 'duplicate', 409)
        }
        throw error
      }
    },

    importDetail: (payload: { id: number }) => {
      const db = ctx.db()
      const record = db.selectObject('SELECT * FROM imports WHERE id = ?', [payload.id])
      if (record === undefined) {
        throw new ApiFailure(`No import ${payload.id}.`, 'not-found', 404)
      }
      const grouped = issuesFor(db, payload.id)
      return {
        record: importJson(record),
        blocking: blockingCount(db, payload.id),
        blockingCodes: [...BLOCKING].sort(),
        issues: [...grouped.entries()].map(([code, items]) => ({
          code,
          blocking: (BLOCKING as readonly string[]).includes(code),
          rows: items.map((item) => ({
            id: item.id,
            lineNo: item.line_no,
            name: (item.parsed.title as string) || (item.parsed.raw_name as string) || '',
            candidates: (item.parsed.candidates as string[]) || [],
            state: item.state,
          })),
        })),
      }
    },

    resolveRow: (payload: {
      importId: number
      rowId: number
      body: Record<string, unknown>
    }) => {
      const db = ctx.db()
      const row = db.selectObject(
        'SELECT * FROM staged_rows WHERE id = ? AND import_id = ?',
        [payload.rowId, payload.importId],
      )
      if (row === undefined) throw new ApiFailure('No such staged row.', 'not-found', 404)

      transaction(db, () => {
        if (payload.body?.skip) {
          db.exec({
            sql: "UPDATE staged_rows SET state = 'skipped' WHERE id = ?",
            bind: [payload.rowId],
          })
        } else {
          const resolution = JSON.parse((row.resolution as string) || '{}')
          for (const key of ['set_code', 'identity', 'mtgjson_uuid', 'product_name']) {
            if (payload.body?.[key]) resolution[key] = payload.body[key]
          }
          db.exec({
            sql: "UPDATE staged_rows SET resolution = ?, state = 'resolved' WHERE id = ?",
            bind: [JSON.stringify(resolution), payload.rowId],
          })
        }
      })
      return { blocking: blockingCount(db, payload.importId) }
    },

    commitImport: (payload: { id: number }) => {
      const db = ctx.db()
      try {
        return transaction(db, () => commitImport(db, payload.id))
      } catch (error) {
        if (error instanceof ImportNotFound) {
          throw new ApiFailure(error.message, 'not-found', 404)
        }
        if (error instanceof ImportStateError) {
          throw new ApiFailure(error.message, 'blocked', 409)
        }
        throw error
      }
    },

    discardImport: (payload: { id: number }) => {
      const db = ctx.db()
      transaction(db, () => discardImport(db, payload.id))
      return { discarded: payload.id }
    },

    exportManifest: () => {
      const db = ctx.db()
      return { tables: exporter.tableNames(db), ...exporter.manifest(db) }
    },

    buylistSummary: (payload: { minPrice?: string }) =>
      exporter.buylistSummary(ctx.db(), minPriceCents(payload?.minPrice)),

    download: (payload: { name?: string; table?: string; minPrice?: string }) => {
      const db = ctx.db()
      const encoder = new TextEncoder()
      const csv = (filename: string, text: string) => ({
        filename,
        mime: 'text/csv',
        bytes: encoder.encode(text),
      })
      switch (payload?.name) {
        case 'table': {
          try {
            return csv(`${payload.table}.csv`, exporter.tableCsv(db, payload.table ?? ''))
          } catch (error) {
            if (error instanceof exporter.NotExportable) {
              throw new ApiFailure(error.message, 'not-exportable', 404)
            }
            throw error
          }
        }
        case 'ledger':
          return csv('mtg_collection_tracker.csv', exporter.ledgerCsv(db))
        case 'buylist':
          return csv('buylist.csv', exporter.buylistCsv(db, minPriceCents(payload.minPrice)))
        case 'buylist-ck':
          return csv(
            'card_kingdom_submission.csv',
            exporter.ckSubmissionCsv(db, minPriceCents(payload.minPrice)),
          )
        case 'sealed-template':
          return csv('sealed.csv', exporter.templateCsv())
        case 'bundle': {
          const { filename, bytes } = exporter.bundle(db, ctx.exportDb())
          return { filename, mime: 'application/zip', bytes }
        }
        default:
          throw new ApiFailure(`'${payload?.name}' is not downloadable`, 'not-found', 404)
      }
    },

    /** Debug/parity only: freeze the worker clock so timestamps deep-equal
     * a Flask run with the same frozen clock. */
    debugSetClock: (payload: { iso?: string }) => {
      setClock(payload?.iso ? () => new Date(payload.iso!) : undefined)
      return { clock: payload?.iso ?? 'live' }
    },

    /** Debug/parity only: the staged rows as the importer wrote them. */
    debugStagedRows: (payload: { id: number }) =>
      ctx
        .db()
        .selectObjects(
          'SELECT line_no, parsed, issues, state FROM staged_rows WHERE import_id = ? ORDER BY line_no',
          [payload.id],
        )
        .map((r) => ({
          lineNo: r.line_no,
          parsed: JSON.parse(r.parsed as string),
          issues: JSON.parse(r.issues as string),
          state: r.state,
        })),
  }
}
