"""Shared test helpers.

The real ManaBox exports live on a Desktop, not in the repo, so any test that
reads them has to skip elsewhere. Those skips all go through `require_exports`
so they carry an identifiable reason — `run_tests.py` allows exactly this one
and fails the build on any other skip.
"""

from __future__ import annotations

import os
import unittest

#: Prefix every "needs the local exports" skip reason starts with.
EXPORTS_MISSING = "manabox exports not present"

DESKTOP = os.path.expanduser("~/Desktop")
BINDERS = os.path.join(DESKTOP, "Binders.csv")
BINDERS2 = os.path.join(DESKTOP, "Binders2.csv")
BINDERS_BAK = os.path.join(DESKTOP, "Binders.csv.bak")
BINDERS2_BAK = os.path.join(DESKTOP, "Binders2.csv.bak")


def require_exports(*paths: str) -> None:
    """Skip the calling test unless every named export is on disk."""
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        raise unittest.SkipTest(f"{EXPORTS_MISSING}: {', '.join(missing)}")
