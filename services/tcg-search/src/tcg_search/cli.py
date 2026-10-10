"""`python -m tcg_search <command>`.

  health                          cluster health + catalog alias status
"""

import argparse
import json
import sys

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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tcg_search")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health", help="cluster health").set_defaults(func=cmd_health)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
