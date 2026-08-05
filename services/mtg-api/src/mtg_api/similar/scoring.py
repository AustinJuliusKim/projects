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
    "cosine": 0.25,
    "combo": 0.45,  # known-combo strength (card_combo_pairs, Commander Spellbook)
    "mechanics": 0.20,  # jaccard over keywords ∪ extracted features
    "type_line": 0.05,
    "resources": 0.05,  # overlap of produced/consumed-resource features
}

# `strength` (card_combo_pairs.strength) sums 1/n_cards across every combo
# variant containing the pair — a single tight 2-card combo already scores
# 0.5. COMBO_SATURATION is the strength at which the strength-based half of
# the normalized "combo" component hits 1.0: a confirmed 2-card combo (or
# the equivalent spread across a couple of looser co-memberships) gets full
# weight there, not just a nudge — this is the signal that actually closes
# the recall gap cosine/mechanics/type/resources structurally can't (see
# OPS.md phase 3).
COMBO_SATURATION = 0.5

# A popular seed (Sol Ring, Basalt Monolith, ...) legitimately has many
# known-combo partners, all saturating the strength half above equally —
# `popularity` (Commander Spellbook's deck-inclusion count for the combo)
# breaks that tie in favor of the famous interaction over an obscure one.
# Blended in as a minority share of the combo component, not a replacement
# for strength: an obscure-but-real combo still scores meaningfully, it
# just doesn't out-rank a famous one on strength alone. Popularity values
# span orders of magnitude (single digits to hundreds of thousands), so
# it's log-scaled and clamped against a generous reference ceiling.
COMBO_POPULARITY_WEIGHT = 0.3
COMBO_POPULARITY_REFERENCE = 50_000

# Calibration: logistic over the hybrid score's z-score against the
# candidate-pool score distribution. Re-fit for the combo-aware WEIGHTS
# (2026-08-05, OPS.md phase 3 recall-gate fix) via
#   make eval-calibration
# Re-fit whenever the embedding model or scoring weights change materially.
CALIBRATION = {"mean": 0.261, "std": 0.082, "slope": 1.6}

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


def _combo_component(strength: float, popularity: int) -> float:
    by_strength = min(1.0, strength / COMBO_SATURATION)
    if by_strength == 0.0:
        return 0.0  # no combo relationship at all — popularity is meaningless here
    pop_ceiling = math.log1p(COMBO_POPULARITY_REFERENCE)
    by_popularity = min(1.0, math.log1p(max(popularity, 0)) / pop_ceiling)
    return (1 - COMBO_POPULARITY_WEIGHT) * by_strength + COMBO_POPULARITY_WEIGHT * by_popularity


def hybrid_score(
    seed: dict[str, Any],
    cand: dict[str, Any],
    cosine: float,
    combo_strength: float = 0.0,
    combo_produces: str | None = None,
    combo_popularity: int = 0,
) -> tuple[float, dict[str, Any]]:
    """`combo_strength`/`combo_produces`/`combo_popularity` come from
    card_combo_pairs (0.0/None/0 when the pair has no known-combo
    relationship — a neutral baseline, not a penalty, same as any other
    zero-overlap component)."""
    seed_feats = card_features(seed)
    cand_feats = card_features(cand)
    seed_mech = seed_feats | {k.lower() for k in seed.get("keywords") or []}
    cand_mech = cand_feats | {k.lower() for k in cand.get("keywords") or []}

    components = {
        "cosine": max(0.0, cosine),
        "combo": _combo_component(combo_strength, combo_popularity),
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
        "combo_produces": combo_produces,
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
    if components["combo"] > 0:
        if components["combo_produces"]:
            out.append(f"known combo: {components['combo_produces']}")
        else:
            out.append("known combo piece")
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
