import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_PERMS,
  can,
  canGrant,
  DEVICE_FORBIDDEN_PERMS,
  keyGrantablePerms,
  KEY_FORBIDDEN_PERMS,
  permsForRole,
  settlePage,
  registerPerms,
  visibleNav,
} from "../src/perms.js";

const pages = (perms, surface) => visibleNav(perms, surface).map((n) => n.value);

test("permsForRole: roles list first, then the system mirror, else unknown", () => {
  assert.equal(permsForRole("owner").size, ALL_PERMS.length);
  assert.ok(!permsForRole("manager").has("apikeys.manage"));
  assert.ok(permsForRole("manager").has("staff.manage"));
  assert.ok(permsForRole("cashier").has("pos.sell"));
  const roles = [{ key: "closer", perms: ["inventory.read"] }];
  assert.deepEqual([...permsForRole("closer", roles)], ["inventory.read"]);
  assert.equal(permsForRole("closer"), null);
  assert.ok(can(null, "anything"));
  assert.ok(!can(new Set(), "x"));
  assert.ok(can(new Set(), null));
});

test("nav is gated by perms and surface", () => {
  assert.deepEqual(pages(permsForRole("owner"), "backoffice"), [
    "inventory", "receive", "import", "credit", "team", "registers", "apikeys", "pin",
  ]);
  assert.deepEqual(pages(permsForRole("manager"), "backoffice"), [
    "inventory", "receive", "import", "credit", "team", "registers", "pin",
  ]);
  assert.deepEqual(pages(permsForRole("cashier"), "backoffice"), ["inventory", "credit", "pin"]);
  // At the register: no account pages, whatever the role.
  assert.deepEqual(pages(permsForRole("cashier"), "register"), ["inventory", "credit"]);
  assert.deepEqual(pages(permsForRole("owner"), "register"), ["inventory", "receive", "import", "credit"]);
  // Unknown perms: show everything, the API decides.
  assert.equal(pages(null, "backoffice").length, 8);
});

test("a register session never shows or holds back-office-only perms", () => {
  // Even if a stale or hand-edited session claims every perm.
  const perms = registerPerms(ALL_PERMS);
  for (const p of DEVICE_FORBIDDEN_PERMS) assert.ok(!perms.has(p), p);
  assert.ok(perms.has("pos.sell") && perms.has("imports.run") && perms.has("approve.override"));
  assert.deepEqual(pages(perms, "register"), ["inventory", "receive", "import", "credit"]);
  // Unknown perms on a register still hide admin pages.
  const admin = pages(null, "register");
  for (const page of ["team", "registers", "apikeys", "pin"]) assert.ok(!admin.includes(page), page);
  assert.ok(KEY_FORBIDDEN_PERMS.includes("approve.override"));
  for (const p of DEVICE_FORBIDDEN_PERMS) assert.ok(KEY_FORBIDDEN_PERMS.includes(p), p);
});

test("settlePage keeps a visible page or falls back", () => {
  const nav = visibleNav(permsForRole("cashier"), "register");
  assert.equal(settlePage("credit", nav), "credit");
  assert.equal(settlePage("team", nav), "inventory");
  assert.equal(settlePage("team", []), null);
});

test("canGrant mirrors the API's escalation rule", () => {
  const owner = { key: "owner", is_system: true, perms: ALL_PERMS };
  const cashier = { key: "cashier", is_system: true, perms: ["pos.sell"] };
  const manager = permsForRole("manager");
  assert.ok(!canGrant(owner, manager, "manager"));
  assert.ok(canGrant(owner, permsForRole("owner"), "owner"));
  assert.ok(canGrant(cashier, manager, "manager"));
  assert.ok(!canGrant({ key: "x", is_system: false, perms: ["billing.manage"] }, manager, "manager"));
  assert.ok(!canGrant(null, manager, "manager"));
});

test("keyGrantablePerms drops admin perms and ones you lack", () => {
  const owner = keyGrantablePerms(permsForRole("owner"));
  for (const p of KEY_FORBIDDEN_PERMS) assert.ok(!owner.includes(p));
  assert.ok(owner.includes("inventory.read"));
  assert.deepEqual(keyGrantablePerms(new Set(["inventory.read", "staff.manage"])), ["inventory.read"]);
});
