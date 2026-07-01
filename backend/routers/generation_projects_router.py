from datetime import datetime
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationProject, GenerationRecord, User
from utils.permissions import require_user


router = APIRouter(prefix="/api/generation-projects", tags=["Generation Projects"])

_WHITESPACE_RE = re.compile(r"\s+")
DEFAULT_GENERATION_PAGE_SIZE = 24
MAX_GENERATION_PAGE_SIZE = 100


class GenerationProjectCreatePayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=5000)


def _normalize_project_name(value: str) -> str:
    normalized = _WHITESPACE_RE.sub(" ", f"{value or ''}".strip())
    return normalized.lower()[:200]


def _clean_optional_description(value: Optional[str]) -> Optional[str]:
    cleaned = f"{value or ''}".strip()
    return cleaned or None


def _clamp_pagination(limit: int, offset: int) -> tuple[int, int]:
    try:
        resolved_limit = int(limit)
    except (TypeError, ValueError):
        resolved_limit = DEFAULT_GENERATION_PAGE_SIZE
    try:
        resolved_offset = int(offset)
    except (TypeError, ValueError):
        resolved_offset = 0
    resolved_limit = resolved_limit if resolved_limit > 0 else DEFAULT_GENERATION_PAGE_SIZE
    resolved_limit = min(resolved_limit, MAX_GENERATION_PAGE_SIZE)
    resolved_offset = max(resolved_offset, 0)
    return resolved_limit, resolved_offset


def _get_owned_project_or_404(db: Session, current_user: User, project_id: int) -> GenerationProject:
    project = (
        db.query(GenerationProject)
        .filter(
            GenerationProject.id == project_id,
            GenerationProject.owner_user_id == current_user.id,
            GenerationProject.archived_at.is_(None),
        )
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Generation project not found")
    return project


def _get_generation_or_404(db: Session, generation_id: int) -> GenerationRecord:
    generation = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.id == generation_id,
            GenerationRecord.archived_at.is_(None),
        )
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Generation record not found")
    return generation


def _validate_generation_project_ownership(
    *,
    current_user: User,
    project: GenerationProject,
    generation: GenerationRecord,
) -> None:
    if generation.owner_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Generation does not belong to the authenticated user")
    if generation.owner_user_id != project.owner_user_id:
        raise HTTPException(status_code=403, detail="Generation owner must match generation project owner")


def _generation_count_by_project_id(db: Session, owner_user_id: int) -> dict[int, int]:
    rows = (
        db.query(GenerationRecord.project_id, func.count(GenerationRecord.id))
        .filter(
            GenerationRecord.owner_user_id == owner_user_id,
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.capture_status == "active",
            GenerationRecord.project_id.isnot(None),
        )
        .group_by(GenerationRecord.project_id)
        .all()
    )
    return {
        int(project_id): int(count)
        for project_id, count in rows
        if project_id is not None
    }


def _serialize_project_with_counts(project: GenerationProject, generation_count: int) -> dict:
    payload = project.to_dict()
    payload["generationCount"] = generation_count
    return payload


@router.get("")
async def list_generation_projects(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    projects = (
        db.query(GenerationProject)
        .filter(
            GenerationProject.owner_user_id == current_user.id,
            GenerationProject.archived_at.is_(None),
        )
        .order_by(GenerationProject.updated_at.desc(), GenerationProject.id.desc())
        .all()
    )
    generation_count_map = _generation_count_by_project_id(db, current_user.id)
    return {
        "success": True,
        "data": [
            _serialize_project_with_counts(project, generation_count_map.get(project.id, 0))
            for project in projects
        ],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_generation_project(
    payload: GenerationProjectCreatePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    raw_name = _WHITESPACE_RE.sub(" ", payload.name.strip())
    normalized_name = _normalize_project_name(raw_name)
    if not raw_name or not normalized_name:
        raise HTTPException(status_code=400, detail="Project name is required")

    existing = (
        db.query(GenerationProject)
        .filter(
            GenerationProject.owner_user_id == current_user.id,
            GenerationProject.normalized_name == normalized_name,
            GenerationProject.archived_at.is_(None),
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="A generation project with this name already exists")

    now = datetime.utcnow()
    project = GenerationProject(
        owner_user_id=current_user.id,
        name=raw_name[:200],
        normalized_name=normalized_name,
        description=_clean_optional_description(payload.description),
        created_by=current_user.id,
        updated_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    try:
        db.add(project)
        db.commit()
        db.refresh(project)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A generation project with this name already exists")

    return {
        "success": True,
        "data": _serialize_project_with_counts(project, 0),
    }


@router.get("/{project_id}")
async def get_generation_project(
    project_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    project = _get_owned_project_or_404(db, current_user, project_id)
    generation_count = (
        db.query(func.count(GenerationRecord.id))
        .filter(
            GenerationRecord.owner_user_id == current_user.id,
            GenerationRecord.project_id == project.id,
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.capture_status == "active",
        )
        .scalar()
        or 0
    )
    return {
        "success": True,
        "data": _serialize_project_with_counts(project, int(generation_count)),
    }


@router.get("/{project_id}/generations")
async def list_generation_project_generations(
    project_id: int,
    limit: int = Query(DEFAULT_GENERATION_PAGE_SIZE, ge=1, le=MAX_GENERATION_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    project = _get_owned_project_or_404(db, current_user, project_id)
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    query = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.owner_user_id == current_user.id,
            GenerationRecord.project_id == project.id,
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
        "project": _serialize_project_with_counts(project, total),
    }


@router.post("/{project_id}/generations/{generation_id}")
async def assign_generation_to_project(
    project_id: int,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    project = _get_owned_project_or_404(db, current_user, project_id)
    generation = _get_generation_or_404(db, generation_id)
    _validate_generation_project_ownership(
        current_user=current_user,
        project=project,
        generation=generation,
    )

    now = datetime.utcnow()
    previous_project_id = generation.project_id
    generation.project_id = project.id
    generation.updated_at = now
    project.updated_at = now
    project.updated_by = current_user.id

    if previous_project_id and previous_project_id != project.id:
        previous_project = (
            db.query(GenerationProject)
            .filter(
                GenerationProject.id == previous_project_id,
                GenerationProject.owner_user_id == current_user.id,
            )
            .first()
        )
        if previous_project:
            previous_project.updated_at = now
            previous_project.updated_by = current_user.id

    db.commit()
    db.refresh(generation)
    return {
        "success": True,
        "data": generation.to_dict(),
    }


@router.delete("/{project_id}/generations/{generation_id}")
async def remove_generation_from_project(
    project_id: int,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    project = _get_owned_project_or_404(db, current_user, project_id)
    generation = _get_generation_or_404(db, generation_id)
    _validate_generation_project_ownership(
        current_user=current_user,
        project=project,
        generation=generation,
    )
    if generation.project_id != project.id:
        raise HTTPException(status_code=404, detail="Generation is not assigned to this project")

    now = datetime.utcnow()
    generation.project_id = None
    generation.updated_at = now
    project.updated_at = now
    project.updated_by = current_user.id
    db.commit()
    db.refresh(generation)
    return {
        "success": True,
        "data": generation.to_dict(),
    }
