import pino from "pino";

// Redact anything that could carry the user's API key. The key lives only in
// memory and in the sandbox env — it must never reach a log line.
export const log = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: ["key", "apiKey", "*.key", "*.apiKey", "env.ANTHROPIC_API_KEY"],
    censor: "[redacted]",
  },
});

// Defense in depth: scrub anything that looks like an Anthropic key from a
// free-form string before it's logged.
export function scrub(text) {
  if (typeof text !== "string") return text;
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");
}
