"""POST /v1/dev/login — a dev-issuer access token for any email, so local
dev can sign in without Cognito. Mounted ONLY when AUTH_ISSUER is the dev
issuer, which app.create_app allows only with ENV=local or ENV=test. The
token is verified like any other (auth/tokens.py); membership still decides
what it can do (scripts/backfill_owner.py makes a dev user a store owner)."""

from fastapi import APIRouter

from tcg_pos_api.auth.dev import DEFAULT_TTL_SECONDS, dev_sub, mint_dev_token
from tcg_pos_api.routes.models import DevLogin, DevToken

router = APIRouter(prefix="/dev", tags=["dev"])


@router.post("/login", response_model=DevToken)
def dev_login(body: DevLogin) -> DevToken:
    return DevToken(
        access_token=mint_dev_token(body.email),
        expires_in=DEFAULT_TTL_SECONDS,
        sub=dev_sub(body.email),
    )
