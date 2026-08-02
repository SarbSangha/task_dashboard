# utils/client_gate.py
"""
Shared validation for the admin-managed Client list used alongside the Task
Mapping gate (see utils/task_gate.py) before a Freepik generation. Clients are
a global, admin-curated lookup (GenerationClient, models_new.py) - unlike
tasks there is no per-user ownership to check, only "does this client exist
and is it still active".
"""
from typing import Optional

from sqlalchemy.orm import Session

from models_new import GenerationClient


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
