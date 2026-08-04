import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { getSimilar } from "../api.js";
import { logAction } from "../feedback.js";
import ConfidenceBadge from "../components/ConfidenceBadge.jsx";
import {
  addCard,
  cardCount,
  deckIdentity,
  groupByType,
  loadDeck,
  removeCard,
  saveDeck,
} from "../deck.js";

// Deck-level suggestions: union of /similar over the deck's cards, filtered
// to the deck's color identity, aggregated by best confidence.
async function deckSuggestions(deck) {
  const identity = deckIdentity(deck);
  const cards = Object.values(deck.cards).slice(0, 15);
  const inDeck = new Set(Object.keys(deck.cards));
  const best = new Map();
  const settled = await Promise.allSettled(
    cards.map((c) =>
      getSimilar(c.oracle_id, { limit: 10, identity: identity || null }).then((results) => ({
        seed: c.oracle_id,
        results,
      })),
    ),
  );
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const s of outcome.value.results) {
      if (inDeck.has(s.oracle_id)) continue;
      const prev = best.get(s.oracle_id);
      if (!prev || s.confidence > prev.confidence) {
        best.set(s.oracle_id, { ...s, seed: outcome.value.seed });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}

export default function DeckPage() {
  const [deck, setDeck] = useState(loadDeck);
  const [suggestions, setSuggestions] = useState(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupByType(deck), [deck]);
  const identity = deckIdentity(deck);

  function update(next) {
    setDeck(next);
    saveDeck(next);
  }

  async function suggest() {
    setBusy(true);
    try {
      setSuggestions(await deckSuggestions(deck));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="deck-page">
      <div>
        <h1>
          {deck.name} <span className="muted">({cardCount(deck)} cards{identity ? `, ${identity}` : ""})</span>
        </h1>
        {cardCount(deck) === 0 && (
          <p className="muted">
            Empty deck — add cards from <Link to="/">search</Link> or any card page.
          </p>
        )}
        {groups.map(({ type, cards }) => (
          <section key={type}>
            <h2>{type}</h2>
            <ul className="deck-list">
              {cards.map((c) => (
                <li key={c.oracle_id}>
                  <span className="qty">{c.qty}×</span>
                  <Link to={`/card/${c.oracle_id}`}>{c.name}</Link>
                  <span className="deck-actions">
                    <button onClick={() => update(addCard(deck, c))}>+</button>
                    <button onClick={() => update(removeCard(deck, c.oracle_id))}>−</button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <aside>
        <h2>Suggestions</h2>
        <button onClick={suggest} disabled={busy || cardCount(deck) === 0}>
          {busy ? "Thinking…" : "Suggest cards for this deck"}
        </button>
        {suggestions !== null && suggestions.length === 0 && (
          <p className="muted">No suggestions (are embeddings loaded yet?).</p>
        )}
        {suggestions?.length > 0 && (
          <ul className="similar-list">
            {suggestions.map((s) => (
              <li key={s.oracle_id}>
                <div className="similar-head">
                  <Link
                    to={`/card/${s.oracle_id}`}
                    onClick={() => logAction("click", s.seed, s, "deck_builder")}
                  >
                    {s.name}
                  </Link>
                  <ConfidenceBadge confidence={s.confidence} band={s.band} />
                  <button
                    onClick={() => {
                      logAction("deck_add", s.seed, s, "deck_builder");
                      update(addCard(deck, s));
                    }}
                    title="Add to deck"
                  >
                    +
                  </button>
                </div>
                {s.reasons.length > 0 && <div className="reasons">{s.reasons.join(" · ")}</div>}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
