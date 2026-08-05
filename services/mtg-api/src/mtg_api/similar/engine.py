"""The similarity pipeline both the API route and the eval harness call:
retrieve top-N candidates by embedding cosine, rescore with the hybrid
scorer, attach calibrated confidence + reasons."""

from typing import Any

import psycopg

from mtg_api import queries
from mtg_api.similar import scoring

CANDIDATE_POOL = 200


def rank_similar(
    conn: psycopg.Connection,
    seed: dict[str, Any],
    *,
    limit: int = 20,
    format_: str | None = None,
    identity: str | None = None,
    min_confidence: float = 0.0,
) -> list[dict[str, Any]]:
    """`seed` is the seed card row (from queries.card_by_id). Returns ranked
    result dicts; empty list also when the seed has no embedding row."""
    candidates = queries.similar_candidates(
        conn,
        str(seed["oracle_id"]),
        seed_name=seed["name"],
        pool=CANDIDATE_POOL,
        format_=format_,
        identity=identity,
    )
    # Known-combo partners (card_combo_pairs) are exactly the candidates
    # cosine-similarity search structurally misses (combo pairs whose
    # oracle text shares no vocabulary — see OPS.md phase 3's diagnosis),
    # so they're unioned in rather than left to the cosine cutoff. Most
    # won't already be in `candidates`; dedupe on oracle_id either way.
    seen = {c["oracle_id"] for c in candidates}
    combos = queries.combo_candidates(
        conn, str(seed["oracle_id"]), format_=format_, identity=identity
    )
    combo_by_id = {c["oracle_id"]: c for c in combos}
    candidates = candidates + [c for c in combos if c["oracle_id"] not in seen]

    results = []
    for cand in candidates:
        combo = combo_by_id.get(cand["oracle_id"])
        score, components = scoring.hybrid_score(
            seed,
            cand,
            cand["cosine"],
            combo_strength=combo["strength"] if combo else 0.0,
            combo_produces=combo["produces"] if combo else None,
            combo_popularity=combo["popularity"] if combo else 0,
        )
        conf = scoring.confidence(score)
        if conf < min_confidence:
            continue
        results.append(
            {
                "oracle_id": cand["oracle_id"],
                "name": cand["name"],
                "type_line": cand["type_line"],
                "image_normal": cand["image_normal"],
                "confidence": conf,
                "band": scoring.band(conf),
                "reasons": scoring.reasons(components),
                # None when the pair has no known-combo relationship — the
                # route turns this into `combo: null` (routes/models.py).
                "combo": (
                    {
                        "produces": combo["produces"] or [],
                        "count": combo["combo_count"],
                        "popularity": combo["popularity"],
                    }
                    if combo
                    else None
                ),
                "score": score,
            }
        )
    results.sort(key=lambda r: r["score"], reverse=True)
    for r in results:
        del r["score"]
    return results[:limit]
