"""The Flask application: a JSON API plus the built front end.

Local-only by construction. `serve()` binds `127.0.0.1` and refuses anything
routable — an unauthenticated view of the collection must not appear on every
network the laptop joins.

CSRF survives the move to fetch. Mutations require an `X-CSRF-Token` header
matching the session token: a cross-origin form post cannot set a custom
header, so the requirement alone defeats classic CSRF, and the comparison is
the belt to that suspenders.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import threading
from typing import Optional

from flask import Flask, jsonify, request, send_from_directory, session

from .api import ApiError, api
from .db import (
    DEFAULT_DB,
    connect,
    init_db,
    is_memory,
    memory_uri,
)

__all__ = ["create_app", "serve", "csrf_token", "DIST"]

MAX_UPLOAD_MB = 25

HERE = os.path.dirname(os.path.abspath(__file__))
#: Vite's output. Built with `npm --prefix frontend run build`.
DIST = os.path.abspath(os.path.join(HERE, os.pardir, "frontend", "dist"))

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def create_app(db_path: Optional[str] = None, *, testing: bool = False) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DATABASE=db_path or DEFAULT_DB,
        SECRET_KEY=os.environ.get("MTG_SECRET_KEY") or secrets.token_hex(32),
        MAX_CONTENT_LENGTH=MAX_UPLOAD_MB * 1024 * 1024,
        TESTING=testing,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_HTTPONLY=True,
    )

    # One connection PER THREAD. A single connection shared across threads
    # raises sqlite3.ProgrammingError on the first request the dev server
    # handles off the main thread — which happens in every real run and never
    # under a test client, so a whole suite passed while the server 500'd.
    #
    # An in-memory database must become a shared-cache URI for this to work: a
    # plain `:memory:` belongs to the connection that opened it, so each thread
    # would otherwise get its own empty database. One code path for memory and
    # file is the point — their divergence is what hid the bug.
    if is_memory(app.config["DATABASE"]):
        app.config["DATABASE"] = memory_uri()

    app.config["_LOCAL"] = threading.local()

    # Anchor connection held for the app's lifetime. For a shared-cache memory
    # database this is load-bearing: the database dies with its last connection.
    app.config["_ANCHOR"] = connect(app.config["DATABASE"])
    init_db(app.config["_ANCHOR"])

    app.register_blueprint(api)
    _register(app)
    return app


def db() -> sqlite3.Connection:
    """This thread's connection, opened on first use."""
    from flask import current_app

    store = current_app.config["_LOCAL"]
    conn = getattr(store, "conn", None)
    if conn is None:
        conn = connect(current_app.config["DATABASE"])
        store.conn = conn
    return conn


# --- CSRF ---------------------------------------------------------------------


def csrf_token() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def _register(app: Flask) -> None:
    @app.before_request
    def guard():
        if request.method in SAFE_METHODS:
            return None
        sent = request.headers.get("X-CSRF-Token", "")
        expected = session.get("csrf", "")
        if not expected or not secrets.compare_digest(sent, expected):
            return (
                jsonify({
                    "error": "Missing or stale session token — reload the page.",
                    "code": "csrf",
                }),
                400,
            )
        return None

    @app.errorhandler(ApiError)
    def api_error(exc: ApiError):
        return jsonify({"error": exc.message, "code": exc.code}), exc.status

    @app.errorhandler(413)
    def too_big(_):
        return (
            jsonify({
                "error": f"That file is over {MAX_UPLOAD_MB} MB.",
                "code": "too-large",
            }),
            413,
        )

    @app.errorhandler(404)
    def not_found(_):
        if request.path.startswith("/api/"):
            return jsonify({"error": "No such endpoint.", "code": "not-found"}), 404
        # Any other path is a client-side route; hand back the shell.
        return _spa()

    # --- the built front end --------------------------------------------------

    @app.get("/")
    def index():
        return _spa()

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(os.path.join(DIST, "assets"), filename)

    @app.get("/<path:filename>")
    def root_files(filename: str):
        """favicon.svg and friends, falling through to the SPA shell.

        `/api/...` never falls through: an unmatched API path must answer JSON,
        or a client typo returns an HTML page and the fetch fails on parsing
        rather than on the actual mistake.
        """
        if filename.startswith("api/"):
            return jsonify({"error": "No such endpoint.", "code": "not-found"}), 404
        candidate = os.path.join(DIST, filename)
        if os.path.isfile(candidate):
            return send_from_directory(DIST, filename)
        return _spa()


def _spa():
    index = os.path.join(DIST, "index.html")
    if not os.path.isfile(index):
        # A clone without a build should say so, rather than 404 into silence.
        return (
            "<h1>Front end isn't built</h1>"
            "<p>Run:</p>"
            "<pre>nvm use\n"
            "npm --prefix frontend ci\n"
            "npm --prefix frontend run build</pre>"
            "<p>Or use the dev server: <code>npm --prefix frontend run dev</code> "
            "(proxies <code>/api</code> here).</p>",
            503,
        )
    return send_from_directory(DIST, "index.html")


def serve(
    db_path: Optional[str] = None,
    host: str = "127.0.0.1",
    port: int = 8765,
    debug: bool = False,
) -> None:
    """Run the local server.

    `host` defaults to loopback and the CLI exposes no flag to change it.
    Binding 0.0.0.0 would put an unauthenticated view of the collection on
    every network the machine joins.
    """
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(
            f"refusing to bind {host!r}: this app has no authentication and is "
            f"meant for loopback only"
        )
    app = create_app(db_path)
    built = os.path.isfile(os.path.join(DIST, "index.html"))
    print(f"Collection manager on http://{host}:{port}")
    print(f"  database: {app.config['DATABASE']}")
    if not built:
        print(
            "  ⚠ front end not built — run `npm --prefix frontend ci && "
            "npm --prefix frontend run build`"
        )
    app.run(host=host, port=port, debug=debug)
