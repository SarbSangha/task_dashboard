# providers/elevenlabs/migrations.py
"""
Idempotent additive DDL for the ElevenLabs Generation Capture System, owned
by this provider module rather than the shared db_migrations.py file -
mirrors providers/freepik/migrations.py's pattern (see its own module
docstring for the rationale).

Unlike Freepik's migrations.py, this file does NOT hand-write CREATE TABLE
DDL for elevenlabs_capture_events/elevenlabs_generations - those tables were
still new enough (models.py only, never deployed with a matching migration)
that Base.metadata.create_all() in main.py was the only thing that had ever
created them, and main.py runs create_all() before ensure_operational_schema()
(hence before this file's functions), so the tables are always guaranteed to
already exist by the time these run - both for a brand-new install (created
fresh, already with every current column, by create_all itself) and for an
existing one (created by an earlier create_all, missing whatever column this
file was written to backfill). Only the backfill case below needs this file
at all: downloaded_at was added to ElevenlabsGeneration after this provider's
tables were already live on at least one real deployment, and create_all
never alters an existing table's columns - see providers/chatgpt/migrations.py's
identical _pg_add_column_if_missing/_sqlite_add_column_if_missing this reuses
the same shape of.
"""
from sqlalchemy import text


def _pg_column_exists(conn, table_name: str, column_name: str) -> bool:
    row = conn.execute(
        text(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :table_name
              AND column_name = :column_name
            LIMIT 1
            """
        ),
        {"table_name": table_name, "column_name": column_name},
    ).fetchone()
    return row is not None


def _pg_add_column_if_missing(conn, table_name: str, column_name: str, sql_type: str) -> None:
    if _pg_column_exists(conn, table_name, column_name):
        return
    conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {sql_type}"))


def _sqlite_column_exists(conn, table_name: str, column_name: str) -> bool:
    rows = conn.execute(text(f"PRAGMA table_info('{table_name}')")).mappings().all()
    return any(row["name"] == column_name for row in rows)


def _sqlite_add_column_if_missing(conn, table_name: str, column_name: str, sql_type: str) -> None:
    if _sqlite_column_exists(conn, table_name, column_name):
        return
    conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {sql_type}"))


def ensure_elevenlabs_postgres_schema(conn) -> None:
    _pg_add_column_if_missing(conn, "elevenlabs_generations", "downloaded_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "elevenlabs_generations", "credits_used", "INTEGER")


def ensure_elevenlabs_sqlite_schema(conn) -> None:
    _sqlite_add_column_if_missing(conn, "elevenlabs_generations", "downloaded_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "elevenlabs_generations", "credits_used", "INTEGER")
