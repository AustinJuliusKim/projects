// Per-session token + cost accounting with a hard cap. The cap matters even
// under BYOK: a runaway agent loop would otherwise silently burn the user's
// money and our sandbox minutes.

export function createUsage(tokenCap) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    runs: 0,
    tokenCap: tokenCap > 0 ? tokenCap : Infinity,
  };
}

// Fold a USAGE message (from the stream-json `result` event) into the running
// totals. One result == one completed run.
export function addUsage(usage, msg) {
  usage.inputTokens += msg.inputTokens ?? 0;
  usage.outputTokens += msg.outputTokens ?? 0;
  usage.cacheReadTokens += msg.cacheReadTokens ?? 0;
  usage.costUsd += msg.costUsd ?? 0;
  usage.runs += 1;
  return usage;
}

export function totalTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
}

export function capExceeded(usage) {
  return totalTokens(usage) >= usage.tokenCap;
}

// Shape sent to the browser for the TokenUsage meter.
export function usagePayload(usage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: usage.costUsd,
    runs: usage.runs,
    tokenCap: usage.tokenCap === Infinity ? null : usage.tokenCap,
  };
}
