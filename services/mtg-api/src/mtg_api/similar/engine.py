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
    results = []
    for cand in candidates:
        score, components = scoring.hybrid_score(seed, cand, cand["cosine"])
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
                "score": score,
            }
        )
    results.sort(key=lambda r: r["score"], reverse=True)
    for r in results:
        del r["score"]
    return results[:limit]
