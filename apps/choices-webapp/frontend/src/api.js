// Thin fetch wrappers around the Lambda Function URL actions.
const API_URL = import.meta.env.VITE_API_URL;

async function call(action, payload) {
  if (!API_URL) throw new Error("VITE_API_URL is not configured");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const createPairing = (choices) => call("createPairing", { choices });
export const claimSeat = (code, seat) => call("claimSeat", { code, seat });
export const getState = (pairingId, role, token) =>
  call("getState", { pairingId, role, token });
export const eliminate = (pairingId, role, token, gameNumber, index) =>
  call("eliminate", { pairingId, role, token, gameNumber, index });
export const rematch = (pairingId, role, token, choices) =>
  call("rematch", { pairingId, role, token, choices });
export const subscribe = (pairingId, role, token, subscription) =>
  call("subscribe", { pairingId, role, token, subscription });
export const linkClick = (pairingId, role, token, gameNumber, platform) =>
  call("linkClick", { pairingId, role, token, gameNumber, platform });
