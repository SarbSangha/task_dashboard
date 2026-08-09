# providers/freepik/migrations.py
"""
Idempotent additive DDL for the Freepik/Magnific Generation Capture System,
owned by this provider module rather than the shared db_migrations.py file -
mirrors providers/chatgpt/migrations.py exactly (see its module docstring for
the rationale). db_migrations.py calls
ensure_freepik_postgres_schema()/ensure_freepik_sqlite_schema() from within
its Postgres/SQLite branches.

Originally every table here was brand new, so this file was CREATE TABLE IF
NOT EXISTS + CREATE INDEX IF NOT EXISTS only. The Task Mapping columns
(linked_task_id/linked_task_name) added later are the first patch onto
already-deployed tables, so the additive-column helpers below mirror
providers/chatgpt/migrations.py's _pg_add_column_if_missing /
_sqlite_add_column_if_missing exactly.
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


def ensure_freepik_postgres_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_capture_events (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER NOT NULL REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_creation_id VARCHAR(160),
                provider_family_id VARCHAR(160),
                ownership_confidence VARCHAR(20),
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_capture_events_credential_client_event_id
            ON freepik_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_creation_id ON freepik_capture_events(provider_creation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_family_id ON freepik_capture_events(provider_family_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_tool_created_at ON freepik_capture_events(tool_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_user_created_at ON freepik_capture_events(user_id, created_at DESC)"))
    _pg_add_column_if_missing(conn, "freepik_capture_events", "linked_task_id", "INTEGER")
    _pg_add_column_if_missing(conn, "freepik_capture_events", "linked_task_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_linked_task_id ON freepik_capture_events(linked_task_id)"))
    _pg_add_column_if_missing(conn, "freepik_capture_events", "linked_client_id", "INTEGER")
    _pg_add_column_if_missing(conn, "freepik_capture_events", "linked_client_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_linked_client_id ON freepik_capture_events(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_recovery_audits (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_recovery_audits_admin_created_at ON freepik_recovery_audits(requested_by_admin_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_recovery_audits_action_created_at ON freepik_recovery_audits(action_type, created_at DESC)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_generations (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                creation_id VARCHAR(160),
                identifier VARCHAR(160),
                reference VARCHAR(160),
                family_id VARCHAR(160),
                variant_index INTEGER,
                external_id VARCHAR(160),
                request_id VARCHAR(160),
                task_id VARCHAR(160),
                iqs_task_id VARCHAR(160),
                transaction_id VARCHAR(160),
                project_folder_reference VARCHAR(160),
                folder_reference VARCHAR(160),
                source_capture_event_id INTEGER REFERENCES freepik_capture_events(id) ON DELETE SET NULL,
                generation_record_id INTEGER REFERENCES generation_records(id) ON DELETE SET NULL,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                ownership_source VARCHAR(80),
                ownership_notes TEXT,
                assigned_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                assigned_at TIMESTAMP,
                generation_source VARCHAR(40) NOT NULL DEFAULT 'live_capture',
                generation_method VARCHAR(40) NOT NULL DEFAULT 'network_intercept',
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                recovery_audit_id INTEGER REFERENCES freepik_recovery_audits(id) ON DELETE SET NULL,
                recovered_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recovered_at TIMESTAMP,
                name_field TEXT,
                prompt TEXT,
                input_prompt TEXT,
                variation_prompt TEXT,
                smart_prompt BOOLEAN,
                prompt_length INTEGER,
                prompt_hash VARCHAR(64),
                prompt_type VARCHAR(40),
                tool VARCHAR(80),
                tool_name VARCHAR(80),
                mode VARCHAR(80),
                slug VARCHAR(80),
                service VARCHAR(120),
                aspect_ratio VARCHAR(20),
                resolution VARCHAR(20),
                width INTEGER,
                height INTEGER,
                output_width INTEGER,
                output_height INTEGER,
                seed VARCHAR(40),
                tags_json JSON,
                modifiers_json JSON,
                image_references_json JSON,
                status VARCHAR(40),
                persisted BOOLEAN,
                visible BOOLEAN,
                is_watermarked BOOLEAN,
                nsfw BOOLEAN,
                is_public BOOLEAN,
                stored BOOLEAN,
                shared BOOLEAN,
                is_last BOOLEAN,
                provider_created_at TIMESTAMP,
                provider_updated_at TIMESTAMP,
                elapsed_time_ms INTEGER,
                expect_time_s INTEGER,
                queue_priority INTEGER,
                credits_charged FLOAT,
                credits_estimated FLOAT,
                unlimited_credits FLOAT,
                credit_ledger_json JSON,
                preview_url TEXT,
                thumbnail_url TEXT,
                large_preview_url TEXT,
                raw_url TEXT,
                download_url TEXT,
                web_url TEXT,
                blurhash VARCHAR(80),
                ratio FLOAT,
                file_size INTEGER,
                file_type_id INTEGER,
                origin VARCHAR(40),
                folder_id INTEGER,
                folder_name VARCHAR(255),
                metadata_json JSON,
                source_metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT ck_freepik_generations_identity_present CHECK (
                    creation_id IS NOT NULL OR identifier IS NOT NULL OR reference IS NOT NULL
                )
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_creation_id ON freepik_generations(provider, creation_id) WHERE creation_id IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_identifier ON freepik_generations(provider, identifier) WHERE identifier IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_reference ON freepik_generations(provider, reference) WHERE reference IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_transaction_id ON freepik_generations(provider, transaction_id) WHERE transaction_id IS NOT NULL"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_family_index ON freepik_generations(family_id, variant_index)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_owner_created_at ON freepik_generations(owner_user_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_owner_status_created_at ON freepik_generations(owner_user_id, ownership_status, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_credential_created_at ON freepik_generations(credential_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_ingestion_created_at ON freepik_generations(ingestion_source, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_generation_record_id ON freepik_generations(generation_record_id)"))
    _pg_add_column_if_missing(conn, "freepik_generations", "linked_task_id", "INTEGER")
    _pg_add_column_if_missing(conn, "freepik_generations", "linked_task_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_linked_task_id ON freepik_generations(linked_task_id)"))
    _pg_add_column_if_missing(conn, "freepik_generations", "linked_client_id", "INTEGER")
    _pg_add_column_if_missing(conn, "freepik_generations", "linked_client_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_linked_client_id ON freepik_generations(linked_client_id)"))
    # Asset mirroring (see providers/freepik/asset_mirror.py): Freepik/Pikaso's
    # own CDN URLs are signed and time-limited - once the token expires the
    # original asset 404s permanently. These columns hold our own R2 copy,
    # fetched once while the source URL is still valid.
    _pg_add_column_if_missing(conn, "freepik_generations", "mirrored_asset_url", "TEXT")
    _pg_add_column_if_missing(conn, "freepik_generations", "mirrored_thumbnail_url", "TEXT")
    # mirrored_asset_key/mirrored_thumbnail_key (added after discovering the
    # R2 bucket is private - see models.py's comment): the durable R2 object
    # key, from which to_dict() mints a fresh presigned URL on every read.
    _pg_add_column_if_missing(conn, "freepik_generations", "mirrored_asset_key", "TEXT")
    _pg_add_column_if_missing(conn, "freepik_generations", "mirrored_thumbnail_key", "TEXT")
    _pg_add_column_if_missing(conn, "freepik_generations", "asset_mirror_status", "VARCHAR(20) NOT NULL DEFAULT 'pending'")
    _pg_add_column_if_missing(conn, "freepik_generations", "asset_mirror_attempted_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "freepik_generations", "asset_mirror_error", "TEXT")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_asset_mirror_status ON freepik_generations(asset_mirror_status)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_sync_cursors (
                id SERIAL PRIMARY KEY,
                credential_id INTEGER NOT NULL REFERENCES it_portal_tool_credentials(id),
                last_seen_creation_id VARCHAR(160),
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
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_sync_cursors_credential ON freepik_sync_cursors(credential_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_capture_health (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_capture_health_session
            ON freepik_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )

    # ---- Search + Download capture (added 2026-08-06) ----
    # See models.py's FreepikSearchQuery/FreepikDownload docstrings - stock
    # library search and existing-asset download are structurally different
    # from a generation, so they get their own tables rather than a
    # creation.id-shaped column added onto freepik_generations.
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_search_queries (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                source_capture_event_id INTEGER REFERENCES freepik_capture_events(id) ON DELETE SET NULL,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                search_term TEXT,
                source_host VARCHAR(80),
                page_url TEXT,
                result_count_label VARCHAR(40),
                filters_json JSON,
                searched_at TIMESTAMP,
                metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_search_queries_owner_created_at ON freepik_search_queries(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_search_queries_credential_created_at ON freepik_search_queries(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_search_queries_term ON freepik_search_queries(search_term)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_downloads (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                source_capture_event_id INTEGER REFERENCES freepik_capture_events(id) ON DELETE SET NULL,
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_owner_created_at ON freepik_downloads(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_credential_created_at ON freepik_downloads(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_linked_task_id ON freepik_downloads(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_linked_client_id ON freepik_downloads(linked_client_id)"))


def ensure_freepik_sqlite_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_capture_events (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER NOT NULL,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_creation_id VARCHAR(160),
                provider_family_id VARCHAR(160),
                ownership_confidence VARCHAR(20),
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
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_capture_events_credential_client_event_id
            ON freepik_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_creation_id ON freepik_capture_events(provider_creation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_family_id ON freepik_capture_events(provider_family_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_tool_created_at ON freepik_capture_events(tool_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_user_created_at ON freepik_capture_events(user_id, created_at)"))
    _sqlite_add_column_if_missing(conn, "freepik_capture_events", "linked_task_id", "INTEGER")
    _sqlite_add_column_if_missing(conn, "freepik_capture_events", "linked_task_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_linked_task_id ON freepik_capture_events(linked_task_id)"))
    _sqlite_add_column_if_missing(conn, "freepik_capture_events", "linked_client_id", "INTEGER")
    _sqlite_add_column_if_missing(conn, "freepik_capture_events", "linked_client_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_capture_events_linked_client_id ON freepik_capture_events(linked_client_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_recovery_audits (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_recovery_audits_admin_created_at ON freepik_recovery_audits(requested_by_admin_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_recovery_audits_action_created_at ON freepik_recovery_audits(action_type, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_generations (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                creation_id VARCHAR(160),
                identifier VARCHAR(160),
                reference VARCHAR(160),
                family_id VARCHAR(160),
                variant_index INTEGER,
                external_id VARCHAR(160),
                request_id VARCHAR(160),
                task_id VARCHAR(160),
                iqs_task_id VARCHAR(160),
                transaction_id VARCHAR(160),
                project_folder_reference VARCHAR(160),
                folder_reference VARCHAR(160),
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
                generation_source VARCHAR(40) NOT NULL DEFAULT 'live_capture',
                generation_method VARCHAR(40) NOT NULL DEFAULT 'network_intercept',
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                recovery_audit_id INTEGER,
                recovered_by_admin_id INTEGER,
                recovered_at DATETIME,
                name_field TEXT,
                prompt TEXT,
                input_prompt TEXT,
                variation_prompt TEXT,
                smart_prompt BOOLEAN,
                prompt_length INTEGER,
                prompt_hash VARCHAR(64),
                prompt_type VARCHAR(40),
                tool VARCHAR(80),
                tool_name VARCHAR(80),
                mode VARCHAR(80),
                slug VARCHAR(80),
                service VARCHAR(120),
                aspect_ratio VARCHAR(20),
                resolution VARCHAR(20),
                width INTEGER,
                height INTEGER,
                output_width INTEGER,
                output_height INTEGER,
                seed VARCHAR(40),
                tags_json JSON,
                modifiers_json JSON,
                image_references_json JSON,
                status VARCHAR(40),
                persisted BOOLEAN,
                visible BOOLEAN,
                is_watermarked BOOLEAN,
                nsfw BOOLEAN,
                is_public BOOLEAN,
                stored BOOLEAN,
                shared BOOLEAN,
                is_last BOOLEAN,
                provider_created_at DATETIME,
                provider_updated_at DATETIME,
                elapsed_time_ms INTEGER,
                expect_time_s INTEGER,
                queue_priority INTEGER,
                credits_charged FLOAT,
                credits_estimated FLOAT,
                unlimited_credits FLOAT,
                credit_ledger_json JSON,
                preview_url TEXT,
                thumbnail_url TEXT,
                large_preview_url TEXT,
                raw_url TEXT,
                download_url TEXT,
                web_url TEXT,
                blurhash VARCHAR(80),
                ratio FLOAT,
                file_size INTEGER,
                file_type_id INTEGER,
                origin VARCHAR(40),
                folder_id INTEGER,
                folder_name VARCHAR(255),
                metadata_json JSON,
                source_metadata_json JSON,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_capture_event_id) REFERENCES freepik_capture_events (id) ON DELETE SET NULL,
                FOREIGN KEY(generation_record_id) REFERENCES generation_records (id) ON DELETE SET NULL,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(assigned_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(recovery_audit_id) REFERENCES freepik_recovery_audits (id) ON DELETE SET NULL,
                FOREIGN KEY(recovered_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                CONSTRAINT ck_freepik_generations_identity_present CHECK (
                    creation_id IS NOT NULL OR identifier IS NOT NULL OR reference IS NOT NULL
                )
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_creation_id ON freepik_generations(provider, creation_id) WHERE creation_id IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_identifier ON freepik_generations(provider, identifier) WHERE identifier IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_reference ON freepik_generations(provider, reference) WHERE reference IS NOT NULL"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_generations_transaction_id ON freepik_generations(provider, transaction_id) WHERE transaction_id IS NOT NULL"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_family_index ON freepik_generations(family_id, variant_index)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_owner_created_at ON freepik_generations(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_owner_status_created_at ON freepik_generations(owner_user_id, ownership_status, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_credential_created_at ON freepik_generations(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_ingestion_created_at ON freepik_generations(ingestion_source, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_generation_record_id ON freepik_generations(generation_record_id)"))
    _sqlite_add_column_if_missing(conn, "freepik_generations", "linked_task_id", "INTEGER")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "linked_task_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_linked_task_id ON freepik_generations(linked_task_id)"))
    _sqlite_add_column_if_missing(conn, "freepik_generations", "linked_client_id", "INTEGER")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "linked_client_name", "VARCHAR(255)")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_linked_client_id ON freepik_generations(linked_client_id)"))
    _sqlite_add_column_if_missing(conn, "freepik_generations", "mirrored_asset_url", "TEXT")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "mirrored_thumbnail_url", "TEXT")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "mirrored_asset_key", "TEXT")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "mirrored_thumbnail_key", "TEXT")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "asset_mirror_status", "VARCHAR(20) NOT NULL DEFAULT 'pending'")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "asset_mirror_attempted_at", "DATETIME")
    _sqlite_add_column_if_missing(conn, "freepik_generations", "asset_mirror_error", "TEXT")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_generations_asset_mirror_status ON freepik_generations(asset_mirror_status)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_sync_cursors (
                id INTEGER PRIMARY KEY,
                credential_id INTEGER NOT NULL,
                last_seen_creation_id VARCHAR(160),
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
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_sync_cursors_credential ON freepik_sync_cursors(credential_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_capture_health (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_freepik_capture_health_session
            ON freepik_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )

    # ---- Search + Download capture (added 2026-08-06) - see the Postgres
    # branch's identical comment above. ----
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_search_queries (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
                source_capture_event_id INTEGER,
                tool_id INTEGER,
                credential_id INTEGER,
                owner_user_id INTEGER,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                search_term TEXT,
                source_host VARCHAR(80),
                page_url TEXT,
                result_count_label VARCHAR(40),
                filters_json JSON,
                searched_at DATETIME,
                metadata_json JSON,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_capture_event_id) REFERENCES freepik_capture_events (id) ON DELETE SET NULL,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_search_queries_owner_created_at ON freepik_search_queries(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_search_queries_credential_created_at ON freepik_search_queries(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_search_queries_term ON freepik_search_queries(search_term)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS freepik_downloads (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'freepik',
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
                FOREIGN KEY(source_capture_event_id) REFERENCES freepik_capture_events (id) ON DELETE SET NULL,
                FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_task_id) REFERENCES tasks (id) ON DELETE SET NULL,
                FOREIGN KEY(linked_client_id) REFERENCES generation_clients (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_owner_created_at ON freepik_downloads(owner_user_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_credential_created_at ON freepik_downloads(credential_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_linked_task_id ON freepik_downloads(linked_task_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_freepik_downloads_linked_client_id ON freepik_downloads(linked_client_id)"))
