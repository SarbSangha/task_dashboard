from sqlalchemy import text

DEFAULT_DEPARTMENT_DIRECTORY = (
    "CREATIVE",
    "CONTENT",
    "CONTENT CREATOR",
    "CRACK TEAM",
    "DIGITAL",
    "GEN AI",
    "INTERNAL BRANDS",
    "3D Visualizer",
)

DEFAULT_TOOL_DIRECTORY = (
    {
        "name": "Claude",
        "slug": "claude",
        "category": "AI",
        "description": "Anthropic Claude assistant",
        "website_url": "https://claude.ai/",
        "login_url": "https://claude.ai/login",
        "icon": "Bot",
        "launch_mode": "extension_autofill",
        "status": "active",
        "is_active": True,
    },
    {
        "name": "Grammarly",
        "slug": "grammarly",
        "category": "Writing",
        "description": "AI writing assistant",
        "website_url": "https://www.grammarly.com/",
        "login_url": "https://www.grammarly.com/signin",
        "icon": "Type",
        "launch_mode": "extension_autofill",
        "status": "active",
        "is_active": True,
    },
    {
        "name": "Enhancor",
        "slug": "enhancor",
        "category": "AI",
        "description": "Enhancor AI workspace",
        "website_url": "https://enhancor.ai/",
        "login_url": "https://app.enhancor.ai/auth",
        "icon": "Globe",
        "launch_mode": "extension_autofill",
        "status": "active",
        "is_active": True,
    },
)


def _table_columns(conn, table_name: str) -> set[str]:
    rows = conn.execute(text(f"PRAGMA table_info('{table_name}')")).mappings().all()
    return {row["name"] for row in rows}


def _table_exists(conn, table_name: str) -> bool:
    dialect_name = getattr(getattr(conn, "dialect", None), "name", "")
    if dialect_name == "postgresql":
        row = conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = :name
                LIMIT 1
                """
            ),
            {"name": table_name},
        ).fetchone()
        return row is not None

    row = conn.execute(
        text("SELECT name FROM sqlite_master WHERE type='table' AND name=:name"),
        {"name": table_name},
    ).fetchone()
    return row is not None


def _pg_type_exists(conn, type_name: str) -> bool:
    row = conn.execute(
        text(
            """
            SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typname = :type_name
            LIMIT 1
            """
        ),
        {"type_name": type_name},
    ).fetchone()
    return row is not None


def _pg_columns_using_type(conn, udt_name: str) -> list[tuple[str, str]]:
    rows = conn.execute(
        text(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND udt_name = :udt_name
            ORDER BY table_name, column_name
            """
        ),
        {"udt_name": udt_name},
    ).fetchall()
    return [(row[0], row[1]) for row in rows]


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


def _pg_constraint_exists(conn, constraint_name: str) -> bool:
    row = conn.execute(
        text(
            """
            SELECT 1
            FROM pg_constraint
            WHERE conname = :constraint_name
            LIMIT 1
            """
        ),
        {"constraint_name": constraint_name},
    ).fetchone()
    return row is not None


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _seed_departments(conn) -> None:
    for department_name in DEFAULT_DEPARTMENT_DIRECTORY:
        conn.execute(
            text(
                """
                INSERT INTO department_directory (name, is_active, created_at, updated_at)
                SELECT CAST(:insert_name AS VARCHAR(120)), CAST(:insert_active AS BOOLEAN), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM department_directory
                    WHERE LOWER(TRIM(name)) = LOWER(TRIM(CAST(:match_name AS TEXT)))
                )
                """
            ),
            {
                "insert_name": department_name,
                "insert_active": True,
                "match_name": department_name,
            },
        )


def _seed_default_tools(conn) -> None:
    if not _table_exists(conn, "it_portal_tools"):
        return

    for tool in DEFAULT_TOOL_DIRECTORY:
        conn.execute(
            text(
                """
                INSERT INTO it_portal_tools (
                    name,
                    slug,
                    category,
                    description,
                    website_url,
                    login_url,
                    icon,
                    launch_mode,
                    status,
                    is_active,
                    created_at,
                    updated_at
                )
                SELECT
                    CAST(:insert_name AS TEXT),
                    CAST(:insert_slug AS TEXT),
                    CAST(:insert_category AS TEXT),
                    CAST(:insert_description AS TEXT),
                    CAST(:insert_website_url AS TEXT),
                    CAST(:insert_login_url AS TEXT),
                    CAST(:insert_icon AS TEXT),
                    CAST(:insert_launch_mode AS TEXT),
                    CAST(:insert_status AS TEXT),
                    CAST(:insert_is_active AS BOOLEAN),
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM it_portal_tools
                    WHERE LOWER(TRIM(slug)) = LOWER(TRIM(CAST(:match_slug AS TEXT)))
                )
                """
            ),
            {
                "insert_name": tool["name"],
                "insert_slug": tool["slug"],
                "insert_category": tool["category"],
                "insert_description": tool["description"],
                "insert_website_url": tool["website_url"],
                "insert_login_url": tool["login_url"],
                "insert_icon": tool["icon"],
                "insert_launch_mode": tool["launch_mode"],
                "insert_status": tool["status"],
                "insert_is_active": tool["is_active"],
                "match_slug": tool["slug"],
            },
        )


def _migrate_enum_type(conn, old_type: str, new_type: str) -> None:
    if not _pg_type_exists(conn, old_type) or not _pg_type_exists(conn, new_type):
        return

    for table_name, column_name in _pg_columns_using_type(conn, old_type):
        table_sql = _quote_ident(table_name)
        column_sql = _quote_ident(column_name)
        conn.execute(
            text(
                f"""
                ALTER TABLE {table_sql}
                ALTER COLUMN {column_sql} TYPE {new_type}
                USING LOWER({column_sql}::text)::{new_type}
                """
            )
        )

    if not _pg_columns_using_type(conn, old_type):
        conn.execute(text(f"DROP TYPE IF EXISTS {old_type}"))


def _ensure_postgres_schema(conn) -> None:
    """Best-effort enum cleanup for legacy PostgreSQL schemas."""
    # Convert legacy enum type names to canonical type names used by models_new.py
    _migrate_enum_type(conn, "participantrole", "participant_role")
    _migrate_enum_type(conn, "taskstatus", "task_status")
    _pg_add_column_if_missing(conn, "users", "enforce_active_task_policy", "BOOLEAN NOT NULL DEFAULT FALSE")
    _pg_add_column_if_missing(conn, "users", "is_deleted", "BOOLEAN DEFAULT FALSE")
    _pg_add_column_if_missing(conn, "users", "deleted_reason", "TEXT")
    _pg_add_column_if_missing(conn, "users", "deleted_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "users", "deleted_by", "INTEGER")
    _pg_add_column_if_missing(conn, "users", "session_revoked_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "backup_codes_encrypted", "TEXT")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "totp_secret_encrypted", "TEXT")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "linked_credential_id", "INTEGER")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "login_method", "VARCHAR(40) DEFAULT 'email_password'")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "external_event_id", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "generation_id", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "request_id", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "fingerprint", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "source", "VARCHAR(80)")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "schema_version", "INTEGER")
    _pg_add_column_if_missing(conn, "it_portal_tool_usage_events", "confidence", "DOUBLE PRECISION")
    _pg_add_column_if_missing(conn, "group_chat_messages", "attachments_json", "JSON")
    _pg_add_column_if_missing(conn, "group_chat_messages", "mentions_json", "JSON")
    _pg_add_column_if_missing(conn, "group_chat_messages", "forward_metadata_json", "JSON")
    _pg_add_column_if_missing(conn, "group_chat_messages", "deleted_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "group_chat_messages", "reply_to_message_id", "INTEGER")
    _pg_add_column_if_missing(conn, "direct_messages", "deleted_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "direct_messages", "reply_to_message_id", "INTEGER")
    _pg_add_column_if_missing(conn, "direct_messages", "forward_metadata_json", "JSON")
    _pg_add_column_if_missing(conn, "task_comments", "attachments_json", "JSON")
    _pg_add_column_if_missing(conn, "tasks", "workflow_enabled", "BOOLEAN DEFAULT FALSE")
    _pg_add_column_if_missing(conn, "tasks", "workflow_status", "VARCHAR")
    _pg_add_column_if_missing(conn, "tasks", "current_stage_id", "INTEGER")
    _pg_add_column_if_missing(conn, "tasks", "current_stage_order", "INTEGER")
    _pg_add_column_if_missing(conn, "tasks", "current_stage_title", "VARCHAR")
    _pg_add_column_if_missing(conn, "tasks", "final_approval_required", "BOOLEAN DEFAULT FALSE")
    _pg_add_column_if_missing(conn, "task_comments", "stage_id", "INTEGER")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_is_deleted ON users(is_deleted)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_session_revoked_at ON users(session_revoked_at)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS user_roles (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role VARCHAR(80) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_user_roles_user_role UNIQUE (user_id, role)
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_user_id ON user_roles(user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_role ON user_roles(role)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_created_at ON user_roles(created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_role_user_id ON user_roles(role, user_id)"))
    conn.execute(
        text(
            """
            INSERT INTO user_roles (user_id, role, created_at)
            SELECT id, 'admin', CURRENT_TIMESTAMP
            FROM users
            WHERE is_admin = TRUE
            ON CONFLICT (user_id, role) DO NOTHING
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT INTO user_roles (user_id, role, created_at)
            SELECT users.id, LOWER(TRIM(role_value)), CURRENT_TIMESTAMP
            FROM users
            CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE
                    WHEN jsonb_typeof(users.roles_json::jsonb) = 'array' THEN users.roles_json::jsonb
                    ELSE '[]'::jsonb
                END
            ) AS role_value
            WHERE users.roles_json IS NOT NULL
              AND TRIM(role_value) <> ''
            ON CONFLICT (user_id, role) DO NOTHING
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS pending_password_changes (
                id SERIAL PRIMARY KEY,
                approval_request_id INTEGER NOT NULL UNIQUE REFERENCES user_approval_requests(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                password_hash TEXT NOT NULL,
                status VARCHAR NOT NULL DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                consumed_at TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_request ON pending_password_changes(approval_request_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_user_id ON pending_password_changes(user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_status ON pending_password_changes(status)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_status_created ON pending_password_changes(status, created_at)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS notification_outbox (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                event_type VARCHAR(120) NOT NULL,
                payload_json JSON NOT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 10,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                next_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                dispatched_at TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_user_id ON notification_outbox(user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_event_type ON notification_outbox(event_type)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_status ON notification_outbox(status)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_created_at ON notification_outbox(created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_next_attempt_at ON notification_outbox(next_attempt_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_status_next_attempt ON notification_outbox(status, next_attempt_at)"))
    conn.execute(
        text(
            """
            WITH ranked AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY user_id, request_type
                        ORDER BY created_at DESC NULLS LAST, id DESC
                    ) AS rn
                FROM user_approval_requests
                WHERE status = 'pending'
            )
            UPDATE user_approval_requests target
            SET
                status = 'rejected',
                reviewed_at = CURRENT_TIMESTAMP,
                review_notes = COALESCE(review_notes, 'Superseded duplicate pending request during migration')
            FROM ranked
            WHERE target.id = ranked.id
              AND ranked.rn > 1
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_user_approval_pending_user_type
            ON user_approval_requests(user_id, request_type)
            WHERE status = 'pending'
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_it_portal_tool_credentials_linked_credential_id ON it_portal_tool_credentials(linked_credential_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_external_event_id ON it_portal_tool_usage_events(external_event_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_generation_id ON it_portal_tool_usage_events(generation_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_request_id ON it_portal_tool_usage_events(request_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_fingerprint ON it_portal_tool_usage_events(fingerprint)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_source ON it_portal_tool_usage_events(source)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS generation_projects (
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
    _pg_add_column_if_missing(conn, "generation_projects", "description", "TEXT")
    _pg_add_column_if_missing(conn, "generation_projects", "created_by", "INTEGER")
    _pg_add_column_if_missing(conn, "generation_projects", "updated_by", "INTEGER")
    _pg_add_column_if_missing(conn, "generation_projects", "archived_at", "TIMESTAMP")
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_projects_owner_normalized_name_active
            ON generation_projects(owner_user_id, normalized_name)
            WHERE archived_at IS NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_projects_owner_updated_at ON generation_projects(owner_user_id, updated_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_projects_archived_at ON generation_projects(archived_at)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS generation_recovery_audits (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'kling',
                action_type VARCHAR(40) NOT NULL,
                requested_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                date_from DATE NOT NULL,
                date_to DATE NOT NULL,
                kling_count INTEGER NOT NULL DEFAULT 0,
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
    _pg_add_column_if_missing(conn, "generation_recovery_audits", "filters_json", "JSON")
    _pg_add_column_if_missing(conn, "generation_recovery_audits", "report_json", "JSON")
    _pg_add_column_if_missing(conn, "generation_recovery_audits", "error_message", "TEXT")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_recovery_audits_admin_created_at ON generation_recovery_audits(requested_by_admin_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_recovery_audits_provider_action_created_at ON generation_recovery_audits(provider, action_type, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_recovery_audits_date_range_created_at ON generation_recovery_audits(date_from, date_to, created_at DESC)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS generation_records (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(40) NOT NULL DEFAULT 'kling',
                provider_task_id VARCHAR(160),
                provider_generation_id VARCHAR(160),
                canonical_asset_url TEXT,
                canonical_asset_key VARCHAR(255),
                prompt_text TEXT,
                model_label VARCHAR(255),
                duration_label VARCHAR(80),
                resolution_label VARCHAR(80),
                credits_burned DOUBLE PRECISION,
                ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                capture_status VARCHAR(40) NOT NULL DEFAULT 'active',
                owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                ownership_source VARCHAR(80),
                ownership_notes TEXT,
                assigned_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                assigned_at TIMESTAMP,
                project_id INTEGER REFERENCES generation_projects(id) ON DELETE SET NULL,
                source_usage_event_id INTEGER REFERENCES it_portal_tool_usage_events(id) ON DELETE SET NULL,
                recovery_audit_id INTEGER REFERENCES generation_recovery_audits(id) ON DELETE SET NULL,
                recovered_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recovered_at TIMESTAMP,
                metadata_json JSON,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                archived_at TIMESTAMP
            )
            """
        )
    )
    _pg_add_column_if_missing(conn, "generation_records", "provider_generation_id", "VARCHAR(160)")
    _pg_add_column_if_missing(conn, "generation_records", "canonical_asset_url", "TEXT")
    _pg_add_column_if_missing(conn, "generation_records", "canonical_asset_key", "VARCHAR(255)")
    _pg_add_column_if_missing(conn, "generation_records", "duration_label", "VARCHAR(80)")
    _pg_add_column_if_missing(conn, "generation_records", "resolution_label", "VARCHAR(80)")
    _pg_add_column_if_missing(conn, "generation_records", "ownership_source", "VARCHAR(80)")
    _pg_add_column_if_missing(conn, "generation_records", "ownership_notes", "TEXT")
    _pg_add_column_if_missing(conn, "generation_records", "assigned_by_admin_id", "INTEGER")
    _pg_add_column_if_missing(conn, "generation_records", "assigned_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "generation_records", "source_usage_event_id", "INTEGER")
    _pg_add_column_if_missing(conn, "generation_records", "recovery_audit_id", "INTEGER")
    _pg_add_column_if_missing(conn, "generation_records", "recovered_by_admin_id", "INTEGER")
    _pg_add_column_if_missing(conn, "generation_records", "recovered_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "generation_records", "archived_at", "TIMESTAMP")
    if not _pg_constraint_exists(conn, "ck_generation_records_identity_present"):
        conn.execute(
            text(
                """
                ALTER TABLE generation_records
                ADD CONSTRAINT ck_generation_records_identity_present
                CHECK (
                    provider_task_id IS NOT NULL
                    OR provider_generation_id IS NOT NULL
                    OR canonical_asset_key IS NOT NULL
                )
                """
            )
        )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_provider_task_id
            ON generation_records(provider, provider_task_id)
            WHERE provider_task_id IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_provider_generation_id
            ON generation_records(provider, provider_generation_id)
            WHERE provider_generation_id IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_provider_asset_key
            ON generation_records(provider, canonical_asset_key)
            WHERE canonical_asset_key IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_source_usage_event_id
            ON generation_records(source_usage_event_id)
            WHERE source_usage_event_id IS NOT NULL
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_owner_project_created_at ON generation_records(owner_user_id, project_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_owner_status_created_at ON generation_records(owner_user_id, ownership_status, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_project_created_at ON generation_records(project_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_ingestion_created_at ON generation_records(ingestion_source, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_workflow_enabled ON tasks(workflow_enabled)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_workflow_status ON tasks(workflow_status)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_current_stage_order ON tasks(current_stage_order)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_comments_stage_id ON task_comments(stage_id)"))
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_tasks_active_creator_status_updated
            ON tasks(creator_id, status, updated_at DESC)
            WHERE is_deleted = FALSE
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_tasks_active_submitted_by_updated
            ON tasks(submitted_by, updated_at DESC)
            WHERE is_deleted = FALSE AND submitted_by IS NOT NULL
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_task_participants_active_user_task
            ON task_participants(user_id, task_id)
            WHERE is_active = TRUE
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_task_participants_active_task_user
            ON task_participants(task_id, user_id)
            WHERE is_active = TRUE
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_task_participants_unread_user_task
            ON task_participants(user_id, task_id)
            WHERE is_active = TRUE AND is_read = FALSE AND role <> 'creator'
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_views_user_task ON task_views(user_id, task_id)"))
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_task_forwards_task_created_id
            ON task_forwards(task_id, created_at, id)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_group_chat_members_active_user_group
            ON group_chat_members(user_id, group_id)
            WHERE is_active = TRUE
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_group_chat_members_active_group_user
            ON group_chat_members(group_id, user_id)
            WHERE is_active = TRUE
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_group_chats_active_last_message_id
            ON group_chats(last_message_at DESC, id DESC)
            WHERE is_archived = FALSE
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_direct_messages_sender_created
            ON direct_messages(sender_id, created_at DESC, id DESC)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_direct_messages_recipient_created
            ON direct_messages(recipient_id, created_at DESC, id DESC)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS chat_message_read_receipts (
                id SERIAL PRIMARY KEY,
                message_scope VARCHAR(20) NOT NULL,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id),
                delivered_at TIMESTAMP,
                seen_at TIMESTAMP
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_message_read_receipts_scope_message_user
            ON chat_message_read_receipts(message_scope, message_id, user_id)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_scope_message
            ON chat_message_read_receipts(message_scope, message_id)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_user_scope
            ON chat_message_read_receipts(user_id, message_scope)
            """
        )
    )
    _pg_add_column_if_missing(conn, "chat_message_read_receipts", "delivered_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "chat_message_read_receipts", "seen_at", "TIMESTAMP")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_delivered_at ON chat_message_read_receipts(delivered_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_seen_at ON chat_message_read_receipts(seen_at)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS chat_message_reactions (
                id SERIAL PRIMARY KEY,
                message_scope VARCHAR(20) NOT NULL,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id),
                emoji VARCHAR(32) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_message_reactions_scope_message_user ON chat_message_reactions(message_scope, message_id, user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_reactions_scope_message ON chat_message_reactions(message_scope, message_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_reactions_user_scope ON chat_message_reactions(user_id, message_scope)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_reactions_emoji ON chat_message_reactions(emoji)"))
    conn.execute(
        text(
            """
            CREATE INDEX IF NOT EXISTS ix_task_stage_assignees_user_id
            ON task_stage_assignees(user_id)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS it_portal_tool_mailboxes (
                id SERIAL PRIMARY KEY,
                tool_id INTEGER NOT NULL UNIQUE REFERENCES it_portal_tools(id) ON DELETE CASCADE,
                email_address VARCHAR(255) NOT NULL,
                app_password_encrypted TEXT NOT NULL,
                otp_sender_filter VARCHAR(255),
                otp_subject_pattern VARCHAR(255),
                otp_regex VARCHAR(255) NOT NULL DEFAULT '\\b(\\d{4,8})\\b',
                auth_link_pattern VARCHAR(255),
                auth_link_host VARCHAR(255),
                created_by INTEGER REFERENCES users(id),
                updated_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_it_portal_tool_mailboxes_tool_id ON it_portal_tool_mailboxes(tool_id)"))
    _pg_add_column_if_missing(conn, "it_portal_tool_mailboxes", "auth_link_pattern", "VARCHAR(255)")
    _pg_add_column_if_missing(conn, "it_portal_tool_mailboxes", "auth_link_host", "VARCHAR(255)")
    _pg_add_column_if_missing(conn, "it_portal_tool_mailboxes", "mailboxes_json", "JSON")
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS department_directory (
                id SERIAL PRIMARY KEY,
                name VARCHAR(120) NOT NULL UNIQUE,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_by INTEGER REFERENCES users(id),
                updated_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_department_directory_name ON department_directory(name)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_department_directory_is_active ON department_directory(is_active)"))
    _seed_departments(conn)
    _seed_default_tools(conn)
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS web_push_subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                expiration_time TIMESTAMP,
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                last_success_at TIMESTAMP,
                last_failure_at TIMESTAMP,
                failure_reason TEXT,
                is_active BOOLEAN NOT NULL DEFAULT TRUE
            )
            """
        )
    )
    conn.execute(
        text(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'uq_web_push_subscriptions_endpoint'
                ) THEN
                    ALTER TABLE web_push_subscriptions
                    ADD CONSTRAINT uq_web_push_subscriptions_endpoint UNIQUE (endpoint);
                END IF;
            END
            $$;
            """
        )
    )
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "expiration_time", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "user_agent", "TEXT")
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "updated_at", "TIMESTAMP DEFAULT NOW()")
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "last_success_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "last_failure_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "failure_reason", "TEXT")
    _pg_add_column_if_missing(conn, "web_push_subscriptions", "is_active", "BOOLEAN DEFAULT TRUE")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_user_id ON web_push_subscriptions(user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_is_active ON web_push_subscriptions(is_active)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_created_at ON web_push_subscriptions(created_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_updated_at ON web_push_subscriptions(updated_at)"))


def ensure_operational_schema(engine) -> None:
    """Best-effort additive migrations for existing SQLite databases."""
    if engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            _ensure_postgres_schema(conn)
        return

    if engine.dialect.name != "sqlite":
        return

    with engine.begin() as conn:
        if _table_exists(conn, "users"):
            user_cols = _table_columns(conn, "users")
            if "employee_id" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN employee_id VARCHAR"))
            if "roles_json" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN roles_json JSON"))
            if "is_admin" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0"))
            if "is_deleted" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN is_deleted BOOLEAN DEFAULT 0"))
            if "approved_by" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN approved_by INTEGER"))
            if "approved_at" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN approved_at DATETIME"))
            if "rejection_reason" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN rejection_reason TEXT"))
            if "deleted_reason" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN deleted_reason TEXT"))
            if "deleted_at" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN deleted_at DATETIME"))
            if "deleted_by" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN deleted_by INTEGER"))
            if "session_revoked_at" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN session_revoked_at DATETIME"))
            if "enforce_active_task_policy" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN enforce_active_task_policy BOOLEAN NOT NULL DEFAULT 0"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_employee_id ON users(employee_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_is_deleted ON users(is_deleted)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_session_revoked_at ON users(session_revoked_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_roles (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    role VARCHAR(80) NOT NULL,
                    created_at DATETIME,
                    UNIQUE(user_id, role),
                    FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_user_id ON user_roles(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_role ON user_roles(role)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_created_at ON user_roles(created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_roles_role_user_id ON user_roles(role, user_id)"))
        conn.execute(
            text(
                """
                INSERT OR IGNORE INTO user_roles (user_id, role, created_at)
                SELECT id, 'admin', CURRENT_TIMESTAMP
                FROM users
                WHERE is_admin = 1
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT OR IGNORE INTO user_roles (user_id, role, created_at)
                SELECT users.id, LOWER(TRIM(json_each.value)), CURRENT_TIMESTAMP
                FROM users, json_each(users.roles_json)
                WHERE users.roles_json IS NOT NULL
                  AND json_valid(users.roles_json)
                  AND TRIM(json_each.value) <> ''
                """
            )
        )
        if _table_exists(conn, "user_approval_requests"):
            conn.execute(
                text(
                    """
                    UPDATE user_approval_requests
                    SET
                        status = 'rejected',
                        reviewed_at = CURRENT_TIMESTAMP,
                        review_notes = COALESCE(review_notes, 'Superseded duplicate pending request during migration')
                    WHERE status = 'pending'
                      AND id NOT IN (
                          SELECT keep_id
                          FROM (
                              SELECT
                                  MAX(id) AS keep_id
                              FROM user_approval_requests
                              WHERE status = 'pending'
                              GROUP BY user_id, request_type
                          )
                      )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_user_approval_pending_user_type
                    ON user_approval_requests(user_id, request_type)
                    WHERE status = 'pending'
                    """
                )
            )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS department_directory (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR(120) NOT NULL UNIQUE,
                    is_active BOOLEAN NOT NULL DEFAULT 1,
                    created_by INTEGER,
                    updated_by INTEGER,
                    created_at DATETIME,
                    updated_at DATETIME,
                    FOREIGN KEY(created_by) REFERENCES users (id),
                    FOREIGN KEY(updated_by) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_department_directory_name ON department_directory(name)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_department_directory_is_active ON department_directory(is_active)"))
        _seed_departments(conn)
        _seed_default_tools(conn)

        if _table_exists(conn, "tasks"):
            task_cols = _table_columns(conn, "tasks")
            add_columns = {
                "task_id_project_hex": "VARCHAR",
                "task_id_customer_hex": "VARCHAR",
                "project_id": "VARCHAR",
                "project_id_raw": "VARCHAR",
                "project_id_hex": "VARCHAR",
                "current_assignee_ids_json": "JSON",
                "submitted_at": "DATETIME",
                "submitted_by": "INTEGER",
                "task_version": "INTEGER DEFAULT 1",
                "result_version": "INTEGER DEFAULT 0",
                "task_edit_locked": "BOOLEAN DEFAULT 0",
                "result_edit_locked": "BOOLEAN DEFAULT 1",
                "result_text": "TEXT",
                "workflow_enabled": "BOOLEAN DEFAULT 0",
                "workflow_status": "VARCHAR",
                "current_stage_id": "INTEGER",
                "current_stage_order": "INTEGER",
                "current_stage_title": "VARCHAR",
                "final_approval_required": "BOOLEAN DEFAULT 0",
            }
            for column, sql_type in add_columns.items():
                if column not in task_cols:
                    conn.execute(text(f"ALTER TABLE tasks ADD COLUMN {column} {sql_type}"))

            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_project_id ON tasks(project_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_workflow_enabled ON tasks(workflow_enabled)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_workflow_status ON tasks(workflow_status)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_current_stage_order ON tasks(current_stage_order)"))

        if _table_exists(conn, "task_comments"):
            comment_cols = _table_columns(conn, "task_comments")
            if "comment_type" not in comment_cols:
                conn.execute(text("ALTER TABLE task_comments ADD COLUMN comment_type VARCHAR DEFAULT 'general'"))
            if "stage_id" not in comment_cols:
                conn.execute(text("ALTER TABLE task_comments ADD COLUMN stage_id INTEGER"))
            if "attachments_json" not in comment_cols:
                conn.execute(text("ALTER TABLE task_comments ADD COLUMN attachments_json JSON"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_comments_stage_id ON task_comments(stage_id)"))

        if _table_exists(conn, "task_notifications"):
            notif_cols = _table_columns(conn, "task_notifications")
            if "task_number" not in notif_cols:
                conn.execute(text("ALTER TABLE task_notifications ADD COLUMN task_number VARCHAR"))
            if "project_id" not in notif_cols:
                conn.execute(text("ALTER TABLE task_notifications ADD COLUMN project_id VARCHAR"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_notifications_task_number ON task_notifications(task_number)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_notifications_project_id ON task_notifications(project_id)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS web_push_subscriptions (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    endpoint TEXT NOT NULL UNIQUE,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    expiration_time DATETIME,
                    user_agent TEXT,
                    created_at DATETIME,
                    updated_at DATETIME,
                    last_success_at DATETIME,
                    last_failure_at DATETIME,
                    failure_reason TEXT,
                    is_active BOOLEAN DEFAULT 1,
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        if _table_exists(conn, "web_push_subscriptions"):
            push_cols = _table_columns(conn, "web_push_subscriptions")
            if "expiration_time" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN expiration_time DATETIME"))
            if "user_agent" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN user_agent TEXT"))
            if "updated_at" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN updated_at DATETIME"))
            if "last_success_at" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN last_success_at DATETIME"))
            if "last_failure_at" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN last_failure_at DATETIME"))
            if "failure_reason" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN failure_reason TEXT"))
            if "is_active" not in push_cols:
                conn.execute(text("ALTER TABLE web_push_subscriptions ADD COLUMN is_active BOOLEAN DEFAULT 1"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_user_id ON web_push_subscriptions(user_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_is_active ON web_push_subscriptions(is_active)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_created_at ON web_push_subscriptions(created_at)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_web_push_subscriptions_updated_at ON web_push_subscriptions(updated_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS task_views (
                    id INTEGER PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    seen_at DATETIME,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS notification_outbox (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    event_type VARCHAR(120) NOT NULL,
                    payload_json JSON NOT NULL,
                    status VARCHAR(40) NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 10,
                    last_error TEXT,
                    created_at DATETIME,
                    next_attempt_at DATETIME,
                    dispatched_at DATETIME,
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_user_id ON notification_outbox(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_event_type ON notification_outbox(event_type)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_status ON notification_outbox(status)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_created_at ON notification_outbox(created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_next_attempt_at ON notification_outbox(next_attempt_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_outbox_status_next_attempt ON notification_outbox(status, next_attempt_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_approval_requests (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    request_type VARCHAR NOT NULL DEFAULT 'signup',
                    status VARCHAR NOT NULL DEFAULT 'pending',
                    payload_json JSON,
                    created_at DATETIME,
                    reviewed_at DATETIME,
                    reviewed_by INTEGER,
                    review_notes TEXT,
                    FOREIGN KEY(user_id) REFERENCES users (id),
                    FOREIGN KEY(reviewed_by) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_approval_requests_status ON user_approval_requests(status)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS pending_password_changes (
                    id INTEGER PRIMARY KEY,
                    approval_request_id INTEGER NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL,
                    password_hash TEXT NOT NULL,
                    status VARCHAR NOT NULL DEFAULT 'pending',
                    created_at DATETIME,
                    expires_at DATETIME,
                    consumed_at DATETIME,
                    FOREIGN KEY(approval_request_id) REFERENCES user_approval_requests (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_request ON pending_password_changes(approval_request_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_user_id ON pending_password_changes(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_status ON pending_password_changes(status)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_pending_password_changes_status_created ON pending_password_changes(status, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_views_task_id ON task_views(task_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_views_user_id ON task_views(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_stage_assignees_user_id ON task_stage_assignees(user_id)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS task_edit_logs (
                    id INTEGER PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    edit_scope VARCHAR NOT NULL,
                    before_json JSON,
                    after_json JSON,
                    created_at DATETIME,
                    FOREIGN KEY(task_id) REFERENCES tasks (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_task_edit_logs_task_id ON task_edit_logs(task_id)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS id_sequences (
                    id INTEGER PRIMARY KEY,
                    sequence_key VARCHAR NOT NULL UNIQUE,
                    prefix VARCHAR NOT NULL,
                    year INTEGER NOT NULL,
                    next_value INTEGER NOT NULL DEFAULT 1
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_activities (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    date DATE NOT NULL,
                    login_time DATETIME,
                    logout_time DATETIME,
                    total_session_duration INTEGER DEFAULT 0,
                    active_time INTEGER DEFAULT 0,
                    idle_time INTEGER DEFAULT 0,
                    away_time INTEGER DEFAULT 0,
                    status VARCHAR DEFAULT 'ACTIVE',
                    last_seen DATETIME,
                    heartbeat_count INTEGER DEFAULT 0,
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_activities_user_id ON user_activities(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_activities_date ON user_activities(date)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_user_activities_user_date ON user_activities(user_id, date)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS group_chats (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR NOT NULL,
                    created_by INTEGER NOT NULL,
                    created_at DATETIME,
                    updated_at DATETIME,
                    last_message_at DATETIME,
                    is_archived BOOLEAN DEFAULT 0,
                    FOREIGN KEY(created_by) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chats_name ON group_chats(name)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chats_created_by ON group_chats(created_by)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chats_last_message_at ON group_chats(last_message_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS group_chat_members (
                    id INTEGER PRIMARY KEY,
                    group_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    role VARCHAR DEFAULT 'member',
                    joined_at DATETIME,
                    is_active BOOLEAN DEFAULT 1,
                    FOREIGN KEY(group_id) REFERENCES group_chats (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_members_group_id ON group_chat_members(group_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_members_user_id ON group_chat_members(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_members_role ON group_chat_members(role)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_group_chat_members_group_user ON group_chat_members(group_id, user_id)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS it_portal_tool_usage_events (
                    id INTEGER PRIMARY KEY,
                    tool_id INTEGER NOT NULL,
                    credential_id INTEGER,
                    user_id INTEGER NOT NULL,
                    event_type VARCHAR NOT NULL,
                    event_date DATE NOT NULL,
                    status VARCHAR NOT NULL DEFAULT 'captured',
                    model_label VARCHAR(255),
                    duration_label VARCHAR(80),
                    resolution_label VARCHAR(80),
                    prompt_text TEXT,
                    expected_credits FLOAT,
                    credits_before FLOAT,
                    credits_after FLOAT,
                    credits_burned FLOAT,
                    external_event_id VARCHAR(160),
                    generation_id VARCHAR(160),
                    request_id VARCHAR(160),
                    fingerprint VARCHAR(160),
                    source VARCHAR(80),
                    schema_version INTEGER,
                    confidence FLOAT,
                    metadata_json JSON,
                    created_at DATETIME,
                    FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                    FOREIGN KEY(credential_id) REFERENCES it_portal_tool_credentials (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_tool_id ON it_portal_tool_usage_events(tool_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_credential_id ON it_portal_tool_usage_events(credential_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_user_id ON it_portal_tool_usage_events(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_event_type ON it_portal_tool_usage_events(event_type)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_event_date ON it_portal_tool_usage_events(event_date)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_created_at ON it_portal_tool_usage_events(created_at)"))
        if _table_exists(conn, "it_portal_tool_usage_events"):
            usage_cols = _table_columns(conn, "it_portal_tool_usage_events")
            usage_add_columns = {
                "external_event_id": "VARCHAR(160)",
                "generation_id": "VARCHAR(160)",
                "request_id": "VARCHAR(160)",
                "fingerprint": "VARCHAR(160)",
                "source": "VARCHAR(80)",
                "schema_version": "INTEGER",
                "confidence": "FLOAT",
            }
            for column, sql_type in usage_add_columns.items():
                if column not in usage_cols:
                    conn.execute(text(f"ALTER TABLE it_portal_tool_usage_events ADD COLUMN {column} {sql_type}"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_external_event_id ON it_portal_tool_usage_events(external_event_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_generation_id ON it_portal_tool_usage_events(generation_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_request_id ON it_portal_tool_usage_events(request_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_fingerprint ON it_portal_tool_usage_events(fingerprint)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tool_usage_events_source ON it_portal_tool_usage_events(source)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS generation_projects (
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
                CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_projects_owner_normalized_name_active
                ON generation_projects(owner_user_id, normalized_name)
                WHERE archived_at IS NULL
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_projects_owner_updated_at ON generation_projects(owner_user_id, updated_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_projects_archived_at ON generation_projects(archived_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS generation_recovery_audits (
                    id INTEGER PRIMARY KEY,
                    provider VARCHAR(40) NOT NULL DEFAULT 'kling',
                    action_type VARCHAR(40) NOT NULL,
                    requested_by_admin_id INTEGER NOT NULL,
                    date_from DATE NOT NULL,
                    date_to DATE NOT NULL,
                    kling_count INTEGER NOT NULL DEFAULT 0,
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
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_recovery_audits_admin_created_at ON generation_recovery_audits(requested_by_admin_id, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_recovery_audits_provider_action_created_at ON generation_recovery_audits(provider, action_type, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_recovery_audits_date_range_created_at ON generation_recovery_audits(date_from, date_to, created_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS generation_records (
                    id INTEGER PRIMARY KEY,
                    provider VARCHAR(40) NOT NULL DEFAULT 'kling',
                    provider_task_id VARCHAR(160),
                    provider_generation_id VARCHAR(160),
                    canonical_asset_url TEXT,
                    canonical_asset_key VARCHAR(255),
                    prompt_text TEXT,
                    model_label VARCHAR(255),
                    duration_label VARCHAR(80),
                    resolution_label VARCHAR(80),
                    credits_burned FLOAT,
                    ingestion_source VARCHAR(40) NOT NULL DEFAULT 'captured',
                    capture_status VARCHAR(40) NOT NULL DEFAULT 'active',
                    owner_user_id INTEGER,
                    ownership_status VARCHAR(40) NOT NULL DEFAULT 'unknown',
                    ownership_source VARCHAR(80),
                    ownership_notes TEXT,
                    assigned_by_admin_id INTEGER,
                    assigned_at DATETIME,
                    project_id INTEGER,
                    source_usage_event_id INTEGER,
                    recovery_audit_id INTEGER,
                    recovered_by_admin_id INTEGER,
                    recovered_at DATETIME,
                    metadata_json JSON,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    archived_at DATETIME,
                    CHECK (
                        provider_task_id IS NOT NULL
                        OR provider_generation_id IS NOT NULL
                        OR canonical_asset_key IS NOT NULL
                    ),
                    FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
                    FOREIGN KEY(assigned_by_admin_id) REFERENCES users (id) ON DELETE SET NULL,
                    FOREIGN KEY(project_id) REFERENCES generation_projects (id) ON DELETE SET NULL,
                    FOREIGN KEY(source_usage_event_id) REFERENCES it_portal_tool_usage_events (id) ON DELETE SET NULL,
                    FOREIGN KEY(recovery_audit_id) REFERENCES generation_recovery_audits (id) ON DELETE SET NULL,
                    FOREIGN KEY(recovered_by_admin_id) REFERENCES users (id) ON DELETE SET NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_provider_task_id
                ON generation_records(provider, provider_task_id)
                WHERE provider_task_id IS NOT NULL
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_provider_generation_id
                ON generation_records(provider, provider_generation_id)
                WHERE provider_generation_id IS NOT NULL
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_provider_asset_key
                ON generation_records(provider, canonical_asset_key)
                WHERE canonical_asset_key IS NOT NULL
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_source_usage_event_id
                ON generation_records(source_usage_event_id)
                WHERE source_usage_event_id IS NOT NULL
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_owner_project_created_at ON generation_records(owner_user_id, project_id, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_owner_status_created_at ON generation_records(owner_user_id, ownership_status, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_project_created_at ON generation_records(project_id, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_generation_records_ingestion_created_at ON generation_records(ingestion_source, created_at)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS group_chat_messages (
                    id INTEGER PRIMARY KEY,
                    group_id INTEGER NOT NULL,
                    sender_id INTEGER NOT NULL,
                    reply_to_message_id INTEGER,
                    message TEXT NOT NULL,
                    created_at DATETIME,
                    edited_at DATETIME,
                    deleted_at DATETIME,
                    FOREIGN KEY(group_id) REFERENCES group_chats (id),
                    FOREIGN KEY(sender_id) REFERENCES users (id),
                    FOREIGN KEY(reply_to_message_id) REFERENCES group_chat_messages (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_group_id ON group_chat_messages(group_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_sender_id ON group_chat_messages(sender_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_reply_to_message_id ON group_chat_messages(reply_to_message_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_created_at ON group_chat_messages(created_at)"))
        if _table_exists(conn, "group_chat_messages"):
            cols = _table_columns(conn, "group_chat_messages")
            if "attachments_json" not in cols:
                conn.execute(text("ALTER TABLE group_chat_messages ADD COLUMN attachments_json JSON"))
            if "mentions_json" not in cols:
                conn.execute(text("ALTER TABLE group_chat_messages ADD COLUMN mentions_json JSON"))
            if "forward_metadata_json" not in cols:
                conn.execute(text("ALTER TABLE group_chat_messages ADD COLUMN forward_metadata_json JSON"))
            if "deleted_at" not in cols:
                conn.execute(text("ALTER TABLE group_chat_messages ADD COLUMN deleted_at DATETIME"))
            if "reply_to_message_id" not in cols:
                conn.execute(text("ALTER TABLE group_chat_messages ADD COLUMN reply_to_message_id INTEGER"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS direct_messages (
                    id INTEGER PRIMARY KEY,
                    sender_id INTEGER NOT NULL,
                    recipient_id INTEGER NOT NULL,
                    reply_to_message_id INTEGER,
                    message TEXT NOT NULL,
                    created_at DATETIME,
                    edited_at DATETIME,
                    deleted_at DATETIME,
                    FOREIGN KEY(sender_id) REFERENCES users (id),
                    FOREIGN KEY(recipient_id) REFERENCES users (id),
                    FOREIGN KEY(reply_to_message_id) REFERENCES direct_messages (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_sender_id ON direct_messages(sender_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_recipient_id ON direct_messages(recipient_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_reply_to_message_id ON direct_messages(reply_to_message_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_created_at ON direct_messages(created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_sender_created ON direct_messages(sender_id, created_at DESC, id DESC)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_recipient_created ON direct_messages(recipient_id, created_at DESC, id DESC)"))
        if _table_exists(conn, "direct_messages"):
            cols = _table_columns(conn, "direct_messages")
            if "attachments_json" not in cols:
                conn.execute(text("ALTER TABLE direct_messages ADD COLUMN attachments_json JSON"))
            if "deleted_at" not in cols:
                conn.execute(text("ALTER TABLE direct_messages ADD COLUMN deleted_at DATETIME"))
            if "reply_to_message_id" not in cols:
                conn.execute(text("ALTER TABLE direct_messages ADD COLUMN reply_to_message_id INTEGER"))
            if "forward_metadata_json" not in cols:
                conn.execute(text("ALTER TABLE direct_messages ADD COLUMN forward_metadata_json JSON"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_message_read_receipts (
                    id INTEGER PRIMARY KEY,
                    message_scope VARCHAR(20) NOT NULL,
                    message_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    delivered_at DATETIME,
                    seen_at DATETIME,
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_message_read_receipts_scope_message_user ON chat_message_read_receipts(message_scope, message_id, user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_scope_message ON chat_message_read_receipts(message_scope, message_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_user_scope ON chat_message_read_receipts(user_id, message_scope)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_delivered_at ON chat_message_read_receipts(delivered_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_read_receipts_seen_at ON chat_message_read_receipts(seen_at)"))
        if _table_exists(conn, "chat_message_read_receipts"):
            cols = _table_columns(conn, "chat_message_read_receipts")
            if "delivered_at" not in cols:
                conn.execute(text("ALTER TABLE chat_message_read_receipts ADD COLUMN delivered_at DATETIME"))
            if "seen_at" not in cols:
                conn.execute(text("ALTER TABLE chat_message_read_receipts ADD COLUMN seen_at DATETIME"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_message_reactions (
                    id INTEGER PRIMARY KEY,
                    message_scope VARCHAR(20) NOT NULL,
                    message_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    emoji VARCHAR(32) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_message_reactions_scope_message_user ON chat_message_reactions(message_scope, message_id, user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_reactions_scope_message ON chat_message_reactions(message_scope, message_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_reactions_user_scope ON chat_message_reactions(user_id, message_scope)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_message_reactions_emoji ON chat_message_reactions(emoji)"))

        if _table_exists(conn, "it_portal_tool_credentials"):
            credential_cols = _table_columns(conn, "it_portal_tool_credentials")
            if "backup_codes_encrypted" not in credential_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_credentials ADD COLUMN backup_codes_encrypted TEXT"))
            if "totp_secret_encrypted" not in credential_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_credentials ADD COLUMN totp_secret_encrypted TEXT"))
            if "linked_credential_id" not in credential_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_credentials ADD COLUMN linked_credential_id INTEGER"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_it_portal_tool_credentials_linked_credential_id ON it_portal_tool_credentials(linked_credential_id)"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS it_portal_tool_mailboxes (
                    id INTEGER PRIMARY KEY,
                    tool_id INTEGER NOT NULL UNIQUE,
                    email_address VARCHAR(255) NOT NULL,
                    app_password_encrypted TEXT NOT NULL,
                    otp_sender_filter VARCHAR(255),
                    otp_subject_pattern VARCHAR(255),
                    otp_regex VARCHAR(255) NOT NULL DEFAULT '\\b(\\d{4,8})\\b',
                    auth_link_pattern VARCHAR(255),
                    auth_link_host VARCHAR(255),
                    created_by INTEGER,
                    updated_by INTEGER,
                    created_at DATETIME,
                    updated_at DATETIME,
                    FOREIGN KEY(tool_id) REFERENCES it_portal_tools (id),
                    FOREIGN KEY(created_by) REFERENCES users (id),
                    FOREIGN KEY(updated_by) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_it_portal_tool_mailboxes_tool_id ON it_portal_tool_mailboxes(tool_id)"))
        if _table_exists(conn, "it_portal_tool_mailboxes"):
            mailbox_cols = _table_columns(conn, "it_portal_tool_mailboxes")
            if "auth_link_pattern" not in mailbox_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_mailboxes ADD COLUMN auth_link_pattern VARCHAR(255)"))
            if "auth_link_host" not in mailbox_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_mailboxes ADD COLUMN auth_link_host VARCHAR(255)"))
            if "mailboxes_json" not in mailbox_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_mailboxes ADD COLUMN mailboxes_json JSON"))
        if _table_exists(conn, "it_portal_tool_credentials"):
            credential_cols = _table_columns(conn, "it_portal_tool_credentials")
            if "login_method" not in credential_cols:
                conn.execute(text("ALTER TABLE it_portal_tool_credentials ADD COLUMN login_method VARCHAR(40) DEFAULT 'email_password'"))
