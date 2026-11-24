"""Manager approvals for restricted actions (0012 approval_policy/approval).

A route whose action may need a manager declares require_or_approval(
Perm.X) instead of require(Perm.X), then calls gate.authorize(amount_cents=
..., payload=body) before writing. What happens depends on the caller's
role's approval_policy row for the permission (a store's own row wins over
the system default; no row = the plain permission decides):

  no row     holds the permission -> go ahead; else 403 {"missing": perm}
  deny       403 {"missing": perm}, even if the role holds it
  approval   approval needed, unless amount_cents <= limit_cents
  allow      go ahead up to limit_cents (NULL = no limit); above it, approval

"Approval needed" answers 403
  {"detail": {"approval_required": "<perm>", "amount_cents": n,
              "payload_hash": "<sha256 hex>",
              "summary": {"title": "...", "lines": ["...", ...], ...}}}
`summary` is built by the server from the request (the route passes it to
authorize) so the approving manager sees what they are approving — e.g.
"Remove $50.00 store credit", the customer and the reason — not just a
permission and an unsigned amount. Routes may add structured fields to it
(credit adjust: customer_name, delta_cents signed, reason).
The register then has a manager enter their PIN (POST /v1/approvals with
that perm, payload_hash and amount_cents) and retries the identical request
with `X-Approval: <approval id>`. The server recomputes the payload hash
from the retried request (method, path, validated body, amount — so a
swapped body or amount can't reuse the approval), consumes the approval
atomically (one UPDATE: same store, perm, hash, amount, requester and
device, unconsumed, unexpired), re-checks that the approver is still an
active member holding the permission and approve.override, and sets
app.approved_by, which the database stamps on the ledger/audit rows (0011).
If the request then fails, the consumption rolls back with it. A bad, used,
expired or mismatched approval gets the same 403 plus
"approval_error": "invalid".

Approvals only exist for register sessions (a manager's PIN only counts on
an enrolled device); a bearer-token user who needs one gets the 403."""

import dataclasses
import hashlib
import json
import uuid
from collections.abc import Callable
from typing import Annotated, Any

import psycopg
from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel

from tcg_pos_api.auth.perms import Perm, forbidden_for
from tcg_pos_api.auth.principal import (
    Principal,
    Session,
    TenantSession,
    member_grants,
    missing_detail,
)

APPROVAL_TTL_SECONDS = 60


def policy_for(conn: psycopg.Connection, principal: Principal, perm: Perm) -> dict | None:
    """The approval_policy row governing `perm` for the caller's role in the
    transaction's store (store row first, then the system default)."""
    if principal.user_id is None:
        return None
    return conn.execute(
        "SELECT ap.mode, ap.limit_cents FROM approval_policy ap "
        "JOIN membership m ON m.role_id = ap.role_id "
        "WHERE m.user_id = %s AND ap.perm = %s "
        "AND (ap.tenant_id IS NULL OR ap.tenant_id = current_tenant_id()) "
        "ORDER BY ap.tenant_id NULLS LAST LIMIT 1",
        (principal.user_id, perm.value),
    ).fetchone()


def decide(principal: Principal, perm: Perm, policy: dict | None, amount: int | None) -> str:
    """allow | approval | deny."""
    if policy is None:
        return "allow" if principal.has(perm) else "deny"
    mode, limit = policy["mode"], policy["limit_cents"]
    if mode == "deny":
        return "deny"
    within = limit is not None and amount is not None and amount <= limit
    if mode == "allow":
        return "allow" if limit is None or within else "approval"
    return "allow" if within else "approval"


def payload_hash(perm: Perm, method: str, path: str, amount: int | None, payload: Any) -> str:
    """SHA-256 over a canonical JSON of what is being approved. Computed on
    the server both times; clients just echo it back."""
    if isinstance(payload, BaseModel):
        payload = payload.model_dump(mode="json")
    canonical = json.dumps(
        {
            "perm": perm.value,
            "method": method,
            "path": path,
            "amount_cents": amount,
            "body": payload,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def format_cents(cents: int) -> str:
    """$1,234.56 (no sign)."""
    return f"${abs(cents) / 100:,.2f}"


def eligible_approver(
    conn: psycopg.Connection, approver: uuid.UUID, requester: uuid.UUID | None, perm: Perm
) -> bool:
    if approver == requester:
        return False
    grants = member_grants(conn, approver)
    return grants is not None and {perm.value, Perm.APPROVE_OVERRIDE.value} <= set(grants["perms"])


@dataclasses.dataclass
class ApprovalGate:
    session: TenantSession
    perm: Perm
    policy: dict | None
    method: str
    path: str
    approval_header: str | None
    approved_by: uuid.UUID | None = None

    @property
    def conn(self) -> psycopg.Connection:
        return self.session.conn

    def authorize(
        self,
        *,
        amount_cents: int | None,
        payload: Any,
        summary: Callable[[], dict[str, Any]] | None = None,
    ) -> uuid.UUID | None:
        """Return (None) if the caller may go ahead without approval; the
        approver's id if a valid X-Approval was consumed; else raise 403.
        `summary` (called only when approval is needed) returns the
        {"title", "lines", ...} the approver is shown."""
        principal = self.session.principal
        decision = decide(principal, self.perm, self.policy, amount_cents)
        if decision == "deny":
            raise HTTPException(403, {"missing": self.perm.value})
        if decision == "allow":
            return None
        digest = payload_hash(self.perm, self.method, self.path, amount_cents, payload)
        required = {
            "approval_required": self.perm.value,
            "amount_cents": amount_cents,
            "payload_hash": digest,
        }
        if summary is not None:
            required["summary"] = summary()
        if not self.approval_header:
            raise HTTPException(403, required)
        approver = self._consume(digest, amount_cents)
        if approver is None:
            raise HTTPException(403, {**required, "approval_error": "invalid"})
        self.conn.execute("SELECT set_config('app.approved_by', %s, true)", (str(approver),))
        self.approved_by = approver
        return approver

    def _consume(self, digest: str, amount: int | None) -> uuid.UUID | None:
        principal = self.session.principal
        if principal.kind != "device":
            return None
        try:
            approval_id = uuid.UUID(self.approval_header.strip())
        except ValueError:
            return None
        row = self.conn.execute(
            "UPDATE approval SET consumed_at = now() "
            "WHERE id = %s AND perm = %s AND payload_hash = %s "
            "AND amount_cents IS NOT DISTINCT FROM %s AND requested_by = %s AND device_id = %s "
            "AND consumed_at IS NULL AND expires_at > now() RETURNING approved_by",
            (approval_id, self.perm.value, digest, amount, principal.user_id, principal.device_id),
        ).fetchone()
        if row is None:
            return None
        if not eligible_approver(self.conn, row["approved_by"], principal.user_id, self.perm):
            return None
        return row["approved_by"]


def require_or_approval(perm: Perm):
    """Like require(perm), but the role's approval policy may let the caller
    proceed with a manager's approval. The dependency refuses up front only
    when no approval could help (no permission and no policy row, or deny);
    the route calls gate.authorize(...) with the amount and body."""
    perm = Perm(perm)

    def check(
        session: Session,
        request: Request,
        x_approval: Annotated[str | None, Header()] = None,
    ) -> ApprovalGate:
        # A policy row can let a role act on a perm it lacks; it can't hand a
        # register or a key an admin perm.
        if perm.value in forbidden_for(session.principal.kind):
            raise HTTPException(403, missing_detail(session.principal, perm))
        policy = policy_for(session.conn, session.principal, perm)
        if (policy is None and not session.principal.has(perm)) or (
            policy is not None and policy["mode"] == "deny"
        ):
            raise HTTPException(403, {"missing": perm.value})
        return ApprovalGate(
            session=session,
            perm=perm,
            policy=policy,
            method=request.method,
            path=request.url.path,
            approval_header=x_approval,
        )

    check.required_perm = perm  # read by tests/test_route_coverage.py
    check.__name__ = f"require_or_approval_{perm.name.lower()}"
    return Depends(check)
