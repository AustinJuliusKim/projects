#!/usr/bin/env python3
"""Run the web app suite.

Separate from `run_tests.py` on purpose. That runner proves `binders` works with
nothing installed and fails on any unsanctioned skip; a "Flask isn't installed"
skip would either break that guard or quietly erode it. Keeping two runners
keeps both guarantees honest.

    .venv/bin/python run_webapp_tests.py
"""

from __future__ import annotations

import sys
import unittest


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    verbosity = 2 if ("-v" in argv or "--verbose" in argv) else 1

    try:
        import flask  # noqa: F401
    except ImportError:
        print(
            "The web app suite needs its dependencies:\n"
            "    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt\n"
            "    .venv/bin/python run_webapp_tests.py",
            file=sys.stderr,
        )
        return 2

    suite = unittest.defaultTestLoader.discover(
        start_dir="tests_webapp", top_level_dir="."
    )
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)

    if result.skipped:
        print(f"\n{len(result.skipped)} test(s) skipped:")
        for test, reason in result.skipped:
            print(f"  {test.id()}: {reason}")
        print("\nThis suite is not meant to skip anything.")
        return 1

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
