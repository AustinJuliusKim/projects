import { useEffect } from "react";

export const COOK_DURATION_MS = 2500;
const REDUCED_DURATION_MS = 600;

interface Props {
  onDone: () => void;
}

export function CookingScene({ onDone }: Props) {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(onDone, reduced ? REDUCED_DURATION_MS : COOK_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return (
    <section className="cooking" aria-label="Cooking in progress">
      <div className="cooking-stage">
        <span className="puff puff-1" aria-hidden="true">💨</span>
        <span className="puff puff-2" aria-hidden="true">☁️</span>
        <span className="puff puff-3" aria-hidden="true">💨</span>
        <span className="star star-1" aria-hidden="true">✦</span>
        <span className="star star-2" aria-hidden="true">✦</span>
        <span className="star star-3" aria-hidden="true">✦</span>
        <span className="star star-4" aria-hidden="true">✦</span>
        <span className="pot" aria-hidden="true">🍲</span>
      </div>
      <p className="cooking-caption">Cooking…</p>
    </section>
  );
}
