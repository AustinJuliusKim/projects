"""Role x endpoint permission matrix, driven by fixtures/perm_matrix.yaml.
Skipped without TEST_DATABASE_URL (the matrix-vs-routes check runs anyway)."""

import uuid
from pathlib import Path

import pytest
import yaml

from conftest import api_routes, dependency_calls, headers, requires_db

FIXTURES = Path(__file__).parent / "fixtures"
MATRIX = yaml.safe_load((FIXTURES / "perm_matrix.yaml").read_text())
ROLES = MATRIX["roles"]
ENDPOINTS = MATRIX["endpoints"]
CSV = (FIXTURES / "tcgplayer_inventory.csv").read_bytes()


def _route(ep):
    return (ep["method"], ep.get("route", ep["path"]))


def _fill(value, slots):
    if isinstance(value, str):
        for k, v in slots.items():
            value = value.replace("{" + k + "}", str(v))
        return value
    if isinstance(value, dict):
        return {k: _fill(v, slots) for k, v in value.items()}
    return value


def _declared_perms():
    from tcg_pos_api.app import create_app

    out = {}
    for method, path, dependant in api_routes(create_app()):
        perms = {
            str(c.required_perm) for c in dependency_calls(dependant) if hasattr(c, "required_perm")
        }
        if perms:
            assert len(perms) == 1, (method, path)
            out[(method, path)] = perms.pop()
    return out


def test_matrix_names_every_guarded_route_with_its_declared_perm():
    from_yaml = {_route(ep): ep["perm"] for ep in ENDPOINTS}
    assert len(from_yaml) == len(ENDPOINTS), "duplicate endpoint rows"
    assert from_yaml == _declared_perms()
    for ep in ENDPOINTS:
        assert set(ep["allow"]) <= set(ROLES), ep


@requires_db
def test_matrix_allow_lists_match_the_seeded_roles(migrated_db, admin_conn):
    grants = {}
    for r in admin_conn.execute(
        "SELECT r.key, rp.perm FROM role r JOIN role_permission rp ON rp.role_id = r.id "
        "WHERE r.tenant_id IS NULL"
    ):
        grants.setdefault(r["key"], set()).add(r["perm"])
    assert set(grants) == set(ROLES)
    approvals = {}
    for r in admin_conn.execute(
        "SELECT r.key, ap.perm FROM approval_policy ap JOIN role r ON r.id = ap.role_id "
        "WHERE ap.tenant_id IS NULL AND ap.mode = 'approval'"
    ):
        approvals.setdefault(r["key"], set()).add(r["perm"])
    for ep in ENDPOINTS:
        assert set(ep["allow"]) == {role for role in ROLES if ep["perm"] in grants[role]}, ep
        if any(ep["perm"] in perms for perms in approvals.values()) or "approval" in ep:
            assert set(ep.get("approval", [])) == {
                role for role in ROLES if ep["perm"] in approvals.get(role, set())
            }, ep


@requires_db
@pytest.mark.parametrize(
    "ep,role",
    [(ep, role) for ep in ENDPOINTS for role in ROLES],
    ids=[
        f"{ep['method']} {ep.get('route', ep['path'])} as {role}"
        for ep in ENDPOINTS
        for role in ROLES
    ],
)
def test_role_can_or_cannot_call_endpoint(client, make_tenant, fake_catalog, admin_conn, ep, role):
    t = make_tenant()
    item = admin_conn.execute(
        "INSERT INTO inventory_item (tenant_id, location_id, printing_id, condition, finish, qty) "
        "VALUES (%s, %s, gen_random_uuid(), 'NM', 'foil', 1) RETURNING id",
        (t["id"], t["location_id"]),
    ).fetchone()["id"]
    slots = {
        "location_id": t["location_id"],
        "customer_id": t["customer_id"],
        "item_id": item,
        "uuid": uuid.uuid4(),
        "hex": uuid.uuid4().hex[:10],
    }
    h = headers(t, actor=f"matrix-{role}", role=role)
    kwargs = {}
    if ep.get("csv"):
        kwargs["content"] = CSV
        h["Content-Type"] = "text/csv"
    elif "body" in ep:
        kwargs["json"] = _fill(ep["body"], slots)
    resp = client.request(ep["method"], _fill(ep["path"], slots), headers=h, **kwargs)
    if role in ep["allow"]:
        assert resp.status_code in ep["expect"], resp.text
    elif role in ep.get("approval", []):
        assert resp.status_code == 403, resp.text
        detail = resp.json()["detail"]
        assert detail["approval_required"] == ep["perm"], detail
        assert len(detail["payload_hash"]) == 64
    else:
        assert resp.status_code == 403, resp.text
        assert resp.json() == {"detail": {"missing": ep["perm"]}}
