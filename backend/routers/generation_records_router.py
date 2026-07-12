import re
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationCollectionMember, GenerationProject, GenerationRecord, GenerationTag, User
from utils.datetime_utils import serialize_utc_datetime
from utils.generation_events import record_generation_project_event
from utils.permissions import require_faculty, require_user


router = APIRouter(prefix="/api/generations", tags=["Generations"])
DEFAULT_UNGROUPED_PAGE_SIZE = 24
MAX_UNGROUPED_PAGE_SIZE = 100
DEFAULT_SEARCH_PAGE_SIZE = 40
MAX_SEARCH_PAGE_SIZE = 120
TOP_TAGS_LIMIT = 100
MAX_TAGS_PER_GENERATION = 20

SEARCH_SORT_OPTIONS = {"latest", "oldest", "credits"}
OWNERSHIP_STATUS_OPTIONS = {"unknown", "resolved"}

_WHITESPACE_RE = re.compile(r"\s+")


class GenerationTagCreatePayload(BaseModel):
    tag: str = Field(..., min_length=1, max_length=40)


def _normalize_tag(value: str) -> str:
    return _WHITESPACE_RE.sub(" ", f"{value or ''}".strip()).lower()[:40]


def _clamp_pagination(limit: int, offset: int, default: int = DEFAULT_UNGROUPED_PAGE_SIZE, maximum: int = MAX_UNGROUPED_PAGE_SIZE) -> tuple[int, int]:
    try:
        resolved_limit = int(limit)
    except (TypeError, ValueError):
        resolved_limit = default
    try:
        resolved_offset = int(offset)
    except (TypeError, ValueError):
        resolved_offset = 0
    resolved_limit = resolved_limit if resolved_limit > 0 else default
    resolved_limit = min(resolved_limit, maximum)
    resolved_offset = max(resolved_offset, 0)
    return resolved_limit, resolved_offset


def _serialize_generation_row(
    generation: GenerationRecord,
    owner: Optional[User],
    project: Optional[GenerationProject],
    tags: Optional[list[str]] = None,
) -> dict:
    payload = generation.to_dict()
    payload["ownerName"] = owner.name if owner else None
    payload["ownerAvatar"] = owner.avatar if owner else None
    payload["ownerDepartment"] = owner.department if owner else None
    payload["projectName"] = project.name if project else None
    payload["tags"] = tags or []
    return payload


def _tags_by_generation_id(db: Session, generation_ids: list[int]) -> dict[int, list[str]]:
    if not generation_ids:
        return {}
    rows = (
        db.query(GenerationTag.generation_id, GenerationTag.tag)
        .filter(GenerationTag.generation_id.in_(generation_ids))
        .order_by(GenerationTag.created_at.asc())
        .all()
    )
    tags_map: dict[int, list[str]] = {}
    for generation_id, tag in rows:
        tags_map.setdefault(generation_id, []).append(tag)
    return tags_map


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


@router.get("/filters")
async def get_generation_filters(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    base_query = db.query(GenerationRecord).filter(GenerationRecord.archived_at.is_(None))
    models = [
        row[0]
        for row in base_query.with_entities(GenerationRecord.model_label)
        .filter(GenerationRecord.model_label.isnot(None))
        .distinct()
        .order_by(GenerationRecord.model_label.asc())
        .all()
    ]
    resolutions = [
        row[0]
        for row in base_query.with_entities(GenerationRecord.resolution_label)
        .filter(GenerationRecord.resolution_label.isnot(None))
        .distinct()
        .order_by(GenerationRecord.resolution_label.asc())
        .all()
    ]
    top_tag_rows = (
        db.query(GenerationTag.normalized_tag, func.count(GenerationTag.id).label("usage_count"))
        .group_by(GenerationTag.normalized_tag)
        .order_by(func.count(GenerationTag.id).desc())
        .limit(TOP_TAGS_LIMIT)
        .all()
    )
    tags = [row[0] for row in top_tag_rows]
    return {
        "success": True,
        "models": models,
        "resolutions": resolutions,
        "ownershipStatuses": sorted(OWNERSHIP_STATUS_OPTIONS),
        "tags": tags,
    }


@router.get("/search")
async def search_generations(
    q: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    owner_user_id: Optional[int] = Query(None),
    project_id: Optional[int] = Query(None),
    collection_id: Optional[int] = Query(None),
    model: Optional[str] = Query(None),
    resolution: Optional[str] = Query(None),
    ownership_status: Optional[str] = Query(None),
    is_favorite: Optional[bool] = Query(None),
    tag: Optional[str] = Query(None),
    include_archived: bool = Query(False),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    sort: str = Query("latest"),
    limit: int = Query(DEFAULT_SEARCH_PAGE_SIZE, ge=1, le=MAX_SEARCH_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    if sort not in SEARCH_SORT_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid sort option. Expected one of {sorted(SEARCH_SORT_OPTIONS)}")
    if ownership_status and ownership_status not in OWNERSHIP_STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid ownership_status. Expected one of {sorted(OWNERSHIP_STATUS_OPTIONS)}")

    resolved_limit, resolved_offset = _clamp_pagination(limit, offset, DEFAULT_SEARCH_PAGE_SIZE, MAX_SEARCH_PAGE_SIZE)

    query = (
        db.query(GenerationRecord, User, GenerationProject)
        .outerjoin(User, GenerationRecord.owner_user_id == User.id)
        .outerjoin(GenerationProject, GenerationRecord.project_id == GenerationProject.id)
    )

    if not include_archived:
        query = query.filter(GenerationRecord.archived_at.is_(None))
    if department:
        query = query.filter(func.lower(User.department) == department.strip().lower())
    if owner_user_id is not None:
        query = query.filter(GenerationRecord.owner_user_id == owner_user_id)
    if project_id is not None:
        query = query.filter(GenerationRecord.project_id == project_id)
    if collection_id is not None:
        query = query.join(
            GenerationCollectionMember, GenerationCollectionMember.generation_id == GenerationRecord.id
        ).filter(GenerationCollectionMember.collection_id == collection_id)
    if model:
        query = query.filter(GenerationRecord.model_label.ilike(f"%{model.strip()}%"))
    if resolution:
        query = query.filter(GenerationRecord.resolution_label == resolution)
    if ownership_status:
        query = query.filter(GenerationRecord.ownership_status == ownership_status)
    if is_favorite is not None:
        query = query.filter(GenerationRecord.is_favorite == is_favorite)
    if tag:
        query = query.join(GenerationTag, GenerationTag.generation_id == GenerationRecord.id).filter(
            GenerationTag.normalized_tag == _normalize_tag(tag)
        )
    if date_from:
        query = query.filter(GenerationRecord.created_at >= date_from)
    if date_to:
        query = query.filter(GenerationRecord.created_at < date_to + timedelta(days=1))
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(
                GenerationRecord.prompt_text.ilike(like),
                GenerationRecord.model_label.ilike(like),
                GenerationRecord.canonical_asset_key.ilike(like),
                GenerationRecord.provider_task_id.ilike(like),
                GenerationRecord.provider_generation_id.ilike(like),
                User.name.ilike(like),
                GenerationProject.name.ilike(like),
            )
        )

    if sort == "oldest":
        query = query.order_by(GenerationRecord.created_at.asc(), GenerationRecord.id.asc())
    elif sort == "credits":
        query = query.order_by(GenerationRecord.credits_burned.desc().nullslast(), GenerationRecord.created_at.desc())
    else:
        query = query.order_by(GenerationRecord.created_at.desc(), GenerationRecord.id.desc())

    rows = query.offset(resolved_offset).limit(resolved_limit + 1).all()
    has_more = len(rows) > resolved_limit
    rows = rows[:resolved_limit]

    tags_map = _tags_by_generation_id(db, [generation.id for generation, _owner, _project in rows])

    return {
        "success": True,
        "data": [
            _serialize_generation_row(generation, owner, project, tags_map.get(generation.id))
            for generation, owner, project in rows
        ],
        "pagination": {
            "limit": resolved_limit,
            "offset": resolved_offset,
            "hasMore": has_more,
            "nextOffset": (resolved_offset + resolved_limit) if has_more else None,
        },
    }


def _top_model_by_user_id(db: Session, user_ids: list[int]) -> dict[int, str]:
    if not user_ids:
        return {}
    rows = (
        db.query(
            GenerationRecord.owner_user_id,
            GenerationRecord.model_label,
            func.count(GenerationRecord.id).label("count"),
        )
        .filter(
            GenerationRecord.owner_user_id.in_(user_ids),
            GenerationRecord.model_label.isnot(None),
            GenerationRecord.archived_at.is_(None),
        )
        .group_by(GenerationRecord.owner_user_id, GenerationRecord.model_label)
        .all()
    )
    best: dict[int, tuple[str, int]] = {}
    for owner_id, model_label, count in rows:
        current = best.get(owner_id)
        if not current or count > current[1]:
            best[owner_id] = (model_label, count)
    return {owner_id: model for owner_id, (model, _count) in best.items()}


@router.get("/users")
async def list_generation_users_directory(
    q: Optional[str] = Query(None),
    limit: int = Query(DEFAULT_UNGROUPED_PAGE_SIZE, ge=1, le=MAX_UNGROUPED_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Company-wide user directory aggregating each owner's generation activity."""
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    video_case = case((GenerationRecord.duration_label.isnot(None), 1), else_=0)

    query = (
        db.query(
            User,
            func.count(GenerationRecord.id).label("total"),
            func.coalesce(func.sum(video_case), 0).label("video_count"),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
            func.max(GenerationRecord.created_at).label("last_activity_at"),
        )
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(GenerationRecord.archived_at.is_(None))
        .group_by(User.id)
    )
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(User.name.ilike(like), User.department.ilike(like)))

    total_users = query.count()
    rows = (
        query.order_by(func.count(GenerationRecord.id).desc())
        .offset(resolved_offset)
        .limit(resolved_limit)
        .all()
    )

    user_ids = [user.id for user, *_rest in rows]
    top_model_map = _top_model_by_user_id(db, user_ids)

    data = []
    for user, total, video_count, credits, last_activity_at in rows:
        total = int(total or 0)
        video_count = int(video_count or 0)
        data.append({
            "userId": user.id,
            "name": user.name,
            "avatar": user.avatar,
            "department": user.department,
            "totalGenerations": total,
            "imageCount": total - video_count,
            "videoCount": video_count,
            "creditsBurned": float(credits or 0),
            "lastActivityAt": serialize_utc_datetime(last_activity_at),
            "topModel": top_model_map.get(user.id),
        })

    return {
        "success": True,
        "data": data,
        "pagination": {
            "limit": resolved_limit,
            "offset": resolved_offset,
            "total": total_users,
        },
    }


@router.get("/users/{user_id}")
async def get_generation_user_profile(
    user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    video_case = case((GenerationRecord.duration_label.isnot(None), 1), else_=0)
    total, video_count, credits, last_activity_at = (
        db.query(
            func.count(GenerationRecord.id),
            func.coalesce(func.sum(video_case), 0),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0),
            func.max(GenerationRecord.created_at),
        )
        .filter(GenerationRecord.owner_user_id == user_id, GenerationRecord.archived_at.is_(None))
        .first()
    )
    total = int(total or 0)
    video_count = int(video_count or 0)

    top_projects_rows = (
        db.query(GenerationProject.id, GenerationProject.name, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.project_id == GenerationProject.id)
        .filter(GenerationRecord.owner_user_id == user_id, GenerationRecord.archived_at.is_(None))
        .group_by(GenerationProject.id, GenerationProject.name)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(5)
        .all()
    )
    top_projects = [{"projectId": pid, "name": name, "count": int(count)} for pid, name, count in top_projects_rows]

    top_tags_rows = (
        db.query(GenerationTag.normalized_tag, func.count(GenerationTag.id).label("count"))
        .join(GenerationRecord, GenerationRecord.id == GenerationTag.generation_id)
        .filter(GenerationRecord.owner_user_id == user_id)
        .group_by(GenerationTag.normalized_tag)
        .order_by(func.count(GenerationTag.id).desc())
        .limit(10)
        .all()
    )
    top_tags = [{"tag": tag, "count": int(count)} for tag, count in top_tags_rows]

    top_model_map = _top_model_by_user_id(db, [user_id])

    return {
        "success": True,
        "data": {
            "userId": user.id,
            "name": user.name,
            "avatar": user.avatar,
            "department": user.department,
            "totalGenerations": total,
            "imageCount": total - video_count,
            "videoCount": video_count,
            "creditsBurned": float(credits or 0),
            "lastActivityAt": serialize_utc_datetime(last_activity_at),
            "topModel": top_model_map.get(user_id),
            "topProjects": top_projects,
            "topTags": top_tags,
        },
    }


@router.get("/analytics")
async def get_generation_analytics(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    """Admin/faculty-only company-wide analytics aggregate (single combined payload)."""
    thirty_days_ago = datetime.utcnow() - timedelta(days=30)

    daily_rows = (
        db.query(
            func.date(GenerationRecord.created_at).label("day"),
            func.count(GenerationRecord.id).label("count"),
        )
        .filter(GenerationRecord.created_at >= thirty_days_ago, GenerationRecord.archived_at.is_(None))
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    daily_generations = [{"date": str(day), "count": int(count)} for day, count in daily_rows]

    department_rows = (
        db.query(User.department, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(GenerationRecord.archived_at.is_(None), User.department.isnot(None))
        .group_by(User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .all()
    )
    department_usage = [{"department": dept, "count": int(count)} for dept, count in department_rows]

    top_users_rows = (
        db.query(User.id, User.name, User.avatar, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(GenerationRecord.archived_at.is_(None))
        .group_by(User.id, User.name, User.avatar)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(10)
        .all()
    )
    top_users = [
        {"userId": uid, "name": name, "avatar": avatar, "count": int(count)}
        for uid, name, avatar, count in top_users_rows
    ]

    top_projects_rows = (
        db.query(GenerationProject.id, GenerationProject.name, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.project_id == GenerationProject.id)
        .filter(GenerationRecord.archived_at.is_(None))
        .group_by(GenerationProject.id, GenerationProject.name)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(10)
        .all()
    )
    top_projects = [{"projectId": pid, "name": name, "count": int(count)} for pid, name, count in top_projects_rows]

    top_tags_rows = (
        db.query(GenerationTag.normalized_tag, func.count(GenerationTag.id).label("count"))
        .group_by(GenerationTag.normalized_tag)
        .order_by(func.count(GenerationTag.id).desc())
        .limit(10)
        .all()
    )
    top_tags = [{"tag": tag, "count": int(count)} for tag, count in top_tags_rows]

    credits_total = (
        db.query(func.coalesce(func.sum(GenerationRecord.credits_burned), 0))
        .filter(GenerationRecord.archived_at.is_(None))
        .scalar()
        or 0
    )
    credits_last_30 = (
        db.query(func.coalesce(func.sum(GenerationRecord.credits_burned), 0))
        .filter(GenerationRecord.archived_at.is_(None), GenerationRecord.created_at >= thirty_days_ago)
        .scalar()
        or 0
    )

    return {
        "success": True,
        "dailyGenerations": daily_generations,
        "departmentUsage": department_usage,
        "topUsers": top_users,
        "topProjects": top_projects,
        "topTags": top_tags,
        "creditsSummary": {
            "total": float(credits_total),
            "last30Days": float(credits_last_30),
        },
    }


@router.get("/{generation_id}")
async def get_generation_detail(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    row = (
        db.query(GenerationRecord, User, GenerationProject)
        .outerjoin(User, GenerationRecord.owner_user_id == User.id)
        .outerjoin(GenerationProject, GenerationRecord.project_id == GenerationProject.id)
        .filter(GenerationRecord.id == generation_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    generation, owner, project = row
    tags_map = _tags_by_generation_id(db, [generation.id])
    return {"success": True, "data": _serialize_generation_row(generation, owner, project, tags_map.get(generation.id))}


@router.post("/{generation_id}/favorite")
async def add_generation_favorite(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = db.query(GenerationRecord).filter(GenerationRecord.id == generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    generation.is_favorite = True
    if generation.project_id:
        record_generation_project_event(
            db,
            project_id=generation.project_id,
            generation_id=generation.id,
            actor_user_id=current_user.id,
            event_type="generation_favorited",
        )
    db.commit()
    db.refresh(generation)
    return {"success": True, "data": generation.to_dict()}


@router.delete("/{generation_id}/favorite")
async def remove_generation_favorite(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = db.query(GenerationRecord).filter(GenerationRecord.id == generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    generation.is_favorite = False
    if generation.project_id:
        record_generation_project_event(
            db,
            project_id=generation.project_id,
            generation_id=generation.id,
            actor_user_id=current_user.id,
            event_type="generation_unfavorited",
        )
    db.commit()
    db.refresh(generation)
    return {"success": True, "data": generation.to_dict()}


@router.get("/{generation_id}/tags")
async def list_generation_tags(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = db.query(GenerationRecord).filter(GenerationRecord.id == generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    tags = (
        db.query(GenerationTag)
        .filter(GenerationTag.generation_id == generation_id)
        .order_by(GenerationTag.created_at.asc())
        .all()
    )
    return {"success": True, "data": [tag.to_dict() for tag in tags]}


@router.post("/{generation_id}/tags", status_code=201)
async def add_generation_tag(
    generation_id: int,
    payload: GenerationTagCreatePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = db.query(GenerationRecord).filter(GenerationRecord.id == generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    raw_tag = _WHITESPACE_RE.sub(" ", payload.tag.strip())
    normalized_tag = _normalize_tag(raw_tag)
    if not raw_tag or not normalized_tag:
        raise HTTPException(status_code=400, detail="Tag is required")

    existing_count = db.query(func.count(GenerationTag.id)).filter(GenerationTag.generation_id == generation_id).scalar() or 0
    if existing_count >= MAX_TAGS_PER_GENERATION:
        raise HTTPException(status_code=400, detail=f"A generation can have at most {MAX_TAGS_PER_GENERATION} tags")

    existing_tag = (
        db.query(GenerationTag)
        .filter(GenerationTag.generation_id == generation_id, GenerationTag.normalized_tag == normalized_tag)
        .first()
    )
    if existing_tag:
        return {"success": True, "data": existing_tag.to_dict()}

    tag_row = GenerationTag(
        generation_id=generation_id,
        tag=raw_tag[:80],
        normalized_tag=normalized_tag,
        created_by=current_user.id,
    )
    try:
        db.add(tag_row)
        if generation.project_id:
            record_generation_project_event(
                db,
                project_id=generation.project_id,
                generation_id=generation.id,
                actor_user_id=current_user.id,
                event_type="generation_tagged",
                description=raw_tag,
            )
        db.commit()
        db.refresh(tag_row)
    except IntegrityError:
        db.rollback()
        existing_tag = (
            db.query(GenerationTag)
            .filter(GenerationTag.generation_id == generation_id, GenerationTag.normalized_tag == normalized_tag)
            .first()
        )
        if existing_tag:
            return {"success": True, "data": existing_tag.to_dict()}
        raise HTTPException(status_code=409, detail="Tag already exists")

    return {"success": True, "data": tag_row.to_dict()}


@router.delete("/{generation_id}/tags/{tag}")
async def remove_generation_tag(
    generation_id: int,
    tag: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = db.query(GenerationRecord).filter(GenerationRecord.id == generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    normalized_tag = _normalize_tag(tag)
    tag_row = (
        db.query(GenerationTag)
        .filter(GenerationTag.generation_id == generation_id, GenerationTag.normalized_tag == normalized_tag)
        .first()
    )
    if not tag_row:
        raise HTTPException(status_code=404, detail="Tag not found on this generation")

    removed_tag_label = tag_row.tag
    db.delete(tag_row)
    if generation.project_id:
        record_generation_project_event(
            db,
            project_id=generation.project_id,
            generation_id=generation.id,
            actor_user_id=current_user.id,
            event_type="generation_untagged",
            description=removed_tag_label,
        )
    db.commit()
    return {"success": True}
