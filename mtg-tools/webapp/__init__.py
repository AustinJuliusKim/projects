"""Local web app for managing the card collection.

Depends on `binders`; `binders` does not depend on this. That arrow points one
way on purpose — the library stays stdlib-only and its 245 tests keep passing
with nothing installed, which `tests_webapp/test_boundary.py` asserts.
"""

from __future__ import annotations

__all__ = ["create_app", "serve"]


def create_app(*args, **kwargs):
    from .app import create_app as _factory

    return _factory(*args, **kwargs)


def serve(*args, **kwargs):
    from .app import serve as _serve

    return _serve(*args, **kwargs)
