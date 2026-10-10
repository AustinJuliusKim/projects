#!/usr/bin/env python3
"""Search relevance report against eval/golden_search.yaml (shape follows
services/mtg-api/scripts/eval_similar.py).

  python scripts/eval_search.py                       # the live `catalog` alias
  python scripts/eval_search.py --baseline-postgres   # mtg_dev's Postgres search
  python scripts/eval_search.py --json eval/runs/after.json
  python scripts/eval_search.py --compare eval/runs/before.json
  python scripts/eval_search.py --gate                # exit 1 if the ship gate fails

Metrics per category and overall: MRR (first result with grade >= 1),
nDCG@10 (graded, exponential gain), success@1 (top result has the query's
best grade) and zero-result rate. Gate (plan §7): name-finding success@1
(nav + typo + accent + nickname) >= 0.95, mean nDCG@10 >= 0.80, no
zero-result typos.

--baseline-postgres reproduces mtg-api's /v1/cards/search (queries.py
search_cards: websearch_to_tsquery over name + type line + oracle text,
default order=name) on the same queries, read-only via CATALOG_DATABASE_URL.
"""

import argparse
import json
import math
import statistics
import sys
from pathlib import Path

import yaml

GOLDEN = Path(__file__).resolve().parent.parent / "eval" / "golden_search.yaml"
K = 10
NAME_FINDING = ("nav", "typo", "accent", "nickname")
CATEGORIES = ("nav", "typo", "accent", "nickname", "syntax")
GATE = {"name_success_at_1": 0.95, "ndcg_at_10": 0.80, "zero_result_typos": 0}

# mtg-api's search_cards with only `q` set (prices-c-api queries.py).
PG_ORDERINGS = {
    "name": "c.name ASC",
    "edhrec": "c.edhrec_rank ASC NULLS LAST, c.name ASC",
}
PG_SQL = (
    "SELECT c.name FROM cards c WHERE NOT c.is_removed "
    "AND c.search_tsv @@ websearch_to_tsquery('english', %s) "
    "ORDER BY {order} LIMIT %s"
)


def ndcg(names: list[str], grades: dict[str, int], k: int = K) -> float:
    dcg = sum((2 ** grades.get(n, 0) - 1) / math.log2(i + 2) for i, n in enumerate(names[:k]))
    ideal = sorted(grades.values(), reverse=True)[:k]
    idcg = sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def reciprocal_rank(names: list[str], grades: dict[str, int]) -> float:
    for i, n in enumerate(names, start=1):
        if grades.get(n, 0) > 0:
            return 1 / i
    return 0.0


def success_at_1(names: list[str], grades: dict[str, int]) -> bool:
    return bool(names) and grades.get(names[0], 0) == max(grades.values())


def run_opensearch(queries: list[dict], index: str | None) -> list[dict]:
    from tcg_search.client import OpenSearch
    from tcg_search.query import SearchRequest, search

    out = []
    with OpenSearch() as os_:
        for item in queries:
            res = search(os_, SearchRequest(q=item["q"], page_size=K), catalog_index=index)
            out.append({
                "names": [r["name"] for r in res["results"]],
                "total": res["total"],
                "took_ms": res["took_ms"],
                "did_you_mean": res["did_you_mean"],
            })
    return out


def run_postgres(queries: list[dict], order: str) -> list[dict]:
    import psycopg

    from tcg_search import config

    out = []
    sql = PG_SQL.format(order=PG_ORDERINGS[order])
    with psycopg.connect(config.catalog_database_url()) as conn:
        for item in queries:
            rows = conn.execute(sql, (item["q"], K)).fetchall()
            total = conn.execute(
                "SELECT count(*) FROM cards c WHERE NOT c.is_removed "
                "AND c.search_tsv @@ websearch_to_tsquery('english', %s)",
                (item["q"],),
            ).fetchone()[0]
            out.append({"names": [r[0] for r in rows], "total": total, "took_ms": None,
                        "did_you_mean": None})
    return out


def missing_names(queries: list[dict]) -> list[str]:
    import psycopg

    from tcg_search import config

    names = sorted({n for q in queries for n in q["relevant"]})
    with psycopg.connect(config.catalog_database_url()) as conn:
        found = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM cards WHERE NOT is_removed AND name = ANY(%s)", (names,)
            ).fetchall()
        }
    return [n for n in names if n not in found]


def score(queries: list[dict], runs: list[dict]) -> tuple[list[dict], dict]:
    rows = []
    for item, run in zip(queries, runs, strict=True):
        grades = {str(k): int(v) for k, v in item["relevant"].items()}
        names = run["names"]
        rank = next((i for i, n in enumerate(names, 1) if grades.get(n, 0) > 0), None)
        rows.append({
            "q": item["q"],
            "category": item["category"],
            "top": names[:3],
            "rank": rank,
            "total": run["total"],
            "took_ms": run["took_ms"],
            "did_you_mean": run["did_you_mean"],
            "rr": reciprocal_rank(names, grades),
            "ndcg": ndcg(names, grades),
            "s1": success_at_1(names, grades),
            "zero": run["total"] == 0,
        })

    def agg(sub: list[dict]) -> dict:
        if not sub:
            return {}
        return {
            "n": len(sub),
            "mrr": round(statistics.mean(r["rr"] for r in sub), 3),
            "ndcg_at_10": round(statistics.mean(r["ndcg"] for r in sub), 3),
            "success_at_1": round(statistics.mean(r["s1"] for r in sub), 3),
            "zero_result_rate": round(statistics.mean(r["zero"] for r in sub), 3),
        }

    metrics = {c: agg([r for r in rows if r["category"] == c]) for c in CATEGORIES}
    metrics["all"] = agg(rows)
    name_rows = [r for r in rows if r["category"] in NAME_FINDING]
    metrics["gate"] = {
        "name_success_at_1": agg(name_rows).get("success_at_1", 0.0),
        "ndcg_at_10": metrics["all"]["ndcg_at_10"],
        "zero_result_typos": sum(r["zero"] for r in rows if r["category"] == "typo"),
    }
    g = metrics["gate"]
    metrics["gate"]["pass"] = (
        g["name_success_at_1"] >= GATE["name_success_at_1"]
        and g["ndcg_at_10"] >= GATE["ndcg_at_10"]
        and g["zero_result_typos"] <= GATE["zero_result_typos"]
    )
    timed = [r["took_ms"] for r in rows if r["took_ms"] is not None]
    if timed:
        metrics["latency_ms"] = {"median": statistics.median(timed), "max": max(timed)}
    return rows, metrics


def print_report(label: str, rows: list[dict], metrics: dict, verbose: bool) -> None:
    print(f"== {label}")
    print(f"{'category':<10} {'n':>3} {'MRR':>6} {'nDCG@10':>8} {'S@1':>6} {'zero':>6}")
    for c in (*CATEGORIES, "all"):
        m = metrics.get(c) or {}
        if m:
            print(f"{c:<10} {m['n']:>3} {m['mrr']:>6.3f} {m['ndcg_at_10']:>8.3f} "
                  f"{m['success_at_1']:>6.3f} {m['zero_result_rate']:>6.3f}")
    g = metrics["gate"]
    print(f"gate: name-finding S@1 {g['name_success_at_1']:.3f} (>= 0.95), "
          f"nDCG@10 {g['ndcg_at_10']:.3f} (>= 0.80), zero-result typos "
          f"{g['zero_result_typos']} (= 0) -> {'PASS' if g['pass'] else 'FAIL'}")
    if "latency_ms" in metrics:
        print(f"latency: median {metrics['latency_ms']['median']} ms, "
              f"max {metrics['latency_ms']['max']} ms (OpenSearch 'took')")
    misses = [r for r in rows if not r["s1"] or verbose]
    if misses:
        print("queries without the best card at #1:" if not verbose else "all queries:")
        for r in misses:
            dym = f"  [did you mean: {r['did_you_mean']}]" if r["did_you_mean"] else ""
            print(f"  {r['category']:<8} {r['q']!r:<36} rank={r['rank']} "
                  f"ndcg={r['ndcg']:.2f} top={r['top']}{dym}")


def compare(prev_path: str, metrics: dict, rows: list[dict]) -> None:
    prev = json.loads(Path(prev_path).read_text())
    print(f"== compared with {prev_path} ({prev.get('label')})")
    for c in (*CATEGORIES, "all"):
        a, b = prev["metrics"].get(c) or {}, metrics.get(c) or {}
        if a and b:
            print(f"{c:<10} nDCG {a['ndcg_at_10']:.3f} -> {b['ndcg_at_10']:.3f}   "
                  f"S@1 {a['success_at_1']:.3f} -> {b['success_at_1']:.3f}   "
                  f"MRR {a['mrr']:.3f} -> {b['mrr']:.3f}")
    before = {r["q"]: r for r in prev["rows"]}
    for r in rows:
        p = before.get(r["q"])
        if p and abs(p["ndcg"] - r["ndcg"]) > 0.001:
            print(f"  {r['q']!r:<36} ndcg {p['ndcg']:.2f} -> {r['ndcg']:.2f} "
                  f"rank {p['rank']} -> {r['rank']}")


def main() -> int:
    ap = argparse.ArgumentParser(description="search relevance eval")
    ap.add_argument("--baseline-postgres", action="store_true",
                    help="score mtg_dev's Postgres websearch search instead of OpenSearch")
    ap.add_argument("--pg-order", choices=sorted(PG_ORDERINGS), default="name",
                    help="baseline ORDER BY (mtg-api's default is name)")
    ap.add_argument("--index", help="catalog index or alias (default: the catalog alias)")
    ap.add_argument("--json", metavar="PATH", help="write rows + metrics as JSON")
    ap.add_argument("--compare", metavar="PATH", help="a previous --json run to diff against")
    ap.add_argument("--category", choices=CATEGORIES, help="only this category")
    ap.add_argument("--verbose", action="store_true", help="list every query")
    ap.add_argument("--gate", action="store_true", help="exit 1 if the ship gate fails")
    args = ap.parse_args()

    queries = yaml.safe_load(GOLDEN.read_text(encoding="utf-8"))["queries"]
    if args.category:
        queries = [q for q in queries if q["category"] == args.category]
    missing = missing_names(queries)
    if missing:
        print(f"warning: golden names not in the catalog DB: {missing}")

    if args.baseline_postgres:
        label = f"postgres websearch_to_tsquery (order={args.pg_order})"
        runs = run_postgres(queries, args.pg_order)
    else:
        label = f"opensearch ({args.index or 'catalog alias'})"
        runs = run_opensearch(queries, args.index)
    rows, metrics = score(queries, runs)
    print_report(label, rows, metrics, args.verbose)
    if args.compare:
        compare(args.compare, metrics, rows)
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(
            {"label": label, "metrics": metrics, "rows": rows}, indent=2))
    return 1 if args.gate and not metrics["gate"]["pass"] else 0


if __name__ == "__main__":
    sys.exit(main())
