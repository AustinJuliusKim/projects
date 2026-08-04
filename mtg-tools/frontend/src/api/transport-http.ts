/**
 * The HTTP transport: today's fetch-against-Flask client, moved verbatim from
 * the original `client.ts`. Owns the CSRF token — a server concern that the
 * local transport deliberately lacks.
 */

import {
  ApiError,
  type Api,
  type DownloadName,
  type DownloadOptions,
  type Filters,
  type Operation,
} from './types'

const DOWNLOAD_URLS: Record<DownloadName, (opts?: DownloadOptions) => string> = {
  bundle: () => '/api/export/bundle',
  ledger: () => '/api/export/ledger',
  buylist: (o) => `/api/export/buylist${o?.minPrice ? `?min_price=${o.minPrice}` : ''}`,
  'buylist-ck': (o) => `/api/export/buylist/ck${o?.minPrice ? `?min_price=${o.minPrice}` : ''}`,
  'sealed-template': () => '/api/sealed/template',
  table: (o) => `/api/export/table/${o?.table ?? ''}`,
}

let csrfToken = ''

function query(filters: Filters = {}, extra: Filters = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value === undefined || value === '' || value === false) continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && method !== 'HEAD') {
    // A custom header is the part that actually blocks cross-origin form
    // posts; the token is the second factor.
    headers.set('X-CSRF-Token', csrfToken)
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await response.json() : null

  if (!response.ok) {
    throw new ApiError(
      body?.error ?? `Request failed (${response.status})`,
      body?.code ?? 'error',
      response.status,
    )
  }
  return body as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const httpApi: Api = {
  async download(name, opts) {
    const response = await fetch(DOWNLOAD_URLS[name](opts), { credentials: 'same-origin' })
    if (!response.ok) {
      const body = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : null
      throw new ApiError(
        body?.error ?? `Download failed (${response.status})`,
        body?.code ?? 'error',
        response.status,
      )
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${name}.csv`
    return { filename, blob: await response.blob() }
  },

  async session() {
    const body = await request<{
      csrfToken: string
      database: string
      undoable: Operation | null
    }>('/api/session')
    csrfToken = body.csrfToken
    return body
  },

  collection: (filters, opts = {}) =>
    request(`/api/collection${query(filters, opts)}`),

  insights: (filters) => request(`/api/collection/insights${query(filters)}`),

  sealed: (filters, opts = {}) => request(`/api/sealed${query(filters, opts)}`),

  sealedInsights: (filters) => request(`/api/sealed/insights${query(filters)}`),

  bulkActions: (kind = 'holding') => request(`/api/bulk/actions?kind=${kind}`),

  bulkPreview: (selection) => post('/api/bulk/preview', selection),

  bulkApply: (selection, action, value) =>
    post('/api/bulk', { ...selection, action, value }),

  imports: () => request('/api/imports'),

  upload: (file) => {
    const form = new FormData()
    form.append('file', file)
    return request('/api/imports', { method: 'POST', body: form })
  },

  importDetail: (id) => request(`/api/imports/${id}`),

  resolveRow: (importId, rowId, body) =>
    post(`/api/imports/${importId}/rows/${rowId}`, body),

  commitImport: (id) => request(`/api/imports/${id}/commit`, { method: 'POST' }),

  discardImport: (id) => request(`/api/imports/${id}/discard`, { method: 'POST' }),

  salesQueue: () => request('/api/sales/queue'),

  sales: (status) => request(`/api/sales${status ? `?status=${status}` : ''}`),

  salesSummary: () => request('/api/sales/summary'),

  listForSale: (body) => post('/api/sales/list', body),

  recordSale: (saleId, body) => post(`/api/sales/${saleId}/sold`, body),

  cancelSale: (saleId) => request(`/api/sales/${saleId}/cancel`, { method: 'POST' }),

  exportManifest: () => request('/api/export/manifest'),

  buylistSummary: () => request('/api/export/buylist/summary'),

  history: () => request('/api/history'),

  undo: () => request('/api/undo', { method: 'POST' }),
}

/** Exposed for tests; the app sets this via `api.session()`. */
export function __setToken(token: string) {
  csrfToken = token
}
