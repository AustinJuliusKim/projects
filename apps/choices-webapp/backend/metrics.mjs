// CloudWatch Embedded Metric Format (EMF): a specially-structured log line that
// CloudWatch Logs auto-extracts into metrics — no SDK call, no dependency, ~zero
// added latency, so it fits the zero-dep house style. Namespace: ChoicesApp.
// Keep dimension cardinality low (constitution Rule 13 — cost): each unique
// metric+dimension combination is a separate paid custom metric.
const NAMESPACE = "ChoicesApp";

// Emit one metric as an EMF log line. `dims` is a small flat object of
// low-cardinality string dimensions (e.g. { action }). Empty dims publishes the
// metric with no dimensions (namespace-level aggregate).
export function emit(name, value, { unit = "Count", dims = {} } = {}) {
  const dimNames = Object.keys(dims);
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [dimNames],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...dims,
    [name]: value,
  };
  console.log(JSON.stringify(line));
}

// A single occurrence of an event (Count = 1).
export function emitCount(name, dims = {}) {
  emit(name, 1, { unit: "Count", dims });
}

// --- Canary exclusion (Growth Plan §10 observability) ---
// The Synthetics canary plays a real golden-path game daily; its synthetic
// games must never pollute business metrics, the event lake, or the
// suggestion feed. The handler flags canary requests
// (x-canary-secret header vs CANARY_SECRET env) at entry; business counters
// and analytics writes are suppressed for them, while Latency/ApiError still
// reflect canary traffic (that's what it's for).
let canaryRequest = false;

export function setCanaryRequest(v) {
  canaryRequest = Boolean(v);
}

export function isCanaryRequest() {
  return canaryRequest;
}

// Business-funnel counter: no-ops on canary traffic.
export function emitBusinessCount(name, dims = {}) {
  if (!canaryRequest) emitCount(name, dims);
}

// Per-action handler latency in milliseconds, dimensioned by action so
// CloudWatch can compute p50/p95/p99 (Growth Plan §10 row 4).
export function emitLatency(action, ms) {
  emit("Latency", ms, { unit: "Milliseconds", dims: { action } });
}
