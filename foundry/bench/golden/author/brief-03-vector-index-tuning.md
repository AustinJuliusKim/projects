---
id: brief-03-vector-index-tuning
topic: Tuning a vector index before blaming the embeddings
whyNow: Default index parameters quietly cap recall; the fix is a config change, not a new model.
suggestedTrack: advanced
sources:
  - title: HNSW parameters and recall — a field guide
    url: https://huggingface.co/blog/hnsw-field-guide
    date: "2026-06-12"
    body: efConstruction, efSearch and M interact with dataset size; measured recall curves for common presets.
  - title: pgvector 0.8 release notes
    url: https://github.com/pgvector/pgvector/releases/tag/v0.8.0
    date: "2026-05-30"
    body: Adds iterative index scans and improved cost estimation for filtered vector queries.
---

Frozen source pack — never live-fetched.
