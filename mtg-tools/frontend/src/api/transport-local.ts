/**
 * The local transport: the same `Api` surface, answered by the in-browser
 * SQLite worker over postMessage instead of Flask over fetch.
 *
 * There is no CSRF here on purpose — CSRF defends a server that trusts
 * cookies, and this backend has neither. The worker is same-origin code.
 *
 * Phase 0 status: the RPC plumbing and `ping` are real; every endpoint route
 * exists but the worker answers `not-implemented` until its phase ports it.
 */

import type { RpcRequest, RpcResponse, PingResult } from '../local/rpc'
import { ApiError, type Api } from './types'

let worker: Worker | null = null
let seq = 0
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason: ApiError) => void }
>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../local/worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<RpcResponse>) => {
    const response = event.data
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new ApiError(response.error, response.code, response.status))
  }
  return worker
}

export function rpc<T>(route: string, payload?: unknown): Promise<T> {
  const target = ensureWorker()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    const message: RpcRequest = { id, route, payload }
    target.postMessage(message)
  })
}

export const pingLocal = () => rpc<PingResult>('ping')

/**
 * Local-only: replace the OPFS database with an uploaded `.db` file — the
 * migration path from a server install's `~/.local/share/mtg-tools/collection.db`.
 * Not part of `Api`; the http backend has no equivalent and never will.
 */
export const importLocalDatabase = (file: File) =>
  rpc<{ imported: boolean; holdings: number; sealed: number }>('importDatabase', { file })

export const localApi: Api = {
  download: async (name, opts) => {
    const result = await rpc<{ filename: string; mime: string; bytes: Uint8Array }>('download', {
      name,
      table: opts?.table,
      minPrice: opts?.minPrice,
    })
    return {
      filename: result.filename,
      blob: new Blob([result.bytes as BlobPart], { type: result.mime }),
    }
  },
  session: () => rpc('session'),
  collection: (filters, opts = {}) => rpc('collection', { filters, opts }),
  insights: (filters) => rpc('insights', { filters }),
  sealed: (filters, opts = {}) => rpc('sealed', { filters, opts }),
  sealedInsights: (filters) => rpc('sealedInsights', { filters }),
  bulkActions: (kind = 'holding') => rpc('bulkActions', { kind }),
  bulkPreview: (selection) => rpc('bulkPreview', selection),
  bulkApply: (selection, action, value) => rpc('bulkApply', { ...selection, action, value }),
  imports: () => rpc('imports'),
  upload: (file) => rpc('upload', { file }),
  importDetail: (id) => rpc('importDetail', { id }),
  resolveRow: (importId, rowId, body) => rpc('resolveRow', { importId, rowId, body }),
  commitImport: (id) => rpc('commitImport', { id }),
  discardImport: (id) => rpc('discardImport', { id }),
  salesQueue: () => rpc('salesQueue'),
  sales: (status) => rpc('sales', { status }),
  salesSummary: () => rpc('salesSummary'),
  listForSale: (body) => rpc('listForSale', body),
  recordSale: (saleId, body) => rpc('recordSale', { saleId, ...body }),
  cancelSale: (saleId) => rpc('cancelSale', { saleId }),
  exportManifest: () => rpc('exportManifest'),
  buylistSummary: () => rpc('buylistSummary'),
  history: () => rpc('history'),
  undo: () => rpc('undo'),
}
