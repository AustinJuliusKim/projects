import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import CreatePairingView from "./CreatePairingView.jsx";
import JoinView from "./JoinView.jsx";
import PlayView from "./PlayView.jsx";
import Landing from "./Landing.jsx";
import AccountView from "./AccountView.jsx";
import AccountCorner from "./AccountCorner.jsx";
import NearMeToggle from "./NearMeToggle.jsx";
import { registerServiceWorker } from "./push.js";
import { loadIdentity } from "./storage.js";
import { isNative } from "./platform.js";
import { handleRedirect } from "./auth.js";
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

  function renderView() {
    // Account view is reachable even mid-game (it has its own back link), so
    // it's checked ahead of the identity gate.
    if (hash.startsWith("#/account")) {
      return <AccountView />;
    }

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

  // The corner tools float over every view except the account view itself:
  // the 📍 near-me pin (hidden when Places is dormant) + the account pill.
  return (
    <>
      {!hash.startsWith("#/account") && (
        <div className="corner-tools">
          <NearMeToggle />
          <AccountCorner />
        </div>
      )}
      {renderView()}
    </>
  );
}

// Service workers don't run in the Capacitor WKWebView — skip registration
// there (push is handled natively in a future phase; polling covers turns).
if (!isNative) registerServiceWorker();

// Complete an in-flight OAuth redirect (no-op for guests) before first
// render; a fresh sign-in lands on the account view.
handleRedirect()
  .then((signedIn) => {
    if (signedIn && !window.location.hash) window.location.hash = "#/account";
  })
  .catch(() => {})
  .finally(() => {
    createRoot(document.getElementById("root")).render(<App />);
  });
