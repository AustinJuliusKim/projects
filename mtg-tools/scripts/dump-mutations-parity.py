"""Run the phase-4 mutation scenario through the real Flask app and dump every
read endpoint. check-phase4-parity.mjs replays the identical scenario in the
browser and deep-diffs. The clock is frozen in both runs, so responses must be
byte-identical.

Usage (repo root): .venv/bin/python scripts/dump-mutations-parity.py OUT_DIR
"""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FROZEN = "2026-07-31T00:00:00+00:00"

import webapp.db  # noqa: E402

webapp.db.now = lambda: FROZEN
# Modules bind `now` at import time; patch every holder.
import webapp.operations, webapp.importer, webapp.bulk, webapp.sales  # noqa: E402,E401

for module in (webapp.operations, webapp.importer, webapp.bulk, webapp.sales):
    module.now = lambda: FROZEN

# The exporter reads the wall clock directly (manifest exportedAt, zip stamp).
from datetime import datetime as _real_datetime  # noqa: E402
import webapp.exporter  # noqa: E402


class _FrozenDatetime:
    @staticmethod
    def now(tz=None):
        return _real_datetime.fromisoformat(FROZEN)


webapp.exporter.datetime = _FrozenDatetime

from webapp.app import create_app  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(REPO, "tests", "fixtures")


def main() -> int:
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)

    app = create_app(":memory:", testing=True)
    client = app.test_client()
    token = client.get("/api/session").get_json()["csrfToken"]
    headers = {"X-CSRF-Token": token}

    def post(path, body=None):
        response = client.post(path, json=body or {}, headers=headers)
        if response.status_code >= 400:
            raise SystemExit(f"{path}: {response.status_code} {response.get_json()}")
        return response.get_json()

    def upload(name):
        with open(os.path.join(FIXTURES, name), "rb") as handle:
            data = handle.read()
        response = client.post(
            "/api/imports",
            data={"file": (io.BytesIO(data), name)},
            content_type="multipart/form-data",
            headers=headers,
        )
        return response.get_json()["importId"]

    # -- the scenario (mirrored exactly in the browser script) ------------
    for name in ("sample.csv", "sample2.csv"):
        post(f"/api/imports/{upload(name)}/commit")

    sealed_id = upload("sealed_sample.csv")
    detail = client.get(f"/api/imports/{sealed_id}").get_json()
    for issue in detail["issues"]:
        if issue["blocking"]:
            for row in issue["rows"]:
                post(f"/api/imports/{sealed_id}/rows/{row['id']}", {"skip": True})
    post(f"/api/imports/{sealed_id}/commit")

    post("/api/bulk", {"kind": "holding", "ids": [1, 2], "action": "verdict", "value": "sell"})
    post("/api/bulk", {"kind": "holding", "ids": [1, 2, 3], "action": "adjust_price", "value": "5"})
    post("/api/bulk", {"kind": "holding", "ids": [4], "action": "price", "value": "9.99"})
    post("/api/bulk", {"kind": "sealed", "selectAll": True, "filters": {}, "action": "cost_basis", "value": "30.00"})
    post("/api/bulk", {"kind": "sealed", "ids": [1], "action": "verdict", "value": "sell"})

    sale1 = post("/api/sales/list", {"kind": "holding", "id": 1})["saleId"]
    post(f"/api/sales/{sale1}/sold", {"sold": "100.00", "fees": "8.00", "shipping": "2.00"})
    sale2 = post("/api/sales/list", {"kind": "holding", "id": 2})["saleId"]
    post(f"/api/sales/{sale2}/cancel")
    sale3 = post("/api/sales/list", {"kind": "sealed", "id": 1, "quantity": 1})["saleId"]
    post(f"/api/sales/{sale3}/sold", {"sold": "45.00", "fees": "4.50"})

    post("/api/undo")  # walk one step back: the sealed sale un-happens

    dumps = {
        "collection": "/api/collection",
        "sealed": "/api/sealed",
        "insights": "/api/collection/insights",
        "queue": "/api/sales/queue",
        "sales": "/api/sales",
        "sales-summary": "/api/sales/summary",
        "history": "/api/history",
    }
    for name, path in dumps.items():
        with open(os.path.join(out_dir, f"{name}.json"), "w", encoding="utf-8") as handle:
            json.dump(client.get(path).get_json(), handle)

    # Phase-5 exports: every download, byte for byte.
    exports = {
        "manifest.json.txt": "/api/export/manifest",
        "ledger.csv": "/api/export/ledger",
        "buylist.csv": "/api/export/buylist",
        "buylist-ck.csv": "/api/export/buylist/ck",
        "template.csv": "/api/sealed/template",
    }
    for table in ("holdings", "sealed", "verdicts", "sales", "price_history", "imports", "operations"):
        exports[f"table-{table}.csv"] = f"/api/export/table/{table}"
    for fname, path in exports.items():
        with open(os.path.join(out_dir, fname), "wb") as handle:
            handle.write(client.get(path).data)

    import zipfile as _zipfile

    bundle_dir = os.path.join(out_dir, "bundle")
    os.makedirs(bundle_dir, exist_ok=True)
    bundle = client.get("/api/export/bundle")
    archive = _zipfile.ZipFile(io.BytesIO(bundle.data))
    with open(os.path.join(bundle_dir, "_names.json"), "w", encoding="utf-8") as handle:
        json.dump(sorted(archive.namelist()), handle)
    for entry in archive.namelist():
        with open(os.path.join(bundle_dir, entry.replace("/", "__")), "wb") as handle:
            handle.write(archive.read(entry))

    print(f"dumped {len(dumps)} endpoints + {len(exports)} exports + bundle to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
