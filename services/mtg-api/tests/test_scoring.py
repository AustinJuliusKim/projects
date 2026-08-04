"""Scoring math on synthetic cards — no DB, no embeddings."""

from mtg_api.similar import features, scoring


def card(name, type_line="Creature — Human", oracle_text="", keywords=None):
    return {
        "name": name,
        "type_line": type_line,
        "oracle_text": oracle_text,
        "keywords": keywords or [],
    }


SEED = card(
    "Blood Artist",
    "Creature — Vampire",
    "Whenever Blood Artist or another creature dies, "
    "target player loses 1 life and you gain 1 life.",
)
TWIN = card(
    "Zulaport Cutthroat",
    "Creature — Human Rogue Ally",
    "Whenever Zulaport Cutthroat or another creature you control dies, "
    "each opponent loses 1 life and you gain 1 life.",
)
UNRELATED = card("Cancel", "Instant", "Counter target spell.")


def test_feature_extraction():
    feats = scoring.card_features(SEED)
    assert "death_trigger" in feats
    assert "lifegain" in feats
    assert "lifeloss" in feats
    assert "counterspell" not in feats
    assert "counterspell" in scoring.card_features(UNRELATED)


def test_related_pair_outscores_unrelated_at_equal_cosine():
    related_score, related_parts = scoring.hybrid_score(SEED, TWIN, cosine=0.5)
    unrelated_score, _ = scoring.hybrid_score(SEED, UNRELATED, cosine=0.5)
    assert related_score > unrelated_score
    assert related_parts["mechanics"] > 0
    assert related_parts["resources"] > 0


def test_confidence_monotonic_and_banded():
    lo, mid, hi = scoring.confidence(0.2), scoring.confidence(0.45), scoring.confidence(0.8)
    assert lo < mid < hi
    assert 0 <= lo and hi <= 1
    assert scoring.band(0.8) == "high"
    assert scoring.band(0.6) == "medium"
    assert scoring.band(0.2) == "low"


def test_reasons_name_shared_mechanics():
    _, parts = scoring.hybrid_score(SEED, TWIN, cosine=0.8)
    reasons = scoring.reasons(parts)
    assert any("death triggers" in r for r in reasons)
    assert "very similar card text" in reasons


def test_resource_keys_are_valid_features():
    assert features.RESOURCE_KEYS <= set(features.FEATURES)
