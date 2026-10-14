"""Table-driven parser tests: every input parses, nothing raises."""

import pytest

from tcg_search.query.syntax import parse, parse_colors


def _c(q):
    return [(c.key, c.op, c.value, c.negated) for c in parse(q).clauses]


@pytest.mark.parametrize(
    "q, expected",
    [
        ("", []),
        ("bolt", [(None, ":", "bolt", False)]),
        ("lightning bolt", [(None, ":", "lightning", False), (None, ":", "bolt", False)]),
        ("-goblin", [(None, ":", "goblin", True)]),
        ("t:dragon", [("t", ":", "dragon", False)]),
        ("type:Dragon", [("t", ":", "Dragon", False)]),
        ('t:"legendary creature"', [("t", ":", "legendary creature", False)]),
        ('o:"draw a card"', [("o", ":", "draw a card", False)]),
        ("oracle:flying", [("o", ":", "flying", False)]),
        ("c:r", [("c", ":", "R", False)]),
        ("c=rg", [("c", "=", "RG", False)]),
        ("c<=gwu", [("c", "<=", "WUG", False)]),
        ("c:gruul", [("c", ":", "RG", False)]),
        ("c:colorless", [("c", ":", "", False)]),
        ("c:m", [("c", ":", "M", False)]),
        ("id<=u", [("id", "<=", "U", False)]),
        ("ci:esper", [("id", ":", "WUB", False)]),
        ("-c:r", [("c", ":", "R", True)]),
        ("mv<=4", [("mv", "<=", 4.0, False)]),
        ("cmc=3", [("mv", "=", 3.0, False)]),
        ("mv:2", [("mv", "=", 2.0, False)]),
        ("pow>=5 tou<2", [("pow", ">=", 5.0, False), ("tou", "<", 2.0, False)]),
        ("r:m", [("r", "=", "mythic", False)]),
        ("rarity>=rare", [("r", ">=", "rare", False)]),
        ("f:edh", [("f", ":", "commander", False)]),
        ("banned:modern", [("banned", ":", "modern", False)]),
        ("kw:flying", [("kw", ":", "flying", False)]),
        ('a:"rebecca guay"', [("a", ":", "rebecca guay", False)]),
        ("is:reserved", [("is", ":", "reserved", False)]),
        ("not:foil", [("is", ":", "foil", True)]),
        ("-not:foil", [("is", ":", "foil", False)]),
        ("cond>=lp", [("cond", ">=", 4, False)]),
        ("usd<5", [("usd", "<", 5.0, False)]),
        ("usd<=$2.50", [("usd", "<=", 2.5, False)]),
        ("s:alpha", [("s", ":", {"code": "lea", "name": "alpha"}, False)]),
        ('s:"ice age"', [("s", ":", {"code": "ice age", "name": "ice age"}, False)]),
        ("e:M11", [("s", ":", {"code": "m11", "name": "M11"}, False)]),
        ("fire // ice", [(None, ":", "fire", False), (None, ":", "//", False),
                         (None, ":", "ice", False)]),
        ("lim-dul's vault", [(None, ":", "lim-dul's", False), (None, ":", "vault", False)]),
        ("- bolt", [(None, ":", "bolt", False)]),
    ],
)
def test_parse(q, expected):
    assert _c(q) == expected


def test_phrase_and_text():
    p = parse('"lightning bolt" goblin -"tap target"')
    assert [(c.value, c.phrase, c.negated) for c in p.clauses] == [
        ("lightning bolt", True, False),
        ("goblin", False, False),
        ("tap target", True, True),
    ]
    assert p.text == "goblin"
    assert not p.is_name_like()


@pytest.mark.parametrize(
    "q, warning",
    [
        ("foo:bar", "unknown key 'foo'"),
        ("mv:abc", "expects a number"),
        ("c:purple", "unknown colors"),
        ("r:legendary", "unknown rarity"),
        ("f:notaformat", "unknown format"),
        ("is:shiny", "unknown value"),
        ("t:", "needs a value"),
        ("t>dragon", "doesn't support"),
        ("cond:mint", "unknown condition"),
    ],
)
def test_bad_terms_fall_back_to_text_with_warning(q, warning):
    p = parse(q)
    assert len(p.warnings) == 1 and warning in p.warnings[0]
    assert [c.key for c in p.clauses] == [None]
    assert p.clauses[0].value == q.replace('"', "")


def test_negated_unknown_key_stays_negated_text():
    p = parse("-foo:bar")
    assert [(c.key, c.value, c.negated) for c in p.clauses] == [(None, "foo:bar", True)]


def test_unclosed_quote_is_tolerated():
    p = parse('o:"draw a')
    assert [(c.key, c.value) for c in p.clauses] == [("o", "draw a")]
    assert parse('"lightning').clauses[0].value == "lightning"


def test_name_like():
    assert parse("tarmogyof").is_name_like()
    assert parse("jace the mind sculptor").is_name_like()
    assert not parse("t:dragon").is_name_like()
    assert not parse("a b c d e f").is_name_like()


def test_as_dict_echo():
    d = parse("-c:r").clauses[0].as_dict()
    assert d == {"key": "c", "op": ":", "value": "R", "negated": True, "raw": "-c:r",
                 "source": "q"}


@pytest.mark.parametrize("v, out", [("wubrg", "WUBRG"), ("gw", "WG"), ("selesnya", "WG"),
                                    ("c", ""), ("multicolor", "M")])
def test_parse_colors(v, out):
    assert parse_colors(v) == out
