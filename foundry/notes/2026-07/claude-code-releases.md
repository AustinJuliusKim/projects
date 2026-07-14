# claude-code-releases — 2026-07-14

## Summary

**Key changes in claude-code (20 releases, 2026-06-23 to 2026-07-14):**

- **Permission modes shift**: Manual mode is now the default (v2.1.200), replacing the ambiguous "default" label across CLI, VS Code, and JetBrains. The UI now shows a grey ⏸ badge for permission mode visibility (v2.1.203).
- **Background agents by default**: Subagents now run in the background and notify on completion (v2.1.198), changing how users interact with Agent spawns—no more foreground blocking while work completes.
- **Auto mode expansion**: Auto mode is now available without opt-in on Bedrock, Vertex AI, and Foundry; users can disable it via settings (v2.1.207).
- **Claude Sonnet 5 default**: Introduced as the new default model with 1M-token context (v2.1.197); organization-configured model restrictions also added (v2.1.187).
- **New tools**: `/dataviz` skill for chart/dashboard design (v2.1.198), `/doctor` command for CLAUDE.md optimization (v2.1.206), `claude mcp login/logout` for MCP auth (v2.1.186).
- **Accessibility & UX**: Screen reader mode (v2.1.208), clickable file attachments (v2.1.196), readable session names (v2.1.196).

**Why it matters for AI-education:** The permission-mode and agent-background changes are **breaking changes** in user interaction patterns. Learners upgrading will see different default behavior. The new tools expand the lesson surface for practical workflows.

_20 new item(s)._
