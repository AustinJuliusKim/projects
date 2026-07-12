/**
 * Renders the running conversation CLI-style: user prompts echo as `> text`
 * input lines, assistant/tool beats get an ⏺ bullet, tool results are
 * indented under an ⎿ marker, and a `✳ Running…` status line appears while
 * status === "running". Auto-scrolls to the bottom as messages arrive.
 */

import { useEffect, useRef, useState } from "react";
import { interpolateUserName } from "@guided-repl/protocol";

const TOOL_ICONS = { Write: "✎", Edit: "✎", MultiEdit: "✎", Read: "\u{1F4C4}", Bash: "⌘" };

/**
 * @param {{tool: string, input: object}} message
 * @returns {string}
 */
function toolSummary({ tool, input }) {
  if (input?.file_path) return `${tool} → ${input.file_path}`;
  if (input?.command) return `${tool} → ${input.command}`;
  return tool;
}

function ToolRow({ message, userName }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg msg-tool" data-testid="transcript-tool-row">
      <button className="tool-summary" onClick={() => setOpen((o) => !o)}>
        <span className="cli-bullet">⏺</span>
        <span className="tool-icon">{TOOL_ICONS[message.tool] ?? "⚙"}</span>
        <span>{toolSummary(message)}</span>
      </button>
      {open && message.result && (
        <pre className={`tool-result ${message.result.isError ? "tool-result-error" : ""}`}>
          <span className="tool-result-marker">⎿</span>
          {interpolateUserName(message.result.content, userName)}
        </pre>
      )}
    </div>
  );
}

/**
 * @param {{messages: Array<object>, status?: string, userName?: string|null}} props
 */
export default function Transcript({ messages, status, userName = null }) {
  // Text-mode interpolation only — React escapes these sinks itself.
  const interp = (text) => interpolateUserName(text, userName);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div className="transcript" data-testid="transcript">
      {messages.map((message, i) => {
        const isLast = i === messages.length - 1;
        if (message.role === "user") {
          return (
            <div className="msg msg-user" key={i}>
              <span className="cli-prompt-marker">&gt;</span> {interp(message.text)}
            </div>
          );
        }
        if (message.role === "assistant") {
          return (
            <div className="msg msg-assistant" key={i}>
              <span className="cli-bullet">⏺</span>
              <span className="msg-text">
                {interp(message.text)}
                {isLast && status === "running" && <span className="stream-cursor" />}
              </span>
            </div>
          );
        }
        if (message.role === "tool") {
          return <ToolRow message={message} userName={userName} key={message.id ?? i} />;
        }
        if (message.role === "error") {
          return (
            <div className="msg msg-error" key={i}>
              <span className="cli-bullet">⏺</span>
              {message.message}
            </div>
          );
        }
        if (message.role === "tty") {
          // Raw terminal output from shellTranscript playback (drills).
          return (
            <pre className="msg msg-tty" data-testid="transcript-tty" key={i}>
              {interp(message.text)}
            </pre>
          );
        }
        return null;
      })}
      {status === "running" && (
        <div className="transcript-status" data-testid="transcript-status">
          <span className="status-glyph">✳</span> Running<span className="status-dots" />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
