import { useEffect, useMemo, useState } from "react";
import { challengesFor, drawChallenge } from "../lib/roulette.js";
import { createRng, randomSeed } from "../lib/rng.js";
import Segmented from "./Segmented.jsx";

const draw = (seed, side) => drawChallenge(createRng(seed), side);

export default function RouletteView({ state, setState }) {
  const [history, setHistory] = useState([]);
  const challenge = useMemo(
    () => (state.seed != null ? draw(state.seed, state.side) : null),
    [state.seed, state.side],
  );

  // Pick a seed whose challenge differs from the one on screen, so a spin
  // always shows something new.
  const spin = (side = state.side, replace = false) => {
    let seed = randomSeed();
    for (let i = 0; i < 10 && challenge && draw(seed, side).id === challenge.id; i++) seed = randomSeed();
    if (challenge) setHistory((h) => [challenge, ...h.filter((c) => c.id !== challenge.id)].slice(0, 6));
    setState({ view: "roulette", side, seed }, { replace });
  };

  useEffect(() => {
    if (state.seed == null) spin(state.side, true);
  }, [state.seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="roulette">
      <div className="roulette-controls">
        <Segmented
          value={state.side}
          onChange={(side) => spin(side)}
          options={[["any", "Either side"], ["attack", "Attack"], ["defense", "Defense"]]}
        />
        <span className="muted">{challengesFor(state.side).length} challenges</span>
      </div>

      {challenge && (
        <article key={state.seed} className="roulette-card">
          <p className="eyebrow">{challenge.category} · {challenge.side === "any" ? "either side" : challenge.side}</p>
          <h1>{challenge.title}</h1>
          <p className="roulette-text">{challenge.text}</p>
        </article>
      )}

      <button type="button" className="btn-primary btn-big" onClick={() => spin()}>Spin</button>

      {history.length > 0 && (
        <section className="history" aria-label="Previous spins">
          <p className="eyebrow">Previous</p>
          <ul>
            {history.map((c) => (
              <li key={c.id}><strong>{c.title}</strong> {c.text}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
