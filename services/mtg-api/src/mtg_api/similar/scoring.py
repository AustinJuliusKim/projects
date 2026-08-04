"""Hybrid scoring: vector similarity carries the bulk, structured mechanic
overlap keeps suggestions honest, and a calibrated confidence turns the raw
score into something a user can read. Weights and calibration are constants
on purpose — tuned against eval/golden_synergies.yaml, changed deliberately,
never learned online."""

import math
from typing import Any

from mtg_api.similar import features
from mtg_api.similar.embed_text import _clean_oracle_text

WEIGHTS = {
    "cosine": 0.55,
    "mechanics": 0.25,  # jaccard over keywords ∪ extracted features
    "type_line": 0.10,
    "resources": 0.10,  # overlap of produced/consumed-resource features
}

# Calibration: logistic over the hybrid score's z-score against the
# candidate-pool score distribution. Fit against the first real Titan V2
# embed run (34,931 cards, 2026-08-04) via
#   make eval-calibration
# Re-fit whenever the embedding model or scoring weights change materially.
CALIBRATION = {"mean": 0.525, "std": 0.121, "slope": 1.6}

BANDS = [(0.75, "high"), (0.5, "medium"), (0.0, "low")]

# Type-line tokens that say nothing about mechanical role.
TYPE_STOPWORDS = {"—", "legendary", "basic", "snow", "token"}


def _type_tokens(type_line: str | None) -> set[str]:
    return {
        tok for tok in (type_line or "").lower().replace("—", " ").split()
    } - TYPE_STOPWORDS


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def card_features(card: dict[str, Any]) -> set[str]:
    cleaned = _clean_oracle_text(card.get("oracle_text") or "", card["name"])
    return features.extract(cleaned)


def hybrid_score(
    seed: dict[str, Any], cand: dict[str, Any], cosine: float
) -> tuple[float, dict[str, Any]]:
    seed_feats = card_features(seed)
    cand_feats = card_features(cand)
    seed_mech = seed_feats | {k.lower() for k in seed.get("keywords") or []}
    cand_mech = cand_feats | {k.lower() for k in cand.get("keywords") or []}

    components = {
        "cosine": max(0.0, cosine),
        "mechanics": _jaccard(seed_mech, cand_mech),
        "type_line": _jaccard(
            _type_tokens(seed.get("type_line")), _type_tokens(cand.get("type_line"))
        ),
        "resources": _jaccard(
            seed_feats & features.RESOURCE_KEYS, cand_feats & features.RESOURCE_KEYS
        ),
        "shared_keywords": sorted(
            set(seed.get("keywords") or []) & set(cand.get("keywords") or [])
        ),
        "shared_features": sorted(seed_feats & cand_feats),
    }
    score = sum(WEIGHTS[k] * components[k] for k in WEIGHTS)
    return score, components


def confidence(score: float) -> float:
    z = (score - CALIBRATION["mean"]) / CALIBRATION["std"]
    return round(1 / (1 + math.exp(-CALIBRATION["slope"] * z)), 3)


def band(conf: float) -> str:
    for threshold, name in BANDS:
        if conf >= threshold:
            return name
    return "low"


def reasons(components: dict[str, Any]) -> list[str]:
    out = []
    for kw in components["shared_keywords"][:3]:
        out.append(f"shared keyword: {kw}")
    for feat in components["shared_features"][:3]:
        out.append(f"both have {features.label(feat)}")
    if components["cosine"] >= 0.75:
        out.append("very similar card text")
    elif components["cosine"] >= 0.55:
        out.append("similar card text")
    if not out and components["type_line"] >= 0.5:
        out.append("similar card type")
    return out
