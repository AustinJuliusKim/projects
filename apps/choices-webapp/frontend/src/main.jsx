import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import CreatePairingView from "./CreatePairingView.jsx";
import JoinView from "./JoinView.jsx";
import PlayView from "./PlayView.jsx";
import Landing from "./Landing.jsx";
import { registerServiceWorker } from "./push.js";
import { loadIdentity } from "./storage.js";
import { isNative } from "./platform.js";
import "./styles.css";

// Routing is driven by stored identity, NOT the URL — on iOS an installed PWA
// always boots at "/". Optional entry hashes (#/create, #/join?code=) let A/B
// start the flow, but resuming never depends on the URL.
function useHash() {
  const [hash, setHash] = useState(window.location.hash || "");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const [identity, setIdentity] = useState(() => loadIdentity());

  // If we already have an identity, we're in the game — ignore entry hashes.
  if (identity) {
    return <PlayView identity={identity} onLeave={() => setIdentity(loadIdentity())} />;
  }

  if (hash.startsWith("#/create")) {
    return <CreatePairingView onReady={() => setIdentity(loadIdentity())} />;
  }
  const joinMatch = hash.match(/^#\/join(?:\?code=([^&]+))?/);
  if (joinMatch) {
    return (
      <JoinView
        prefillCode={joinMatch[1] ? decodeURIComponent(joinMatch[1]) : ""}
        onReady={() => setIdentity(loadIdentity())}
      />
    );
  }
  return <Landing />;
}

// Service workers don't run in the Capacitor WKWebView — skip registration
// there (push is handled natively in a future phase; polling covers turns).
if (!isNative) registerServiceWorker();
createRoot(document.getElementById("root")).render(<App />);
