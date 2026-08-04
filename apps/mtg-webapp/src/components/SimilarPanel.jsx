import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getSimilar } from "../api.js";
import { logAction, logImpressions } from "../feedback.js";
import ConfidenceBadge from "./ConfidenceBadge.jsx";

// The differentiator: mechanically synergistic suggestions with confidence
// and reasons. Impressions/clicks are logged from day one — training data
// for the eventual reranker.
export default function SimilarPanel({ oracleId, identity, context = "card_page", onAdd }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setResults(null);
    setError(null);
    getSimilar(oracleId, { limit: 12, identity: identity || null })
      .then((r) => {
        if (!alive) return;
        setResults(r);
        logImpressions(oracleId, r, context);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [oracleId, identity, context]);

  if (error) return <p className="muted">Similar cards unavailable: {error}</p>;
  if (results === null) return <p className="muted">Finding similar cards…</p>;
  if (!results.length) return <p className="muted">No similar cards found.</p>;

  return (
    <ul className="similar-list">
      {results.map((s) => (
        <li key={s.oracle_id}>
          <div className="similar-head">
            <Link
              to={`/card/${s.oracle_id}`}
              onClick={() => logAction("click", oracleId, s, context)}
            >
              {s.name}
            </Link>
            <ConfidenceBadge confidence={s.confidence} band={s.band} />
            {onAdd && (
              <button
                onClick={() => {
                  logAction("deck_add", oracleId, s, context);
                  onAdd(s);
                }}
                title="Add to deck"
              >
                +
              </button>
            )}
          </div>
          {s.reasons.length > 0 && <div className="reasons">{s.reasons.join(" · ")}</div>}
        </li>
      ))}
    </ul>
  );
}
