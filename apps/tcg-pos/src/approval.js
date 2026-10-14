// Manager approvals (services/tcg-pos-api/src/tcg_pos_api/auth/approvals.py):
// a gated request answers 403 {approval_required, amount_cents,
// payload_hash}; a manager enters their PIN on this register
// (POST /v1/approvals) and the IDENTICAL request is retried once with
// X-Approval. withApproval runs that loop around any request; the modal is
// the `requestApproval` callback.

export class ApprovalCancelled extends Error {
  constructor() {
    super("Approval cancelled.");
    this.name = "ApprovalCancelled";
  }
}

// The approval a failed request needs, or null if it failed for another
// reason. `invalid` = a supplied approval was bad, used, expired or for a
// different request.
export function approvalNeeded(err) {
  const d = err && err.status === 403 && err.detail;
  if (!d || typeof d !== "object" || !d.approval_required) return null;
  return {
    perm: d.approval_required,
    amountCents: d.amount_cents ?? null,
    payloadHash: d.payload_hash,
    invalid: d.approval_error === "invalid",
  };
}

export function approvalBody(need, approverUserId, pin) {
  return {
    perm: need.perm,
    payload_hash: need.payloadHash,
    amount_cents: need.amountCents,
    approver_user_id: approverUserId,
    pin,
  };
}

// Who to offer in the approver picker: everyone signed up on this register
// except the requester (the API refuses self-approval anyway). Whether they
// hold the perm + approve.override is the API's call (approver_not_allowed).
export function approverChoices(staff, requesterUserId) {
  return (staff || []).filter((s) => s.user_id !== requesterUserId);
}

// send(approvalId|null) performs the request; it must send the same method,
// path and body both times (the payload hash covers them).
// requestApproval(need) resolves to an approval id, or null if cancelled.
export async function withApproval(send, requestApproval) {
  try {
    return await send(null);
  } catch (err) {
    const need = approvalNeeded(err);
    if (!need) throw err;
    const approvalId = await requestApproval(need);
    if (!approvalId) throw new ApprovalCancelled();
    // A second approval_required here (approval_error: invalid) surfaces as
    // the error; it's single-use, so we don't loop on it.
    return send(approvalId);
  }
}

// One approval attempt from the modal: { approvalId } or { error, kind,
// retryAfter } for the modal to show (it stays open on wrong_pin etc.).
export async function submitApproval(need, approverUserId, pin, createApproval) {
  if (!approverUserId) return { error: "Pick who is approving.", kind: "form" };
  if (!/^[0-9]{6}$/.test(pin || "")) return { error: "Enter the 6-digit PIN.", kind: "form" };
  try {
    const out = await createApproval(approvalBody(need, approverUserId, pin));
    return { approvalId: out.approval_id };
  } catch (err) {
    return {
      error: err.message,
      kind: err.reason || err.kind || "error",
      retryAfter: err.retryAfter ?? (err.detail && err.detail.retry_after) ?? null,
    };
  }
}
