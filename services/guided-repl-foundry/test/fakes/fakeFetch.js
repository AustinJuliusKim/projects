/**
 * Fake fetch for keyless tests: routes URL prefixes to canned bodies and
 * records every request.
 */

/**
 * @param {Record<string, string|object|{status?: number, body: string|object}>} routes
 *   url-prefix → response body (string = text, object = json) or {status, body}
 * @returns {{fetchImpl: typeof fetch, requests: {url: string, headers: object}[]}}
 */
export function createFakeFetch(routes) {
  const requests = [];

  async function fetchImpl(url, opts = {}) {
    requests.push({ url, headers: opts.headers ?? {} });
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) {
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    }
    const route = routes[key];
    const { status = 200, body } =
      route && typeof route === "object" && "body" in route ? route : { body: route };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  }

  return { fetchImpl, requests };
}
