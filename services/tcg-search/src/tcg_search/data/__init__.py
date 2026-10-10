"""Curated data files: nicknames.yaml and set_aliases.yaml."""

from functools import cache
from pathlib import Path

import yaml

from tcg_search.cardtext import compact

DATA_DIR = Path(__file__).resolve().parent


@cache
def nicknames() -> dict[str, list[str]]:
    """compacted nickname -> card names."""
    raw = yaml.safe_load((DATA_DIR / "nicknames.yaml").read_text(encoding="utf-8")) or {}
    return {compact(str(k)): [str(n) for n in v] for k, v in raw.items()}


@cache
def nicknames_by_card() -> dict[str, list[str]]:
    """compacted card name -> nicknames (as written in the YAML, compacted)."""
    out: dict[str, list[str]] = {}
    for nick, names in nicknames().items():
        for name in names:
            out.setdefault(compact(name), []).append(nick)
    return out


@cache
def set_aliases() -> dict[str, str]:
    """compacted alias -> set code."""
    raw = yaml.safe_load((DATA_DIR / "set_aliases.yaml").read_text(encoding="utf-8")) or {}
    return {compact(str(k)): str(v).lower() for k, v in raw.items()}
