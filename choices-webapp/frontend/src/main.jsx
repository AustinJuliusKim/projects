import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import CreateView from "./CreateView.jsx";
import PlayView from "./PlayView.jsx";
import { registerServiceWorker } from "./push.js";
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

registerServiceWorker();
createRoot(document.getElementById("root")).render(<App />);
