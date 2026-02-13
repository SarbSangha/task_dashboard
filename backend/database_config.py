# database_config.py - Dual Database Configuration
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from contextlib import contextmanager

# ==================== OPERATIONAL DATABASE ====================
OPERATIONAL_DB_URL = "sqlite:///./task_db.sqlite"
operational_engine = create_engine(
    OPERATIONAL_DB_URL,
    connect_args={"check_same_thread": False},
    echo=False  # Set to True for SQL debugging
)
OperationalSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=operational_engine
)

# ==================== ARCHIVE DATABASE ====================
ARCHIVE_DB_URL = "sqlite:///./archive_db.sqlite"
archive_engine = create_engine(
    ARCHIVE_DB_URL,
    connect_args={"check_same_thread": False},
    echo=False
)
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
