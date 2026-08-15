import type { Dish } from "../game/types.ts";
import { PixelSprite } from "../sprites/PixelSprite.tsx";

interface Props {
  dish: Dish;
  isNew: boolean;
  isMystery: boolean;
  onCookAgain: () => void;
}

const SPARKLE_SPOTS = [
  { top: "4%", left: "10%", animationDelay: "0s" },
  { top: "2%", right: "14%", animationDelay: "0.2s" },
  { top: "16%", left: "3%", animationDelay: "0.45s" },
  { top: "12%", right: "4%", animationDelay: "0.3s" },
  { top: "24%", left: "16%", animationDelay: "0.6s" },
] as const;

export function DishReveal({ dish, isNew, isMystery, onCookAgain }: Props) {
  return (
    <section className="reveal">
      <div className="reveal-card">
        {isNew && <span className="new-badge">New!</span>}
        {SPARKLE_SPOTS.map((spot, i) => (
          <span key={i} className="sparkle" style={spot} aria-hidden="true">
            <PixelSprite name="star" className="sparkle-sprite" />
          </span>
        ))}
        <div className={`praise-banner${isMystery ? " praise-mystery" : ""}`}>
          {isMystery ? "...Interesting!" : "Perfect!"}
        </div>
        <div className="plate-spot">
          <div className="sunburst" aria-hidden="true" />
          <PixelSprite name={dish.id} className="reveal-plate" />
        </div>
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
