# providers/flow/migrations.py
"""
Idempotent additive DDL for the Flow Generation Capture System, owned by
this provider module rather than the shared db_migrations.py file - mirrors
providers/freepik/migrations.py's pattern (see its own module docstring for
the rationale).

Like providers/elevenlabs/migrations.py, this does NOT hand-write CREATE
TABLE DDL - flow_capture_events/flow_generations were already live (created
by Base.metadata.create_all() in main.py, which always runs before
ensure_operational_schema()/this file) by the time the asset-mirroring
columns below were added, so only the backfill case needs handling here:
create_all() never alters an existing table's columns.
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


def ensure_flow_postgres_schema(conn) -> None:
    _pg_add_column_if_missing(conn, "flow_generations", "mirrored_asset_key", "TEXT")
    _pg_add_column_if_missing(conn, "flow_generations", "mirrored_thumbnail_key", "TEXT")
    _pg_add_column_if_missing(conn, "flow_generations", "asset_mirror_status", "VARCHAR(20) NOT NULL DEFAULT 'pending'")
    _pg_add_column_if_missing(conn, "flow_generations", "asset_mirror_attempted_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "flow_generations", "asset_mirror_error", "TEXT")


def ensure_flow_sqlite_schema(conn) -> None:
    _sqlite_add_column_if_missing(conn, "flow_generations", "mirrored_asset_key", "TEXT")
    _sqlite_add_column_if_missing(conn, "flow_generations", "mirrored_thumbnail_key", "TEXT")
    _sqlite_add_column_if_missing(conn, "flow_generations", "asset_mirror_status", "VARCHAR(20) NOT NULL DEFAULT 'pending'")
    _sqlite_add_column_if_missing(conn, "flow_generations", "asset_mirror_attempted_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "flow_generations", "asset_mirror_error", "TEXT")
