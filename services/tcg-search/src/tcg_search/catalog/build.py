"""Build, swap, roll back and inspect the versioned catalog index.

  build [--swap]   new `<alias>-YYYYMMDD-HHMMSS` index from the extract;
                   with --swap, point the alias at it if it passes the guards
  swap [INDEX]     point the alias at INDEX (default: newest version)
  rollback         point the alias at the version before the current one
  status           alias target, versions, doc counts, _meta

Guards (a build that trips one never swaps; its index is left for
inspection and removed by the next successful build's cleanup):
  - any bulk item error
  - indexed doc count != extracted rows
  - doc count below MIN_RATIO (95%) of the index currently behind the alias
"""

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib import metadata
from typing import Any

from tcg_search import cardtext, config, data
from tcg_search.client import OpenSearch
from tcg_search.docs import catalog_doc
from tcg_search.mappings import catalog_index_body

log = logging.getLogger("tcg_search.catalog")

MIN_RATIO = 0.95
DEFAULT_KEEP = 2  # current + one previous, for rollback
VERSION = "1"  # bump when mappings/doc shape change incompatibly


class BuildError(Exception):
    pass


def _package_version() -> str:
    try:
        return f"tcg-search {metadata.version('tcg-search')}"
    except metadata.PackageNotFoundError:
        return "tcg-search (not installed)"


def alias_name() -> str:
    return f"{config.index_prefix()}catalog"


def new_index_name(alias: str, now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    # Millisecond resolution: two builds in one second must not collide.
    return f"{alias}-{now:%Y%m%d-%H%M%S}{now.microsecond // 1000:03d}"


def versions(os_: OpenSearch, alias: str) -> list[str]:
    """Versioned indices for `alias`, oldest first (names sort by time)."""
    return sorted(
        r["index"] for r in os_.list_indices(f"{alias}-*") if r["index"].startswith(f"{alias}-")
    )


def current(os_: OpenSearch, alias: str) -> str | None:
    targets = os_.get_alias(alias)
    if len(targets) > 1:
        raise BuildError(f"alias {alias} points at {len(targets)} indices: {targets}")
    return targets[0] if targets else None


@dataclass
class BuildResult:
    index: str
    docs: int = 0
    printings: int = 0
    priced: int = 0
    seconds: float = 0.0
    swapped: bool = False
    previous: str | None = None
    errors: list[dict[str, Any]] = field(default_factory=list)
    unresolved_nicknames: list[str] = field(default_factory=list)


def _actions(
    rows: Iterable[dict[str, Any]], result: BuildResult, seen_names: set[str]
) -> Iterable[tuple[str, dict[str, Any], dict[str, Any]]]:
    for row in rows:
        doc = catalog_doc(row)
        result.docs += 1
        result.printings += doc.get("printing_count", 0)
        result.priced += 1 if doc.get("price_cents") else 0
        for n in doc.get("names_exact", []):
            seen_names.add(cardtext.compact(n))
        if result.docs % 5000 == 0:
            log.info("extracted %d cards", result.docs)
        yield ("index", {"_id": doc["oracle_id"]}, doc)


def build(
    os_: OpenSearch,
    rows: Iterable[dict[str, Any]],
    *,
    alias: str | None = None,
    swap: bool = False,
    keep: int = DEFAULT_KEEP,
    min_ratio: float = MIN_RATIO,
    meta: dict[str, Any] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> BuildResult:
    alias = alias or alias_name()
    started = time.monotonic()
    index = new_index_name(alias, now())
    result = BuildResult(index=index)
    os_.create_index(index, catalog_index_body(refresh_interval="-1"))
    log.info("created %s", index)

    seen: set[str] = set()
    bulk = os_.bulk(_actions(rows, result, seen), index=index)
    result.errors = bulk.errors
    os_.put_settings(index, {"index": {"refresh_interval": "1s"}})
    os_.refresh(index)
    indexed = os_.count(index)
    result.unresolved_nicknames = sorted(
        {n for names in data.nicknames().values() for n in names if cardtext.compact(n) not in seen}
    )
    result.seconds = round(time.monotonic() - started, 1)

    failure = None
    prev = current(os_, alias)
    if result.errors:
        sample = "; ".join(f"{e['_id']}: {e.get('error')}" for e in result.errors[:3])
        failure = f"{len(result.errors)} bulk errors ({sample})"
    elif indexed != result.docs:
        failure = f"index holds {indexed} docs but {result.docs} were extracted"
    elif result.docs == 0:
        failure = "extract returned no cards"
    elif prev:
        prev_count = os_.count(prev)
        if indexed < min_ratio * prev_count:
            failure = f"{indexed} docs is below {min_ratio:.0%} of {prev} ({prev_count})"

    # _meta records the outcome; a failed version is never a swap/rollback
    # target and is deleted by the next successful build's cleanup.
    os_.put_mapping(index, {"_meta": {
        **(meta or {}),
        "built_at": now().isoformat(timespec="seconds"),
        "package": _package_version(),
        "doc_version": VERSION,
        "docs": result.docs,
        "printings": result.printings,
        "priced_cards": result.priced,
        "build_seconds": result.seconds,
        "bulk_errors": len(result.errors),
        "unresolved_nicknames": result.unresolved_nicknames,
        **({"failed": failure} if failure else {}),
    }})
    if failure:
        raise BuildError(f"{failure}; not swapping {index}")

    if swap:
        result.previous = prev
        os_.swap_alias(alias, index)
        result.swapped = True
        log.info("alias %s -> %s (was %s)", alias, index, prev)
        cleanup(os_, alias, keep=keep)
    return result


def _meta(os_: OpenSearch, index: str) -> dict[str, Any]:
    return ((os_.get_index(index) or {}).get(index, {}).get("mappings", {}).get("_meta")) or {}


def good_versions(os_: OpenSearch, alias: str) -> list[str]:
    """Versions whose build passed every guard, oldest first."""
    return [v for v in versions(os_, alias) if "failed" not in _meta(os_, v)]


def cleanup(os_: OpenSearch, alias: str, *, keep: int = DEFAULT_KEEP) -> list[str]:
    """Delete every version except the current one and the (keep - 1)
    newest good versions older than it. Failed builds are always deleted."""
    cur = current(os_, alias)
    if cur is None:
        return []
    older = [v for v in good_versions(os_, alias) if v < cur]
    keep_set = {cur, *(older[-(keep - 1):] if keep > 1 else [])}
    deleted = []
    for v in versions(os_, alias):
        if v not in keep_set:
            os_.delete_index(v, missing_ok=True)
            deleted.append(v)
    return deleted


def swap(
    os_: OpenSearch, alias: str | None = None, index: str | None = None
) -> tuple[str | None, str]:
    """Point the alias at `index` (default: the newest good version)."""
    alias = alias or alias_name()
    good = good_versions(os_, alias)
    target = index or (good[-1] if good else None)
    if target is None or target not in good:
        raise BuildError(f"no such good version for {alias}: {target}")
    prev = current(os_, alias)
    os_.swap_alias(alias, target)
    return prev, target


def rollback(os_: OpenSearch, alias: str | None = None) -> tuple[str, str]:
    alias = alias or alias_name()
    cur = current(os_, alias)
    if cur is None:
        raise BuildError(f"alias {alias} does not exist")
    older = [v for v in good_versions(os_, alias) if v < cur]
    if not older:
        raise BuildError(f"no version older than {cur} to roll back to")
    os_.swap_alias(alias, older[-1])
    return cur, older[-1]


def status(os_: OpenSearch, alias: str | None = None) -> dict[str, Any]:
    alias = alias or alias_name()
    cur = current(os_, alias)
    rows = {r["index"]: r for r in os_.list_indices(f"{alias}-*")}
    out = []
    for v in versions(os_, alias):
        out.append({
            "index": v,
            "current": v == cur,
            "docs": int(rows[v].get("docs.count") or 0),
            "store_bytes": int(rows[v].get("store.size") or 0),
            "meta": _meta(os_, v),
        })
    return {"alias": alias, "current": cur, "versions": out}
