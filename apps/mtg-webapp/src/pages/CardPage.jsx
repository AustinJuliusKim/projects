import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { getCard, getPrintings, getRulings } from "../api.js";
import { addCard, loadDeck, saveDeck } from "../deck.js";
import SimilarPanel from "../components/SimilarPanel.jsx";

export default function CardPage() {
  const { oracleId } = useParams();
  const [card, setCard] = useState(null);
  const [printings, setPrintings] = useState([]);
  const [rulings, setRulings] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setCard(null);
    setError(null);
    getCard(oracleId)
      .then((c) => alive && setCard(c))
      .catch((e) => alive && setError(e.message));
    getPrintings(oracleId).then((p) => alive && setPrintings(p)).catch(() => {});
    getRulings(oracleId).then((r) => alive && setRulings(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [oracleId]);

  if (error) return <p className="muted">{error}</p>;
  if (!card) return <p className="muted">Loading…</p>;

  function onAdd(c) {
    saveDeck(addCard(loadDeck(), { ...card, ...c }));
  }

  return (
    <div className="card-page">
      <div className="card-page-left">
        {card.image_normal && <img src={card.image_normal} alt={card.name} />}
        <button onClick={() => saveDeck(addCard(loadDeck(), card))}>Add to deck</button>
      </div>
      <div className="card-page-right">
        <h1>
          {card.name} <span className="mana">{card.mana_cost}</span>
        </h1>
        <p className="type-line">{card.type_line}</p>
        <p className="oracle-text">{card.oracle_text}</p>
        {(card.power || card.loyalty || card.defense) && (
          <p className="stats">
            {card.power != null ? `${card.power}/${card.toughness}` : null}
            {card.loyalty != null ? `Loyalty ${card.loyalty}` : null}
            {card.defense != null ? `Defense ${card.defense}` : null}
          </p>
        )}

        {/* The differentiator lives above the fold */}
        <section>
          <h2>Similar cards</h2>
          <SimilarPanel oracleId={oracleId} onAdd={onAdd} />
        </section>

        {printings.length > 0 && (
          <section>
            <h2>Printings</h2>
            <table className="printings">
              <thead>
                <tr>
                  <th>Set</th>
                  <th>#</th>
                  <th>Rarity</th>
                  <th>USD</th>
                  <th>EUR</th>
                </tr>
              </thead>
              <tbody>
                {printings.map((p) => (
                  <tr key={p.id}>
                    <td>{p.set_name || p.set_code}</td>
                    <td>{p.collector_number}</td>
                    <td>{p.rarity}</td>
                    <td>{p.price_usd != null ? `$${p.price_usd}` : "—"}</td>
                    <td>{p.price_eur != null ? `€${p.price_eur}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {rulings.length > 0 && (
          <section>
            <h2>Rulings</h2>
            <ul className="rulings">
              {rulings.map((r, i) => (
                <li key={i}>
                  {r.published_at && <span className="muted">{r.published_at} — </span>}
                  {r.comment}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
