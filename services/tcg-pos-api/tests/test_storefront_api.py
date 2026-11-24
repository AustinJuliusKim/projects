"""Public storefront API (/v1/storefront/{slug}): slug resolution, live
offers, cart quote, reserve orders, caps and rate limits. Staff order
handling and expiry are in test_web_orders.py. Skipped without
TEST_DATABASE_URL."""

import datetime
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from conftest import headers, item_qty, public_headers, requires_db

pytestmark = requires_db


def order_body(lines, *, key=None, email="Pat@Example.com", **extra):
    body = {
        "idempotency_key": key or uuid.uuid4().hex,
        "customer": {"name": "  Pat Doe ", "email": email, "phone": "555-0100"},
        "lines": [
            {"inventory_item_id": str(item), "qty": qty, **({"unit_price_cents": p} if p else {})}
            for item, qty, *rest in lines
            for p in [rest[0] if rest else None]
        ],
    }
    body.update(extra)
    return body


def place(client, shop, lines, **kw):
    return client.post(f"{shop['base']}/orders", json=order_body(lines, **kw),
                       headers=public_headers())


# --- store resolution --------------------------------------------------------------


def test_store_info(client, make_shop):
    shop = make_shop(policy_text="No returns")
    resp = client.get(shop["base"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "slug": shop["slug"],
        "display_name": "Test Store",
        "pickup_location": {"id": str(shop["tenant"]["location_id"]), "name": "Main"},
        "pickup_text": "Front counter",
        "policy_text": "No returns",
        "reservation_hours": 48,
    }
    assert client.get(f"/v1/storefront/{shop['slug'].upper()}").status_code == 200


def test_unknown_unpublished_and_malformed_slugs_404(client, make_shop):
    hidden = make_shop(published=False)
    for slug in (hidden["slug"], "no-such-store-here", "x", "bad_slug!", "a" * 41):
        resp = client.get(f"/v1/storefront/{slug}")
        assert resp.status_code == 404, slug
        assert resp.json() == {"detail": "no such store"}
    resp = client.post(f"{hidden['base']}/cart/quote", json={"lines": []},
                       headers=public_headers())
    assert resp.status_code == 404


def test_forged_tenant_header_is_ignored(client, make_shop):
    a, b = make_shop("A"), make_shop("B")
    printing = uuid.uuid4()
    a_item = a["stock"](3, 100, printing_id=printing)
    b_item = b["stock"](5, 999, printing_id=printing)
    forged = {**public_headers(), "X-Tenant-Id": str(b["tenant"]["id"])}

    resp = client.get(f"{a['base']}/offers", params={"printing_id": str(printing)},
                      headers=forged)
    assert [o["inventory_item_id"] for o in resp.json()["offers"]] == [str(a_item)]
    resp = client.post(
        f"{a['base']}/cart/quote",
        json={"lines": [{"inventory_item_id": str(b_item), "qty": 1}]},
        headers=forged,
    )
    assert resp.json()["lines"][0]["status"] == "not_found"
    resp = client.post(f"{a['base']}/orders", json=order_body([(b_item, 1)]), headers=forged)
    assert resp.status_code == 409
    assert resp.json()["detail"]["issues"][0]["status"] == "not_found"
    # Garbage tenant header doesn't matter either: it's never parsed here.
    assert client.get(a["base"], headers={"X-Tenant-Id": "not-a-uuid"}).status_code == 200


# --- offers ---------------------------------------------------------------------------


def test_offers_are_priced_web_available_at_the_web_location(client, make_shop, admin_conn):
    shop = make_shop(holdback_copies=1)
    t = shop["tenant"]
    annex = admin_conn.execute(
        "INSERT INTO location (tenant_id, name) VALUES (%s, 'Annex') RETURNING id", (t["id"],)
    ).fetchone()["id"]
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    lp = shop["stock"](3, 80, printing_id=p1, condition="LP")
    nm = shop["stock"](2, 100, printing_id=p1)
    shop["stock"](1, 100, printing_id=p1, finish="foil")  # held back entirely
    shop["stock"](5, None, printing_id=p1, condition="MP")  # unpriced: never listed
    shop["stock"](9, 100, printing_id=p1, condition="HP", location_id=annex)  # not web
    foil = shop["stock"](4, 500, printing_id=p2, finish="foil")

    resp = client.get(f"{shop['base']}/offers",
                      params={"printing_id": [str(p1), str(p2), str(uuid.uuid4())]})
    assert resp.status_code == 200, resp.text
    offers = resp.json()["offers"]
    got = [(o["inventory_item_id"], o["condition"], o["available"], o["price_cents"])
           for o in offers]
    by_printing = {str(p1): [(str(nm), "NM", 1, 100), (str(lp), "LP", 2, 80)],
                   str(p2): [(str(foil), "NM", 3, 500)]}
    assert sorted(got) == sorted(by_printing[str(p1)] + by_printing[str(p2)])
    # Within a printing: NM before LP.
    p1_offers = [o["condition"] for o in offers if o["printing_id"] == str(p1)]
    assert p1_offers == ["NM", "LP"]


def test_offers_validation(client, make_shop):
    shop = make_shop()
    assert client.get(f"{shop['base']}/offers").status_code == 422
    too_many = [str(uuid.uuid4()) for _ in range(101)]
    assert client.get(f"{shop['base']}/offers",
                      params={"printing_id": too_many}).status_code == 422
    assert client.get(f"{shop['base']}/offers",
                      params={"printing_id": "nope"}).status_code == 422


def test_storefront_offers_function_shape(make_shop):
    """The helper M6's card page calls: grouped by printing, holdback applied."""
    from conftest import app_conn
    from tcg_pos_api.storefront import Storefront, storefront_offers

    shop = make_shop(holdback_pct=50)
    printing = uuid.uuid4()
    item = shop["stock"](4, 250, printing_id=printing)
    store = Storefront(
        tenant_id=shop["tenant"]["id"], slug=shop["slug"], display_name="x",
        location_id=shop["tenant"]["location_id"], holdback_copies=0, holdback_pct=50,
        reservation_hours=48, pickup_text=None, policy_text=None,
    )
    with app_conn(shop["tenant"]["id"]) as conn:
        out = storefront_offers(conn, store, [printing, uuid.uuid4()])
        assert storefront_offers(conn, store, []) == {}
        with pytest.raises(ValueError):
            storefront_offers(conn, store, [uuid.uuid4() for _ in range(501)])
    assert list(out) == [printing]
    assert out[printing] == [{
        "inventory_item_id": item, "printing_id": printing, "game": "mtg", "condition": "NM",
        "finish": "nonfoil", "lang": "en", "price_cents": 250, "available": 2,
    }]


# --- cart quote -------------------------------------------------------------------------


def test_quote_flags_each_problem(client, make_shop):
    shop = make_shop(holdback_copies=1)
    ok = shop["stock"](5, 150)
    short = shop["stock"](2, 100)  # 1 web-available after holdback
    unpriced = shop["stock"](5, None)
    repriced = shop["stock"](5, 300)
    resp = client.post(
        f"{shop['base']}/cart/quote",
        json={"lines": [
            {"inventory_item_id": str(ok), "qty": 2, "unit_price_cents": 150},
            {"inventory_item_id": str(short), "qty": 2},
            {"inventory_item_id": str(unpriced), "qty": 1},
            {"inventory_item_id": str(repriced), "qty": 1, "unit_price_cents": 250},
            {"inventory_item_id": str(uuid.uuid4()), "qty": 1},
        ]},
        headers=public_headers(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert [(line["status"], line["available"]) for line in body["lines"]] == [
        ("ok", 4), ("insufficient", 1), ("not_priced", 0), ("price_changed", 4),
        ("not_found", 0),
    ]
    assert body["lines"][3]["unit_price_cents"] == 300
    assert body["total_cents"] == 300  # only ok lines count

    resp = client.post(f"{shop['base']}/cart/quote",
                       json={"lines": [{"inventory_item_id": str(ok), "qty": 4}]},
                       headers=public_headers())
    assert resp.json()["ok"] is True and resp.json()["total_cents"] == 600


# --- orders ---------------------------------------------------------------------------


def test_order_reserves_stock_with_ledger_audit_and_outbox(client, make_shop, admin_conn):
    shop = make_shop(reservation_hours=24)
    t = shop["tenant"]
    a = shop["stock"](5, 150)
    b = shop["stock"](1, 999, finish="foil")
    outbox_sql = "SELECT count(*) AS n FROM search_outbox WHERE tenant_id = %s"
    events_before = admin_conn.execute(outbox_sql, (t["id"],)).fetchone()["n"]
    resp = place(client, shop, [(a, 2, 150), (b, 1)])
    assert resp.status_code == 201, resp.text
    order = resp.json()
    assert order["status"] == "reserved" and order["customer_name"] == "Pat Doe"
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{6}", order["pickup_code"])
    assert order["total_cents"] == 2 * 150 + 999
    expires = datetime.datetime.fromisoformat(order["expires_at"])
    created = datetime.datetime.fromisoformat(order["created_at"])
    assert expires - created == datetime.timedelta(hours=24)
    assert order["store"]["slug"] == shop["slug"]
    assert sorted((line["inventory_item_id"], line["qty"], line["unit_price_cents"])
                  for line in order["lines"]) == sorted([(str(a), 2, 150), (str(b), 1, 999)])

    assert (item_qty(admin_conn, a), item_qty(admin_conn, b)) == (3, 0)
    ledger = admin_conn.execute(
        "SELECT inventory_item_id, delta, reason, channel, actor FROM inventory_ledger "
        "WHERE tenant_id = %s ORDER BY delta", (t["id"],)
    ).fetchall()
    reason = f"web_reserve:{order['id']}"
    assert [(r["inventory_item_id"], r["delta"], r["reason"], r["channel"], r["actor"])
            for r in ledger] == [
        (a, -2, reason, "web", f"storefront:{shop['slug']}"),
        (b, -1, reason, "web", f"storefront:{shop['slug']}"),
    ]
    audit = admin_conn.execute(
        "SELECT action, entity, before, after FROM audit_log WHERE tenant_id = %s", (t["id"],)
    ).fetchall()
    assert sorted(a_["action"] for a_ in audit) == [
        "web_order.create", "web_order.reserve", "web_order.reserve",
    ]
    item_audit = next(x for x in audit if x["entity"] == "inventory_item"
                      and x["before"]["id"] == str(a))
    assert (item_audit["before"]["qty"], item_audit["after"]["qty"]) == (5, 3)
    events = admin_conn.execute(outbox_sql, (t["id"],)).fetchone()["n"]
    assert events - events_before == 2  # one event per reserved line, same transaction


def test_rejected_order_writes_nothing(client, make_shop, admin_conn):
    shop = make_shop()
    t = shop["tenant"]
    a = shop["stock"](5, 150)
    b = shop["stock"](1, 100)
    tables = ("web_order", "inventory_ledger", "audit_log", "search_outbox")

    def counts():
        return [admin_conn.execute(f"SELECT count(*) AS n FROM {table} WHERE tenant_id = %s",
                                   (t["id"],)).fetchone()["n"] for table in tables]

    before = counts()
    assert before[:3] == [0, 0, 0]
    resp = place(client, shop, [(a, 1), (b, 2)])
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert [(i["inventory_item_id"], i["status"], i["available"]) for i in detail["issues"]] == [
        (str(b), "insufficient", 1)
    ]
    assert (item_qty(admin_conn, a), item_qty(admin_conn, b)) == (5, 1)
    assert counts() == before
    # A stale expected price is also a rejection, not a silent re-price.
    resp = place(client, shop, [(a, 1, 149)])
    assert resp.status_code == 409
    assert resp.json()["detail"]["issues"][0]["status"] == "price_changed"


def test_holdback_respected_in_orders(client, make_shop, admin_conn):
    shop = make_shop(holdback_copies=1, holdback_pct=0)
    last = shop["stock"](1, 100)
    two = shop["stock"](2, 100)
    resp = place(client, shop, [(last, 1)])
    assert resp.status_code == 409
    assert resp.json()["detail"]["issues"][0]["status"] == "insufficient"
    assert place(client, shop, [(two, 2)]).status_code == 409
    assert place(client, shop, [(two, 1)]).status_code == 201
    assert (item_qty(admin_conn, last), item_qty(admin_conn, two)) == (1, 1)


def test_idempotent_replay_returns_the_same_order(client, make_shop, admin_conn):
    shop = make_shop()
    a = shop["stock"](5, 100)
    body = order_body([(a, 2)])
    first = client.post(f"{shop['base']}/orders", json=body, headers=public_headers())
    second = client.post(f"{shop['base']}/orders", json=body, headers=public_headers())
    assert (first.status_code, second.status_code) == (201, 200)
    assert first.json() == second.json()
    assert item_qty(admin_conn, a) == 3
    # Same key, different cart: refused, nothing reserved.
    other = order_body([(a, 1)], key=body["idempotency_key"])
    resp = client.post(f"{shop['base']}/orders", json=other, headers=public_headers())
    assert resp.status_code == 409 and "idempotency_key" in resp.json()["detail"]["message"]
    assert item_qty(admin_conn, a) == 3
    # The same key at another store is a different order.
    shop2 = make_shop()
    b = shop2["stock"](1, 100)
    resp = client.post(f"{shop2['base']}/orders", json=order_body(
        [(b, 1)], key=body["idempotency_key"]), headers=public_headers())
    assert resp.status_code == 201


def test_concurrent_replays_of_one_key_reserve_once(client, make_shop, admin_conn):
    shop = make_shop()
    a = shop["stock"](10, 100)
    body = order_body([(a, 3)])

    def go(_):
        return client.post(f"{shop['base']}/orders", json=body, headers=public_headers())

    with ThreadPoolExecutor(max_workers=6) as pool:
        resps = list(pool.map(go, range(6)))
    assert sorted(r.status_code for r in resps) == [200] * 5 + [201]
    assert len({r.json()["id"] for r in resps}) == 1
    assert item_qty(admin_conn, a) == 7


def test_two_reservations_of_the_last_copy_exactly_one_wins(client, make_shop, admin_conn):
    shop = make_shop()
    last = shop["stock"](1, 100)

    def go(i):
        return place(client, shop, [(last, 1)], email=f"buyer{i}@example.com").status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(go, range(8)))
    assert sorted(codes) == [201] + [409] * 7
    assert item_qty(admin_conn, last) == 0
    n = admin_conn.execute(
        "SELECT count(*) AS n FROM web_order WHERE tenant_id = %s", (shop["tenant"]["id"],)
    ).fetchone()["n"]
    assert n == 1


def test_confirmation_page_needs_the_pickup_code(client, make_shop):
    shop = make_shop()
    order = place(client, shop, [(shop["stock"](2, 100), 1)]).json()
    url = f"{shop['base']}/orders/{order['id']}"
    resp = client.get(url, params={"code": order["pickup_code"].lower()})
    assert resp.status_code == 200 and resp.json() == order
    for code in ("AAAAAA", "é", " "):
        assert client.get(url, params={"code": code}).status_code in (404, 422), code
    assert client.get(url).status_code == 422
    other = make_shop()
    resp = client.get(f"{other['base']}/orders/{order['id']}",
                      params={"code": order["pickup_code"]})
    assert resp.status_code == 404


def test_order_validation_and_caps(client, make_shop):
    shop = make_shop()
    items = [shop["stock"](50, 100) for _ in range(41)]
    a = items[0]
    bad_bodies = [
        order_body([(i, 1) for i in items]),  # 41 lines
        order_body([(a, 21)]),  # qty cap
        order_body([(a, 0)]),
        order_body([]),
        order_body([(a, 1), (a, 1)]),  # duplicate item
        order_body([(a, 1)], email="not-an-email"),
        order_body([(a, 1)], email="a@b.c\x00"),
        order_body([(a, 1)], email=("x" * 250) + "@example.com"),
        order_body([(a, 1)], key="short"),
        order_body([(a, 1)], key="has spaces in it"),
        order_body([(a, 1)], extra_field=True),
        {**order_body([(a, 1)]), "customer": {"name": " ", "email": "a@b.co"}},
        {**order_body([(a, 1)]), "customer": {"name": "a\x00", "email": "a@b.co"}},
        {**order_body([(a, 1)]), "customer": {"name": "x" * 101, "email": "a@b.co"}},
        {**order_body([(a, 1)]),
         "customer": {"name": "Pat", "email": "a@b.co", "phone": "call me maybe"}},
    ]
    for body in bad_bodies:
        resp = client.post(f"{shop['base']}/orders", json=body, headers=public_headers())
        assert resp.status_code == 422, body
    # 40 lines × 20 copies is allowed.
    ok = order_body([(i, 20) for i in items[:40]])
    assert client.post(f"{shop['base']}/orders", json=ok,
                       headers=public_headers()).status_code == 201
    quote = {"lines": [{"inventory_item_id": str(i), "qty": 1} for i in items]}
    assert client.post(f"{shop['base']}/cart/quote", json=quote,
                       headers=public_headers()).status_code == 422


# --- rate limits ------------------------------------------------------------------------


def test_public_writes_are_rate_limited_per_ip(client, make_shop, admin_conn, monkeypatch):
    shop = make_shop()
    a = shop["stock"](10, 100)
    monkeypatch.setenv("STOREFRONT_ORDER_LIMIT", "2")
    monkeypatch.setenv("STOREFRONT_QUOTE_LIMIT", "3")
    # Fixed windows: don't straddle a boundary, or the counts reset mid-test.
    from tcg_pos_api.ratelimit import WINDOW_SECONDS

    if time.time() % WINDOW_SECONDS > WINDOW_SECONDS - 10:
        time.sleep(WINDOW_SECONDS - time.time() % WINDOW_SECONDS + 0.5)
    ip = f"203.0.113.{uuid.uuid4().int % 250 + 1}"
    spoofed = {"X-Forwarded-For": f"1.2.3.4, {ip}"}  # only the last hop counts

    codes = [client.post(f"{shop['base']}/orders", json=order_body([(a, 1)]),
                         headers=spoofed).status_code for _ in range(3)]
    assert codes == [201, 201, 429]
    resp = client.post(f"{shop['base']}/orders", json=order_body([(a, 1)]),
                       headers={"X-Forwarded-For": ip})
    assert resp.status_code == 429 and int(resp.headers["Retry-After"]) >= 1
    # The 429 is decided before any reservation: stock moved twice only.
    assert item_qty(admin_conn, a) == 8
    # Rejected (409) attempts still count.
    ip2 = f"198.51.100.{uuid.uuid4().int % 250 + 1}"
    codes = [client.post(f"{shop['base']}/orders", json=order_body([(a, 99)]),
                         headers={"X-Forwarded-For": ip2}).status_code for _ in range(3)]
    assert codes == [422, 422, 429]

    quote = {"lines": [{"inventory_item_id": str(a), "qty": 1}]}
    codes = [client.post(f"{shop['base']}/cart/quote", json=quote,
                         headers={"X-Forwarded-For": ip}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]  # separate bucket from orders
    # Other IPs are unaffected; reads are never limited.
    assert client.post(f"{shop['base']}/cart/quote", json=quote,
                       headers=public_headers()).status_code == 200
    assert client.get(shop["base"], headers={"X-Forwarded-For": ip}).status_code == 200


def test_rate_counter_is_owner_only(make_tenant):
    import psycopg

    from conftest import app_conn

    t = make_tenant()
    for stmt in ("SELECT * FROM storefront_rate_counter",
                 "DELETE FROM storefront_rate_counter",
                 "SELECT prune_storefront_rate_counters()"):
        with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(stmt)
    with app_conn(None) as conn:
        first = conn.execute("SELECT storefront_rate_hit('test:x', 60) AS n").fetchone()["n"]
        second = conn.execute("SELECT storefront_rate_hit('test:x', 60) AS n").fetchone()["n"]
    assert second == first + 1


def test_staff_headers_are_not_needed_or_used(client, make_shop):
    shop = make_shop()
    resp = client.get(shop["base"], headers=headers(make_shop()["tenant"]))
    assert resp.json()["slug"] == shop["slug"]
