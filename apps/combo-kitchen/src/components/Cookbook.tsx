import { useState } from "react";
import type { Dish } from "../game/types.ts";
import { DISHES } from "../game/combos.ts";

interface Props {
  discovered: Dish[];
  onClose: () => void;
}

export function Cookbook({ discovered, onClose }: Props) {
  const [open, setOpen] = useState<Dish | null>(null);
  const found = new Set(discovered.map((d) => d.id));

  return (
    <section className="cookbook" role="dialog" aria-label="Cookbook">
      <div className="cookbook-panel">
        <header className="cookbook-header">
          <h2>Cookbook</h2>
          <span className="cookbook-count">
            {discovered.length} / {DISHES.length}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
        </header>
        {open ? (
          <div className="cookbook-detail">
            <button type="button" className="btn" onClick={() => setOpen(null)}>
              ← All dishes
            </button>
            <span className="reveal-plate" aria-hidden="true">
              {open.plateEmoji}
            </span>
            <h3 className="reveal-name">{open.name}</h3>
            <p className="reveal-flavor">{open.flavorText}</p>
            <div className="recipe">
              <h4>You'll need</h4>
              <ul>
                {open.recipe.ingredients.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <h4>Steps</h4>
              <ol>
                {open.recipe.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          </div>
        ) : (
          <div className="cookbook-grid">
            {DISHES.map((dish) =>
              found.has(dish.id) ? (
                <button
                  key={dish.id}
                  type="button"
                  className="cookbook-slot found"
                  onClick={() => setOpen(dish)}
                >
                  <span aria-hidden="true">{dish.plateEmoji}</span>
                  <span className="cookbook-slot-name">{dish.name}</span>
                </button>
              ) : (
                <div key={dish.id} className="cookbook-slot">
                  <span aria-hidden="true">❓</span>
                  <span className="cookbook-slot-name">???</span>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}
