import { useEffect, useMemo, useState } from "react";
import { fromPlan } from "../lib/board.js";
import { generatePlan } from "../lib/plan.js";
import { createRng, randomSeed } from "../lib/rng.js";
import Minimap, { ROLE_COLORS } from "./Minimap.jsx";
import Segmented from "./Segmented.jsx";

const POOL_KEY = "stratboard.pool";
const CHOICE_KEY = "stratboard.mapChoice";

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the setting just won't persist.
  }
}

export default function PlanView({ state, setState, data, onOpenBoard }) {
  const { maps, agents } = data;
  const [pool, setPool] = useState(() => load(POOL_KEY, null)); // null = every map
  const [choice, setChoice] = useState(() => load(CHOICE_KEY, "random"));
  const [active, setActive] = useState(null);
  const [copied, setCopied] = useState(false);

  const inPool = (m) => !pool || pool.includes(m.id);
  const poolMaps = maps.filter(inPool);

  const roll = (replace = false) => {
    const seed = randomSeed();
    const candidates = poolMaps.length ? poolMaps : maps;
    // A saved choice can name a map that has since left the data set.
    const fixed = maps.some((m) => m.id === choice) ? choice : null;
    const map = fixed ?? createRng(seed).pick(candidates).id;
    setState({ ...state, view: "plan", map, seed }, { replace });
  };

  // First visit without a shared link (or a link to an unknown map): show a
  // plan straight away.
  useEffect(() => {
    if (state.seed == null || !maps.some((m) => m.id === state.map)) roll(true);
  }, [state.seed, state.map]); // eslint-disable-line react-hooks/exhaustive-deps

  const map = maps.find((m) => m.id === state.map);
  const plan = useMemo(
    () => (map && state.seed != null
      ? generatePlan({ map, agents, side: state.side, comp: state.comp, twist: state.twist, seed: state.seed })
      : null),
    [map, agents, state.side, state.comp, state.twist, state.seed],
  );

  const setSetting = (patch) => setState({ ...state, ...patch });
  const chooseMap = (value) => {
    setChoice(value);
    save(CHOICE_KEY, value);
    if (value !== "random") setSetting({ map: value });
  };
  const togglePool = (id) => {
    const current = pool ?? maps.map((m) => m.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    const value = next.length === maps.length ? null : next;
    setPool(value);
    save(POOL_KEY, value);
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="plan-layout">
      <section className="panel controls" aria-label="Plan settings">
        <label className="field">
          <span className="field-label">Map</span>
          <select value={choice} onChange={(e) => chooseMap(e.target.value)}>
            <option value="random">Random from pool ({poolMaps.length})</option>
            {maps.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="field-label">Side</span>
          <Segmented
            value={state.side}
            onChange={(side) => setSetting({ side })}
            options={[["random", "Random"], ["attack", "Attack"], ["defense", "Defense"]]}
          />
        </div>

        <div className="field">
          <span className="field-label">Team comp</span>
          <Segmented
            value={state.comp}
            onChange={(comp) => setSetting({ comp })}
            options={[["standard", "One per role"], ["random", "Anything goes"]]}
          />
        </div>

        <label className="check">
          <input type="checkbox" checked={state.twist} onChange={(e) => setSetting({ twist: e.target.checked })} />
          Add a strat roulette twist
        </label>

        <div className="actions">
          <button type="button" className="btn-primary" onClick={() => roll()}>Randomize</button>
          <button type="button" className="btn-ghost" onClick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
        </div>

        <details className="pool">
          <summary>Map pool</summary>
          <div className="pool-grid">
            {maps.map((m) => (
              <label key={m.id} className="check">
                <input type="checkbox" checked={inPool(m)} onChange={() => togglePool(m.id)} />
                {m.name}
              </label>
            ))}
          </div>
        </details>
      </section>

      {plan && map ? (
        <>
          <section className="panel board" aria-label="Minimap">
            <div className="board-head">
              <div>
                <p className="eyebrow">{map.name} · {plan.side === "attack" ? "Attack" : "Defense"} · {plan.site} site</p>
                <h1 className="strat-name">{plan.strat.name}</h1>
              </div>
              <div className="board-head-actions">
                <span className={`side-pill side-${plan.side}`}>{plan.side}</span>
                <button type="button" className="btn-ghost" onClick={() => onOpenBoard(fromPlan(plan))}>Edit in planner</button>
              </div>
            </div>
            <p className="summary">{plan.strat.summary}</p>
            <Minimap map={map} plan={plan} active={active} onActive={setActive} />
          </section>

          <section className="panel roster" aria-label="Player assignments">
            <ol className="players">
              {plan.players.map((p, i) => (
                <li
                  key={p.agentId}
                  className={`player ${active === i ? "is-active" : ""}`}
                  style={{ "--role": ROLE_COLORS[p.role] }}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                >
                  <span className="player-num">{i + 1}</span>
                  {p.icon && <img className="agent-icon" src={p.icon} alt="" width="44" height="44" />}
                  <div className="player-body">
                    <div className="player-head">
                      <strong>{p.agent}</strong>
                      <span className="role">{p.role}</span>
                    </div>
                    <p className="job">{p.job}</p>
                    {p.ability && (
                      <span className="ability">
                        {p.ability.icon && <img src={p.ability.icon} alt="" width="16" height="16" />}
                        {p.ability.name}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {plan.postPlant && <p className="note"><strong>Post-plant.</strong> {plan.postPlant}</p>}
            {plan.twist && (
              <div className="twist">
                <p className="eyebrow">Roulette twist · {plan.twist.category}</p>
                <strong>{plan.twist.title}</strong>
                <p>{plan.twist.text}</p>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
