import { useEffect, useState } from "react";
import type { IngredientId } from "../game/types.ts";
import { ingredientById } from "../game/ingredients.ts";

export const COOK_DURATION_MS = 2500;
const POOF_MS = 400;
const REDUCED_DURATION_MS = 600;

interface Props {
  selected: IngredientId[];
  onDone: () => void;
}

// Fixed spots around the cloud edge where things poke out mid-rumble.
const POKE_SPOTS = [
  { top: "-14%", left: "8%", delay: "0s" },
  { top: "18%", right: "-10%", delay: "0.35s" },
  { bottom: "-6%", left: "-8%", delay: "0.7s" },
  { top: "-10%", right: "18%", delay: "0.5s" },
  { bottom: "4%", right: "4%", delay: "0.15s" },
  { top: "30%", left: "-12%", delay: "0.85s" },
] as const;

export function CookingScene({ selected, onDone }: Props) {
  const [poofing, setPoofing] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const total = reduced ? REDUCED_DURATION_MS : COOK_DURATION_MS;
    const poofTimer = window.setTimeout(() => setPoofing(true), Math.max(total - POOF_MS, 0));
    const doneTimer = window.setTimeout(onDone, total);
    return () => {
      window.clearTimeout(poofTimer);
      window.clearTimeout(doneTimer);
    };
  }, [onDone]);

  const pokers = [
    ...selected.map((id) => ingredientById(id)?.emoji ?? "❓"),
    "🥄",
    "✦",
    "✦",
  ];

  return (
    <section className="cooking" aria-label="Cooking in progress">
      <div className="cooking-stage">
        <div className={`rumble-cloud${poofing ? " poofing" : ""}`}>
          <span className="cloud-blob blob-1" aria-hidden="true">☁️</span>
          <span className="cloud-blob blob-2" aria-hidden="true">☁️</span>
          <span className="cloud-blob blob-3" aria-hidden="true">☁️</span>
          <span className="cloud-blob blob-4" aria-hidden="true">☁️</span>
          <span className="cloud-blob blob-5" aria-hidden="true">☁️</span>
          <span className="cloud-bang bang-1" aria-hidden="true">💥</span>
          <span className="cloud-bang bang-2" aria-hidden="true">💥</span>
          {pokers.map((emoji, i) => {
            const { delay, ...position } = POKE_SPOTS[i % POKE_SPOTS.length];
            return (
              <span
                key={i}
                className={`poker${emoji === "✦" ? " poker-star" : ""}`}
                style={{ ...position, animationDelay: delay }}
                aria-hidden="true"
              >
                {emoji}
              </span>
            );
          })}
        </div>
        {poofing && (
          <>
            <span className="steam steam-1" aria-hidden="true">💨</span>
            <span className="steam steam-2" aria-hidden="true">💨</span>
          </>
        )}
        <span className="pot" aria-hidden="true">🍲</span>
        <div className="stove" aria-hidden="true">
          <div className="burner" />
        </div>
        <span className="puff puff-1" aria-hidden="true">💨</span>
        <span className="puff puff-2" aria-hidden="true">💨</span>
      </div>
      <p className="cooking-caption">Cooking…</p>
    </section>
  );
}
