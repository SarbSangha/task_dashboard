# providers/higgsfield/migrations.py
"""
Idempotent additive DDL for the Higgsfield Generation Capture System, owned
by this provider module rather than the shared db_migrations.py file -
mirrors providers/heygen/migrations.py exactly. db_migrations.py calls
ensure_higgsfield_postgres_schema()/ensure_higgsfield_sqlite_schema() from
within its Postgres/SQLite branches.

No asset-mirroring columns here (unlike Freepik's/HeyGen's own migrations) -
deferred per the approved plan until real CDN-URL-expiry behavior for
Higgsfield is confirmed, the same reason Freepik/HeyGen needed real traffic
first before that could be built.
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


def ensure_higgsfield_postgres_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_capture_events (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER NOT NULL REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_generation_id VARCHAR(160),
                provider_project_id VARCHAR(160),
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_capture_events_credential_client_event_id
            ON higgsfield_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_generation_id ON higgsfield_capture_events(provider_generation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_project_id ON higgsfield_capture_events(provider_project_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_tool_created_at ON higgsfield_capture_events(tool_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_user_created_at ON higgsfield_capture_events(user_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_linked_task_id ON higgsfield_capture_events(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_linked_client_id ON higgsfield_capture_events(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_recovery_audits (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_recovery_audits_admin_created_at ON higgsfield_recovery_audits(requested_by_admin_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_recovery_audits_action_created_at ON higgsfield_recovery_audits(action_type, created_at DESC)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_generations (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
                generation_id VARCHAR(160),
                job_id VARCHAR(160),
                request_id VARCHAR(160),
                project_id VARCHAR(160),
                external_event_id VARCHAR(160),
                source_capture_event_id INTEGER REFERENCES higgsfield_capture_events(id) ON DELETE SET NULL,
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
                recovery_audit_id INTEGER REFERENCES higgsfield_recovery_audits(id) ON DELETE SET NULL,
                recovered_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recovered_at TIMESTAMP,
                kind VARCHAR(40),
                prompt_text TEXT,
                prompt_length INTEGER,
                preset_id VARCHAR(160),
                preset_name VARCHAR(255),
                preset_category VARCHAR(120),
                multi_shot BOOLEAN,
                enhance_prompt BOOLEAN,
                image_reference_url TEXT,
                resolution VARCHAR(20),
                aspect_ratio VARCHAR(20),
                fps INTEGER,
                duration_seconds FLOAT,
                quality VARCHAR(40),
                credits_before FLOAT,
                credits_after FLOAT,
                credits_used FLOAT,
                credit_ledger_json JSON,
                status VARCHAR(40),
                provider_created_at TIMESTAMP,
                provider_updated_at TIMESTAMP,
                submitted_at TIMESTAMP,
                completed_at TIMESTAMP,
                failed_at TIMESTAMP,
                cancelled_at TIMESTAMP,
                generation_duration_ms INTEGER,
                output_type VARCHAR(20),
                video_url TEXT,
                thumbnail_url TEXT,
                download_url TEXT,
                preview_url TEXT,
                metadata_json JSON,
                source_metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT ck_higgsfield_generations_identity_present CHECK (
                    generation_id IS NOT NULL OR job_id IS NOT NULL
                    OR request_id IS NOT NULL OR external_event_id IS NOT NULL
                )
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_generations_generation_id ON higgsfield_generations(provider, generation_id) WHERE generation_id IS NOT NULL"))
    # job_id was WRONGLY unique until 2026-08-06 - it's populated from
    # Higgsfield's job_set_id, a batch identifier multiple sibling
    # generations legitimately share (see models.py's own comment on this
    # column). Found via a live backfill_all run hitting real
    # UniqueViolation errors on real sibling-batch data. DROP first since
    # CREATE INDEX IF NOT EXISTS is a no-op against an already-existing
    # index of the same name - an install that already ran the old
    # migration needs the wrong constraint actually removed, not skipped.
    conn.execute(text("DROP INDEX IF EXISTS ux_higgsfield_generations_job_id"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_job_id ON higgsfield_generations(provider, job_id) WHERE job_id IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_generations_request_id ON higgsfield_generations(provider, request_id) WHERE request_id IS NOT NULL"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_project_id ON higgsfield_generations(project_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_owner_created_at ON higgsfield_generations(owner_user_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_owner_status_created_at ON higgsfield_generations(owner_user_id, ownership_status, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_credential_created_at ON higgsfield_generations(credential_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_ingestion_created_at ON higgsfield_generations(ingestion_source, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_generation_record_id ON higgsfield_generations(generation_record_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_linked_task_id ON higgsfield_generations(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_linked_client_id ON higgsfield_generations(linked_client_id)"))
    # output_type ("video" | "image") - added 2026-08-05 after real traffic
    # confirmed Higgsfield is not video-only (see models.py's comment). The
    # CREATE TABLE above is a no-op on an already-existing table, so this
    # covers an install that ran migrations before that column existed.
    _pg_add_column_if_missing(conn, "higgsfield_generations", "output_type", "VARCHAR(20)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_output_type ON higgsfield_generations(output_type)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_sync_cursors (
                id SERIAL PRIMARY KEY,
                credential_id INTEGER NOT NULL REFERENCES it_portal_tool_credentials(id),
                last_seen_generation_id VARCHAR(160),
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
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_sync_cursors_credential ON higgsfield_sync_cursors(credential_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_capture_health (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_capture_health_session
            ON higgsfield_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )


def ensure_higgsfield_sqlite_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_capture_events (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER NOT NULL,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_generation_id VARCHAR(160),
                provider_project_id VARCHAR(160),
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_capture_events_credential_client_event_id
            ON higgsfield_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_generation_id ON higgsfield_capture_events(provider_generation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_project_id ON higgsfield_capture_events(provider_project_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_tool_created_at ON higgsfield_capture_events(tool_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_user_created_at ON higgsfield_capture_events(user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_linked_task_id ON higgsfield_capture_events(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_capture_events_linked_client_id ON higgsfield_capture_events(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_recovery_audits (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_recovery_audits_admin_created_at ON higgsfield_recovery_audits(requested_by_admin_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_recovery_audits_action_created_at ON higgsfield_recovery_audits(action_type, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_generations (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
                generation_id VARCHAR(160),
                job_id VARCHAR(160),
                request_id VARCHAR(160),
                project_id VARCHAR(160),
                external_event_id VARCHAR(160),
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
                kind VARCHAR(40),
                prompt_text TEXT,
                prompt_length INTEGER,
                preset_id VARCHAR(160),
                preset_name VARCHAR(255),
                preset_category VARCHAR(120),
                multi_shot BOOLEAN,
                enhance_prompt BOOLEAN,
                image_reference_url TEXT,
                resolution VARCHAR(20),
                aspect_ratio VARCHAR(20),
                fps INTEGER,
                duration_seconds FLOAT,
                quality VARCHAR(40),
                credits_before FLOAT,
                credits_after FLOAT,
                credits_used FLOAT,
                credit_ledger_json JSON,
                status VARCHAR(40),
                provider_created_at DATETIME,
                provider_updated_at DATETIME,
                submitted_at DATETIME,
                completed_at DATETIME,
                failed_at DATETIME,
                cancelled_at DATETIME,
                generation_duration_ms INTEGER,
                output_type VARCHAR(20),
                video_url TEXT,
                thumbnail_url TEXT,
                download_url TEXT,
                preview_url TEXT,
                metadata_json JSON,
                source_metadata_json JSON,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_capture_event_id) REFERENCES higgsfield_capture_events (id) ON DELETE SET NULL,
                FOREIGN KEY(generation_record_id) REFERENCES generation_records (id) ON DELETE SET NULL,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(assigned_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_task_id) REFERENCES tasks (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_client_id) REFERENCES generation_clients (id) ON DELETE SET NULL,
                FOREIGN KEY(recovery_audit_id) REFERENCES higgsfield_recovery_audits (id) ON DELETE SET NULL,
                FOREIGN KEY(recovered_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                CONSTRAINT ck_higgsfield_generations_identity_present CHECK (
                    generation_id IS NOT NULL OR job_id IS NOT NULL
                    OR request_id IS NOT NULL OR external_event_id IS NOT NULL
                )
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_generations_generation_id ON higgsfield_generations(provider, generation_id) WHERE generation_id IS NOT NULL"))
    # job_id was WRONGLY unique until 2026-08-06 - see the Postgres branch's
    # identical comment above for why (job_set_id is a shared batch id, not
    # a per-generation one).
    conn.execute(text("DROP INDEX IF EXISTS ux_higgsfield_generations_job_id"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_job_id ON higgsfield_generations(provider, job_id) WHERE job_id IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_generations_request_id ON higgsfield_generations(provider, request_id) WHERE request_id IS NOT NULL"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_project_id ON higgsfield_generations(project_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_owner_created_at ON higgsfield_generations(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_owner_status_created_at ON higgsfield_generations(owner_user_id, ownership_status, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_credential_created_at ON higgsfield_generations(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_ingestion_created_at ON higgsfield_generations(ingestion_source, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_generation_record_id ON higgsfield_generations(generation_record_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_linked_task_id ON higgsfield_generations(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_linked_client_id ON higgsfield_generations(linked_client_id)"))
    # output_type ("video" | "image") - added 2026-08-05 after real traffic
    # confirmed Higgsfield is not video-only (see models.py's comment). The
    # CREATE TABLE above is a no-op on an already-existing table, so this
    # covers an install that ran migrations before that column existed.
    _sqlite_add_column_if_missing(conn, "higgsfield_generations", "output_type", "VARCHAR(20)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_higgsfield_generations_output_type ON higgsfield_generations(output_type)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_sync_cursors (
                id INTEGER PRIMARY KEY,
                credential_id INTEGER NOT NULL,
                last_seen_generation_id VARCHAR(160),
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
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_sync_cursors_credential ON higgsfield_sync_cursors(credential_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS higgsfield_capture_health (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'higgsfield',
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_higgsfield_capture_health_session
            ON higgsfield_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )
