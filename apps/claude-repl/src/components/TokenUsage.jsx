import React from "react";

// Live token + cost meter. Shows progress toward the per-session cap.
export default function TokenUsage({ usage }) {
  if (!usage) return <div className="token-usage muted">No usage yet</div>;
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
  const pct = usage.tokenCap ? Math.min(100, (total / usage.tokenCap) * 100) : 0;
  return (
    <div className="token-usage">
      <span className="usage-stat">{total.toLocaleString()} tok</span>
      <span className="usage-stat">${usage.costUsd.toFixed(4)}</span>
      <span className="usage-stat muted">{usage.runs} runs</span>
      {usage.tokenCap && (
        <span className="usage-bar" title={`${total} / ${usage.tokenCap}`}>
          <span className="usage-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}
