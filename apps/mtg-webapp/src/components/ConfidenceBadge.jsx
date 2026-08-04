// Confidence of *mechanical synergy* relative to the card pool — the API's
// framing, kept honest in the title text (never a power-level claim).
export default function ConfidenceBadge({ confidence, band }) {
  return (
    <span
      className={`confidence confidence-${band}`}
      title={`Confidence of mechanical synergy: ${Math.round(confidence * 100)}%`}
    >
      {Math.round(confidence * 100)}%
    </span>
  );
}
