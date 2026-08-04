import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { searchCards } from "../api.js";
import { addCard, loadDeck, saveDeck } from "../deck.js";
import CardGrid from "../components/CardGrid.jsx";

const COLORS = ["W", "U", "B", "R", "G"];
const FORMATS = ["", "commander", "modern", "standard", "pioneer", "legacy", "pauper", "vintage"];

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const identity = params.get("identity") || "";
  const format = params.get("format") || "";
  const order = params.get("order") || "name";
  const page = Number(params.get("page") || 1);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!q && !identity && !format) {
      setResult(null);
      return;
    }
    let alive = true;
    searchCards({ q: q || null, identity: identity || null, format: format || null, order, page })
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [q, identity, format, order, page]);

  function patch(next) {
    const merged = { q, identity, format, order, ...next, page: next.page ?? 1 };
    setParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== "" && v !== null)),
    );
  }

  function toggleColor(c) {
    patch({
      identity: identity.includes(c)
        ? identity.replace(c, "")
        : COLORS.filter((x) => identity.includes(x) || x === c).join(""),
    });
  }

  function onAdd(card) {
    saveDeck(addCard(loadDeck(), card));
  }

  const pages = result ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1;

  return (
    <div>
      <div className="filters">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`chip chip-${c} ${identity.includes(c) ? "chip-on" : ""}`}
            onClick={() => toggleColor(c)}
          >
            {c}
          </button>
        ))}
        <select value={format} onChange={(e) => patch({ format: e.target.value })}>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {f || "any format"}
            </option>
          ))}
        </select>
        <select value={order} onChange={(e) => patch({ order: e.target.value })}>
          <option value="name">by name</option>
          <option value="mv">by mana value</option>
          <option value="edhrec">by popularity</option>
        </select>
      </div>
      {error && <p className="muted">Search failed: {error}</p>}
      {!result && !error && (
        <p className="muted">
          Search by rules text (“deals damage to each”), name, or type — then filter by color
          identity and format.
        </p>
      )}
      {result && (
        <>
          <p className="muted">{result.total} cards</p>
          <CardGrid cards={result.cards} onAdd={onAdd} />
          {pages > 1 && (
            <div className="pager">
              <button disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>
                ‹ prev
              </button>
              <span>
                {page} / {pages}
              </span>
              <button disabled={page >= pages} onClick={() => patch({ page: page + 1 })}>
                next ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
