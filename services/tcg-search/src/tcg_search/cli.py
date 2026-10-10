"""`python -m tcg_search <command>`.

  health                              cluster health
  catalog build [--swap] [--keep N]   build a new catalog version from the mtg DB
  catalog swap [INDEX]                alias -> INDEX (default newest version)
  catalog rollback                    alias -> previous version
  catalog status                      alias target, versions, counts, _meta
  search "<query>" [--json] [...]     run a query against the catalog (or listings)
"""

import argparse
import json
import logging
import re
import sys

from tcg_search import config
from tcg_search.client import OpenSearch, OpenSearchError


def cmd_health(args: argparse.Namespace) -> int:
    with OpenSearch() as os_:
        try:
            info = os_.info()
            health = os_.health()
        except OpenSearchError as err:
            print(f"opensearch: DOWN ({err})", file=sys.stderr)
            return 1
        out = {
            "url": os_.url,
            "version": info.get("version", {}).get("number"),
            "status": health.get("status"),
            "nodes": health.get("number_of_nodes"),
            "active_shards": health.get("active_shards"),
            "unassigned_shards": health.get("unassigned_shards"),
        }
    print(json.dumps(out, indent=2))
    # Yellow = unassigned replicas only; data is still served.
    return 0 if out["status"] in ("green", "yellow") else 1


def _redact(url: str) -> str:
    return re.sub(r"//([^:/@]+):[^@]*@", r"//\1:***@", url)


def cmd_catalog(args: argparse.Namespace) -> int:
    from tcg_search.catalog import build as b

    with OpenSearch() as os_:
        try:
            if args.action == "build":
                from tcg_search.catalog import extract

                url = config.catalog_database_url()
                with extract.connect(url) as conn:
                    snap = extract.latest_snapshot(conn)
                    meta = {
                        "source_db": _redact(url),
                        "price_snapshot": snap and snap["snapshot_id"],
                    }
                    res = b.build(
                        os_, extract.iter_cards(conn), swap=args.swap, keep=args.keep, meta=meta
                    )
                print(
                    f"built {res.index}: {res.docs} cards, {res.printings} printings, "
                    f"{res.priced} priced, {res.seconds}s"
                    + (f"; alias -> {res.index} (was {res.previous})" if res.swapped else
                       "; not swapped (pass --swap)")
                )
                if res.unresolved_nicknames:
                    print(f"warning: nickname targets not in catalog: {res.unresolved_nicknames}")
            elif args.action == "swap":
                prev, target = b.swap(os_, index=args.index)
                print(f"alias -> {target} (was {prev})")
            elif args.action == "rollback":
                prev, target = b.rollback(os_)
                print(f"rolled back: alias -> {target} (was {prev})")
            else:
                print(json.dumps(b.status(os_), indent=2))
        except b.BuildError as err:
            print(f"catalog {args.action} FAILED: {err}", file=sys.stderr)
            return 2
        except OpenSearchError as err:
            print(f"catalog {args.action} FAILED: {err}", file=sys.stderr)
            return 1
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    from tcg_search.query import SearchRequest, search

    req = SearchRequest(
        q=args.query,
        mode=args.mode,
        tenant_id=args.tenant,
        sort=args.sort,
        page=args.page,
        page_size=args.size,
    )
    with OpenSearch() as os_:
        try:
            res = search(os_, req)
        except OpenSearchError as err:
            print(f"search FAILED: {err}", file=sys.stderr)
            return 1
    if args.json:
        print(json.dumps(res, indent=2, default=str))
        return 0
    for w in res.get("warnings", []):
        print(f"warning: {w}")
    if res.get("did_you_mean"):
        print(f"Showing results for {res['did_you_mean']!r}")
    print(f"{res['total']} results ({res['took_ms']} ms)")
    for i, hit in enumerate(res["results"], start=(args.page - 1) * args.size + 1):
        price = hit.get("price_cents")
        price_s = f"${price / 100:,.2f}" if price else "-"
        print(f"{i:>3}. {hit['name']:<45} {hit.get('type_line') or '':<40.40} {price_s:>9}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tcg_search")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health", help="cluster health").set_defaults(func=cmd_health)

    cat = sub.add_parser("catalog", help="catalog index lifecycle")
    cat.set_defaults(func=cmd_catalog)
    cat_sub = cat.add_subparsers(dest="action", required=True)
    p = cat_sub.add_parser("build")
    p.add_argument("--swap", action="store_true", help="swap the alias if the guards pass")
    p.add_argument("--keep", type=int, default=2, help="versions to keep incl. current")
    p = cat_sub.add_parser("swap")
    p.add_argument("index", nargs="?")
    cat_sub.add_parser("rollback")
    cat_sub.add_parser("status")

    s = sub.add_parser("search", help="search the catalog / a store's listings")
    s.set_defaults(func=cmd_search)
    s.add_argument("query")
    s.add_argument("--json", action="store_true")
    s.add_argument("--mode", choices=["catalog", "stock"], default="catalog")
    s.add_argument("--tenant", help="tenant id (required for --mode stock)")
    s.add_argument("--sort", default="relevance")
    s.add_argument("--page", type=int, default=1)
    s.add_argument("--size", type=int, default=10)
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    args = build_parser().parse_args(argv)
    return args.func(args)
