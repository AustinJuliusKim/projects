import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import CreateView from "./CreateView.jsx";
import PlayView from "./PlayView.jsx";
import { registerServiceWorker, isStandalone } from "./push.js";
import { readActiveGame } from "./resume.js";
import { saveIdentity } from "./storage.js";
import "./styles.css";

// Tiny hash router: "#/" -> create, "#/g/{id}?t={token}" -> play.
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function App() {
  const hash = useRoute();
  // Match "#/g/{id}" with optional "?t={inviteToken}"
  const match = hash.match(/^#\/g\/([^?]+)(?:\?t=([^&]+))?/);
  if (match) {
    return <PlayView gameId={match[1]} inviteToken={match[2] || null} />;
  }
  return <CreateView />;
}

// On iOS, an installed PWA launches at "/" with isolated storage. If we're
// running standalone with no game in the URL, recover the most recent game from
// the Cache Storage bridge, restore identity into this (separate) localStorage,
// and redirect into the game before rendering.
async function recoverStandaloneGame() {
  const hasGameRoute = /^#\/g\//.test(window.location.hash);
  if (!isStandalone() || hasGameRoute) return;
  const active = await readActiveGame();
  if (!active) return;
  saveIdentity(active.gameId, active.role, active.token);
  window.location.hash = `#/g/${active.gameId}`;
}

async function boot() {
  registerServiceWorker();
  await recoverStandaloneGame();
  createRoot(document.getElementById("root")).render(<App />);
}

boot();
