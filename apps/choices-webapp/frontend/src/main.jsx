import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import CreatePairingView from "./CreatePairingView.jsx";
import JoinView from "./JoinView.jsx";
import PlayView from "./PlayView.jsx";
import Landing from "./Landing.jsx";
import HistoryView from "./HistoryView.jsx";
import PremiumView from "./PremiumView.jsx";
import SettingsView from "./SettingsView.jsx";
import CancelView from "./CancelView.jsx";
import AdminView from "./AdminView.jsx";
import TopBar from "./TopBar.jsx";
import BottomNav from "./BottomNav.jsx";
import { registerServiceWorker } from "./push.js";
import { track } from "./api.js";
import { loadIdentity } from "./storage.js";
import { isNative } from "./platform.js";
import { handleRedirect, authEnabled } from "./auth.js";
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

  // Legacy #/account links (Stripe's checkout/portal return URLs are baked
  // in as #/account and #/account?upgraded=1 — backend/billing.mjs) now
  // resolve to the Premium tab. `replace` (not a hash assignment) so Back
  // never loops through the alias.
  useEffect(() => {
    if (hash.startsWith("#/account")) {
      window.location.replace("#/premium" + hash.slice("#/account".length));
    }
  }, [hash]);

  function renderView() {
    // History/Premium/Settings are reachable even mid-game (each has its own
    // way out), so they're checked ahead of the identity gate.
    if (hash.startsWith("#/history")) {
      return <HistoryView />;
    }
    // Native shell (and any web build without Cognito configured) never
    // shows the Premium tab — an unmatched hash falls through to the rows
    // below (the identity gate, then Landing).
    if (authEnabled && hash.startsWith("#/premium")) {
      return <PremiumView />;
    }
    if (hash.startsWith("#/settings")) {
      return <SettingsView />;
    }

    // Cancel-subscription page (the Choicey plea), reached from the Premium
    // badge. Above the identity gate so it's reachable mid-game like above.
    if (hash.startsWith("#/cancel")) {
      return <CancelView />;
    }

    // Owner-only activity dashboard — also above the identity gate so it's
    // reachable mid-game. The real access boundary is the backend assertAdmin.
    if (hash.startsWith("#/admin")) {
      return <AdminView />;
    }

    // Alias resolves via the effect above — render nothing for the one frame
    // before the hash flips to #/premium.
    if (hash.startsWith("#/account")) {
      return null;
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

  // Persistent top bar: contextual back (left) + the 📍 near-me pin and account
  // pill (right). Visibility of each is a pure function of the hash inside TopBar.
  // Floating pill bottom nav sits above everything (four destinations).
  return (
    <>
      <TopBar hash={hash} hasIdentity={!!identity} />
      {renderView()}
      <BottomNav hash={hash} />
    </>
  );
}

// Service workers don't run in the Capacitor WKWebView — skip registration
// there (push is handled natively in a future phase; polling covers turns).
if (!isNative) registerServiceWorker();

// Analytics beacons (event catalog bundles A + D). Enum-only payloads by
// contract: never an error message, stack, or URL — just the fact that a
// class of error happened. appinstalled only fires in browsers, so the
// platform is always "web" here (the native shells install via stores).
window.addEventListener("appinstalled", () => {
  track("pwa_installed", { platform: "web" });
});
window.addEventListener("error", () => {
  track("client_error", { error_type: "js_error" });
});
window.addEventListener("unhandledrejection", () => {
  track("client_error", { error_type: "unhandled_rejection" });
});

// Complete an in-flight OAuth redirect (no-op for guests) before first
// render; a fresh sign-in lands on the History tab.
handleRedirect()
  .then((signedIn) => {
    if (signedIn && !window.location.hash) window.location.hash = "#/history";
  })
  .catch(() => {})
  .finally(() => {
    createRoot(document.getElementById("root")).render(<App />);
  });
