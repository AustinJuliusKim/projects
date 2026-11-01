# mcp-spec — 2026-11-01

## Summary

The MCP specification repository received 30 commits over the past 72 hours, predominantly focused on **documentation maintenance and correctness**. Key themes:

- **Tutorial fixes** — Corrected failing code samples in Java, Kotlin, Rust, TypeScript, and Ruby client tutorials; updated Rust tutorial to rmcp 3 with protocol negotiation and structured output validation
- **Link and anchor corrections** — Fixed dead links to ext-auth specs (moved to SEP-3392 layout), incorrect platform paths (added Linux config paths), and broken documentation anchors
- **Extension ecosystem housekeeping** — Updated support matrices (Skills/MCPJam, Tasks, Kiro Crew), extension lifecycle documentation, and identity provider support tables for enterprise auth
- **Governance updates** — Restructured Security IG as a routing group, broadened Filesystems WG charter scope

**Why it matters for AI-education**: These are incremental maintenance commits that ship corrections and align documentation to released software versions (rmcp 3, Inspector 2.13.0, MCPJam/Skills alignment). No new protocols, architectural patterns, or learner-facing capabilities emerged. The changes improve *correctness* of existing tutorials rather than teaching new concepts.



**Reasoning**: While the Rust tutorial update and tool-use block handling show interesting implementation patterns (protocol negotiation, structured validation, edge cases in tool use), these are specialized concerns for developers *building* MCP servers/clients—not for guided-repl's audience, who are learning core Claude Code workflows (prompting, permission modes, debugging, CLAUDE.md conventions). No new lesson merits a 5-minute hands-on slot from this source.

_30 new item(s)._
