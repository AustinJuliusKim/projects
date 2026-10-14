"""Every route either is deliberately public, is a signed-in-user route with
no store (an explicit short list), or declares exactly one permission with
require(Perm.X). A new route that does none of these fails here. No
database needed."""

import pytest

from conftest import api_routes, dependency_calls
from tcg_pos_api.auth import dev as dev_auth
from tcg_pos_api.auth.principal import _tenant_session, _user_session

# No authentication at all.
PUBLIC = {
    ("GET", "/v1/health"),
    ("POST", "/v1/dev/login"),  # mounted only for the dev issuer (ENV=local/test)
    ("GET", "/v1/storefront/{slug}"),
    ("GET", "/v1/storefront/{slug}/offers"),
    ("GET", "/v1/storefront/{slug}/search"),
    ("GET", "/v1/storefront/{slug}/autocomplete"),
    ("GET", "/v1/storefront/{slug}/cards/{oracle_id}"),
    ("POST", "/v1/storefront/{slug}/cart/quote"),
    ("POST", "/v1/storefront/{slug}/orders"),
    ("GET", "/v1/storefront/{slug}/orders/{order_id}"),
    ("GET", "/"),
}
# Signed in, but no store selected and no permission (auth.UserConn).
USER_ONLY = {
    ("GET", "/v1/me"),
    ("POST", "/v1/stores"),
    ("POST", "/v1/invites/accept"),
}


@pytest.fixture(scope="module")
def app():
    """The app as local dev runs it (dev issuer), so /v1/dev/login is
    included in the walk too."""
    mp = pytest.MonkeyPatch()
    mp.setenv("AUTH_ISSUER", dev_auth.DEV_ISSUER)
    mp.delenv("AUTH_CLIENT_IDS")
    mp.setenv("ENV", "test")
    from tcg_pos_api.app import create_app

    try:
        return create_app()
    finally:
        mp.undo()


def required_perms(dependant):
    return [c.required_perm for c in dependency_calls(dependant) if hasattr(c, "required_perm")]


def test_every_route_is_public_user_only_or_declares_one_permission(app):
    seen = set()
    for method, path, dependant in api_routes(app):
        key = (method, path)
        seen.add(key)
        calls = set(dependency_calls(dependant))
        perms = required_perms(dependant)
        if key in PUBLIC:
            assert not perms and _tenant_session not in calls and _user_session not in calls, key
        elif key in USER_ONLY:
            assert not perms and _user_session in calls and _tenant_session not in calls, key
        else:
            assert len(set(perms)) == 1, f"{key} must declare exactly one require(Perm.X)"
            assert _tenant_session in calls, key
    # The allowlists name real routes (no stale entries).
    assert (PUBLIC | USER_ONLY) - seen == set()


def test_the_dev_login_route_is_absent_for_a_real_issuer():
    from tcg_pos_api.app import create_app

    keys = {(method, path) for method, path, _ in api_routes(create_app())}
    assert ("POST", "/v1/dev/login") not in keys
