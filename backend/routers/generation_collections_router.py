from datetime import datetime
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationCollection, GenerationCollectionMember, GenerationRecord, User
from utils.permissions import require_user


router = APIRouter(prefix="/api/generation-collections", tags=["Generation Collections"])

_WHITESPACE_RE = re.compile(r"\s+")
DEFAULT_COLLECTION_PAGE_SIZE = 24
MAX_COLLECTION_PAGE_SIZE = 100


class GenerationCollectionCreatePayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=5000)


def _normalize_collection_name(value: str) -> str:
    normalized = _WHITESPACE_RE.sub(" ", f"{value or ''}".strip())
    return normalized.lower()[:200]


def _clean_optional_description(value: Optional[str]) -> Optional[str]:
    cleaned = f"{value or ''}".strip()
    return cleaned or None


def _clamp_pagination(limit: int, offset: int) -> tuple[int, int]:
    try:
        resolved_limit = int(limit)
    except (TypeError, ValueError):
        resolved_limit = DEFAULT_COLLECTION_PAGE_SIZE
    try:
        resolved_offset = int(offset)
    except (TypeError, ValueError):
        resolved_offset = 0
    resolved_limit = resolved_limit if resolved_limit > 0 else DEFAULT_COLLECTION_PAGE_SIZE
    resolved_limit = min(resolved_limit, MAX_COLLECTION_PAGE_SIZE)
    resolved_offset = max(resolved_offset, 0)
    return resolved_limit, resolved_offset


def _get_owned_collection_or_404(db: Session, current_user: User, collection_id: int) -> GenerationCollection:
    collection = (
        db.query(GenerationCollection)
        .filter(
            GenerationCollection.id == collection_id,
            GenerationCollection.owner_user_id == current_user.id,
            GenerationCollection.archived_at.is_(None),
        )
        .first()
    )
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")
    return collection


def _get_collection_or_404_for_directory(db: Session, collection_id: int) -> GenerationCollection:
    collection = (
        db.query(GenerationCollection)
        .filter(GenerationCollection.id == collection_id, GenerationCollection.archived_at.is_(None))
        .first()
    )
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")
    return collection


def _member_count_by_collection_id(db: Session, collection_ids: list[int]) -> dict[int, int]:
    if not collection_ids:
        return {}
    rows = (
        db.query(GenerationCollectionMember.collection_id, func.count(GenerationCollectionMember.id))
        .filter(GenerationCollectionMember.collection_id.in_(collection_ids))
        .group_by(GenerationCollectionMember.collection_id)
        .all()
    )
    return {int(collection_id): int(count) for collection_id, count in rows}


def _serialize_collection_with_counts(collection: GenerationCollection, member_count: int) -> dict:
    payload = collection.to_dict()
    payload["memberCount"] = member_count
    return payload


def _serialize_collection_with_owner(collection: GenerationCollection, owner: Optional[User], member_count: int) -> dict:
    payload = _serialize_collection_with_counts(collection, member_count)
    payload["ownerName"] = owner.name if owner else None
    payload["ownerAvatar"] = owner.avatar if owner else None
    payload["ownerDepartment"] = owner.department if owner else None
    return payload


@router.get("/directory")
def list_generation_collections_directory(
    q: Optional[str] = Query(None),
    limit: int = Query(DEFAULT_COLLECTION_PAGE_SIZE, ge=1, le=MAX_COLLECTION_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Company-wide, read-only collection listing (all owners) for the Kling Collections explorer."""
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    query = (
        db.query(GenerationCollection, User)
        .outerjoin(User, GenerationCollection.owner_user_id == User.id)
        .filter(GenerationCollection.archived_at.is_(None))
    )
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(
                GenerationCollection.name.ilike(like),
                GenerationCollection.description.ilike(like),
                User.name.ilike(like),
            )
        )
    total = query.count()
    rows = (
        query.order_by(GenerationCollection.updated_at.desc(), GenerationCollection.id.desc())
        .offset(resolved_offset)
        .limit(resolved_limit)
        .all()
    )
    collection_ids = [collection.id for collection, _owner in rows]
    counts = _member_count_by_collection_id(db, collection_ids)
    return {
        "success": True,
        "data": [
            _serialize_collection_with_owner(collection, owner, counts.get(collection.id, 0))
            for collection, owner in rows
        ],
        "pagination": {
            "limit": resolved_limit,
            "offset": resolved_offset,
            "total": total,
        },
    }


@router.get("")
def list_generation_collections(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    collections = (
        db.query(GenerationCollection)
        .filter(
            GenerationCollection.owner_user_id == current_user.id,
            GenerationCollection.archived_at.is_(None),
        )
        .order_by(GenerationCollection.updated_at.desc(), GenerationCollection.id.desc())
        .all()
    )
    counts = _member_count_by_collection_id(db, [collection.id for collection in collections])
    return {
        "success": True,
        "data": [
            _serialize_collection_with_counts(collection, counts.get(collection.id, 0))
            for collection in collections
        ],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_generation_collection(
    payload: GenerationCollectionCreatePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    raw_name = _WHITESPACE_RE.sub(" ", payload.name.strip())
    normalized_name = _normalize_collection_name(raw_name)
    if not raw_name or not normalized_name:
        raise HTTPException(status_code=400, detail="Collection name is required")

    existing = (
        db.query(GenerationCollection)
        .filter(
            GenerationCollection.owner_user_id == current_user.id,
            GenerationCollection.normalized_name == normalized_name,
            GenerationCollection.archived_at.is_(None),
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="A collection with this name already exists")

    now = datetime.utcnow()
    collection = GenerationCollection(
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
        db.add(collection)
        db.commit()
        db.refresh(collection)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A collection with this name already exists")

    return {"success": True, "data": _serialize_collection_with_counts(collection, 0)}


@router.get("/{collection_id}")
def get_generation_collection(
    collection_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    collection = _get_owned_collection_or_404(db, current_user, collection_id)
    member_count = (
        db.query(func.count(GenerationCollectionMember.id))
        .filter(GenerationCollectionMember.collection_id == collection.id)
        .scalar()
        or 0
    )
    return {"success": True, "data": _serialize_collection_with_counts(collection, int(member_count))}


@router.get("/{collection_id}/generations")
def list_generation_collection_generations(
    collection_id: int,
    limit: int = Query(DEFAULT_COLLECTION_PAGE_SIZE, ge=1, le=MAX_COLLECTION_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    collection = _get_owned_collection_or_404(db, current_user, collection_id)
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    query = (
        db.query(GenerationRecord, GenerationCollectionMember)
        .join(GenerationCollectionMember, GenerationCollectionMember.generation_id == GenerationRecord.id)
        .filter(
            GenerationCollectionMember.collection_id == collection.id,
            GenerationRecord.archived_at.is_(None),
        )
    )
    total = query.count()
    rows = (
        query.order_by(GenerationCollectionMember.added_at.desc(), GenerationCollectionMember.id.desc())
        .offset(resolved_offset)
        .limit(resolved_limit)
        .all()
    )
    return {
        "success": True,
        "data": [generation.to_dict() for generation, _member in rows],
        "pagination": {
            "limit": resolved_limit,
            "offset": resolved_offset,
            "total": total,
        },
        "collection": _serialize_collection_with_counts(collection, total),
    }


@router.get("/{collection_id}/generations/directory")
def list_generation_collection_generations_directory(
    collection_id: int,
    limit: int = Query(DEFAULT_COLLECTION_PAGE_SIZE, ge=1, le=MAX_COLLECTION_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Company-wide, read-only listing of a collection's members for the Kling Collections explorer."""
    collection = _get_collection_or_404_for_directory(db, collection_id)
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    query = (
        db.query(GenerationRecord, User, GenerationCollectionMember)
        .join(GenerationCollectionMember, GenerationCollectionMember.generation_id == GenerationRecord.id)
        .outerjoin(User, GenerationRecord.owner_user_id == User.id)
        .filter(
            GenerationCollectionMember.collection_id == collection.id,
            GenerationRecord.archived_at.is_(None),
        )
    )
    total = query.count()
    rows = (
        query.order_by(GenerationCollectionMember.added_at.desc(), GenerationCollectionMember.id.desc())
        .offset(resolved_offset)
        .limit(resolved_limit)
        .all()
    )
    collection_owner = (
        db.query(User).filter(User.id == collection.owner_user_id).first()
        if collection.owner_user_id
        else None
    )
    return {
        "success": True,
        "data": [
            {
                **generation.to_dict(),
                "ownerName": generation_owner.name if generation_owner else None,
                "ownerAvatar": generation_owner.avatar if generation_owner else None,
            }
            for generation, generation_owner, _member in rows
        ],
        "pagination": {
            "limit": resolved_limit,
            "offset": resolved_offset,
            "total": total,
        },
        "collection": _serialize_collection_with_owner(collection, collection_owner, total),
    }


@router.post("/{collection_id}/generations/{generation_id}", status_code=status.HTTP_201_CREATED)
def add_generation_to_collection(
    collection_id: int,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Add any visible generation to a collection you own — unlike Projects, ownership of the
    generation itself is not required, since collections model cross-owner curation."""
    collection = _get_owned_collection_or_404(db, current_user, collection_id)
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.archived_at.is_(None))
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Generation record not found")

    existing_member = (
        db.query(GenerationCollectionMember)
        .filter(
            GenerationCollectionMember.collection_id == collection.id,
            GenerationCollectionMember.generation_id == generation.id,
        )
        .first()
    )
    if existing_member:
        return {"success": True, "data": existing_member.to_dict()}

    member = GenerationCollectionMember(
        collection_id=collection.id,
        generation_id=generation.id,
        added_by=current_user.id,
    )
    try:
        db.add(member)
        collection.updated_at = datetime.utcnow()
        collection.updated_by = current_user.id
        db.commit()
        db.refresh(member)
    except IntegrityError:
        db.rollback()
        existing_member = (
            db.query(GenerationCollectionMember)
            .filter(
                GenerationCollectionMember.collection_id == collection.id,
                GenerationCollectionMember.generation_id == generation.id,
            )
            .first()
        )
        if existing_member:
            return {"success": True, "data": existing_member.to_dict()}
        raise HTTPException(status_code=409, detail="Generation is already in this collection")

    return {"success": True, "data": member.to_dict()}


@router.delete("/{collection_id}/generations/{generation_id}")
def remove_generation_from_collection(
    collection_id: int,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    collection = _get_owned_collection_or_404(db, current_user, collection_id)
    member = (
        db.query(GenerationCollectionMember)
        .filter(
            GenerationCollectionMember.collection_id == collection.id,
            GenerationCollectionMember.generation_id == generation_id,
        )
        .first()
    )
    if not member:
        raise HTTPException(status_code=404, detail="Generation is not in this collection")

    db.delete(member)
    collection.updated_at = datetime.utcnow()
    collection.updated_by = current_user.id
    db.commit()
    return {"success": True}
