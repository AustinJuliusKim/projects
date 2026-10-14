import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/api.js";
import {
  ApprovalCancelled,
  approvalBody,
  approvalNeeded,
  approverChoices,
  submitApproval,
  withApproval,
} from "../src/approval.js";

const HASH = "a".repeat(64);
const required = (extra = {}) =>
  new ApiError(403, {
    detail: { approval_required: "credit.adjust", amount_cents: 500, payload_hash: HASH, ...extra },
  });

test("approvalNeeded reads the 403 and ignores other errors", () => {
  assert.deepEqual(approvalNeeded(required()), {
    perm: "credit.adjust",
    amountCents: 500,
    payloadHash: HASH,
    invalid: false,
  });
  assert.equal(approvalNeeded(required({ approval_error: "invalid" })).invalid, true);
  assert.equal(approvalNeeded(new ApiError(403, { detail: { missing: "x" } })), null);
  assert.equal(approvalNeeded(new Error("network")), null);
  assert.deepEqual(approvalBody(approvalNeeded(required()), "m1", "284716"), {
    perm: "credit.adjust",
    payload_hash: HASH,
    amount_cents: 500,
    approver_user_id: "m1",
    pin: "284716",
  });
});

test("withApproval retries the identical request once with the approval id", async () => {
  const sent = [];
  const send = async (approvalId) => {
    sent.push(approvalId);
    if (!approvalId) throw required();
    return { balance_cents: 1500 };
  };
  let asked;
  const result = await withApproval(send, async (need) => {
    asked = need;
    return "ap-1";
  });
  assert.deepEqual(result, { balance_cents: 1500 });
  assert.deepEqual(sent, [null, "ap-1"]);
  assert.equal(asked.perm, "credit.adjust");
});

test("withApproval: no approval needed, cancelled, other errors, invalid approval", async () => {
  assert.equal(await withApproval(async () => "ok", async () => assert.fail("not asked")), "ok");
  await assert.rejects(
    withApproval(async () => {
      throw required();
    }, async () => null),
    ApprovalCancelled,
  );
  await assert.rejects(
    withApproval(async () => {
      throw new ApiError(409, { detail: "insufficient store credit" });
    }, async () => assert.fail("not asked")),
    /insufficient/,
  );
  // The retry's approval was rejected: surface it, don't loop.
  let calls = 0;
  await assert.rejects(
    withApproval(async (id) => {
      calls += 1;
      throw required(id ? { approval_error: "invalid" } : {});
    }, async () => "ap-1"),
    /invalid, expired or already used/,
  );
  assert.equal(calls, 2);
});

test("submitApproval validates, posts, and reports PIN failures", async () => {
  const need = approvalNeeded(required());
  assert.equal((await submitApproval(need, null, "284716", null)).kind, "form");
  assert.equal((await submitApproval(need, "m1", "12", null)).kind, "form");
  let body;
  const ok = await submitApproval(need, "m1", "284716", async (b) => {
    body = b;
    return { approval_id: "ap-9" };
  });
  assert.deepEqual(ok, { approvalId: "ap-9" });
  assert.equal(body.approver_user_id, "m1");
  const self = await submitApproval(need, "m1", "284716", async () => {
    throw new ApiError(403, { detail: { reason: "self_approval" } });
  });
  assert.equal(self.kind, "self_approval");
  assert.match(self.error, /own request/);
  const notAllowed = await submitApproval(need, "m1", "284716", async () => {
    throw new ApiError(403, { detail: { reason: "approver_not_allowed", perm: "credit.adjust" } });
  });
  assert.equal(notAllowed.kind, "approver_not_allowed");
  const locked = await submitApproval(need, "m1", "284716", async () => {
    throw new ApiError(423, { detail: { reason: "pin_locked", retry_after: 60 } }, { retryAfter: 60 });
  });
  assert.equal(locked.kind, "pin_locked");
  assert.equal(locked.retryAfter, 60);
});

test("approverChoices leaves out the requester", () => {
  const staff = [{ user_id: "u1" }, { user_id: "u2" }];
  assert.deepEqual(approverChoices(staff, "u1"), [{ user_id: "u2" }]);
  assert.deepEqual(approverChoices(null, "u1"), []);
});
