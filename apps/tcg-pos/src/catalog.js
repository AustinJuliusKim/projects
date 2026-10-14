// The card catalog (services/mtg-api), called directly from the browser —
// its CORS is open and it needs no tenant. VITE_MTG_API_BASE overrides the
// local default.
import { request } from "./api.js";

const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
export const MTG_API_BASE = (env.VITE_MTG_API_BASE || "http://localhost:8000").replace(/\/$/, "");

export const searchCards = (q, { signal } = {}) =>
  request("GET", "/v1/cards/search", {
    params: { q, page_size: 20 },
    signal,
    base: MTG_API_BASE,
  });

export const getPrintings = (oracleId, { signal } = {}) =>
  request("GET", `/v1/cards/${encodeURIComponent(oracleId)}/printings`, {
    signal,
    base: MTG_API_BASE,
  });
