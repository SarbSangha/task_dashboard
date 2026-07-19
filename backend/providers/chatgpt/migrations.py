# providers/chatgpt/migrations.py
"""
Idempotent additive DDL for the ChatGPT Capture & Conversation Intelligence
System, owned by this provider module rather than the shared db_migrations.py
file (see providers/__init__.py for the modular-provider rationale).

db_migrations.py calls ensure_chatgpt_postgres_schema()/ensure_chatgpt_sqlite_schema()
from within its Postgres/SQLite branches, at the same point where the inline
DDL used to live.
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


def ensure_chatgpt_postgres_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_projects (
                id SERIAL PRIMARY KEY,
                owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(200) NOT NULL,
                normalized_name VARCHAR(200) NOT NULL,
                description TEXT,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                archived_at TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_projects_owner_normalized_name_active
            ON conversation_projects(owner_user_id, normalized_name)
            WHERE archived_at IS NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_projects_owner_updated_at ON conversation_projects(owner_user_id, updated_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_projects_archived_at ON conversation_projects(archived_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_recovery_audits (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                action_type VARCHAR(40) NOT NULL,
                requested_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                date_from DATE NOT NULL,
                date_to DATE NOT NULL,
                source_count INTEGER NOT NULL DEFAULT 0,
                database_count INTEGER NOT NULL DEFAULT 0,
                missing_count INTEGER NOT NULL DEFAULT 0,
                imported_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(40) NOT NULL DEFAULT 'started',
                filters_json JSON,
                report_json JSON,
                error_message TEXT,
                started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_recovery_audits_admin_created_at ON conversation_recovery_audits(requested_by_admin_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_recovery_audits_provider_action_created_at ON conversation_recovery_audits(provider, action_type, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_recovery_audits_date_range_created_at ON conversation_recovery_audits(date_from, date_to, created_at DESC)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_capture_events (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER NOT NULL REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_conversation_id VARCHAR(160),
                provider_message_id VARCHAR(160),
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
    # conversation_capture_events pre-dates the Capture Contract in some
    # environments (an earlier, differently-shaped capture table already
    # existed there) - CREATE TABLE IF NOT EXISTS is a no-op against it, so
    # missing contract columns must be patched in explicitly.
    _pg_add_column_if_missing(conn, "conversation_capture_events", "client_event_id", "VARCHAR(160) NOT NULL DEFAULT ''")
    _pg_add_column_if_missing(conn, "conversation_capture_events", "payload_json", "JSON NOT NULL DEFAULT '{}'::json")
    _pg_add_column_if_missing(conn, "conversation_capture_events", "capture_version", "INTEGER NOT NULL DEFAULT 1")
    _pg_add_column_if_missing(conn, "conversation_capture_events", "extension_version", "VARCHAR(40)")
    _pg_add_column_if_missing(conn, "conversation_capture_events", "browser", "VARCHAR(80)")
    _pg_add_column_if_missing(conn, "conversation_capture_events", "tab_id", "INTEGER")
    _pg_add_column_if_missing(conn, "conversation_capture_events", "session_id", "VARCHAR(512)")
    # session_id holds the app's signed session token (itsdangerous), which
    # runs well past 160 chars in practice - widen it if an earlier version of
    # this migration already created it too narrow. Growing a VARCHAR is a
    # metadata-only change in Postgres, safe to run on every startup.
    conn.execute(text("ALTER TABLE conversation_capture_events ALTER COLUMN session_id TYPE VARCHAR(512)"))
    # "status" is a leftover column from the pre-Capture-Contract table shape
    # (not part of this schema at all - see the legacy columns like
    # text_content/role/sequence_index still sitting alongside it). It was
    # NOT NULL with no default, which blocked every insert since the current
    # ORM model never populates it. Only present in environments that carried
    # over the old table, so guard existence before altering it.
    if _pg_column_exists(conn, "conversation_capture_events", "status"):
        conn.execute(text("ALTER TABLE conversation_capture_events ALTER COLUMN status DROP NOT NULL"))
    # Two more leftover constraints from the pre-Capture-Contract table shape.
    # The old design used provider_message_id (and a fingerprint fallback) as
    # its idempotency key; the current one deliberately does not, because a
    # single raw message legitimately produces multiple rows sharing the same
    # provider_message_id (response_started + response_completed - see
    # ConversationCaptureEvent's docstring in models.py). Confirmed live: a
    # real response_completed insert failed with a UniqueViolation against
    # ux_conversation_capture_events_credential_message_id purely because
    # response_started for the same turn had already used that message_id.
    # The real idempotency key is now client_event_id, enforced by the index
    # created just below - these two are pure dead weight that actively
    # breaks correct inserts, not routine legacy cruft to leave alone.
    conn.execute(text("DROP INDEX IF EXISTS ux_conversation_capture_events_credential_message_id"))
    conn.execute(text("DROP INDEX IF EXISTS ux_conversation_capture_events_credential_fingerprint"))
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_capture_events_credential_client_event_id
            ON conversation_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_conversation_id ON conversation_capture_events(provider_conversation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_message_id ON conversation_capture_events(provider_message_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_tool_created_at ON conversation_capture_events(tool_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_user_created_at ON conversation_capture_events(user_id, created_at DESC)"))
    # event_type/created_at single-column indexes for Capture Center filtering
    # already exist via Column(index=True) on the model + Base.metadata.create_all
    # (which runs before this function on every startup) - no migration needed here.

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_records (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                provider_conversation_id VARCHAR(160),
                canonical_conversation_key TEXT,
                title VARCHAR(500),
                conversation_url TEXT,
                model_label VARCHAR(255),
                gpt_version VARCHAR(80),
                workspace_type VARCHAR(80),
                provider_created_time TIMESTAMP,
                provider_updated_time TIMESTAMP,
                conversation_status VARCHAR(40) NOT NULL DEFAULT 'active',
                is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
                is_archived BOOLEAN NOT NULL DEFAULT FALSE,
                is_deleted_detected BOOLEAN NOT NULL DEFAULT FALSE,
                prompt_count INTEGER NOT NULL DEFAULT 0,
                response_count INTEGER NOT NULL DEFAULT 0,
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                capture_status VARCHAR(40) NOT NULL DEFAULT 'active',
                owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                ownership_source VARCHAR(80),
                ownership_notes TEXT,
                assigned_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                assigned_at TIMESTAMP,
                project_id INTEGER REFERENCES conversation_projects(id) ON DELETE SET NULL,
                recovery_audit_id INTEGER REFERENCES conversation_recovery_audits(id) ON DELETE SET NULL,
                recovered_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recovered_at TIMESTAMP,
                metadata_json JSON,
                is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                archived_at TIMESTAMP,
                CONSTRAINT ck_conversation_records_identity_present CHECK (
                    provider_conversation_id IS NOT NULL OR canonical_conversation_key IS NOT NULL
                )
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_records_provider_conversation_id
            ON conversation_records(provider, provider_conversation_id)
            WHERE provider_conversation_id IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_records_provider_canonical_key
            ON conversation_records(provider, canonical_conversation_key)
            WHERE canonical_conversation_key IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_owner_project_created_at ON conversation_records(owner_user_id, project_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_owner_status_created_at ON conversation_records(owner_user_id, ownership_status, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_project_created_at ON conversation_records(project_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_ingestion_created_at ON conversation_records(ingestion_source, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_favorite_created_at ON conversation_records(is_favorite, created_at DESC)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_prompts (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL REFERENCES conversation_records(id) ON DELETE CASCADE,
                source_capture_event_id INTEGER REFERENCES conversation_capture_events(id) ON DELETE SET NULL,
                provider_message_id VARCHAR(160),
                sequence_index INTEGER NOT NULL DEFAULT 0,
                prompt_text TEXT,
                prompt_length INTEGER,
                attachments_json JSON,
                images_json JSON,
                files_json JSON,
                code_blocks_json JSON,
                prompt_metadata_json JSON,
                prompt_timestamp TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_prompts_conversation_message_id
            ON conversation_prompts(conversation_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_prompts_conversation_sequence ON conversation_prompts(conversation_id, sequence_index)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_responses (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL REFERENCES conversation_records(id) ON DELETE CASCADE,
                prompt_id INTEGER REFERENCES conversation_prompts(id) ON DELETE SET NULL,
                source_capture_event_id INTEGER REFERENCES conversation_capture_events(id) ON DELETE SET NULL,
                provider_message_id VARCHAR(160),
                sequence_index INTEGER NOT NULL DEFAULT 0,
                response_text TEXT,
                response_length INTEGER,
                code_blocks_json JSON,
                has_markdown BOOLEAN NOT NULL DEFAULT FALSE,
                has_tables BOOLEAN NOT NULL DEFAULT FALSE,
                images_json JSON,
                files_json JSON,
                artifacts_json JSON,
                reasoning_metadata_json JSON,
                response_status VARCHAR(40) NOT NULL DEFAULT 'completed',
                response_timestamp TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_responses_conversation_message_id
            ON conversation_responses(conversation_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_responses_conversation_sequence ON conversation_responses(conversation_id, sequence_index)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_responses_prompt_id ON conversation_responses(prompt_id)"))

    # Ordered content-part model (Phase 3 normalization) - preserves
    # text/image/etc. interleaving that the original flat text_json/images_json
    # columns above can't represent. Additive, both tables pre-date this.
    _pg_add_column_if_missing(conn, "conversation_prompts", "content_parts_json", "JSON")
    _pg_add_column_if_missing(conn, "conversation_responses", "content_parts_json", "JSON")
    _pg_add_column_if_missing(conn, "conversation_responses", "citations_json", "JSON")

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_generated_assets (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL REFERENCES conversation_records(id) ON DELETE CASCADE,
                response_id INTEGER REFERENCES conversation_responses(id) ON DELETE SET NULL,
                prompt_id INTEGER REFERENCES conversation_prompts(id) ON DELETE SET NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                output_type VARCHAR(40) NOT NULL,
                provider_asset_id VARCHAR(160),
                canonical_asset_key VARCHAR(255),
                file_url TEXT,
                file_name VARCHAR(500),
                mime_type VARCHAR(120),
                size_bytes INTEGER,
                metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_generated_assets_provider_asset_id
            ON conversation_generated_assets(provider, provider_asset_id)
            WHERE provider_asset_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_generated_assets_conversation_created_at ON conversation_generated_assets(conversation_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_generated_assets_response_id ON conversation_generated_assets(response_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_tags (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL REFERENCES conversation_records(id) ON DELETE CASCADE,
                tag VARCHAR(80) NOT NULL,
                normalized_tag VARCHAR(80) NOT NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_tags_conversation_normalized
            ON conversation_tags(conversation_id, normalized_tag)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_tags_normalized_tag ON conversation_tags(normalized_tag)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_tags_conversation_id ON conversation_tags(conversation_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_project_events (
                id SERIAL PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES conversation_projects(id) ON DELETE CASCADE,
                conversation_id INTEGER REFERENCES conversation_records(id) ON DELETE SET NULL,
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                event_type VARCHAR(40) NOT NULL,
                description TEXT,
                metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_project_events_project_created_at ON conversation_project_events(project_id, created_at DESC)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_capture_health (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER REFERENCES it_portal_tools(id),
                credential_id INTEGER REFERENCES it_portal_tool_credentials(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
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
    # Same stale-table issue as conversation_capture_events - this table also
    # pre-existed under an older shape in some environments.
    _pg_add_column_if_missing(conn, "conversation_capture_health", "last_capture_event_at", "TIMESTAMP")
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_capture_health_session
            ON conversation_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_health_user_id ON conversation_capture_health(user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_health_reported_at ON conversation_capture_health(reported_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_capture_attachments (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                provider_conversation_id VARCHAR(160),
                client_event_id VARCHAR(160),
                user_id INTEGER NOT NULL REFERENCES users(id),
                kind VARCHAR(20) NOT NULL DEFAULT 'input',
                file_name VARCHAR(500),
                mime_type VARCHAR(120),
                size_bytes INTEGER,
                file_url TEXT NOT NULL,
                storage_path TEXT,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_attachments_conversation_id ON conversation_capture_attachments(provider_conversation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_attachments_created_at ON conversation_capture_attachments(created_at)"))

    # ---- Media capture layer (additive, Phase 1) - own table, does not
    # touch any text-capture table above. ----------------------------------
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_media_assets (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER REFERENCES conversation_records(id) ON DELETE CASCADE,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                provider_conversation_id VARCHAR(160),
                message_id VARCHAR(160),
                assistant_message_id VARCHAR(160),
                correlation_id VARCHAR(160),
                media_type VARCHAR(40) NOT NULL,
                generated BOOLEAN NOT NULL DEFAULT TRUE,
                url TEXT,
                source_url TEXT,
                thumbnail_url TEXT,
                mime_type VARCHAR(120),
                width INTEGER,
                height INTEGER,
                duration_ms INTEGER,
                provider_asset_id VARCHAR(160),
                prompt TEXT,
                alt_text TEXT,
                source VARCHAR(255),
                display_order INTEGER,
                status VARCHAR(40) NOT NULL DEFAULT 'pending',
                enrichment_status VARCHAR(40) NOT NULL DEFAULT 'pending',
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    # Additive for installs where conversation_media_assets already existed
    # before enrichment_status was introduced (DOM/network capture landing
    # ahead of - and no longer blocked on - authoritative-fetch enrichment).
    _pg_add_column_if_missing(conn, "conversation_media_assets", "enrichment_status", "VARCHAR(40) NOT NULL DEFAULT 'pending'")
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_media_assets_provider_asset_id
            ON conversation_media_assets(provider, provider_asset_id)
            WHERE provider_asset_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_media_assets_conversation_created_at ON conversation_media_assets(conversation_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_media_assets_provider_conversation_id ON conversation_media_assets(provider_conversation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_media_assets_enrichment_status ON conversation_media_assets(enrichment_status)"))


def ensure_chatgpt_sqlite_schema(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_projects (
                id INTEGER PRIMARY KEY,
                owner_user_id INTEGER NOT NULL,
                name VARCHAR(200) NOT NULL,
                normalized_name VARCHAR(200) NOT NULL,
                description TEXT,
                created_by INTEGER,
                updated_by INTEGER,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                archived_at DATETIME,
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(updated_by) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_projects_owner_normalized_name_active
            ON conversation_projects(owner_user_id, normalized_name)
            WHERE archived_at IS NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_projects_owner_updated_at ON conversation_projects(owner_user_id, updated_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_projects_archived_at ON conversation_projects(archived_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_recovery_audits (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                action_type VARCHAR(40) NOT NULL,
                requested_by_admin_id INTEGER NOT NULL,
                date_from DATE NOT NULL,
                date_to DATE NOT NULL,
                source_count INTEGER NOT NULL DEFAULT 0,
                database_count INTEGER NOT NULL DEFAULT 0,
                missing_count INTEGER NOT NULL DEFAULT 0,
                imported_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(40) NOT NULL DEFAULT 'started',
                filters_json JSON,
                report_json JSON,
                error_message TEXT,
                started_at DATETIME NOT NULL,
                completed_at DATETIME,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(requested_by_admin_id) REFERENCES users (id) ON DELETE RESTRICT
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_recovery_audits_admin_created_at ON conversation_recovery_audits(requested_by_admin_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_recovery_audits_provider_action_created_at ON conversation_recovery_audits(provider, action_type, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_recovery_audits_date_range_created_at ON conversation_recovery_audits(date_from, date_to, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_capture_events (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER NOT NULL,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                event_type VARCHAR(40) NOT NULL,
                client_event_id VARCHAR(160) NOT NULL,
                provider_conversation_id VARCHAR(160),
                provider_message_id VARCHAR(160),
                payload_json JSON NOT NULL,
                capture_version INTEGER NOT NULL DEFAULT 1,
                extension_version VARCHAR(40),
                browser VARCHAR(80),
                tab_id INTEGER,
                session_id VARCHAR(512),
                extension_session_id VARCHAR(160),
                event_date DATE NOT NULL,
                created_at DATETIME NOT NULL,
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_capture_events_credential_client_event_id
            ON conversation_capture_events(provider, credential_id, client_event_id)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_conversation_id ON conversation_capture_events(provider_conversation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_message_id ON conversation_capture_events(provider_message_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_tool_created_at ON conversation_capture_events(tool_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_events_user_created_at ON conversation_capture_events(user_id, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_records (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                provider_conversation_id VARCHAR(160),
                canonical_conversation_key TEXT,
                title VARCHAR(500),
                conversation_url TEXT,
                model_label VARCHAR(255),
                gpt_version VARCHAR(80),
                workspace_type VARCHAR(80),
                provider_created_time DATETIME,
                provider_updated_time DATETIME,
                conversation_status VARCHAR(40) NOT NULL DEFAULT 'active',
                is_pinned BOOLEAN NOT NULL DEFAULT 0,
                is_archived BOOLEAN NOT NULL DEFAULT 0,
                is_deleted_detected BOOLEAN NOT NULL DEFAULT 0,
                prompt_count INTEGER NOT NULL DEFAULT 0,
                response_count INTEGER NOT NULL DEFAULT 0,
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                capture_status VARCHAR(40) NOT NULL DEFAULT 'active',
                owner_user_id INTEGER,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                ownership_source VARCHAR(80),
                ownership_notes TEXT,
                assigned_by_admin_id INTEGER,
                assigned_at DATETIME,
                project_id INTEGER,
                recovery_audit_id INTEGER,
                recovered_by_admin_id INTEGER,
                recovered_at DATETIME,
                metadata_json JSON,
                is_favorite BOOLEAN NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                archived_at DATETIME,
                CHECK (
                    provider_conversation_id IS NOT NULL OR canonical_conversation_key IS NOT NULL
                ),
                FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(assigned_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                FOREIGN KEY(project_id) REFERENCES conversation_projects (id) ON DELETE SET NULL,
                FOREIGN KEY(recovery_audit_id) REFERENCES conversation_recovery_audits (id) ON DELETE SET NULL,
                FOREIGN KEY(recovered_by_admin_id) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_records_provider_conversation_id
            ON conversation_records(provider, provider_conversation_id)
            WHERE provider_conversation_id IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_records_provider_canonical_key
            ON conversation_records(provider, canonical_conversation_key)
            WHERE canonical_conversation_key IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_owner_project_created_at ON conversation_records(owner_user_id, project_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_owner_status_created_at ON conversation_records(owner_user_id, ownership_status, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_project_created_at ON conversation_records(project_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_ingestion_created_at ON conversation_records(ingestion_source, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_records_favorite_created_at ON conversation_records(is_favorite, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_prompts (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                source_capture_event_id INTEGER,
                provider_message_id VARCHAR(160),
                sequence_index INTEGER NOT NULL DEFAULT 0,
                prompt_text TEXT,
                prompt_length INTEGER,
                attachments_json JSON,
                images_json JSON,
                files_json JSON,
                code_blocks_json JSON,
                prompt_metadata_json JSON,
                prompt_timestamp DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversation_records (id) ON DELETE CASCADE,
                FOREIGN KEY(source_capture_event_id) REFERENCES conversation_capture_events (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_prompts_conversation_message_id
            ON conversation_prompts(conversation_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_prompts_conversation_sequence ON conversation_prompts(conversation_id, sequence_index)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_responses (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                prompt_id INTEGER,
                source_capture_event_id INTEGER,
                provider_message_id VARCHAR(160),
                sequence_index INTEGER NOT NULL DEFAULT 0,
                response_text TEXT,
                response_length INTEGER,
                code_blocks_json JSON,
                has_markdown BOOLEAN NOT NULL DEFAULT 0,
                has_tables BOOLEAN NOT NULL DEFAULT 0,
                images_json JSON,
                files_json JSON,
                artifacts_json JSON,
                reasoning_metadata_json JSON,
                response_status VARCHAR(40) NOT NULL DEFAULT 'completed',
                response_timestamp DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversation_records (id) ON DELETE CASCADE,
                FOREIGN KEY(prompt_id) REFERENCES conversation_prompts (id) ON DELETE SET NULL,
                FOREIGN KEY(source_capture_event_id) REFERENCES conversation_capture_events (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_responses_conversation_message_id
            ON conversation_responses(conversation_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_responses_conversation_sequence ON conversation_responses(conversation_id, sequence_index)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_responses_prompt_id ON conversation_responses(prompt_id)"))

    # Ordered content-part model (Phase 3 normalization) - see the matching
    # comment in ensure_chatgpt_postgres_schema.
    _sqlite_add_column_if_missing(conn, "conversation_prompts", "content_parts_json", "JSON")
    _sqlite_add_column_if_missing(conn, "conversation_responses", "content_parts_json", "JSON")
    _sqlite_add_column_if_missing(conn, "conversation_responses", "citations_json", "JSON")

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_generated_assets (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                response_id INTEGER,
                prompt_id INTEGER,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                output_type VARCHAR(40) NOT NULL,
                provider_asset_id VARCHAR(160),
                canonical_asset_key VARCHAR(255),
                file_url TEXT,
                file_name VARCHAR(500),
                mime_type VARCHAR(120),
                size_bytes INTEGER,
                metadata_json JSON,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversation_records (id) ON DELETE CASCADE,
                FOREIGN KEY(response_id) REFERENCES conversation_responses (id) ON DELETE SET NULL,
                FOREIGN KEY(prompt_id) REFERENCES conversation_prompts (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_generated_assets_provider_asset_id
            ON conversation_generated_assets(provider, provider_asset_id)
            WHERE provider_asset_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_generated_assets_conversation_created_at ON conversation_generated_assets(conversation_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_generated_assets_response_id ON conversation_generated_assets(response_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_tags (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                tag VARCHAR(80) NOT NULL,
                normalized_tag VARCHAR(80) NOT NULL,
                created_by INTEGER,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversation_records (id) ON DELETE CASCADE,
                FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_tags_conversation_normalized
            ON conversation_tags(conversation_id, normalized_tag)
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_tags_normalized_tag ON conversation_tags(normalized_tag)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_tags_conversation_id ON conversation_tags(conversation_id)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_project_events (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL,
                conversation_id INTEGER,
                actor_user_id INTEGER,
                event_type VARCHAR(40) NOT NULL,
                description TEXT,
                metadata_json JSON,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(project_id) REFERENCES conversation_projects (id) ON DELETE CASCADE,
                FOREIGN KEY(conversation_id) REFERENCES conversation_records (id) ON DELETE SET NULL,
                FOREIGN KEY(actor_user_id) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_project_events_project_created_at ON conversation_project_events(project_id, created_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_capture_health (
                id INTEGER PRIMARY KEY,
                tool_id INTEGER,
                credential_id INTEGER,
                user_id INTEGER NOT NULL,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
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
                reported_at DATETIME NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
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
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_capture_health_session
            ON conversation_capture_health(provider, extension_session_id)
            WHERE extension_session_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_health_user_id ON conversation_capture_health(user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_health_reported_at ON conversation_capture_health(reported_at)"))

    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_capture_attachments (
                id INTEGER PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                provider_conversation_id VARCHAR(160),
                client_event_id VARCHAR(160),
                user_id INTEGER NOT NULL,
                kind VARCHAR(20) NOT NULL DEFAULT 'input',
                file_name VARCHAR(500),
                mime_type VARCHAR(120),
                size_bytes INTEGER,
                file_url TEXT NOT NULL,
                storage_path TEXT,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_attachments_conversation_id ON conversation_capture_attachments(provider_conversation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_capture_attachments_created_at ON conversation_capture_attachments(created_at)"))

    # ---- Media capture layer (additive, Phase 1) - own table, does not
    # touch any text-capture table above. ----------------------------------
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS conversation_media_assets (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER,
                provider VARCHAR(40) NOT NULL DEFAULT 'chatgpt',
                provider_conversation_id VARCHAR(160),
                message_id VARCHAR(160),
                assistant_message_id VARCHAR(160),
                correlation_id VARCHAR(160),
                media_type VARCHAR(40) NOT NULL,
                generated BOOLEAN NOT NULL DEFAULT 1,
                url TEXT,
                source_url TEXT,
                thumbnail_url TEXT,
                mime_type VARCHAR(120),
                width INTEGER,
                height INTEGER,
                duration_ms INTEGER,
                provider_asset_id VARCHAR(160),
                prompt TEXT,
                alt_text TEXT,
                source VARCHAR(255),
                display_order INTEGER,
                status VARCHAR(40) NOT NULL DEFAULT 'pending',
                enrichment_status VARCHAR(40) NOT NULL DEFAULT 'pending',
                user_id INTEGER,
                metadata_json JSON,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversation_records (id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
            )
            """
        )
    )
    _sqlite_add_column_if_missing(conn, "conversation_media_assets", "enrichment_status", "VARCHAR(40) NOT NULL DEFAULT 'pending'")
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_media_assets_provider_asset_id
            ON conversation_media_assets(provider, provider_asset_id)
            WHERE provider_asset_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_media_assets_conversation_created_at ON conversation_media_assets(conversation_id, created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_media_assets_provider_conversation_id ON conversation_media_assets(provider_conversation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_media_assets_enrichment_status ON conversation_media_assets(enrichment_status)"))
