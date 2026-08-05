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


def test_combo_defaults_to_zero_not_a_penalty():
    # No combo data for this pair — the component should be a neutral 0.0
    # baseline (same as any other zero-overlap component), not missing or
    # negative.
    _, parts = scoring.hybrid_score(SEED, UNRELATED, cosine=0.5)
    assert parts["combo"] == 0.0
    assert parts["combo_produces"] is None


def test_combo_signal_can_overcome_low_cosine():
    # This is the whole point: a confirmed combo pair with weak textual
    # similarity should still outrank an unrelated pair at the same cosine.
    combo_score, combo_parts = scoring.hybrid_score(
        SEED, UNRELATED, cosine=0.1, combo_strength=0.5, combo_produces=["Infinite mana"]
    )
    no_combo_score, _ = scoring.hybrid_score(SEED, UNRELATED, cosine=0.1)
    assert combo_score > no_combo_score
    assert combo_parts["combo"] > 0.5  # strength alone (no popularity) still scores highly


def test_combo_strength_saturates_independent_of_popularity():
    # More variants/combos don't push the strength half past its ceiling —
    # at equal (zero) popularity, extra strength buys nothing further.
    _, at_saturation = scoring.hybrid_score(SEED, TWIN, cosine=0.3, combo_strength=0.5)
    _, way_above = scoring.hybrid_score(SEED, TWIN, cosine=0.3, combo_strength=5.0)
    assert at_saturation["combo"] == way_above["combo"]


def test_combo_popularity_breaks_ties_between_equally_strong_partners():
    # Two candidates both at max strength (a confirmed 2-card combo each) —
    # the famous one (high popularity) should score higher than the
    # obscure one (low popularity), same as it would in the real golden
    # set (crowding among a popular seed's many legitimate combo partners
    # was exactly the gap this closes — see OPS.md phase 3).
    _, famous = scoring.hybrid_score(
        SEED, TWIN, cosine=0.3, combo_strength=0.5, combo_popularity=50_000
    )
    _, obscure = scoring.hybrid_score(
        SEED, TWIN, cosine=0.3, combo_strength=0.5, combo_popularity=1
    )
    assert famous["combo"] > obscure["combo"]


def test_combo_popularity_is_irrelevant_without_any_combo_relationship():
    # Popularity must never manufacture a combo signal on its own — it's a
    # tie-breaker among real matches, not an independent source of score.
    _, parts = scoring.hybrid_score(SEED, UNRELATED, cosine=0.3, combo_popularity=1_000_000)
    assert parts["combo"] == 0.0


def test_reasons_leads_with_known_combo():
    _, parts = scoring.hybrid_score(
        SEED, UNRELATED, cosine=0.2, combo_strength=0.5, combo_produces=["Infinite mana"]
    )
    reasons = scoring.reasons(parts)
    assert reasons[0] == "known combo: Infinite mana"


def test_reasons_combo_without_produces_text():
    _, parts = scoring.hybrid_score(SEED, UNRELATED, cosine=0.2, combo_strength=0.5)
    assert scoring.reasons(parts)[0] == "known combo piece"


def test_reasons_joins_multiple_produces_entries():
    # combo_produces is a structured list now (card_combo_pairs.produces) —
    # the prose reason still renders as a single ", "-joined string.
    _, parts = scoring.hybrid_score(
        SEED,
        UNRELATED,
        cosine=0.2,
        combo_strength=0.5,
        combo_produces=["Infinite mana", "Infinite tokens"],
    )
    assert scoring.reasons(parts)[0] == "known combo: Infinite mana, Infinite tokens"
