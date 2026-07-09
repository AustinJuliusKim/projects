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

// Per-action handler latency in milliseconds, dimensioned by action so
// CloudWatch can compute p50/p95/p99 (Growth Plan §10 row 4).
export function emitLatency(action, ms) {
  emit("Latency", ms, { unit: "Milliseconds", dims: { action } });
}
