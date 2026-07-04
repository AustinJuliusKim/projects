// Thin fetch wrappers around the game API (Function URL or CloudFront /api).
const API_URL = import.meta.env.VITE_API_URL;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toError(status, data) {
  const err = new Error(data.error || `Request failed (${status})`);
  err.code = data.code;
  err.status = status;
  return err;
}

async function post(action, payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(res.status, data);
  return data;
}

// Mutations carry an actionId and are idempotent server-side (duplicate
// requests replay the stored result), so retrying on network errors / 429 /
// 5xx can never double-apply a move. Other 4xx (409 turn conflicts etc.) are
// real answers — never retried.
async function mutate(action, payload) {
  if (!API_URL) throw new Error("VITE_API_URL is not configured");
  const actionId = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      return await post(action, { ...payload, actionId });
    } catch (err) {
      const retryable = err.status == null || RETRYABLE.has(err.status);
      if (!retryable || attempt >= 2) throw err;
      await sleep(Math.random() * 400 * 2 ** attempt); // full jitter
    }
  }
}

export const createPairing = (choices) => post("createPairing", { choices });
export const claimSeat = (code, seat) => post("claimSeat", { code, seat });
// GET so CloudFront can edge-cache game state (POSTs are never cached). No
// retry loop: the poll itself is the retry.
export async function getState(pairingId, role, token) {
  if (!API_URL) throw new Error("VITE_API_URL is not configured");
  const qs = new URLSearchParams({ action: "getState", pairingId, role, token });
  const res = await fetch(`${API_URL}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(res.status, data);
  return data;
}
export const eliminate = (pairingId, role, token, gameNumber, index) =>
  mutate("eliminate", { pairingId, role, token, gameNumber, index });
export const rematch = (pairingId, role, token, choices) =>
  mutate("rematch", { pairingId, role, token, choices });
export const subscribe = (pairingId, role, token, subscription) =>
  post("subscribe", { pairingId, role, token, subscription });
export const linkClick = (pairingId, role, token, gameNumber, platform) =>
  mutate("linkClick", { pairingId, role, token, gameNumber, platform });
