import React, { useState } from "react";

// First-run gate. Collects the user's own Anthropic API key (BYOK). We are
// explicit about where the key goes so users can trust it.
export default function ApiKeyModal({ onSubmit }) {
  const [key, setKey] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (key.trim()) onSubmit(key.trim());
  };

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>Bring your own Anthropic API key</h2>
        <p className="muted">
          This playground runs <strong>Claude Code</strong> on your own API key, so usage is
          billed to you directly. Your key stays in this browser tab, is sent only over an
          encrypted connection to run your prompts, and is never stored on our servers or logs.
        </p>
        <input
          type="password"
          placeholder="sk-ant-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={!key.trim()}>
          Start session
        </button>
        <p className="muted small">
          Get a key at platform.claude.com → API Keys. We never use Claude Pro/Max subscription
          logins — only standard API keys.
        </p>
      </form>
    </div>
  );
}
