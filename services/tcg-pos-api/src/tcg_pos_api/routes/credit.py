import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, HTTPException

from tcg_pos_api import queries
from tcg_pos_api.auth.approvals import ApprovalGate, format_cents, require_or_approval
from tcg_pos_api.deps import Perm, TenantConn, require
from tcg_pos_api.routes.models import CreditAdjust, CreditBalance, CreditChange

router = APIRouter(prefix="/customers", tags=["store credit"])


@router.get(
    "/{customer_id}/credit",
    response_model=CreditBalance,
    dependencies=[require(Perm.CREDIT_READ)],
)
def get_credit(conn: TenantConn, customer_id: uuid.UUID) -> CreditBalance:
    balance = queries.credit_balance(conn, customer_id)
    if balance is None:
        raise HTTPException(404, "no customer with that id")
    return CreditBalance(customer_id=customer_id, balance_cents=balance)


def _apply(
    conn: psycopg.Connection,
    customer_id: uuid.UUID,
    delta_cents: int,
    reason: str,
    action: str,
) -> CreditBalance:
    # Lock first, then read: a concurrent redeem on the same customer waits
    # here until this transaction commits, so it sees the updated balance.
    if not queries.lock_customer(conn, customer_id):
        raise HTTPException(404, "no customer with that id")
    before = queries.credit_balance(conn, customer_id)
    after = before + delta_cents
    if after < 0:
        raise HTTPException(
            409, f"insufficient store credit (balance {before}, redeem {-delta_cents})"
        )
    queries.insert_credit_ledger(
        conn, customer_id=customer_id, delta_cents=delta_cents, reason=reason
    )
    queries.write_audit(
        conn,
        action=action,
        entity="customer_credit",
        entity_id=customer_id,
        before={"balance_cents": before},
        after={"balance_cents": after, "delta_cents": delta_cents, "reason": reason},
    )
    return CreditBalance(customer_id=customer_id, balance_cents=after)


@router.post(
    "/{customer_id}/credit/issue",
    response_model=CreditBalance,
    dependencies=[require(Perm.CREDIT_ISSUE)],
)
def issue(conn: TenantConn, customer_id: uuid.UUID, body: CreditChange) -> CreditBalance:
    return _apply(conn, customer_id, body.amount_cents, body.reason, "credit.issue")


# Redeeming is spending credit as tender, which is part of selling: pos.sell.
# (Correcting a balance without a sale is credit.adjust, below.)
@router.post(
    "/{customer_id}/credit/redeem",
    response_model=CreditBalance,
    dependencies=[require(Perm.POS_SELL)],
)
def redeem(conn: TenantConn, customer_id: uuid.UUID, body: CreditChange) -> CreditBalance:
    return _apply(conn, customer_id, -body.amount_cents, body.reason, "credit.redeem")


# A correction to a balance (either direction) that isn't a sale or an
# issue. Cashiers get it only with a manager's approval by default (the
# cashier approval_policy row in 0012); a store's own policy row can set a
# limit_cents under which no approval is needed.
@router.post("/{customer_id}/credit/adjust", response_model=CreditBalance)
def adjust(
    gate: Annotated[ApprovalGate, require_or_approval(Perm.CREDIT_ADJUST)],
    customer_id: uuid.UUID,
    body: CreditAdjust,
) -> CreditBalance:
    gate.authorize(
        amount_cents=abs(body.delta_cents),
        payload=body,
        summary=lambda: _adjust_summary(gate.conn, customer_id, body),
    )
    return _apply(gate.conn, customer_id, body.delta_cents, body.reason, "credit.adjust")


def _adjust_summary(conn: psycopg.Connection, customer_id: uuid.UUID, body: CreditAdjust) -> dict:
    """What the approving manager is shown: direction, amount, customer,
    reason and the balance before/after."""
    row = conn.execute("SELECT name FROM customer WHERE id = %s", (customer_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "no customer with that id")
    balance = queries.credit_balance(conn, customer_id)
    amount = format_cents(body.delta_cents)
    adding = body.delta_cents > 0
    sign = "+" if adding else "-"
    lines = [
        f"Customer: {row['name']}",
        f"Change: {sign}{amount} ({'add to' if adding else 'take from'} their balance)",
        f"Reason: {body.reason}",
    ]
    if balance is not None:
        lines.append(
            f"Balance: {format_cents(balance)} -> {format_cents(balance + body.delta_cents)}"
            if balance + body.delta_cents >= 0
            else f"Balance: {format_cents(balance)} (not enough to remove {amount})"
        )
    return {
        "title": f"{'Add' if adding else 'Remove'} {amount} store credit",
        "lines": lines,
        "customer_name": row["name"],
        "delta_cents": body.delta_cents,
        "reason": body.reason,
        "balance_cents": balance,
    }
