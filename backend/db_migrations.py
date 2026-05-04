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


def _table_columns(conn, table_name: str) -> set[str]:
    rows = conn.execute(text(f"PRAGMA table_info('{table_name}')")).mappings().all()
    return {row["name"] for row in rows}


def _table_exists(conn, table_name: str) -> bool:
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
    _pg_add_column_if_missing(conn, "users", "is_deleted", "BOOLEAN DEFAULT FALSE")
    _pg_add_column_if_missing(conn, "users", "deleted_reason", "TEXT")
    _pg_add_column_if_missing(conn, "users", "deleted_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "users", "deleted_by", "INTEGER")
    _pg_add_column_if_missing(conn, "users", "session_revoked_at", "TIMESTAMP")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "backup_codes_encrypted", "TEXT")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "totp_secret_encrypted", "TEXT")
    _pg_add_column_if_missing(conn, "it_portal_tool_credentials", "linked_credential_id", "INTEGER")
    _pg_add_column_if_missing(conn, "group_chat_messages", "attachments_json", "JSON")
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_it_portal_tool_credentials_linked_credential_id ON it_portal_tool_credentials(linked_credential_id)"))
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
                created_by INTEGER REFERENCES users(id),
                updated_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_it_portal_tool_mailboxes_tool_id ON it_portal_tool_mailboxes(tool_id)"))
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
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_employee_id ON users(employee_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_is_deleted ON users(is_deleted)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_session_revoked_at ON users(session_revoked_at)"))

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
                CREATE TABLE IF NOT EXISTS group_chat_messages (
                    id INTEGER PRIMARY KEY,
                    group_id INTEGER NOT NULL,
                    sender_id INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    created_at DATETIME,
                    edited_at DATETIME,
                    FOREIGN KEY(group_id) REFERENCES group_chats (id),
                    FOREIGN KEY(sender_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_group_id ON group_chat_messages(group_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_sender_id ON group_chat_messages(sender_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_group_chat_messages_created_at ON group_chat_messages(created_at)"))
        if _table_exists(conn, "group_chat_messages"):
            cols = _table_columns(conn, "group_chat_messages")
            if "attachments_json" not in cols:
                conn.execute(text("ALTER TABLE group_chat_messages ADD COLUMN attachments_json JSON"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS direct_messages (
                    id INTEGER PRIMARY KEY,
                    sender_id INTEGER NOT NULL,
                    recipient_id INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    created_at DATETIME,
                    edited_at DATETIME,
                    FOREIGN KEY(sender_id) REFERENCES users (id),
                    FOREIGN KEY(recipient_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_sender_id ON direct_messages(sender_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_recipient_id ON direct_messages(recipient_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_created_at ON direct_messages(created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_sender_created ON direct_messages(sender_id, created_at DESC, id DESC)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_direct_messages_recipient_created ON direct_messages(recipient_id, created_at DESC, id DESC)"))
        if _table_exists(conn, "direct_messages"):
            cols = _table_columns(conn, "direct_messages")
            if "attachments_json" not in cols:
                conn.execute(text("ALTER TABLE direct_messages ADD COLUMN attachments_json JSON"))

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
