// Suggestion-feedback logging — the future recommendation model's training
// data (docs/PLAN.md: no model before ~10k events). Fire-and-forget:
// impressions batch up and flush on pagehide via sendBeacon; clicks and
// deck-adds flush immediately.

import { API_BASE } from "./api.js";

const ENDPOINT = () => `${API_BASE}/v1/feedback/suggestions`;
const MAX_BATCH = 50;

let queue = [];
let hooked = false;

export function makeEvent(event, seedOracleId, suggestion, context) {
  return {
    event,
    seed_oracle_id: seedOracleId,
    suggested_oracle_id: suggestion.oracle_id,
    confidence: suggestion.confidence ?? null,
    context: context || null,
  };
}

function send(events) {
  if (events.length === 0) return;
  const body = JSON.stringify(events.slice(0, MAX_BATCH));
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT(), new Blob([body], { type: "application/json" }));
  } else if (typeof fetch !== "undefined") {
    fetch(ENDPOINT(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }
}

export function flush() {
  const batch = queue;
  queue = [];
  send(batch);
}

export function logImpressions(seedOracleId, suggestions, context) {
  for (const s of suggestions) queue.push(makeEvent("impression", seedOracleId, s, context));
  if (queue.length >= MAX_BATCH) flush();
  if (!hooked && typeof window !== "undefined") {
    hooked = true;
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
}

export function logAction(event, seedOracleId, suggestion, context) {
  send([makeEvent(event, seedOracleId, suggestion, context)]);
}

// test seam
export function _pendingCount() {
  return queue.length;
}
