import type { Ingredient } from "../game/types.ts";
import { PixelSprite } from "../sprites/PixelSprite.tsx";

interface Props {
  ingredient: Ingredient;
  selected: boolean;
  disabled: boolean;
  onToggle: (id: Ingredient["id"]) => void;
}

export function IngredientTile({ ingredient, selected, disabled, onToggle }: Props) {
  return (
    <button
      type="button"
      className="tile"
      aria-pressed={selected}
      disabled={disabled && !selected}
      onClick={() => onToggle(ingredient.id)}
    >
      <PixelSprite name={ingredient.id} className="tile-sprite" center />
      <span className="tile-name">{ingredient.name}</span>
    </button>
  );
}
