# genai-for-beginners — 2026-11-01

## Summary

The genai-for-beginners repo saw mostly maintenance this cycle (dependency bumps, link fixes), but **three changes matter for AI education**:

- **Model deprecation & SDK versioning**: Lesson 09 migrated from `gpt-image-1` (sunset) to `gpt-image-2`; Lesson 06 pinned `openai>=1.66.0` to ensure the Responses API is available. Shows real-world version management in production AI apps.
- **RAG clarity**: Revised documentation on embeddings and vector database architecture; Lesson 15 now surfaces the distance of each retrieved chunk to the query, making relevance ranking visible and debuggable.
- **Prompt injection hardening**: Removed angle brackets from strict prompt sanitization, a concrete injection defense pattern.

The first two have the most direct 5-minute lesson potential.

_30 new item(s)._
