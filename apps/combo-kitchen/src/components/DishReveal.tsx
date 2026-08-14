import type { Dish } from "../game/types.ts";

interface Props {
  dish: Dish;
  isNew: boolean;
  onCookAgain: () => void;
}

export function DishReveal({ dish, isNew, onCookAgain }: Props) {
  return (
    <section className="reveal">
      <div className="reveal-card">
        {isNew && <span className="new-badge">New!</span>}
        <span className="reveal-plate" aria-hidden="true">
          {dish.plateEmoji}
        </span>
        <h2 className="reveal-name">{dish.name}</h2>
        <p className="reveal-flavor">{dish.flavorText}</p>
        <div className="recipe">
          <h3>Quick recipe</h3>
          <h4>You'll need</h4>
          <ul>
            {dish.recipe.ingredients.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h4>Steps</h4>
          <ol>
            {dish.recipe.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        <button type="button" className="btn btn-cook" onClick={onCookAgain}>
          Cook again
        </button>
      </div>
    </section>
  );
}
