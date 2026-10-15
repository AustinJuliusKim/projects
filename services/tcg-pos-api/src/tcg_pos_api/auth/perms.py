"""The permission vocabulary. migrations/0011_rbac.sql seeds the same keys
into the `permission` table (a test asserts the two are equal); system roles
grant subsets of them there. Routes declare one with deps.require()."""

from enum import StrEnum


class Perm(StrEnum):
    POS_SELL = "pos.sell"
    POS_DISCOUNT = "pos.discount"
    POS_PRICE_OVERRIDE = "pos.price_override"
    POS_REFUND = "pos.refund"
    POS_VOID = "pos.void"
    POS_DRAWER_OPEN = "pos.drawer_open"
    CREDIT_READ = "credit.read"
    CREDIT_ISSUE = "credit.issue"
    CREDIT_ADJUST = "credit.adjust"
    BUYLIST_CREATE = "buylist.create"
    BUYLIST_PAYOUT_CREDIT = "buylist.payout_credit"
    BUYLIST_PAYOUT_CASH = "buylist.payout_cash"
    INVENTORY_READ = "inventory.read"
    INVENTORY_ADJUST = "inventory.adjust"
    INVENTORY_PRICE_EDIT = "inventory.price_edit"
    PRICING_RULES_MANAGE = "pricing.rules_manage"
    IMPORTS_RUN = "imports.run"
    WEB_ORDERS_READ = "web_orders.read"
    WEB_ORDERS_FULFILL = "web_orders.fulfill"
    STOREFRONT_MANAGE = "storefront.manage"
    CUSTOMERS_READ = "customers.read"
    CUSTOMERS_MANAGE = "customers.manage"
    REPORTS_VIEW = "reports.view"
    AUDIT_READ = "audit.read"
    STAFF_MANAGE = "staff.manage"
    ROLES_MANAGE = "roles.manage"
    REGISTERS_MANAGE = "registers.manage"
    APIKEYS_MANAGE = "apikeys.manage"
    CHANNELS_MANAGE = "channels.manage"
    SETTINGS_MANAGE = "settings.manage"
    BILLING_MANAGE = "billing.manage"
    APPROVE_OVERRIDE = "approve.override"


# --- what a non-person principal may never use ----------------------------------
#
# A register session (Device + PIN) and an API key are not "a person at their
# own sign-in": a register is a shared machine that anyone at the counter can
# reach once someone has signed in on it, and a key is a long-lived secret in
# some integration. Neither administers the store. These sets are subtracted
# from the principal's perms when it is resolved (auth/principal.py), so a
# new route guarded by require(Perm.X) inherits the rule, and require()
# answers 403 {"missing": perm, "reason": "back_office_only"} for them.
#
#   people, credentials and the account: staff.manage, roles.manage,
#     registers.manage, apikeys.manage, billing.manage
#   store-wide configuration: settings.manage, channels.manage,
#     storefront.manage (the public web store's settings), and
#     pricing.rules_manage (one rule reprices the whole store's suggestions)
#
# Counter work stays available on a register, including imports.run (stock
# intake is counter work, and the same rows can be written one at a time
# with inventory.adjust / inventory.price_edit anyway) and approve.override
# (approvals check the approver's own membership, not the session's).
ADMIN_PERMS = frozenset(
    {
        Perm.STAFF_MANAGE,
        Perm.ROLES_MANAGE,
        Perm.REGISTERS_MANAGE,
        Perm.APIKEYS_MANAGE,
        Perm.BILLING_MANAGE,
        Perm.SETTINGS_MANAGE,
        Perm.CHANNELS_MANAGE,
        Perm.STOREFRONT_MANAGE,
        Perm.PRICING_RULES_MANAGE,
    }
)

DEVICE_FORBIDDEN = ADMIN_PERMS
# A key can't approve anything either (approvals are a person's PIN).
API_KEY_FORBIDDEN = ADMIN_PERMS | {Perm.APPROVE_OVERRIDE}

_FORBIDDEN_BY_KIND = {"device": DEVICE_FORBIDDEN, "apikey": API_KEY_FORBIDDEN}


def forbidden_for(kind: str) -> frozenset[str]:
    """Permissions a principal of this kind (user | device | apikey) never
    holds, whatever its role or key says."""
    return frozenset(str(p) for p in _FORBIDDEN_BY_KIND.get(kind, ()))
