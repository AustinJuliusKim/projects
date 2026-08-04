"""Regex mechanic extraction over (cleaned) oracle text. Two consumers: the
hybrid score's overlap terms, and the human-readable `reasons` shown next to
each suggestion. Precision beats recall here — a wrong reason erodes trust in
unfamiliar suggestions faster than a missing one."""

import re

# feature key -> (regex over lowercased cleaned text, display label)
FEATURES: dict[str, tuple[re.Pattern, str]] = {
    key: (re.compile(pattern), label)
    for key, pattern, label in [
        ("counterspell", r"counter (target|that|all) .{0,30}spell", "counters spells"),
        ("plus_counters", r"\+1/\+1 counter", "uses +1/+1 counters"),
        ("token_creation", r"creates? .{0,60}token", "creates tokens"),
        (
            "token_doubling",
            r"(twice that many|double the number of) .{0,20}token",
            "doubles tokens",
        ),
        ("sacrifice", r"\bsacrifices? \b", "sacrifice effects"),
        ("graveyard", r"\bgraveyards?\b", "graveyard interaction"),
        ("reanimation", r"return .{0,60}from (a|your) graveyard to the battlefield", "reanimation"),
        ("lifegain", r"(gains? .{0,20}life|\blifelink\b)", "gains life"),
        ("lifeloss", r"loses? .{0,20}life", "drains life"),
        ("card_draw", r"draws? (a card|two|three|x|that many)", "draws cards"),
        ("discard", r"\bdiscards?\b", "discard effects"),
        ("landfall", r"(landfall|land (you control )?enters)", "land-drop triggers"),
        ("ramp", r"search (your|their) library for .{0,40}land", "fetches lands"),
        ("mana_ability", r"add \{", "produces mana"),
        ("untap", r"untap (target|another|that|it|this|all|up to)", "untap effects"),
        ("copy", r"\b(copy|copies)\b", "copy effects"),
        ("damage", r"deals? .{0,25}damage", "deals damage"),
        ("removal", r"(destroy|exile) (target|all|each|any)", "removal"),
        (
            "etb_trigger",
            r"(enters, |enters the battlefield|when .{0,40} enters)",
            "enter-the-battlefield triggers",
        ),
        ("death_trigger", r"(dies|is put into a graveyard from the battlefield)", "death triggers"),
        ("mill", r"\bmills?\b", "mill"),
        ("tutor", r"search your library for (?!.{0,40}land)", "tutors"),
        ("flicker", r"exile .{0,60}return .{0,60}battlefield", "flicker effects"),
        ("cost_reduction", r"costs? \{?\d*.{0,10} less to cast", "cost reduction"),
        ("extra_turn", r"extra turn", "extra turns"),
    ]
}

# The plan's "shared resource signals" — the subset describing what a card
# produces/consumes, weighted separately from general mechanic overlap.
RESOURCE_KEYS = {
    "plus_counters",
    "token_creation",
    "token_doubling",
    "sacrifice",
    "graveyard",
    "reanimation",
    "lifegain",
    "lifeloss",
    "mana_ability",
    "mill",
}


def extract(cleaned_text: str) -> set[str]:
    text = cleaned_text.lower()
    return {key for key, (pattern, _) in FEATURES.items() if pattern.search(text)}


def label(key: str) -> str:
    return FEATURES[key][1]
