# providers/grammarly_docs/migrations.py
"""
Additive DDL for the Grammarly Docs provider, owned by this provider module
rather than the shared db_migrations.py file - mirrors
providers/freepik/migrations.py exactly (see its own module docstring for
the rationale).

registry.py originally listed this provider with migrations_module=None,
correct at the time (both tables were brand new, so Base.metadata.create_all()
alone covered them - see database_config.py's Base.metadata.create_all()
call path). That stopped being true the moment content_text/
content_word_count/content_char_count/content_captured_at were added to an
ALREADY-DEPLOYED grammarly_doc_sessions table: create_all() only creates
tables that don't exist yet, it never alters an existing table to add a
missing column - confirmed real (2026-08-27): the live database still
lacked all four columns after the model change alone, with
psycopg.errors.UndefinedColumn on the very next query. Same one-off
"Task Mapping columns added later" story providers/chatgpt/migrations.py's
own docstring tells, just compressed into the same session as the table's
own creation instead of a later one.

db_migrations.py calls ensure_grammarly_docs_postgres_schema()/
ensure_grammarly_docs_sqlite_schema() from within its Postgres/SQLite
branches.
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


def ensure_grammarly_docs_postgres_schema(conn) -> None:
    # grammarly_capture_events / grammarly_doc_sessions themselves are
    # covered by Base.metadata.create_all() (still brand-new tables as of
    # the columns below existing) - only the columns added after that
    # initial create need explicit additive DDL here.
    _pg_add_column_if_missing(conn, "grammarly_doc_sessions", "content_text", "TEXT")
    _pg_add_column_if_missing(conn, "grammarly_doc_sessions", "content_word_count", "INTEGER")
    _pg_add_column_if_missing(conn, "grammarly_doc_sessions", "content_char_count", "INTEGER")
    _pg_add_column_if_missing(conn, "grammarly_doc_sessions", "content_captured_at", "TIMESTAMP")
    # Page identity within the doc - added once Coda's multi-page doc URL
    # structure was confirmed (2026-08-27, see models.py's own comment).
    _pg_add_column_if_missing(conn, "grammarly_doc_sessions", "page_id", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "grammarly_doc_sessions", "page_name", "TEXT")


def ensure_grammarly_docs_sqlite_schema(conn) -> None:
    _sqlite_add_column_if_missing(conn, "grammarly_doc_sessions", "content_text", "TEXT")
    _sqlite_add_column_if_missing(conn, "grammarly_doc_sessions", "content_word_count", "INTEGER")
    _sqlite_add_column_if_missing(conn, "grammarly_doc_sessions", "content_char_count", "INTEGER")
    _sqlite_add_column_if_missing(conn, "grammarly_doc_sessions", "content_captured_at", "TIMESTAMP")
    _sqlite_add_column_if_missing(conn, "grammarly_doc_sessions", "page_id", "VARCHAR(160)")
    _sqlite_add_column_if_missing(conn, "grammarly_doc_sessions", "page_name", "TEXT")
