import { useEffect, useState } from "react";
import type { IngredientId } from "../game/types.ts";
import { PixelSprite } from "../sprites/PixelSprite.tsx";

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

  const pokers = [...selected, "spoon", "star", "star"];

  return (
    <section className="cooking" aria-label="Cooking in progress">
      <div className="cooking-stage">
        <div className={`rumble-cloud${poofing ? " poofing" : ""}`}>
          <PixelSprite name="cloud" className="cloud-blob blob-1" />
          <PixelSprite name="cloud" className="cloud-blob blob-2" />
          <PixelSprite name="cloud" className="cloud-blob blob-3" />
          <PixelSprite name="cloud" className="cloud-blob blob-4" />
          <PixelSprite name="cloud" className="cloud-blob blob-5" />
          <PixelSprite name="bang" className="cloud-bang bang-1" />
          <PixelSprite name="bang" className="cloud-bang bang-2" />
          {pokers.map((name, i) => {
            const { delay, ...position } = POKE_SPOTS[i % POKE_SPOTS.length];
            return (
              <span key={i} className="poker" style={{ ...position, animationDelay: delay }}>
                <PixelSprite name={name} className={name === "star" ? "poker-sprite poker-star" : "poker-sprite"} />
              </span>
            );
          })}
        </div>
        {poofing && (
          <>
            <PixelSprite name="puff" className="steam steam-1" />
            <PixelSprite name="puff" className="steam steam-2" />
          </>
        )}
        <PixelSprite name="pot" className="pot" />
        <div className="stove" aria-hidden="true">
          <div className="burner" />
        </div>
        <PixelSprite name="puff" className="puff puff-1" />
        <PixelSprite name="puff" className="puff puff-2" />
      </div>
      <p className="cooking-caption">Cooking…</p>
    </section>
  );
}
