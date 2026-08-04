/**
 * The message envelope between the UI thread and the SQLite worker. Shared by
 * `api/transport-local.ts` (sender) and `local/worker.ts` (receiver) so the
 * two cannot drift.
 */

export interface RpcRequest {
  id: number
  route: string
  payload?: unknown
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code: string; status: number }

export interface PingResult {
  status: 'ok'
  vfs: 'opfs-sahpool' | 'memory'
  schemaVersion: number
}
