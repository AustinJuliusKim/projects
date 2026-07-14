# mcp-spec — 2026-07-14

## Institutional-Memory Note

**What changed:**
- **Routine dependency maintenance**: Minor bumps across dev tooling (typescript-eslint, eslint, prettier)
- **Critical incident & recovery**: TypeScript 7.0.2 upgrade broke all CI jobs due to typedoc peer-dependency constraint (supports only 5.0.x–6.0.x). Incident diagnosed, reverted, and Dependabot configured to hold TypeScript majors until downstream tooling catches up
- **Specification refinements**: MCP spec clarified three subtle areas—subscription acknowledgment ordering (per-subscription, not per-stream to avoid ambiguity on stdio), error response `data` field documentation, and Mcp-Param-* header handling guidance

**Why it matters for AI-education:**
The TypeScript incident exemplifies a recurring pattern in dependency management: major version upstream breaks transitive resolution when peer constraints are tight. The commit history shows the diagnostic workflow (identifying the failure, reading peer constraints, understanding why it happened) and recovery strategy (revert, pin, allow tooling to catch up). This is universally applicable to developers managing npm monorepos and CI/CD. The spec clarifications illustrate how subtle wording in technical writing can produce implementation bugs, a metacognitive lesson for anyone writing protocols or APIs.

---

_30 new item(s)._
