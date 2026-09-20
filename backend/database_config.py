# database_config.py - Dual Database Configuration (Env-driven, SQLite/PostgreSQL)
import os
import re
import threading
from urllib.parse import urlparse, urlunparse
from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool
from contextlib import contextmanager


class ConnectionPoolSaturatedError(RuntimeError):
    """Raised when the NullPool connection limiter (see
    _install_connection_limiter below) has no free slot within the
    configured wait. main.py maps this to a 503 instead of a generic 500."""


def _is_truthy(value: str) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _should_load_env_file() -> bool:
    explicit = (os.getenv("LOAD_DOTENV") or "").strip().lower()
    if explicit in {"1", "true", "yes", "on"}:
        return True
    if explicit in {"0", "false", "no", "off"}:
        return False

    environment = (os.getenv("ENVIRONMENT") or "").strip().lower()
    if environment == "production" or _is_truthy(os.getenv("RENDER")):
        return False
    return True


def _is_local_runtime() -> bool:
    environment = (os.getenv("ENVIRONMENT") or "").strip().lower()
    if environment == "production" or _is_truthy(os.getenv("RENDER")):
        return False
    return True


def _should_override_env_file_values() -> bool:
    explicit = (os.getenv("LOAD_DOTENV_OVERRIDE") or "").strip().lower()
    if explicit in {"1", "true", "yes", "on"}:
        return True
    if explicit in {"0", "false", "no", "off"}:
        return False
    # In local dev, prefer the checked-in backend/.env over stale inherited
    # process env so uvicorn reloads pick up credential changes.
    return _is_local_runtime()


def _prefer_local_supabase_transaction_pooler(url: str) -> str:
    if not url or not _is_local_runtime():
        return url
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.port != 5432
        or ("pooler.supabase.com" not in host and "pooler.supabase.co" not in host)
    ):
        return url

    # Supabase transaction pooler on 6543 is a better fit for local/dev
    # scripts and reloaders than session mode on 5432, which has a much lower
    # effective client cap.
    replaced_netloc = parsed.netloc[::-1].replace("2345:", "3456:", 1)[::-1]
    return urlunparse(parsed._replace(netloc=replaced_netloc))


def _load_env_file_if_needed(env_path: str | None = None) -> None:
    """
    Lightweight .env loader (no external dependency).
    Local dev defaults to letting backend/.env refresh inherited process env so
    reloaders pick up credential edits without a full shell restart.
    """
    if not _should_load_env_file():
        return
    env_path = env_path or os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    override_existing = _should_override_env_file_values()
    try:
        with open(env_path, "r", encoding="utf-8") as fp:
            for raw in fp:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = re.split(r"\s+#", value.strip(), maxsplit=1)[0]
                value = value.strip().strip('"').strip("'")
                if key and (override_existing or key not in os.environ):
                    os.environ[key] = value
    except Exception:
        # Fallback silently; process env may already be configured by runtime.
        return


_load_env_file_if_needed()

# ==================== DATABASE URLS ====================
OPERATIONAL_DB_URL = _prefer_local_supabase_transaction_pooler((os.getenv("DATABASE_URL") or "").strip())
ARCHIVE_DB_URL = _prefer_local_supabase_transaction_pooler((os.getenv("ARCHIVE_DATABASE_URL") or "").strip())

if not OPERATIONAL_DB_URL:
    raise RuntimeError("DATABASE_URL is required (PostgreSQL/Supabase).")

if not ARCHIVE_DB_URL:
    # Keep archive on the same hosted DB when dedicated archive URL is not provided.
    ARCHIVE_DB_URL = OPERATIONAL_DB_URL


def _normalize_db_url(url: str) -> str:
    # Prefer psycopg (v3) for PostgreSQL.
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _sql_echo_enabled() -> bool:
    return _is_truthy(os.getenv("SQLALCHEMY_ECHO") or os.getenv("DB_SQL_ECHO"))


def _is_supabase_pooler_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    port = parsed.port
    return port == 6543 or "pooler.supabase.com" in host or "pooler.supabase.co" in host


def _uses_external_pooler(url: str) -> bool:
    parsed = urlparse(url)
    port = parsed.port
    return (
        _is_supabase_pooler_url(url)
        or _is_truthy(os.getenv("DB_EXTERNAL_POOLER"))
        or _is_truthy(os.getenv("DB_USE_NULL_POOL"))
        or port == 6432
    )


def _pool_settings(url: str) -> dict:
    is_supabase_pooler = _is_supabase_pooler_url(url)
    # Keep hosted pooler connections tiny, but give direct droplet PostgreSQL
    # enough app-side checkout capacity for real dashboard traffic.
    if is_supabase_pooler:
        default_pool_size = 1
        default_max_overflow = 0
    else:
        default_pool_size = 20
        default_max_overflow = 20
    return {
        "pool_size": max(1, _int_env("DB_POOL_SIZE", default_pool_size)),
        "max_overflow": max(0, _int_env("DB_MAX_OVERFLOW", default_max_overflow)),
        "pool_timeout": max(1, _int_env("DB_POOL_TIMEOUT", 5)),
        "pool_recycle": max(30, _int_env("DB_POOL_RECYCLE", 1800)),
        "pool_pre_ping": True,
        "pool_use_lifo": True,
    }


def _create_engine(url: str):
    normalized = _normalize_db_url(url)
    if not normalized.startswith("postgresql+psycopg://"):
        raise RuntimeError("Only PostgreSQL connection URLs are supported in this environment.")
    kwargs = {
        # Keep SQL logging opt-in so profiling can be enabled without code edits.
        "echo": _sql_echo_enabled(),
        # Supabase pooler (PgBouncer) can conflict with psycopg prepared statements.
        # Disable automatic prepare to avoid DuplicatePreparedStatement on startup.
        "connect_args": {
            "prepare_threshold": None,
            "connect_timeout": max(3, _int_env("DB_CONNECT_TIMEOUT", 10)),
        },
    }
    pool_settings = _pool_settings(normalized)
    uses_null_pool = _uses_external_pooler(normalized) and not _is_truthy(os.getenv("DB_USE_SQLALCHEMY_POOL"))
    if uses_null_pool:
        # PgBouncer/Supabase poolers are already the connection pool. Holding another
        # app-side QueuePool on top leaves idle client connections open until a
        # process restart, which can make login fail during traffic bursts.
        kwargs["poolclass"] = NullPool
    else:
        kwargs.update(pool_settings)
    engine = create_engine(normalized, **kwargs)
    _install_session_timeouts(engine)
    if uses_null_pool:
        # NullPool has no ceiling of its own - every checkout opens a brand
        # new real connection against the hosted pooler, unlike QueuePool
        # (the `else` branch above), which already bounds itself via
        # pool_size/max_overflow/pool_timeout. A burst of concurrent
        # requests, or this process's own periodic background sync loops
        # (asset mirrors, notification outbox, report schedules - see
        # main.py) firing alongside live traffic, can open more simultaneous
        # connections than the pooler's own project-level budget allows,
        # which the pooler then refuses outright - indistinguishable from
        # "the DB is exhausted" from here, and identical in shape to a real
        # leak even though every one of those connections closes normally on
        # its own. Reusing DB_POOL_SIZE/DB_MAX_OVERFLOW/DB_POOL_TIMEOUT here
        # gives NullPool the same app-side ceiling QueuePool would have
        # provided, without reintroducing the idle-connection buildup the
        # comment above chose NullPool to avoid.
        max_concurrent = max(1, pool_settings["pool_size"] + pool_settings["max_overflow"])
        _install_connection_limiter(engine, max_concurrent, pool_settings["pool_timeout"])
    return engine


# Server-side backstop for connections parked mid-transaction. The application
# rule is that no request handler holds a session across network I/O (see the
# db.close() calls in routers/it_tools_router.py, providers/chatgpt/media.py and
# friends), but that rule is enforced only by review - one handler that forgets
# it leaves a connection "idle in transaction" for as long as its upload or
# mailbox round-trip takes, and Postgres will never reclaim it on its own. Under
# NullPool (the hosted pooler path above) each of those is a real client
# connection against the pooler's limit, so enough of them starve login and
# every other request until the process is restarted - the shape of the outage
# this backstop exists to bound.
#
# Applied per connection via a SET rather than a libpq `options` startup
# parameter on purpose: poolers in transaction mode do not reliably accept
# `options` in the startup packet, and a rejected startup parameter fails EVERY
# connection rather than degrading. Any failure here is therefore swallowed -
# the timeout is a safety net, never a precondition for connecting.
#
# Defaults are deliberately generous: this is meant to catch a leak, not to
# police slow-but-legitimate work (the asset-mirror sweeps hold a transaction
# open across a paced fetch loop by design). Set either to 0 to disable.
DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = _int_env("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", 300_000)  # 5 min
DB_STATEMENT_TIMEOUT_MS = _int_env("DB_STATEMENT_TIMEOUT_MS", 0)  # off by default


def _install_session_timeouts(engine) -> None:
    settings = []
    if DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > 0:
        settings.append(("idle_in_transaction_session_timeout", DB_IDLE_IN_TRANSACTION_TIMEOUT_MS))
    if DB_STATEMENT_TIMEOUT_MS > 0:
        settings.append(("statement_timeout", DB_STATEMENT_TIMEOUT_MS))
    if not settings:
        return

    @event.listens_for(engine, "connect")
    def _set_session_timeouts(dbapi_connection, _connection_record):  # noqa: ANN001
        try:
            with dbapi_connection.cursor() as cursor:
                for name, milliseconds in settings:
                    # Identifiers are module constants, values are ints from
                    # _int_env - no user input reaches this string.
                    cursor.execute(f"SET {name} = {int(milliseconds)}")
        except Exception:  # noqa: BLE001 - a pooler that refuses SET must not break connecting
            pass


def _install_connection_limiter(engine, max_concurrent: int, timeout_seconds: int) -> None:
    """Bounds concurrent DBAPI connections for an engine using NullPool.

    SQLAlchemy fires "checkout"/"checkin" around every connection use for
    every pool implementation, including NullPool - this is the standard
    pattern for giving a poolless engine the same app-side ceiling a real
    pool provides. Every caller of OperationalSessionLocal()/
    ArchiveSessionLocal() goes through this (get_operational_db, the
    background sync loops in main.py, the websocket auth check in
    tasks_router.py, ad-hoc scripts, ...), so this is enforced once here
    rather than needing every call site to cooperate.

    A checkout that can't get a slot within timeout_seconds raises
    ConnectionPoolSaturatedError instead of piling on the pooler - main.py
    turns that into a 503 for request handlers; a background loop's own
    try/except around its cycle just logs and retries next tick.
    """
    semaphore = threading.Semaphore(max_concurrent)

    @event.listens_for(engine, "checkout")
    def _acquire_slot(dbapi_connection, connection_record, connection_proxy):  # noqa: ANN001
        if not semaphore.acquire(timeout=timeout_seconds):
            raise ConnectionPoolSaturatedError(
                f"database connection limiter saturated ({max_concurrent} concurrent connections in use) - "
                "retry shortly"
            )

    @event.listens_for(engine, "checkin")
    def _release_slot(dbapi_connection, connection_record):  # noqa: ANN001
        semaphore.release()


# ==================== OPERATIONAL DATABASE ====================
_NORMALIZED_OPERATIONAL_DB_URL = _normalize_db_url(OPERATIONAL_DB_URL)
_NORMALIZED_ARCHIVE_DB_URL = _normalize_db_url(ARCHIVE_DB_URL)

operational_engine = _create_engine(OPERATIONAL_DB_URL)
OperationalSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    bind=operational_engine
)

# ==================== ARCHIVE DATABASE ====================
archive_engine = (
    operational_engine
    if _NORMALIZED_ARCHIVE_DB_URL == _NORMALIZED_OPERATIONAL_DB_URL
    else _create_engine(ARCHIVE_DB_URL)
)
ArchiveSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    bind=archive_engine
)

# Base classes
Base = declarative_base()
ArchiveBase = declarative_base()


# ==================== DATABASE DEPENDENCIES ====================
def get_operational_db():
    """Get operational database session"""
    db = OperationalSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_archive_db():
    """Get archive database session"""
    db = ArchiveSessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_dual_db():
    """Get both databases in a context manager"""
    operational_db = OperationalSessionLocal()
    archive_db = ArchiveSessionLocal()
    try:
        yield operational_db, archive_db
    finally:
        operational_db.close()
        archive_db.close()


# Convenience function
def get_db():
    """Default to operational DB (for backward compatibility)"""
    return get_operational_db()
