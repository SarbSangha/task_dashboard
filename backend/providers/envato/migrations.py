# providers/envato/migrations.py
"""
Idempotent additive DDL for the Envato Generation Capture System, owned by
this provider module - mirrors providers/freepik/migrations.py exactly (see
its docstring for the rationale). db_migrations.py calls
ensure_envato_postgres_schema()/ensure_envato_sqlite_schema() from within its
Postgres/SQLite branches.
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


def ensure_envato_postgres_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_capture_events (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER NOT NULL REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_item_uuid VARCHAR(160),
                ownership_confidence VARCHAR(20),
                linked_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
                linked_task_name VARCHAR(255),
                linked_client_id INTEGER REFERENCES generation_clients(id) ON DELETE SET NULL,
                linked_client_name VARCHAR(255),
                payload_json JSON NOT NULL,
                capture_version INTEGER NOT NULL DEFAULT 1,
                extension_version VARCHAR(40),
                browser VARCHAR(80),
                tab_id INTEGER,
                session_id VARCHAR(512),
                extension_session_id VARCHAR(160),
                event_date DATE NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_capture_events_credential_client_event_id
            ON envato_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_item_uuid ON envato_capture_events(provider_item_uuid)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_tool_created_at ON envato_capture_events(tool_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_user_created_at ON envato_capture_events(user_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_linked_task_id ON envato_capture_events(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_linked_client_id ON envato_capture_events(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_recovery_audits (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                action_type VARCHAR(40) NOT NULL,
                requested_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                pages_walked INTEGER NOT NULL DEFAULT 0,
                source_count INTEGER NOT NULL DEFAULT 0,
                database_count INTEGER NOT NULL DEFAULT 0,
                missing_count INTEGER NOT NULL DEFAULT 0,
                imported_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(40) NOT NULL DEFAULT 'started',
                report_json JSON,
                error_message TEXT,
                started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_recovery_audits_admin_created_at ON envato_recovery_audits(requested_by_admin_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_recovery_audits_action_created_at ON envato_recovery_audits(action_type, created_at DESC)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_generations (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                item_uuid VARCHAR(160),
                item_type VARCHAR(40),
                source_capture_event_id INTEGER REFERENCES envato_capture_events(id) ON DELETE SET NULL,
                generation_record_id INTEGER REFERENCES generation_records(id) ON DELETE SET NULL,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                ownership_source VARCHAR(80),
                ownership_notes TEXT,
                assigned_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                assigned_at TIMESTAMP,
                linked_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
                linked_task_name VARCHAR(255),
                linked_client_id INTEGER REFERENCES generation_clients(id) ON DELETE SET NULL,
                linked_client_name VARCHAR(255),
                generation_source VARCHAR(40) NOT NULL DEFAULT 'live_capture',
                generation_method VARCHAR(40) NOT NULL DEFAULT 'network_intercept',
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                recovery_audit_id INTEGER REFERENCES envato_recovery_audits(id) ON DELETE SET NULL,
                recovered_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recovered_at TIMESTAMP,
                prompt TEXT,
                prompt_length INTEGER,
                prompt_hash VARCHAR(64),
                title TEXT,
                aspect_ratio VARCHAR(20),
                style VARCHAR(120),
                shortcut_slug VARCHAR(120),
                is_in_workspace BOOLEAN,
                is_downloaded BOOLEAN,
                review_status VARCHAR(40),
                provider_created_at TIMESTAMP,
                credits_badge FLOAT,
                quota_remaining_before INTEGER,
                quota_remaining_after INTEGER,
                canvas_url TEXT,
                fallback_url TEXT,
                thumbnail_url TEXT,
                src_set_json JSON,
                metadata_json JSON,
                source_metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT ck_envato_generations_identity_present CHECK (item_uuid IS NOT NULL)
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_generations_item_uuid ON envato_generations(provider, item_uuid)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_owner_created_at ON envato_generations(owner_user_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_owner_status_created_at ON envato_generations(owner_user_id, ownership_status, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_credential_created_at ON envato_generations(credential_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_ingestion_created_at ON envato_generations(ingestion_source, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_generation_record_id ON envato_generations(generation_record_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_item_type ON envato_generations(item_type)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_linked_task_id ON envato_generations(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_linked_client_id ON envato_generations(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_sync_cursors (
                id SERIAL PRIMARY KEY,
                credential_id INTEGER NOT NULL REFERENCES it_portal_tool_credentials(id),
                last_seen_item_uuid VARCHAR(160),
                last_synced_page INTEGER NOT NULL DEFAULT 0,
                last_full_reconciliation_at TIMESTAMP,
                last_run_at TIMESTAMP,
                last_run_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'idle',
                last_error TEXT,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_sync_cursors_credential ON envato_sync_cursors(credential_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_capture_health (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                extension_session_id VARCHAR(160),
                extension_version VARCHAR(40),
                queue_length INTEGER NOT NULL DEFAULT 0,
                events_waiting INTEGER NOT NULL DEFAULT 0,
                oldest_pending_event_at TIMESTAMP,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_capture_event_at TIMESTAMP,
                last_successful_upload_at TIMESTAMP,
                last_failed_upload_at TIMESTAMP,
                average_upload_time_ms INTEGER,
                offline_since TIMESTAMP,
                reported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_capture_health_session
            ON envato_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )

    # ---- Downloads (Envato Elements stock-asset downloads, added after the
    # initial generation-capture rollout) - see models.py's EnvatoDownload
    # docstring for why this is a separate table from envato_generations. ----
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_downloads (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                source_capture_event_id INTEGER REFERENCES envato_capture_events(id) ON DELETE SET NULL,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                linked_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
                linked_task_name VARCHAR(255),
                linked_client_id INTEGER REFERENCES generation_clients(id) ON DELETE SET NULL,
                linked_client_name VARCHAR(255),
                asset_title TEXT,
                asset_thumbnail_url TEXT,
                asset_source_url TEXT,
                search_term TEXT,
                source_host VARCHAR(80),
                page_url TEXT,
                downloaded_at TIMESTAMP,
                metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_owner_created_at ON envato_downloads(owner_user_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_credential_created_at ON envato_downloads(credential_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_linked_task_id ON envato_downloads(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_linked_client_id ON envato_downloads(linked_client_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_source_host ON envato_downloads(source_host)"))
    # Added once a real `/download.data?itemUuid=...&itemType=...` request
    # was observed (see models.py's EnvatoDownload.item_uuid comment) -
    # additive since envato_downloads may already exist from the initial
    # rollout, same _add_column_if_missing pattern Freepik's own migrations
    # use for later columns.
    _pg_add_column_if_missing(conn, "envato_downloads", "item_uuid", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "envato_downloads", "item_type", "VARCHAR(40)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_item_uuid ON envato_downloads(item_uuid)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_item_type ON envato_downloads(item_type)"))


def ensure_envato_sqlite_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_capture_events (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER NOT NULL,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_item_uuid VARCHAR(160),
                ownership_confidence VARCHAR(20),
                linked_task_id INTEGER,
                linked_task_name VARCHAR(255),
                linked_client_id INTEGER,
                linked_client_name VARCHAR(255),
                payload_json JSON NOT NULL,
                capture_version INTEGER NOT NULL DEFAULT 1,
                extension_version VARCHAR(40),
                browser VARCHAR(80),
                tab_id INTEGER,
                session_id VARCHAR(512),
                extension_session_id VARCHAR(160),
                event_date DATE NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(user_id) REFERENCES users (id),
                FOREIGN KEY(linked_task_id) REFERENCES tasks (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_client_id) REFERENCES generation_clients (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_capture_events_credential_client_event_id
            ON envato_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_item_uuid ON envato_capture_events(provider_item_uuid)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_tool_created_at ON envato_capture_events(tool_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_user_created_at ON envato_capture_events(user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_linked_task_id ON envato_capture_events(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_capture_events_linked_client_id ON envato_capture_events(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_recovery_audits (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                action_type VARCHAR(40) NOT NULL,
                requested_by_admin_id INTEGER NOT NULL,
                credential_id INTEGER,
                pages_walked INTEGER NOT NULL DEFAULT 0,
                source_count INTEGER NOT NULL DEFAULT 0,
                database_count INTEGER NOT NULL DEFAULT 0,
                missing_count INTEGER NOT NULL DEFAULT 0,
                imported_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(40) NOT NULL DEFAULT 'started',
                report_json JSON,
                error_message TEXT,
                started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(requested_by_admin_id) REFERENCES users (id) ON DELETE RESTRICT,
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id)
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_recovery_audits_admin_created_at ON envato_recovery_audits(requested_by_admin_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_recovery_audits_action_created_at ON envato_recovery_audits(action_type, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_generations (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                item_uuid VARCHAR(160),
                item_type VARCHAR(40),
                source_capture_event_id INTEGER,
                generation_record_id INTEGER,
                tool_id INTEGER,
                credential_id INTEGER,
                owner_user_id INTEGER,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                ownership_source VARCHAR(80),
                ownership_notes TEXT,
                assigned_by_admin_id INTEGER,
                assigned_at DATETIME,
                linked_task_id INTEGER,
                linked_task_name VARCHAR(255),
                linked_client_id INTEGER,
                linked_client_name VARCHAR(255),
                generation_source VARCHAR(40) NOT NULL DEFAULT 'live_capture',
                generation_method VARCHAR(40) NOT NULL DEFAULT 'network_intercept',
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                recovery_audit_id INTEGER,
                recovered_by_admin_id INTEGER,
                recovered_at DATETIME,
                prompt TEXT,
                prompt_length INTEGER,
                prompt_hash VARCHAR(64),
                title TEXT,
                aspect_ratio VARCHAR(20),
                style VARCHAR(120),
                shortcut_slug VARCHAR(120),
                is_in_workspace BOOLEAN,
                is_downloaded BOOLEAN,
                review_status VARCHAR(40),
                provider_created_at DATETIME,
                credits_badge FLOAT,
                quota_remaining_before INTEGER,
                quota_remaining_after INTEGER,
                canvas_url TEXT,
                fallback_url TEXT,
                thumbnail_url TEXT,
                src_set_json JSON,
                metadata_json JSON,
                source_metadata_json JSON,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_capture_event_id) REFERENCES envato_capture_events (id) ON DELETE SET NULL,
                FOREIGN KEY(generation_record_id) REFERENCES generation_records (id) ON DELETE SET NULL,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(assigned_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_task_id) REFERENCES tasks (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_client_id) REFERENCES generation_clients (id) ON DELETE SET NULL,
                FOREIGN KEY(recovery_audit_id) REFERENCES envato_recovery_audits (id) ON DELETE SET NULL,
                FOREIGN KEY(recovered_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                CONSTRAINT ck_envato_generations_identity_present CHECK (item_uuid IS NOT NULL)
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_generations_item_uuid ON envato_generations(provider, item_uuid)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_owner_created_at ON envato_generations(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_owner_status_created_at ON envato_generations(owner_user_id, ownership_status, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_credential_created_at ON envato_generations(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_ingestion_created_at ON envato_generations(ingestion_source, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_generation_record_id ON envato_generations(generation_record_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_item_type ON envato_generations(item_type)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_linked_task_id ON envato_generations(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_generations_linked_client_id ON envato_generations(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_sync_cursors (
                id INTEGER PRIMARY KEY,
                credential_id INTEGER NOT NULL,
                last_seen_item_uuid VARCHAR(160),
                last_synced_page INTEGER NOT NULL DEFAULT 0,
                last_full_reconciliation_at DATETIME,
                last_run_at DATETIME,
                last_run_by_user_id INTEGER,
                status VARCHAR(40) NOT NULL DEFAULT 'idle',
                last_error TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(last_run_by_user_id) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_sync_cursors_credential ON envato_sync_cursors(credential_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_capture_health (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                extension_session_id VARCHAR(160),
                extension_version VARCHAR(40),
                queue_length INTEGER NOT NULL DEFAULT 0,
                events_waiting INTEGER NOT NULL DEFAULT 0,
                oldest_pending_event_at DATETIME,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_capture_event_at DATETIME,
                last_successful_upload_at DATETIME,
                last_failed_upload_at DATETIME,
                average_upload_time_ms INTEGER,
                offline_since DATETIME,
                reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_envato_capture_health_session
            ON envato_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )

    # ---- Downloads (Envato Elements stock-asset downloads) - see the
    # Postgres branch's identical comment above. ----
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS envato_downloads (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'envato',
                source_capture_event_id INTEGER,
                tool_id INTEGER,
                credential_id INTEGER,
                owner_user_id INTEGER,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                linked_task_id INTEGER,
                linked_task_name VARCHAR(255),
                linked_client_id INTEGER,
                linked_client_name VARCHAR(255),
                asset_title TEXT,
                asset_thumbnail_url TEXT,
                asset_source_url TEXT,
                search_term TEXT,
                source_host VARCHAR(80),
                page_url TEXT,
                downloaded_at DATETIME,
                metadata_json JSON,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_capture_event_id) REFERENCES envato_capture_events (id) ON DELETE SET NULL,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_task_id) REFERENCES tasks (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_client_id) REFERENCES generation_clients (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_owner_created_at ON envato_downloads(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_credential_created_at ON envato_downloads(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_linked_task_id ON envato_downloads(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_linked_client_id ON envato_downloads(linked_client_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_source_host ON envato_downloads(source_host)"))
    _sqlite_add_column_if_missing(conn, "envato_downloads", "item_uuid", "VARCHAR(160)")
    _sqlite_add_column_if_missing(conn, "envato_downloads", "item_type", "VARCHAR(40)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_item_uuid ON envato_downloads(item_uuid)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_envato_downloads_item_type ON envato_downloads(item_type)"))
