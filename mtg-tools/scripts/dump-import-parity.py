"""Stage CSVs through the real webapp importer and dump what it staged.

The phase-3 oracle: scripts/check-phase3-parity.mjs runs the same bytes
through the TS importer in Chromium and deep-diffs the result against this.

Usage: .venv/bin/python scripts/dump-import-parity.py OUT_DIR FILE [FILE...]
Singles files are committed after staging; the final /api/collection JSON is
dumped too. Run from the repo root.
"""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from webapp.app import create_app  # noqa: E402


def main() -> int:
    out_dir, files = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)

    app = create_app(":memory:", testing=True)
    client = app.test_client()
    token = client.get("/api/session").get_json()["csrfToken"]
    conn = app.config["_ANCHOR"]

    staged_dump = {}
    for path in files:
        name = os.path.basename(path)
        with open(path, "rb") as handle:
            data = handle.read()
        response = client.post(
            "/api/imports",
            data={"file": (io.BytesIO(data), name)},
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": token},
        )
        body = response.get_json()
        if response.status_code != 201:
            raise SystemExit(f"{name}: {response.status_code} {body}")
        import_id, kind = body["importId"], body["kind"]

        staged_dump[name] = {
            "kind": kind,
            "rows": [
                {
                    "lineNo": row["line_no"],
                    "parsed": json.loads(row["parsed"]),
                    "issues": json.loads(row["issues"]),
                    "state": row["state"],
                }
                for row in conn.execute(
                    "SELECT * FROM staged_rows WHERE import_id = ? ORDER BY line_no",
                    (import_id,),
                )
            ],
        }

        if kind == "singles":
            commit = client.post(
                f"/api/imports/{import_id}/commit", headers={"X-CSRF-Token": token}
            )
            if commit.status_code != 200:
                raise SystemExit(f"commit {name}: {commit.status_code} {commit.get_json()}")

    with open(os.path.join(out_dir, "staged.json"), "w", encoding="utf-8") as handle:
        json.dump(staged_dump, handle)
    with open(os.path.join(out_dir, "collection-after.json"), "w", encoding="utf-8") as handle:
        json.dump(client.get("/api/collection").get_json(), handle)
    print(f"dumped {len(files)} file(s) to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
