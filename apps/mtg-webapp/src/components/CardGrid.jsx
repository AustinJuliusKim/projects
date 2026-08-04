import { Link } from "react-router-dom";

export default function CardGrid({ cards, onAdd }) {
  if (!cards.length) return <p className="muted">No cards.</p>;
  return (
    <div className="card-grid">
      {cards.map((card) => (
        <div key={card.oracle_id} className="card-tile">
          <Link to={`/card/${card.oracle_id}`}>
            {card.image_normal || card.image_small ? (
              <img src={card.image_normal || card.image_small} alt={card.name} loading="lazy" />
            ) : (
              <div className="card-placeholder">
                <strong>{card.name}</strong>
                <span>{card.type_line}</span>
              </div>
            )}
          </Link>
          <div className="card-tile-row">
            <Link to={`/card/${card.oracle_id}`}>{card.name}</Link>
            {onAdd && (
              <button onClick={() => onAdd(card)} title="Add to deck">
                +
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
