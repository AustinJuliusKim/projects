"""Index analysis settings shared by the catalog and listings indices, so a
query built once runs against either.

Analyzers (expectations are pinned by tests/test_os_integration.py through
_analyze against a real cluster):

  name_index     "Lim-Dûl the Necromancer" -> limdul lim dul the necromancer
                 "Urza's Saga"             -> urzas urza s saga
                 (apostrophes split AND catenate, so "urza", "urzas" and
                 "urza's" all match; a lone "s" token is harmless)
                 "Fire // Ice"             -> fire ice
                 "Æther Vial"              -> aether vial
  name_search    as name_index without the catenated parts (no query graphs)
  name_plain     simple folded words, for search_as_you_type (no graphs)
  rules          rules text: mana symbols ({W/U} -> mswu, {T} -> mst), folded,
                 apostrophes dropped, English-stemmed
  rules_search   rules + a few MTG shorthand synonyms at query time (etb, ltb)
  rules_plain    rules text unstemmed, for quoted o:"..." phrases
  plain          folded words, for type lines, artist, set names

Normalizer `compact` lower-cases, folds and deletes everything that is not
a letter or digit: "Fire // Ice" = "fire ice" = "fireice". It backs the
exact-name and nickname keyword fields.
"""

from typing import Any

# Shorthand -> what Oracle text actually says. Applied at query time only
# (synonym_graph), so the index stays a plain view of the card.
RULES_SYNONYMS = [
    "etb => enters",
    "etbs => enters",
    "ltb => leaves the battlefield",
    "gy => graveyard",
    "eot => end of turn",
    "cmc => mana value",
    "ooc => out of combat",
]

APOSTROPHES = ["'=>", "’=>", "‘=>", "`=>"]


def analysis_settings() -> dict[str, Any]:
    return {
        "char_filter": {
            "apostrophes": {"type": "mapping", "mappings": APOSTROPHES},
            # {W/U/P} -> " mswup ", {W/U} -> " mswu ", {T} -> " mst ". Lower-cased later.
            "mana_symbols": {
                "type": "pattern_replace",
                "pattern": r"\{([^}/]+)(?:/([^}/]+))?(?:/([^}/]+))?\}",
                "replacement": " ms$1$2$3 ",
            },
            # Punctuation to spaces for the graph-free analyzers: hyphens,
            # commas, slashes all split words.
            "punct_to_space": {
                "type": "pattern_replace",
                "pattern": r"[^\p{L}\p{N}\s]+",
                "replacement": " ",
            },
            "strip_non_alnum": {
                "type": "pattern_replace",
                "pattern": r"[^\p{L}\p{N}]+",
                "replacement": "",
            },
        },
        "filter": {
            "name_wdg_index": {
                "type": "word_delimiter_graph",
                "catenate_words": True,
                "catenate_numbers": True,
                "preserve_original": False,
                "split_on_case_change": False,
                "split_on_numerics": False,
                "stem_english_possessive": False,
            },
            "name_wdg_search": {
                "type": "word_delimiter_graph",
                "preserve_original": False,
                "split_on_case_change": False,
                "split_on_numerics": False,
                "stem_english_possessive": False,
            },
            "english_stem": {"type": "stemmer", "language": "english"},
            "light_english_stem": {"type": "stemmer", "language": "light_english"},
            "rules_synonyms": {
                "type": "synonym_graph",
                "synonyms": RULES_SYNONYMS,
            },
        },
        "analyzer": {
            "name_index": {
                "type": "custom",
                "tokenizer": "whitespace",
                "filter": ["lowercase", "asciifolding", "name_wdg_index", "flatten_graph"],
            },
            "name_search": {
                "type": "custom",
                "tokenizer": "whitespace",
                "filter": ["lowercase", "asciifolding", "name_wdg_search"],
            },
            "name_plain": {
                "type": "custom",
                "char_filter": ["apostrophes", "punct_to_space"],
                "tokenizer": "standard",
                "filter": ["lowercase", "asciifolding"],
            },
            "rules": {
                "type": "custom",
                "char_filter": ["mana_symbols", "apostrophes"],
                "tokenizer": "standard",
                "filter": ["lowercase", "asciifolding", "english_stem"],
            },
            "rules_search": {
                "type": "custom",
                "char_filter": ["mana_symbols", "apostrophes"],
                "tokenizer": "standard",
                "filter": ["lowercase", "asciifolding", "rules_synonyms", "english_stem"],
            },
            "rules_plain": {
                "type": "custom",
                "char_filter": ["mana_symbols", "apostrophes"],
                "tokenizer": "standard",
                "filter": ["lowercase", "asciifolding"],
            },
            "plain": {
                "type": "custom",
                "char_filter": ["apostrophes", "punct_to_space"],
                "tokenizer": "standard",
                "filter": ["lowercase", "asciifolding", "light_english_stem"],
            },
        },
        "normalizer": {
            "compact": {
                "type": "custom",
                "char_filter": ["apostrophes", "strip_non_alnum"],
                "filter": ["lowercase", "asciifolding"],
            },
            "lower": {"type": "custom", "filter": ["lowercase", "asciifolding"]},
        },
    }
