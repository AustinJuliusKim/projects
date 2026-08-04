/**
 * The client facade. Components import from here and never know which backend
 * answers: Flask over HTTP (today's default) or the in-browser SQLite worker.
 *
 * `VITE_BACKEND=local` at build time selects the worker. The same frontend
 * running against both backends is the coexistence mechanism for the SPA port
 * — and the parity harness that gates retiring the server.
 */

import { importLocalDatabase, localApi, pingLocal, rpc } from './transport-local'
import { httpApi } from './transport-http'
import type { Api } from './types'

export * from './types'
export { __setToken } from './transport-http'

const useLocal = import.meta.env.VITE_BACKEND === 'local'

export const api: Api = useLocal ? localApi : httpApi

if (useLocal && typeof window !== 'undefined') {
  // Debug/boot hooks: let a smoke script (and a curious devtools user) await
  // the worker's first answer, see which VFS mounted, and drive endpoints
  // directly — scripts/check-local-boot.mjs asserts through these.
  const w = window as unknown as {
    __localBoot: Promise<unknown>
    __localApi: Api
    __localImportDb: typeof importLocalDatabase
    __localRpc: typeof rpc
  }
  w.__localBoot = pingLocal()
  w.__localApi = localApi
  w.__localImportDb = importLocalDatabase
  w.__localRpc = rpc // parity scripts reach debug-only routes through this
}
