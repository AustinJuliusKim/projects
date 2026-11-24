import { useCallback, useEffect, useState } from "react";
import snapshot from "./data/snapshot.json";
import { fetchGameData } from "./lib/data.js";
import { buildHash, parseHash } from "./lib/share.js";
import PlanView from "./components/PlanView.jsx";
import RouletteView from "./components/RouletteView.jsx";

function useHashState() {
  const [state, setState] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Auto-generated first results replace the entry so Back doesn't land on
  // an empty view that immediately rolls again.
  const update = useCallback((next, { replace = false } = {}) => {
    const hash = buildHash(next);
    if (hash !== window.location.hash) {
      window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    }
    setState(parseHash(hash));
  }, []);
  return [state, update];
}

export default function App() {
  const [data, setData] = useState(snapshot);
  const [live, setLive] = useState(false);
  const [state, setState] = useHashState();

  // The snapshot renders immediately; live data replaces it when it arrives.
  useEffect(() => {
    let cancelled = false;
    fetchGameData()
      .then((fresh) => {
        if (!cancelled && fresh.maps.length && fresh.agents.length) {
          setData(fresh);
          setLive(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const tab = (view) => (
    <button
      type="button"
      role="tab"
      aria-selected={state.view === view}
      className="tab"
      onClick={() => state.view !== view && setState(parseHash(`#${view}`))}
    >
      {view === "plan" ? "Tactical plan" : "Strat roulette"}
    </button>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Stratboard</span>
        </div>
        <nav className="tabs" role="tablist">
          {tab("plan")}
          {tab("roulette")}
        </nav>
      </header>
      <main>
        {state.view === "roulette" ? (
          <RouletteView state={state} setState={setState} />
        ) : (
          <PlanView state={state} setState={setState} data={data} />
        )}
      </main>
      <footer className="footer">
        Game data from valorant-api.com ({live ? "live" : `snapshot ${snapshot.fetchedAt}`}). Fan
        project, not affiliated with Riot Games.
      </footer>
    </div>
  );
}
