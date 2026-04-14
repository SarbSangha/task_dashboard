# database_config.py - Dual Database Configuration (Env-driven, SQLite/PostgreSQL)
import os
import re
from urllib.parse import urlparse
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from contextlib import contextmanager


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


def _load_env_file_if_needed(env_path: str | None = None) -> None:
    """
    Lightweight .env loader (no external dependency).
    Only sets keys that are not already in process env.
    """
    if not _should_load_env_file():
        return
    env_path = env_path or os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
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
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception:
        # Fallback silently; process env may already be configured by runtime.
        return


_load_env_file_if_needed()

# ==================== DATABASE URLS ====================
OPERATIONAL_DB_URL = (os.getenv("DATABASE_URL") or "").strip()
ARCHIVE_DB_URL = (os.getenv("ARCHIVE_DATABASE_URL") or "").strip()

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


def _pool_settings(url: str) -> dict:
    is_supabase_pooler = _is_supabase_pooler_url(url)
    # Supabase pooler session mode caps client connections at its configured
    # pool size. Keep the application pool small and never create overflow
    # clients unless the deployment explicitly opts in via env vars.
    default_pool_size = 2 if is_supabase_pooler else 10
    default_max_overflow = 0 if is_supabase_pooler else 20
    return {
        "pool_size": max(1, _int_env("DB_POOL_SIZE", default_pool_size)),
        "max_overflow": max(0, _int_env("DB_MAX_OVERFLOW", default_max_overflow)),
        "pool_timeout": max(1, _int_env("DB_POOL_TIMEOUT", 30)),
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
        **_pool_settings(normalized),
        # Supabase pooler (PgBouncer) can conflict with psycopg prepared statements.
        # Disable automatic prepare to avoid DuplicatePreparedStatement on startup.
        "connect_args": {"prepare_threshold": None},
    }
    return create_engine(normalized, **kwargs)


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
