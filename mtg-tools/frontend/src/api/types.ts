/**
 * The API contract, extracted from the original client so two transports can
 * implement it: `transport-http.ts` (fetch against Flask) and
 * `transport-local.ts` (postMessage to the in-browser SQLite worker).
 *
 * Two rules mirrored from the server, because breaking either here would undo
 * the guarantees it enforces:
 *
 * 1. **Money arrives as integer cents plus a preformatted string.** Nothing in
 *    the UI does money arithmetic — JSON numbers are doubles, and the whole
 *    stack keeps money exact precisely to avoid that.
 *
 * 2. **A bulk selection is never a materialized id list when it means
 *    "everything matching".** `selectAll` plus the filters goes to the server,
 *    which re-resolves it, so a filter that changed since render cannot widen
 *    an edit.
 */

export type Filters = Record<string, string | number | boolean | undefined>

export interface Holding {
  id: number
  title: string
  edition: string
  setName: string
  collectorNumber: string
  rarity: string
  foil: boolean
  quantity: number
  priceCents: number | null
  totalCents: number | null
  price: string
  total: string
  condition: string
  language: string
  verdict: 'keep' | 'sell' | 'undecided'
}

export interface Totals {
  rows: number
  quantity: number
  valueCents: number
  value: string
  unpriced: number
}

export interface CollectionPage {
  rows: Holding[]
  page: number
  perPage: number
  pages: number
  totalRows: number
  sort: string
  direction: 'asc' | 'desc'
  totals: Totals
  grandTotals: Totals
  facets: { editions: string[]; rarities: string[]; conditions: string[] }
}

export interface Tier {
  tier: string
  label: string
  quantity: number
  marketCents: number
  cashCents: number
  creditCents: number
  cashPct: number
  creditPct: number
  market: string
  cash: string
  credit: string
}

export interface Insights {
  concentration: {
    points: { n: number; rowPct: number; valuePct: number }[]
    marks: { valuePct: number; rows: number }[]
    pricedRows: number
  }
  tiers: Tier[]
  sets: { name: string; quantity: number; cents: number; value: string; other: boolean }[]
  rarity: { name: string; quantity: number; cents: number; value: string }[]
  totals: Totals
}

export interface SealedRow {
  id: number
  name: string
  rawName: string
  setCode: string
  setName: string
  year: string
  quantity: number
  priceCents: number | null
  totalCents: number | null
  price: string
  total: string
  costBasisCents: number | null
  costBasis: string
  gainCents: number | null
  gain: string
  priceDate: string | null
  priceSource: string
  condition: string
  resolved: boolean
  purchaseUrl: string
  notes: string
  verdict: 'keep' | 'sell' | 'undecided'
}

export interface SealedTotals extends Totals {
  unresolved: number
  costCents: number
  cost: string
}

export interface SealedPage {
  rows: SealedRow[]
  page: number
  perPage: number
  pages: number
  totalRows: number
  sort: string
  direction: 'asc' | 'desc'
  totals: SealedTotals
  grandTotals: SealedTotals
  facets: { sets: string[]; years: string[]; conditions: string[] }
}

export interface SealedInsights {
  byYear: {
    year: string
    quantity: number
    cents: number
    value: string
    unpriced: number
  }[]
  coverage: { priced: number; unpriced: number; pricedCents: number }
  totals: SealedTotals
}

/** What the CK submission list would contain, shown before it is downloaded. */
export interface BuylistSummary {
  rows: number
  quantity: number
  marketCents: number
  market: string
  cashCents: number
  cash: string
  creditCents: number
  credit: string
  minPriceCents: number
}

export interface Operation {
  id: number
  kind: string
  summary: string
  affected: number
  createdAt: string
  revertedAt: string | null
  reverted: boolean
}

export interface ImportRecord {
  id: number
  filename: string
  kind: string
  dialect: string
  rowCount: number
  status: string
  createdAt: string
  committedAt: string | null
}

export interface ImportDetail {
  record: ImportRecord
  blocking: number
  blockingCodes: string[]
  issues: {
    code: string
    blocking: boolean
    rows: { id: number; lineNo: number; name: string; candidates: string[]; state: string }[]
  }[]
}

export interface SaleRecord {
  id: number
  subject_kind: string
  subject_id: number
  quantity: number
  channel: string
  status: 'listed' | 'sold' | 'cancelled'
  listed_at: string | null
  listed_cents: number | null
  sold_at: string | null
  sold_cents: number | null
  fees_cents: number
  shipping_cents: number
  net_cents: number | null
  realized_gain_cents: number | null
  notes: string
  name: string | null
}

export interface QueueItem {
  kind: 'holding' | 'sealed'
  id: number
  name: string
  setCode: string
  quantity: number
  priceCents: number | null
  marketCents: number
  costBasisCents: number | null
  sale: SaleRecord | null
}

export interface SalesSummary {
  soldCount: number
  grossCents: number
  costsCents: number
  netCents: number
  realizedGainCents: number
  gainKnownFor: number
  listedCount: number
  listedCents: number
  gross: string
  costs: string
  net: string
  realizedGain: string
  listed: string
}

export interface BulkAction {
  key: string
  label: string
  needsValue: boolean
  destructive: boolean
}

export interface Selection {
  ids?: number[]
  selectAll?: boolean
  filters?: Filters
  /** Which table the selection is over. The server re-resolves against it. */
  kind?: 'holding' | 'sealed'
}

export interface SessionInfo {
  csrfToken: string
  database: string
  undoable: Operation | null
}

export interface BulkPreview {
  count: number
  quantity: number
  valueCents: number
  value: string
  more: number
  sample: { title: string; edition: string; quantity: number; price: string }[]
}

export interface BulkResult {
  affected: number
  summary: string
}

export interface UploadResult {
  importId: number
  kind: string
}

export interface CommitResult {
  added: number
  updated: number
  kind: string
}

export interface SaleSoldResult {
  saleId: number
  netCents: number
  realizedGainCents: number | null
  removedFromCollection: boolean
  net: string
  realizedGain: string
}

export interface ExportManifest {
  tables: string[]
  exportedAt: string
  rowCounts: Record<string, number>
  singles: { quantity: number; valueCents: number; value: string }
  notes: string[]
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type DownloadName =
  | 'bundle'
  | 'ledger'
  | 'buylist'
  | 'buylist-ck'
  | 'sealed-template'
  | 'table'

export interface DownloadOptions {
  table?: string
  minPrice?: string
}

export interface DownloadResult {
  filename: string
  blob: Blob
}

/** Everything a backend must provide. Both transports implement exactly this. */
export interface Api {
  /** A file download: http fetches the route, local builds the bytes in the
   * worker. Either way the caller gets a Blob and its filename. */
  download(name: DownloadName, opts?: DownloadOptions): Promise<DownloadResult>
  session(): Promise<SessionInfo>
  collection(filters: Filters, opts?: Filters): Promise<CollectionPage>
  insights(filters: Filters): Promise<Insights>
  sealed(filters: Filters, opts?: Filters): Promise<SealedPage>
  sealedInsights(filters: Filters): Promise<SealedInsights>
  bulkActions(kind?: string): Promise<BulkAction[]>
  bulkPreview(selection: Selection): Promise<BulkPreview>
  bulkApply(selection: Selection, action: string, value?: string): Promise<BulkResult>
  imports(): Promise<ImportRecord[]>
  upload(file: File): Promise<UploadResult>
  importDetail(id: number): Promise<ImportDetail>
  resolveRow(
    importId: number,
    rowId: number,
    body: Record<string, unknown>,
  ): Promise<{ blocking: number }>
  commitImport(id: number): Promise<CommitResult>
  discardImport(id: number): Promise<{ discarded: number }>
  salesQueue(): Promise<QueueItem[]>
  sales(status?: string): Promise<SaleRecord[]>
  salesSummary(): Promise<SalesSummary>
  listForSale(body: {
    kind: string
    id: number
    channel?: string
    listed?: string
    quantity?: number
  }): Promise<{ saleId: number }>
  recordSale(
    saleId: number,
    body: { sold: string; fees?: string; shipping?: string; notes?: string },
  ): Promise<SaleSoldResult>
  cancelSale(saleId: number): Promise<{ cancelled: number }>
  exportManifest(): Promise<ExportManifest>
  buylistSummary(): Promise<BuylistSummary>
  history(): Promise<Operation[]>
  undo(): Promise<Operation>
}
