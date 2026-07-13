---
id: brief-02-agent-observability
topic: Tracing an agent's tool calls to find the slow step
whyNow: Agent pipelines are moving to production; the debugging story is the gap.
suggestedTrack: advanced
sources:
  - title: Claude Code v2.5.0 release notes
    url: https://github.com/anthropics/claude-code/releases/tag/v2.5.0
    date: "2026-07-01"
    body: Adds verbose stream-json output improvements; each tool_use/tool_result pair carries timing usable for tracing.
  - title: OpenTelemetry GenAI semantic conventions
    url: https://opentelemetry.io/docs/specs/semconv/gen-ai/
    date: "2026-05-20"
    body: Span attributes for model calls and tool invocations in generative-AI pipelines.
---

Frozen source pack — never live-fetched.
