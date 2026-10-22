# utils/client_gate.py
"""
Shared validation for the admin-managed Client list used alongside the Task
Mapping gate (see utils/task_gate.py) before a Freepik generation. Clients are
a global, admin-curated lookup (GenerationClient, models_new.py) - unlike
tasks there is no per-user ownership to check, only "does this client exist
and is it still active".
"""
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, select, union_all
from sqlalchemy.orm import Session

from database_config import Base
from models_new import GenerationClient

RECENT_CLIENTS_LIMIT = 5
RECENT_CLIENTS_LOOKBACK = timedelta(days=90)


def _client_pick_tables() -> list:
    """Every tool's capture-event table: one row per generate/download click,
    holding who clicked (user_id) and the client they picked in the gate.
    Kling's is it_portal_tool_usage_events. Found from the registered models
    so a new tool's table is picked up without listing it here."""
    tables = []
    for name, table in Base.metadata.tables.items():
        if not (name.endswith("_capture_events") or name == "it_portal_tool_usage_events"):
            continue
        if {"user_id", "linked_client_id", "created_at"} <= set(table.c.keys()):
            tables.append(table)
    return tables


def get_recent_client_ids(db: Session, user_id: Optional[int], limit: int = RECENT_CLIENTS_LIMIT) -> list[int]:
    """The clients this user picked most recently, across every tool, newest
    first. Read from the server rather than the browser because one Chrome
    profile is often shared by several people."""
    tables = _client_pick_tables()
    if not user_id or not tables:
        return []
    since = datetime.utcnow() - RECENT_CLIENTS_LOOKBACK
    picks = union_all(*[
        select(table.c.linked_client_id.label("client_id"), table.c.created_at.label("picked_at")).where(
            table.c.user_id == user_id,
            table.c.linked_client_id.isnot(None),
            table.c.created_at >= since,
        )
        for table in tables
    ]).subquery()
    last_picked = func.max(picks.c.picked_at)
    rows = db.execute(
        select(picks.c.client_id, last_picked)
        .group_by(picks.c.client_id)
        .order_by(last_picked.desc())
        .limit(limit)
    ).all()
    return [int(client_id) for client_id, _ in rows]


def get_active_clients(db: Session, limit: int = 500) -> list[GenerationClient]:
    """Populates the client picker."""
    return (
        db.query(GenerationClient)
        .filter(GenerationClient.is_active == True)  # noqa: E712
        .order_by(GenerationClient.name.asc())
        .limit(limit)
        .all()
    )


def validate_client_for_generation(db: Session, client_id: Optional[int]) -> Optional[GenerationClient]:
    """Re-check, server-side, that `client_id` is still a real, active
    client - never trust a client_id handed back by a client (extension,
    browser, or otherwise) at face value."""
    if not client_id:
        return None
    return (
        db.query(GenerationClient)
        .filter(GenerationClient.id == client_id, GenerationClient.is_active == True)  # noqa: E712
        .first()
    )
