/**
 * A failure with a status code and a message meant for a person — the worker
 * side of `webapp.api.ApiError`. The RPC layer serializes it back to the UI
 * as the same `{error, code, status}` shape Flask sends, so components can't
 * tell which backend refused them.
 */
export class ApiFailure extends Error {
  code: string
  status: number

  constructor(message: string, code = 'error', status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}
