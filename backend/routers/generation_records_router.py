from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationRecord, User
from utils.permissions import require_user


router = APIRouter(prefix="/api/generations", tags=["Generations"])
DEFAULT_UNGROUPED_PAGE_SIZE = 24
MAX_UNGROUPED_PAGE_SIZE = 100


def _clamp_pagination(limit: int, offset: int) -> tuple[int, int]:
    try:
        resolved_limit = int(limit)
    except (TypeError, ValueError):
        resolved_limit = DEFAULT_UNGROUPED_PAGE_SIZE
    try:
        resolved_offset = int(offset)
    except (TypeError, ValueError):
        resolved_offset = 0
    resolved_limit = resolved_limit if resolved_limit > 0 else DEFAULT_UNGROUPED_PAGE_SIZE
    resolved_limit = min(resolved_limit, MAX_UNGROUPED_PAGE_SIZE)
    resolved_offset = max(resolved_offset, 0)
    return resolved_limit, resolved_offset


@router.get("/ungrouped")
async def list_ungrouped_generations(
    limit: int = Query(DEFAULT_UNGROUPED_PAGE_SIZE, ge=1, le=MAX_UNGROUPED_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    query = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.owner_user_id == current_user.id,
            GenerationRecord.project_id.is_(None),
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.capture_status == "active",
        )
    )
    total = query.count()
    generations = (
        query.order_by(GenerationRecord.created_at.desc(), GenerationRecord.id.desc())
        .offset(resolved_offset)
        .limit(resolved_limit)
        .all()
    )
    return {
        "success": True,
        "data": [generation.to_dict() for generation in generations],
        "pagination": {
            "limit": resolved_limit,
            "offset": resolved_offset,
            "total": total,
        },
    }
