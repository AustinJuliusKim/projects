import uuid

import psycopg
from fastapi import APIRouter, HTTPException

from tcg_pos_api import queries
from tcg_pos_api.deps import Actor, TenantConn
from tcg_pos_api.routes.models import CreditBalance, CreditChange

router = APIRouter(prefix="/customers", tags=["store credit"])


@router.get("/{customer_id}/credit", response_model=CreditBalance)
def get_credit(conn: TenantConn, customer_id: uuid.UUID) -> CreditBalance:
    balance = queries.credit_balance(conn, customer_id)
    if balance is None:
        raise HTTPException(404, "no customer with that id")
    return CreditBalance(customer_id=customer_id, balance_cents=balance)


def _apply(
    conn: psycopg.Connection,
    actor: str,
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
        conn, customer_id=customer_id, delta_cents=delta_cents, reason=reason, actor=actor
    )
    queries.write_audit(
        conn,
        actor=actor,
        action=action,
        entity="customer_credit",
        entity_id=customer_id,
        before={"balance_cents": before},
        after={"balance_cents": after, "delta_cents": delta_cents, "reason": reason},
    )
    return CreditBalance(customer_id=customer_id, balance_cents=after)


@router.post("/{customer_id}/credit/issue", response_model=CreditBalance)
def issue(
    actor: Actor, conn: TenantConn, customer_id: uuid.UUID, body: CreditChange
) -> CreditBalance:
    return _apply(conn, actor, customer_id, body.amount_cents, body.reason, "credit.issue")


@router.post("/{customer_id}/credit/redeem", response_model=CreditBalance)
def redeem(
    actor: Actor, conn: TenantConn, customer_id: uuid.UUID, body: CreditChange
) -> CreditBalance:
    return _apply(conn, actor, customer_id, -body.amount_cents, body.reason, "credit.redeem")
