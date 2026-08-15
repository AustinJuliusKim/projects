import type { IngredientId } from "../game/types.ts";
import { INGREDIENTS } from "../game/ingredients.ts";
import { IngredientTile } from "./IngredientTile.tsx";
import { PixelSprite } from "../sprites/PixelSprite.tsx";

interface Props {
  selected: IngredientId[];
  onToggle: (id: IngredientId) => void;
  onCook: () => void;
}

export function Pantry({ selected, onToggle, onCook }: Props) {
  const full = selected.length === 3;
  return (
    <section className="pantry">
      <p className="pantry-hint">Pick 3 ingredients</p>
      <div className="pantry-grid">
        {INGREDIENTS.map((ingredient) => (
          <IngredientTile
            key={ingredient.id}
            ingredient={ingredient}
            selected={selected.includes(ingredient.id)}
            disabled={full}
            onToggle={onToggle}
          />
        ))}
      </div>
      <div className="counter" aria-live="polite">
        {[0, 1, 2].map((slot) => {
          const id = selected[slot];
          return (
            <span key={slot} className={`counter-slot${id ? " filled" : ""}`}>
              {id ? <PixelSprite name={id} className="slot-sprite" center /> : "·"}
            </span>
          );
        })}
      </div>
      <button type="button" className="btn btn-cook" disabled={!full} onClick={onCook}>
        Cook!
      </button>
    </section>
  );
}
