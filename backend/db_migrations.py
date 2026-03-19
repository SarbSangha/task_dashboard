from sqlalchemy import text


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
    _pg_add_column_if_missing(conn, "group_chat_messages", "attachments_json", "JSON")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_is_deleted ON users(is_deleted)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_session_revoked_at ON users(session_revoked_at)"))


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
            }
            for column, sql_type in add_columns.items():
                if column not in task_cols:
                    conn.execute(text(f"ALTER TABLE tasks ADD COLUMN {column} {sql_type}"))

            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_project_id ON tasks(project_id)"))

        if _table_exists(conn, "task_comments"):
            comment_cols = _table_columns(conn, "task_comments")
            if "comment_type" not in comment_cols:
                conn.execute(text("ALTER TABLE task_comments ADD COLUMN comment_type VARCHAR DEFAULT 'general'"))

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
