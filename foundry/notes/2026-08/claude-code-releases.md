# claude-code-releases — 2026-08-01

Now I'll analyze the release notes for lesson-relevant changes:

## Summary

The Claude Code releases (v2.1.200–v2.1.220) introduce several features and fixes spanning **auto mode workflows, model updates, permission controls, and developer experience**. For guided-repl's 5-minute lesson scope, three areas merit attention:

1. **Opus 5 launch** (v2.1.219): New default model with 1M context window and fast mode pricing — directly relevant to model-choice guidance.
2. **Auto mode availability democratized** (v2.1.207): Now enabled by default on Bedrock/Vertex/Foundry (previously required opt-in) — key lesson for permission-mode strategies.
3. **`/code-review` subagent shift** (v2.1.218): Moved to background execution, changing how developers invoke and consume reviews — practical permission/workflow pattern.
4. **Screen reader mode** (v2.1.208): New `--ax-screen-reader` flag and `axScreenReader` setting for accessibility — teachable in a "customization" lesson.

However, most other fixes are **internal reliability/bug-fixes** that don't create new hands-on lesson moments (e.g., Windows path corruption, message normalization slowdowns, MCP memory leaks).

## Proposed Lessons



**Rationale for zero other cards:**
- `/code-review` subagent shift is internal tooling UX, not a conceptual lesson (learners invoke it the same way).
- Screen reader mode is accessibility customization, valuable but not core to the tracks' mission (prompting, plan mode, permission modes, model choice, debugging).
- Remaining changes (memory leaks, slowdown fixes, Vim remaps, emoji autocomplete) are reliability or niche preferences, not teachable moments.

_20 new item(s)._
