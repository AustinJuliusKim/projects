import React, { useEffect, useRef, useState } from "react";

// The left pane: a structured prompt/response log (NOT a raw TTY) plus the
// prompt input. Renders user prompts, Claude's streaming text, and tool-use
// chips with their results.
export default function Terminal({ messages, onSubmit, disabled, status }) {
  const [text, setText] = useState("");
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    if (text.trim() && !disabled) {
      onSubmit(text.trim());
      setText("");
    }
  };

  return (
    <div className="terminal">
      <div className="log" ref={logRef}>
        {messages.map((m, i) => (
          <LogEntry key={i} m={m} />
        ))}
        {status === "running" && <div className="entry running">running…</div>}
      </div>
      <form className="prompt-bar" onSubmit={submit}>
        <span className="prompt-glyph">›</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? "Waiting…" : "Ask Claude Code to build something…"}
          disabled={disabled}
        />
      </form>
    </div>
  );
}

function LogEntry({ m }) {
  if (m.kind === "user") {
    return (
      <div className="entry user">
        <span className="prompt-glyph">›</span> {m.text}
      </div>
    );
  }
  if (m.kind === "assistant") {
    return <div className="entry assistant">{m.text}</div>;
  }
  if (m.kind === "tool") {
    return (
      <div className="entry tool">
        <span className="tool-chip">{m.tool}</span>
        <span className="tool-target">{toolTarget(m)}</span>
        {m.result != null && (
          <pre className={m.isError ? "tool-result error" : "tool-result"}>{truncate(m.result)}</pre>
        )}
      </div>
    );
  }
  return null;
}

function toolTarget(m) {
  const i = m.input || {};
  if (i.file_path) return i.file_path;
  if (i.command) return i.command;
  if (i.path) return i.path;
  return "";
}

function truncate(s, n = 2000) {
  return s.length > n ? s.slice(0, n) + "\n… (truncated)" : s;
}
