import os

# Below the Lambda's 10 s timeout (template.yaml), so an unreachable database
# fails the request with a clear error instead of the whole invocation timing out.
DEFAULT_CONNECT_TIMEOUT = 5


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    return url


def connect_kwargs() -> dict:
    """Keyword args for every psycopg.connect. prepare_threshold=None turns
    off server-side prepared statements: Supabase's transaction pooler
    (:6543) hands each transaction a different backend, where a statement
    prepared on another one doesn't exist. DB_CONNECT_TIMEOUT overrides the
    connect timeout (seconds)."""
    return {
        "prepare_threshold": None,
        "connect_timeout": int(os.environ.get("DB_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT)),
    }


def env_name() -> str:
    """ENV: local | test | (anything else = a deployed environment). Only
    local and test may use the dev token issuer (auth/dev.py)."""
    return os.environ.get("ENV", "").strip().lower()
