from typing import Optional

from sqlalchemy.orm import Session

from models_new import GenerationProjectEvent


def record_generation_project_event(
    db: Session,
    *,
    project_id: int,
    generation_id: Optional[int] = None,
    actor_user_id: Optional[int] = None,
    event_type: str,
    description: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> GenerationProjectEvent:
    """Insert a project timeline event. Does not commit — caller controls the transaction."""
    event = GenerationProjectEvent(
        project_id=project_id,
        generation_id=generation_id,
        actor_user_id=actor_user_id,
        event_type=event_type,
        description=description,
        metadata_json=metadata or None,
    )
    db.add(event)
    return event
