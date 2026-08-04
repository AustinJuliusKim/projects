#!/usr/bin/env python3
"""Run the test suite, failing if a test skips for an unexpected reason.

Tests that read the real ManaBox exports skip when those files are not on disk
— they live on a Desktop, not in the repo, so CI never has them. That is the
one sanctioned skip, and it goes through `tests.support.require_exports` so it
is identifiable by reason rather than by which module it came from.

Any other skip fails the run. Without this, a missing fixture or a broken guard
shows up as a green `OK (skipped=N)` and nobody looks twice.

    python3 run_tests.py           # same as unittest discover, plus the guard
    python3 run_tests.py -v        # verbose
"""

from __future__ import annotations

import sys
import unittest

from tests.support import EXPORTS_MISSING


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    verbosity = 2 if ("-v" in argv or "--verbose" in argv) else 1

    suite = unittest.defaultTestLoader.discover(start_dir="tests", top_level_dir=".")
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)

    unexpected = [
        (test, reason)
        for test, reason in result.skipped
        if not str(reason).startswith(EXPORTS_MISSING)
    ]

    if result.skipped:
        allowed = len(result.skipped) - len(unexpected)
        if allowed:
            print(
                f"\n{allowed} test(s) skipped because the ManaBox exports are not "
                f"present — expected anywhere but the dev machine."
            )

    if unexpected:
        print(f"\n{len(unexpected)} test(s) skipped for an unsanctioned reason:")
        for test, reason in unexpected:
            print(f"  {test.id()}: {reason}")
        print(
            "\nOnly 'exports not present' skips are allowed. Anything else hides "
            "real coverage loss behind a green run."
        )
        return 1

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
