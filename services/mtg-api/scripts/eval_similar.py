#!/usr/bin/env python3
"""Similarity quality report against eval/golden_synergies.yaml, plus a
calibration fitter for the confidence constants in scoring.py.

  DATABASE_URL=... python scripts/eval_similar.py
  DATABASE_URL=... python scripts/eval_similar.py --fit-calibration

Metrics: recall@10 / recall@25 (partner appears in the seed's top k, both
directions), MRR over found partners, and bad-pair leakage (unrelated pairs
appearing in each other's top 25). Numbers are only meaningful with real
Titan embeddings — --fake vectors produce noise-level scores by design.
"""

import argparse
import statistics
import sys
from pathlib import Path

import psycopg
import yaml
from psycopg.rows import dict_row

from mtg_api.config import database_url
from mtg_api.similar import scoring
from mtg_api.similar.engine import rank_similar

GOLDEN = Path(__file__).resolve().parent.parent / "eval" / "golden_synergies.yaml"


def seed_row(conn, name):
    return conn.execute(
        "SELECT c.oracle_id, c.name, c.type_line, c.oracle_text, c.keywords "
        "FROM cards c WHERE NOT c.is_removed AND lower(c.name) = lower(%s) "
        "ORDER BY c.edhrec_rank ASC NULLS LAST LIMIT 1",
        (name,),
    ).fetchone()


def rank_of(conn, seed, partner_name, k=25):
    results = rank_similar(conn, seed, limit=k)
    for i, r in enumerate(results, start=1):
        if r["name"].lower() == partner_name.lower():
            return i
    return None


def run_eval(conn) -> int:
    golden = yaml.safe_load(GOLDEN.read_text())
    ranks, missing = [], []
    for a, b in golden["pairs"]:
        for seed_name, partner in ((a, b), (b, a)):
            seed = seed_row(conn, seed_name)
            if seed is None or seed_row(conn, partner) is None:
                missing.append((seed_name, partner))
                continue
            ranks.append(rank_of(conn, seed, partner))
    found = [r for r in ranks if r is not None]
    leaks = 0
    for a, b in golden["bad_pairs"]:
        seed = seed_row(conn, a)
        if seed is not None and rank_of(conn, seed, b) is not None:
            leaks += 1

    n = len(ranks)
    print(f"golden pairs evaluated: {n} directions ({len(missing)} skipped, cards not in DB)")
    if n:
        print(f"recall@10: {sum(1 for r in found if r <= 10) / n:.2f}")
        print(f"recall@25: {sum(1 for r in found if r <= 25) / n:.2f}")
        if found:
            print(f"MRR (found): {statistics.mean(1 / r for r in found):.3f}")
    print(f"bad-pair leakage (top 25): {leaks}/{len(golden['bad_pairs'])}")
    for pair in missing:
        print(f"  skipped: {pair[0]} -> {pair[1]}")
    return 0


def fit_calibration(conn) -> int:
    """Sample candidate-pool hybrid scores for random seeds and print
    refreshed CALIBRATION constants for scoring.py."""
    seeds = conn.execute(
        "SELECT c.oracle_id, c.name, c.type_line, c.oracle_text, c.keywords "
        "FROM cards c JOIN card_embeddings e ON e.oracle_id = c.oracle_id "
        "WHERE NOT c.is_removed ORDER BY random() LIMIT 100"
    ).fetchall()
    from mtg_api import queries

    scores = []
    for seed in seeds:
        for cand in queries.similar_candidates(
            conn, str(seed["oracle_id"]), seed_name=seed["name"], pool=200
        ):
            score, _ = scoring.hybrid_score(seed, cand, cand["cosine"])
            scores.append(score)
    mean = statistics.mean(scores)
    std = statistics.stdev(scores)
    print(f"sampled {len(scores)} candidate scores from {len(seeds)} seeds")
    print(f'CALIBRATION = {{"mean": {mean:.3f}, "std": {std:.3f}, "slope": 1.6}}')
    print("-> paste into src/mtg_api/similar/scoring.py and re-run the eval")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="similarity eval / calibration")
    parser.add_argument("--fit-calibration", action="store_true")
    args = parser.parse_args()
    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        return fit_calibration(conn) if args.fit_calibration else run_eval(conn)


if __name__ == "__main__":
    sys.exit(main())
