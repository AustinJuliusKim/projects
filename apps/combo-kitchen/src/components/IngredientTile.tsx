import type { Ingredient } from "../game/types.ts";

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
      <span className="tile-emoji" aria-hidden="true">
        {ingredient.emoji}
      </span>
      <span className="tile-name">{ingredient.name}</span>
    </button>
  );
}
