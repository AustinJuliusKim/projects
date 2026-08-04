/**
 * The "local server": a dedicated worker that owns the SQLite database.
 *
 * VFS is `opfs-sahpool` — sync access handles inside this worker, no
 * COOP/COEP headers, works on any static host, and its one-open-handle rule
 * matches the app's single-writer design (Flask had one writer too; here the
 * worker is the writer). If OPFS is unavailable (old browser, some private
 * modes, non-worker test contexts), we fall back to an in-memory database and
 * say so in `ping` — the UI can then warn that nothing persists.
 *
 * Route handlers live in `endpoints.ts` (the api.py port); this file is only
 * boot, storage ownership, and RPC dispatch. Routes not yet ported answer
 * 501 — the phases 3–5 checklist.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import schemaSql from '../../../webapp/schema.sql?raw'
import { initSchema, wrapDb, type Database } from './db'
import { ApiFailure } from './errors'
import { makeRoutes } from './endpoints'
import type { RpcRequest, RpcResponse } from './rpc'

interface RawDb {
  exec(arg: unknown): unknown
  selectValue(sql: string, bind?: unknown[]): unknown
  selectObject(sql: string, bind?: unknown[]): Record<string, unknown> | undefined
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[]
  close(): void
}

interface SAHPoolUtil {
  OpfsSAHPoolDb: new (name: string) => RawDb
  importDb(name: string, bytes: Uint8Array): number
}

let db: (Database & { close(): void }) | null = null
let rawDb: RawDb | null = null
let sqlite3Api: { capi: { sqlite3_js_db_export(db: unknown): Uint8Array } } | null = null
let poolUtil: SAHPoolUtil | null = null
let vfs: 'opfs-sahpool' | 'memory' = 'memory'

async function boot(): Promise<void> {
  const sqlite3 = await sqlite3InitModule()
  sqlite3Api = sqlite3 as never
  try {
    poolUtil = (await sqlite3.installOpfsSAHPoolVfs({})) as unknown as SAHPoolUtil
    rawDb = new poolUtil.OpfsSAHPoolDb('/collection.db')
    vfs = 'opfs-sahpool'
  } catch {
    rawDb = new sqlite3.oo1.DB(':memory:') as never
    vfs = 'memory'
  }
  db = wrapDb(rawDb!)
  initSchema(db!, schemaSql)
}

const ready = boot()

async function importDatabase(bytes: Uint8Array): Promise<{ holdings: number; sealed: number }> {
  if (!poolUtil) {
    throw new ApiFailure(
      'Importing a database needs OPFS storage, which this browser context lacks.',
      'no-opfs',
      400,
    )
  }
  db!.close()
  try {
    poolUtil.importDb('/collection.db', bytes)
  } finally {
    rawDb = new poolUtil.OpfsSAHPoolDb('/collection.db')
    db = wrapDb(rawDb)
  }
  // The imported file may predate the late columns; init_db semantics apply.
  initSchema(db, schemaSql)
  return {
    holdings: Number(db.selectValue('SELECT COUNT(*) FROM holdings')),
    sealed: Number(db.selectValue('SELECT COUNT(*) FROM sealed')),
  }
}

const routes: Record<string, ((payload: never) => unknown) | undefined> = makeRoutes({
  db: () => db!,
  vfs: () => vfs,
  schemaVersion: () => Number(db!.selectValue('SELECT version FROM schema_version')),
  importDatabase,
  // The real database image, via the same serialization sqlite3 itself uses —
  // the bundle's collection.sqlite opens in any stock sqlite3.
  exportDb: () => {
    try {
      return sqlite3Api!.capi.sqlite3_js_db_export(rawDb)
    } catch {
      return null
    }
  },
})

self.onmessage = async (event: MessageEvent<RpcRequest>) => {
  const { id, route, payload } = event.data
  let response: RpcResponse
  try {
    await ready
    const handler = routes[route]
    if (!handler) {
      response = {
        id,
        ok: false,
        error: `'${route}' is not ported to the local backend yet.`,
        code: 'not-implemented',
        status: 501,
      }
    } else {
      response = { id, ok: true, result: await handler(payload as never) }
    }
  } catch (error) {
    response = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof ApiFailure ? error.code : 'error',
      status: error instanceof ApiFailure ? error.status : 500,
    }
  }
  self.postMessage(response)
}
