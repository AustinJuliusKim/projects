"""An in-memory stand-in for the few OpenSearch calls the storefront routes
and the listings indexer make, served through httpx.MockTransport (no
network). It records every request so tests can assert the exact bodies
(tenant filter, routing) the POS sends.

  catalog   {oracle_id: catalog _source}, built with tcg_search.docs.catalog_doc
  listings  {_id: {"routing": tenant, "doc": _source}}
  search_response  canned raw response for "real" search queries (the ones
                   tcg_search.query builds); lookups the indexer and the
                   routes make (printing -> card, tenant ids, in-stock
                   annotation, mget) are answered from the dicts above.
"""

import json
import uuid
from typing import Any

import httpx
from tcg_search.client import OpenSearch
from tcg_search.docs import catalog_doc

CATALOG = "catalog"
LISTINGS = "listings"
LISTINGS_INDEX = "listings-20261010-000000000"


def printing_row(pid, set_code, number, *, rarity="common", released="2020-01-01",
                 nonfoil=None, finishes=("nonfoil", "foil"), digital=False):
    return {
        "id": str(pid), "set_code": set_code, "set_name": set_code.upper() + " Set",
        "set_type": "expansion", "collector_number": number, "rarity": rarity, "lang": "en",
        "released_at": released, "artist": "Someone", "finishes": list(finishes),
        "promo": False, "digital": digital,
        "image_small": f"https://img.test/{set_code}/{number}/s.jpg",
        "image_normal": f"https://img.test/{set_code}/{number}/n.jpg",
        "price_nonfoil_cents": nonfoil, "price_nonfoil_source": "mtgjson_tcgplayer" if nonfoil
        else None,
        "price_foil_cents": None, "price_foil_source": None,
        "price_etched_cents": None, "price_etched_source": None,
    }


def card_row(name, printings, *, oracle_id=None, type_line="Instant", rank=100, **kw):
    row = {
        "oracle_id": str(oracle_id or uuid.uuid5(uuid.NAMESPACE_URL, f"pos-test/{name}")),
        "name": name, "mana_cost": "{R}", "mana_value": 1, "type_line": type_line,
        "oracle_text": f"{name} does a thing.", "colors": ["R"], "color_identity": ["R"],
        "keywords": [], "power": None, "toughness": None, "loyalty": None, "defense": None,
        "produced_mana": None, "layout": "normal", "legalities": {"modern": "legal"},
        "card_faces": None, "reserved": False, "edhrec_rank": rank, "printings": printings,
    }
    row.update(kw)
    return row


class FakeOpenSearch:
    def __init__(self):
        self.catalog: dict[str, dict[str, Any]] = {}
        self.listings: dict[str, dict[str, Any]] = {}
        self.aliases = {CATALOG: "catalog-1", LISTINGS: LISTINGS_INDEX}
        self.requests: list[dict[str, Any]] = []
        self.search_response: dict[str, Any] = {"took": 3, "hits": {"total": {"value": 0},
                                                                     "hits": []}}
        self.down = False
        self.fail_ids: set[str] = set()  # bulk items that fail with a 400

    # --- setup helpers -----------------------------------------------------------

    def add_card(self, row) -> dict[str, Any]:
        doc = catalog_doc(row)
        self.catalog[doc["oracle_id"]] = doc
        return doc

    def client(self) -> OpenSearch:
        return OpenSearch("http://os.test", transport=httpx.MockTransport(self.handler))

    def searches(self, index=None):
        return [r for r in self.requests if r["op"] == "_search"
                and (index is None or r["index"] == index)]

    def bulk_requests(self):
        return [r for r in self.requests if r["op"] == "_bulk"]

    # --- transport ------------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        parts = [p for p in request.url.path.split("/") if p]
        params = dict(request.url.params)
        if request.method == "GET" and parts[0] == "_alias":
            target = self.aliases.get(parts[1])
            if target is None:
                return httpx.Response(404, json={"error": "alias missing", "status": 404})
            return httpx.Response(200, json={target: {"aliases": {parts[1]: {}}}})
        op = parts[-1]
        index = parts[0] if len(parts) > 1 else None
        if op == "_bulk":
            lines = [json.loads(x) for x in request.content.decode().splitlines() if x]
            self.requests.append({"op": op, "index": index, "params": params, "lines": lines})
            return self._bulk(lines)
        body = json.loads(request.content) if request.content else {}
        self.requests.append({"op": op, "index": index, "params": params, "body": body})
        if index in (CATALOG, LISTINGS) and self.aliases.get(index) is None:
            return httpx.Response(404, json={"error": {"type": "index_not_found_exception",
                                                       "reason": "no such index"}})
        if op == "_mget":
            docs = [{"_id": i, "found": i in self.catalog, **(
                {"_source": self.catalog[i]} if i in self.catalog else {})} for i in body["ids"]]
            return httpx.Response(200, json={"docs": docs})
        if op == "_search":
            return httpx.Response(200, json=self._search(index, body, params))
        return httpx.Response(400, json={"error": f"fake: unsupported {request.method} "
                                                  f"{request.url.path}"})

    def _hits(self, docs):
        return {"took": 1, "hits": {"total": {"value": len(docs)}, "hits": docs}}

    def _search(self, index, body, params):
        query = body.get("query", {})
        nested_terms = (query.get("nested", {}).get("query", {}).get("terms", {})
                        .get("printings.printing_id"))
        if index == CATALOG and nested_terms is not None:  # indexer: printing -> card
            want = set(nested_terms)
            return self._hits([
                {"_id": oid, "_source": src} for oid, src in self.catalog.items()
                if want & {p["printing_id"] for p in src.get("printings", [])}])
        filters = query.get("bool", {}).get("filter", [])
        if index == LISTINGS and body.get("_source") is False:  # indexer: tenant's doc ids
            tenant = filters[0]["term"]["tenant_id"]
            ids = sorted(i for i, d in self.listings.items() if d["doc"]["tenant_id"] == tenant)
            return self._hits([{"_id": i, "sort": [i]} for i in ids])
        if index == LISTINGS and any("terms" in f and "oracle_id" in f["terms"]
                                     for f in filters):  # route: in-stock annotation
            tenant = filters[0]["term"]["tenant_id"]
            oids = next(f["terms"]["oracle_id"] for f in filters if "terms" in f)
            return self._hits([{"_id": i, "_source": d["doc"]} for i, d in self.listings.items()
                               if d["doc"]["tenant_id"] == tenant
                               and d["doc"]["oracle_id"] in oids])
        return self.search_response

    def _bulk(self, lines):
        items = []
        i = 0
        while i < len(lines):
            (op, meta), = lines[i].items()
            doc = lines[i + 1] if op != "delete" else None
            i += 1 if op == "delete" else 2
            _id = meta["_id"]
            if _id in self.fail_ids:
                items.append({op: {"_id": _id, "status": 400, "error": {"type": "fake"}}})
                continue
            if op == "delete":
                found = self.listings.pop(_id, None)
                items.append({op: {"_id": _id, "status": 200 if found else 404}})
            else:
                assert meta.get("routing"), "listings writes must be routed"
                self.listings[_id] = {"routing": meta["routing"], "doc": doc}
                items.append({op: {"_id": _id, "status": 201}})
        return httpx.Response(200, json={"errors": False, "items": items})
