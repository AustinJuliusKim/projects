// Permission gating for the UI. The server is the authority (every route
// checks); this only hides what the user certainly can't use.
//
// Where perms come from:
//   register mode  POST /v1/register/sessions returns the user's perms.
//   back office    GET /v1/me gives each store's role key but not its perms,
//                  and GET /v1/roles needs staff.manage. So: the roles list
//                  when we have it (it covers store-defined roles), else a
//                  mirror of the system roles seeded in migrations/0011,
//                  else null = unknown (show everything; the API decides).

// Mirrors services/tcg-pos-api/src/tcg_pos_api/auth/perms.py.
export const ALL_PERMS = [
  "pos.sell",
  "pos.discount",
  "pos.price_override",
  "pos.refund",
  "pos.void",
  "pos.drawer_open",
  "credit.read",
  "credit.issue",
  "credit.adjust",
  "buylist.create",
  "buylist.payout_credit",
  "buylist.payout_cash",
  "inventory.read",
  "inventory.adjust",
  "inventory.price_edit",
  "pricing.rules_manage",
  "imports.run",
  "web_orders.read",
  "web_orders.fulfill",
  "storefront.manage",
  "customers.read",
  "customers.manage",
  "reports.view",
  "audit.read",
  "staff.manage",
  "roles.manage",
  "registers.manage",
  "apikeys.manage",
  "channels.manage",
  "settings.manage",
  "billing.manage",
  "approve.override",
];

const MANAGER_EXCLUDED = ["billing.manage", "roles.manage", "channels.manage", "apikeys.manage"];

// Mirrors the system role seeds in migrations/0011_rbac.sql.
export const SYSTEM_ROLE_PERMS = {
  owner: ALL_PERMS,
  manager: ALL_PERMS.filter((p) => !MANAGER_EXCLUDED.includes(p)),
  buyer: [
    "buylist.create",
    "buylist.payout_credit",
    "buylist.payout_cash",
    "inventory.read",
    "inventory.adjust",
    "inventory.price_edit",
    "imports.run",
    "credit.read",
    "credit.issue",
    "customers.read",
    "pos.sell",
  ],
  cashier: [
    "pos.sell",
    "pos.discount",
    "inventory.read",
    "credit.read",
    "customers.read",
    "web_orders.read",
    "web_orders.fulfill",
  ],
};

// A Set of the role's perms, or null when unknown.
export function permsForRole(roleKey, roles = null) {
  if (Array.isArray(roles)) {
    const role = roles.find((r) => r.key === roleKey);
    if (role) return new Set(role.perms);
  }
  const system = SYSTEM_ROLE_PERMS[roleKey];
  return system ? new Set(system) : null;
}

// null (unknown) allows: the API answers 403 if it was wrong to.
export function can(perms, perm) {
  if (!perm) return true;
  return perms === null || perms === undefined || perms.has(perm);
}

// `perm` hides the page without it; `surfaces` limits where it appears.
export const NAV = [
  { value: "inventory", label: "Inventory", perm: "inventory.read" },
  { value: "receive", label: "Receive", perm: "inventory.adjust" },
  { value: "import", label: "Import", perm: "imports.run" },
  { value: "credit", label: "Store credit", perm: "credit.read" },
  { value: "team", label: "Team", perm: "staff.manage", surfaces: ["backoffice"] },
  { value: "registers", label: "Registers", perm: "registers.manage", surfaces: ["backoffice"] },
  { value: "apikeys", label: "API keys", perm: "apikeys.manage", surfaces: ["backoffice"] },
  // PUT /v1/me/pin is for a person signed in with their own account.
  { value: "pin", label: "My PIN", surfaces: ["backoffice"] },
];

// Admin perms a register session or an API key never holds, whatever the
// role (mirrors services/tcg-pos-api/src/tcg_pos_api/auth/perms.py
// ADMIN_PERMS): the API strips them from register sessions and answers 403
// {missing, reason: "back_office_only"}. A person signs in to the back
// office with their own account for these.
export const ADMIN_PERMS = [
  "staff.manage",
  "roles.manage",
  "registers.manage",
  "apikeys.manage",
  "billing.manage",
  "settings.manage",
  "channels.manage",
  "storefront.manage",
  "pricing.rules_manage",
];
export const DEVICE_FORBIDDEN_PERMS = ADMIN_PERMS;

// A register session's perms as the UI should use them: whatever the
// sign-in response said, minus the back-office-only perms.
export function registerPerms(perms) {
  return new Set((perms || []).filter((p) => !DEVICE_FORBIDDEN_PERMS.includes(p)));
}

export function visibleNav(perms, surface) {
  return NAV.filter(
    (n) =>
      (!n.surfaces || n.surfaces.includes(surface)) &&
      !(surface === "register" && DEVICE_FORBIDDEN_PERMS.includes(n.perm)) &&
      can(perms, n.perm),
  );
}

// The current page if it's still visible, else the first visible one.
export function settlePage(page, nav) {
  if (nav.some((n) => n.value === page)) return page;
  return nav.length ? nav[0].value : null;
}

// Mirror of the API's escalation rule (routes/staff.check_grantable): may
// someone with `myPerms` / `myRole` grant (or manage holders of) `role`?
// Used to filter the role menus; the API still decides.
export function canGrant(role, myPerms, myRole) {
  if (!role) return false;
  if (role.is_system && role.key === "owner" && myRole !== "owner") return false;
  if (!myPerms) return true;
  return role.perms.every((p) => myPerms.has(p));
}

// Mirrors auth/perms.API_KEY_FORBIDDEN: admin perms an API key can never
// hold (the register's set, plus approving).
export const KEY_FORBIDDEN_PERMS = [...ADMIN_PERMS, "approve.override"];

// Perms the caller may put on a new API key: theirs, minus the forbidden.
export function keyGrantablePerms(myPerms) {
  return ALL_PERMS.filter((p) => !KEY_FORBIDDEN_PERMS.includes(p) && can(myPerms, p));
}
