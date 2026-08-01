# mcp-spec — 2026-08-01

Looking at the 30 commits from the MCP specification repo, I see activity around documentation management, release processes, and UI fixes—but nothing directly applicable to **guided-repl's core teaching scope** (prompting, plan mode, permission modes, CLAUDE.md, model choice, debugging in a 5-minute interactive format).

## Summary

The MCP spec repo shipped **documentation and release infrastructure improvements**:

- **Specification versioning**: Fixed version stamps in `learn/versioning.mdx` and dated draft links to 2026-07-28 (multiple commits standardizing the promoted spec tree).
- **SEP metadata**: Marked Final SEPs as historical records with disclaimer notices; corrected error code in SEP-2663.
- **Documentation rendering**: Fixed regex that dropped wrapped Author lines due to `.` not matching newlines.
- **Release automation**: Deduped redirect sources, published the 2026-07-28 GA post with versioned docs links.
- **Website/UI**: Fixed carousel navigation on mobile (scroll-target quantization bug); refreshed PostHog logo with theme variants.

**Why it matters for AI education**: These are domain-specific protocol-repo improvements. The regex bug and release process work are *technically* instructive, but too specialized (and too site-specific) to generalize into a teachable lesson for guided-repl's tracks.

## Proposed lesson cards



None of these changes align with guided-repl's curriculum (prompting, plan mode, permissions, CLAUDE.md, model choice, debugging). The MCP spec repo is a separate project with its own documentation and release needs; its wins don't map to the 5-minute interactive lesson format.

_30 new item(s)._
