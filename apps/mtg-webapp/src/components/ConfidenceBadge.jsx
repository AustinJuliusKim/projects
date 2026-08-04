import { Badge } from "@mantine/core";

// Confidence of *mechanical synergy* relative to the card pool — the API's
// framing, kept honest in the title text (never a power-level claim).
const BAND_COLOR = { high: "teal", medium: "indigo", low: "gray" };

export default function ConfidenceBadge({ confidence, band }) {
  return (
    <Badge
      color={BAND_COLOR[band] || "gray"}
      variant="light"
      size="sm"
      title={`Confidence of mechanical synergy: ${Math.round(confidence * 100)}%`}
    >
      {Math.round(confidence * 100)}%
    </Badge>
  );
}
