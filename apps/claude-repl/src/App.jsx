import React from "react";
import { useSession } from "./state/useSession.js";
import ApiKeyModal from "./components/ApiKeyModal.jsx";
import ModeSelector from "./components/ModeSelector.jsx";
import Terminal from "./components/Terminal.jsx";
import WorkspacePane from "./components/WorkspacePane.jsx";
import PermissionModal from "./components/PermissionModal.jsx";
import TokenUsage from "./components/TokenUsage.jsx";

export default function App() {
  const { state, setKey, setMode, prompt, approve, deny, openFile } = useSession();

  const needsKey = state.status === "needs_key";
  const promptDisabled =
    state.status === "running" || state.status === "connecting" || state.status === "disconnected";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Claude Code Playground</div>
        <ModeSelector mode={state.mode} onChange={setMode} disabled={state.status === "running"} />
        <TokenUsage usage={state.usage} />
        <StatusBadge status={state.status} />
      </header>

      {state.error && <div className="error-banner">{state.error}</div>}

      <div className="split">
        <div className="pane left">
          <Terminal
            messages={state.messages}
            onSubmit={prompt}
            disabled={promptDisabled}
            status={state.status}
          />
        </div>
        <div className="pane right">
          <WorkspacePane
            files={state.files}
            openFile={state.openFile}
            onOpen={openFile}
          />
        </div>
      </div>

      {needsKey && <ApiKeyModal onSubmit={setKey} />}
      <PermissionModal permission={state.permission} onApprove={approve} onDeny={deny} />
    </div>
  );
}

function StatusBadge({ status }) {
  const label = {
    disconnected: "offline",
    connecting: "connecting…",
    needs_key: "needs key",
    booting: "booting sandbox…",
    ready: "ready",
    running: "running…",
  }[status];
  return <div className={`status ${status}`}>{label}</div>;
}
