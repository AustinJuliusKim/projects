"""Authentication (who: a verified access token, or a register device plus a
PIN session) and authorization (what: memberships, roles, permissions and
approval policies in Postgres). See docs/AUTH_PLAN.md."""

from tcg_pos_api.auth.perms import Perm
from tcg_pos_api.auth.principal import (
    DeviceConn,
    DeviceSession,
    MemberSession,
    Principal,
    RegisterSession,
    Session,
    TenantSession,
    UserConn,
    UserSession,
    require,
)

__all__ = [
    "DeviceConn",
    "DeviceSession",
    "MemberSession",
    "Perm",
    "Principal",
    "RegisterSession",
    "Session",
    "TenantSession",
    "UserConn",
    "UserSession",
    "require",
]
