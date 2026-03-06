# database_config.py - Dual Database Configuration (Env-driven, SQLite/PostgreSQL)
import os
import re
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from contextlib import contextmanager


def _load_env_file_if_needed(env_path: str = ".env") -> None:
    """
    Lightweight .env loader (no external dependency).
    Only sets keys that are not already in process env.
    """
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


def _create_engine(url: str):
    normalized = _normalize_db_url(url)
    if not normalized.startswith("postgresql+psycopg://"):
        raise RuntimeError("Only PostgreSQL connection URLs are supported in this environment.")
    kwargs = {
        "echo": False,
        "pool_pre_ping": True,
        # Supabase pooler (PgBouncer) can conflict with psycopg prepared statements.
        # Disable automatic prepare to avoid DuplicatePreparedStatement on startup.
        "connect_args": {"prepare_threshold": None},
    }
    return create_engine(normalized, **kwargs)


# ==================== OPERATIONAL DATABASE ====================
operational_engine = _create_engine(OPERATIONAL_DB_URL)
OperationalSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=operational_engine
)

# ==================== ARCHIVE DATABASE ====================
archive_engine = _create_engine(ARCHIVE_DB_URL)
ArchiveSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
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
