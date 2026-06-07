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

export const createGame = (choices) => call("createGame", { choices });
export const getGame = (game_id) => call("getGame", { game_id });
export const eliminate = (game_id, role, token, index) =>
  call("eliminate", { game_id, role, token, index });
export const subscribe = (game_id, role, token, subscription) =>
  call("subscribe", { game_id, role, token, subscription });
