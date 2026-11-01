import os
import re
from datetime import date, datetime, timedelta
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import Text, and_, case, cast, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import (
    GenerationCollectionMember,
    GenerationProject,
    GenerationRecord,
    GenerationTag,
    ITPortalToolUsageEvent,
    User,
)
from utils.admin_card_credits import validate_admin_credits
from utils.datetime_utils import serialize_utc_datetime
from utils.generation_events import record_generation_project_event
from utils import r2_storage
from utils.permissions import require_admin, require_faculty, require_user


IST_OFFSET = timedelta(minutes=330)  # India Standard Time, UTC+05:30

router = APIRouter(prefix="/api/generations", tags=["Generations"])
# GenerationRecord is a shared, cross-provider table - Freepik's normalization
# pipeline projects its own generations into it too (see
# providers/freepik/normalization.py's _project_into_generation_record), using
# provider="freepik". Every endpoint in this router backs the Kling-specific
# frontend (KlingTab.jsx and friends) exclusively, so every query here must be
# scoped to provider=="kling" - otherwise Freepik generations silently show up
# in Kling's search results, filters, user directory, analytics, and even
# single-record actions like favorite/tag/claim.
KLING_PROVIDER = "kling"
DEFAULT_UNGROUPED_PAGE_SIZE = 24
MAX_UNGROUPED_PAGE_SIZE = 100
DEFAULT_SEARCH_PAGE_SIZE = 40
MAX_SEARCH_PAGE_SIZE = 120
TOP_TAGS_LIMIT = 100
MAX_TAGS_PER_GENERATION = 20

SEARCH_SORT_OPTIONS = {"latest", "oldest", "credits"}
OWNERSHIP_STATUS_OPTIONS = {"unknown", "resolved"}

_WHITESPACE_RE = re.compile(r"\s+")

ADMIN_VIDEO_MAX_BYTES = 90 * 1024 * 1024  # requests pass the proxy only under ~100 MB; same cap as the frontend's LEGACY_UPLOAD_FALLBACK_MAX_BYTES
ADMIN_VIDEO_EXTENSIONS = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
ADMIN_VIDEO_KEY_PREFIX = "kling-admin-uploads"
# Direct-to-R2 uploads (routers/upload.py presign) never pass the proxy, so
# they get a higher cap than ADMIN_VIDEO_MAX_BYTES.
ADMIN_VIDEO_DIRECT_MAX_BYTES = 1024 * 1024 * 1024
DIRECT_UPLOAD_KEY_PREFIX = "task-attachments/"
# The Kling reports zero out credits above their MAX_SANE_KLING_CREDITS (3000)
# as garbage, so an admin can't enter more than that.
ADMIN_KLING_MAX_CREDITS = 3000


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
def list_ungrouped_generations(
    limit: int = Query(DEFAULT_UNGROUPED_PAGE_SIZE, ge=1, le=MAX_UNGROUPED_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    resolved_limit, resolved_offset = _clamp_pagination(limit, offset)
    query = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.provider == KLING_PROVIDER,
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
def get_generation_filters(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    base_query = db.query(GenerationRecord).filter(
        GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None)
    )
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
    owner_rows = (
        db.query(User.id, User.name)
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None))
        .distinct()
        .order_by(User.name.asc())
        .all()
    )
    owners = [{"userId": user_id, "name": name} for user_id, name in owner_rows]

    credits = kling_effective_credits()
    active = (GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None))
    owner_counts = dict(
        db.query(GenerationRecord.owner_user_id, func.count(GenerationRecord.id))
        .filter(*active)
        .group_by(GenerationRecord.owner_user_id)
        .all()
    )
    for owner in owners:
        owner["count"] = int(owner_counts.get(owner["userId"], 0))

    account = kling_account_expr()
    accounts = [
        {"value": label, "count": int(count), "credits": float(credit_sum or 0)}
        for label, count, credit_sum in db.query(account, func.count(GenerationRecord.id), func.sum(credits))
        .filter(*active, account.isnot(None))
        .group_by(account)
        .order_by(func.count(GenerationRecord.id).desc())
        .all()
    ]
    clients = [
        {"id": client_id, "name": name or f"Client {client_id}", "count": int(count)}
        for client_id, name, count in db.query(
            GenerationRecord.linked_client_id, GenerationRecord.linked_client_name, func.count(GenerationRecord.id)
        )
        .filter(*active, GenerationRecord.linked_client_id.isnot(None))
        .group_by(GenerationRecord.linked_client_id, GenerationRecord.linked_client_name)
        .order_by(func.count(GenerationRecord.id).desc())
        .all()
    ]
    departments = [
        {"value": dept, "count": int(count)}
        for dept, count in db.query(User.department, func.count(GenerationRecord.id))
        .join(User, GenerationRecord.owner_user_id == User.id)
        .filter(*active, User.department.isnot(None))
        .group_by(User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .all()
    ]

    def flag(condition):
        return func.sum(case((condition, 1), else_=0))

    missing_credits = credits.is_(None)
    missing_prompt = kling_missing_prompt_expr()
    missing_file = GenerationRecord.canonical_asset_url.is_(None)
    stats = db.query(
        func.count(GenerationRecord.id),
        func.sum(credits),
        func.min(credits),
        func.max(credits),
        func.min(GenerationRecord.created_at),
        func.max(GenerationRecord.created_at),
        flag(kling_is_video_expr()),
        flag(kling_is_image_expr()),
        flag(GenerationRecord.linked_task_id.isnot(None)),
        flag(GenerationRecord.linked_client_id.isnot(None)),
        flag(and_(GenerationRecord.linked_task_id.is_(None), GenerationRecord.linked_client_id.is_(None))),
        flag(missing_credits),
        flag(missing_prompt),
        flag(missing_file),
        flag(or_(missing_credits, missing_prompt, missing_file)),
        flag(kling_is_duplicate_expr()),
        flag(_kling_meta_text("source") == KLING_HISTORY_SOURCE),
        flag(GenerationRecord.is_favorite.is_(True)),
    ).filter(*active).one()
    (total, total_credits, credit_min, credit_max, first_at, last_at, video, image, linked_task, linked_client, unlinked,
     no_credits, no_prompt, no_file, any_missing, duplicates, history, favorites) = stats
    total = int(total or 0)

    def ist_day(value):
        return (value + IST_OFFSET).date().isoformat() if value else None

    return {
        "success": True,
        "models": models,
        "resolutions": resolutions,
        "ownershipStatuses": sorted(OWNERSHIP_STATUS_OPTIONS),
        "tags": tags,
        "owners": owners,
        "accounts": accounts,
        "clients": clients,
        "departments": departments,
        "creditRange": {"min": float(credit_min) if credit_min is not None else None,
                        "max": float(credit_max) if credit_max is not None else None},
        "dateRange": {"from": ist_day(first_at), "to": ist_day(last_at)},
        "counts": {
            "total": total,
            "credits": float(total_credits or 0),
            "video": int(video or 0),
            "image": int(image or 0),
            "noOutput": total - int(video or 0) - int(image or 0),
            "linkedTask": int(linked_task or 0),
            "noTask": total - int(linked_task or 0),
            "linkedClient": int(linked_client or 0),
            "noClient": total - int(linked_client or 0),
            "unlinked": int(unlinked or 0),
            "missingCredits": int(no_credits or 0),
            "missingPrompt": int(no_prompt or 0),
            "missingFile": int(no_file or 0),
            "missingAny": int(any_missing or 0),
            "complete": total - int(any_missing or 0),
            "duplicates": int(duplicates or 0),
            "history": int(history or 0),
            "live": total - int(history or 0),
            "favorites": int(favorites or 0),
        },
    }


# ── Kling filters (shared by /search and the RMW Data Excel export) ─────────
#
# Chosen from what the captured data actually carries: model/duration/
# resolution labels are blank on ~97% of rows, so the useful axes are the
# Kling account a generation was made on, output type, credits, whether it is
# linked to a task/client, and data-quality gaps (no credits / prompt / file).
# Several of those live in metadata_json rather than columns.

KLING_OUTPUT_TYPES = {"video", "image", "none"}
KLING_LINKED_OPTIONS = {"task", "no_task", "client", "no_client", "unlinked"}
KLING_QUALITY_OPTIONS = {"complete", "missing_any", "missing_credits", "missing_prompt", "missing_file"}
KLING_DUPLICATE_OPTIONS = {"only", "exclude"}
KLING_CAPTURE_OPTIONS = {"history", "live"}
KLING_HISTORY_SOURCE = "asset_history_discovered"


def kling_effective_credits():
    """Admin-corrected credits win over what the capture reported."""
    return func.coalesce(GenerationRecord.admin_credits, GenerationRecord.credits_burned)


def _kling_meta_text(key: str):
    return GenerationRecord.metadata_json[key].as_string()


def kling_account_expr():
    return _kling_meta_text("klingAccountLabel")


def _kling_media_assets_text():
    # Never NULL, so NOT LIKE keeps rows that have no mediaAssets at all.
    return func.coalesce(cast(GenerationRecord.metadata_json["mediaAssets"], Text), "")


def kling_is_video_expr():
    # mediaAssets is a list of {"assetType": "video" | "image" | "media"};
    # a generation counts as video when any captured output is a video.
    return _kling_media_assets_text().like('%"assetType": "video"%')


def kling_is_image_expr():
    text = _kling_media_assets_text()
    return and_(~kling_is_video_expr(), or_(text.like('%"assetType": "image"%'), text.like('%"assetType": "media"%')))


def kling_is_duplicate_expr():
    return func.coalesce(_kling_meta_text("crossUserDuplicate"), "false") == "true"


def kling_missing_prompt_expr():
    return or_(GenerationRecord.prompt_text.is_(None), func.trim(GenerationRecord.prompt_text) == "")


class KlingFilterParams:
    """Every Kling filter as one dependency, so search and export agree."""

    def __init__(
        self,
        q: Optional[str] = Query(None, max_length=300),
        department: Optional[str] = Query(None),
        owner_user_id: Optional[int] = Query(None),
        project_id: Optional[int] = Query(None),
        collection_id: Optional[int] = Query(None),
        client_id: Optional[int] = Query(None),
        model: Optional[str] = Query(None),
        resolution: Optional[str] = Query(None),
        ownership_status: Optional[str] = Query(None),
        is_favorite: Optional[bool] = Query(None),
        tag: Optional[str] = Query(None),
        include_archived: bool = Query(False),
        date_from: Optional[date] = Query(None),
        date_to: Optional[date] = Query(None),
        account: Optional[str] = Query(None, max_length=200),
        output_type: Optional[str] = Query(None),
        credits_min: Optional[float] = Query(None, ge=0),
        credits_max: Optional[float] = Query(None, ge=0),
        linked: Optional[str] = Query(None),
        quality: Optional[str] = Query(None),
        duplicates: Optional[str] = Query(None),
        capture: Optional[str] = Query(None),
    ):
        self.q = (q or "").strip() or None
        self.department = (department or "").strip() or None
        self.owner_user_id = owner_user_id
        self.project_id = project_id
        self.collection_id = collection_id
        self.client_id = client_id
        self.model = (model or "").strip() or None
        self.resolution = resolution or None
        self.ownership_status = ownership_status or None
        self.is_favorite = is_favorite
        self.tag = (tag or "").strip() or None
        self.include_archived = include_archived
        self.date_from = date_from
        self.date_to = date_to
        self.account = (account or "").strip() or None
        self.output_type = output_type or None
        self.credits_min = credits_min
        self.credits_max = credits_max
        self.linked = linked or None
        self.quality = quality or None
        self.duplicates = duplicates or None
        self.capture = capture or None
        self._validate()

    def _validate(self):
        checks = (
            ("ownership_status", self.ownership_status, OWNERSHIP_STATUS_OPTIONS),
            ("output_type", self.output_type, KLING_OUTPUT_TYPES),
            ("linked", self.linked, KLING_LINKED_OPTIONS),
            ("quality", self.quality, KLING_QUALITY_OPTIONS),
            ("duplicates", self.duplicates, KLING_DUPLICATE_OPTIONS),
            ("capture", self.capture, KLING_CAPTURE_OPTIONS),
        )
        for name, value, allowed in checks:
            if value and value not in allowed:
                raise HTTPException(status_code=400, detail=f"Invalid {name}. Expected one of {sorted(allowed)}")
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise HTTPException(status_code=400, detail="The start date is after the end date")
        if self.credits_min is not None and self.credits_max is not None and self.credits_min > self.credits_max:
            raise HTTPException(status_code=400, detail="Minimum credits is above maximum credits")

    def describe(self, db: Optional[Session] = None) -> list[str]:
        """Human-readable list of the active filters (for the export Summary)."""
        fmt = "%d %b %Y"
        parts = []
        if self.q:
            parts.append(f'Search: "{self.q}"')
        if self.date_from or self.date_to:
            start = self.date_from.strftime(fmt) if self.date_from else "start"
            end = self.date_to.strftime(fmt) if self.date_to else "today"
            parts.append(f"Dates: {start} – {end}")
        if self.owner_user_id is not None:
            name = None
            if db is not None:
                name = db.query(User.name).filter(User.id == self.owner_user_id).scalar()
            parts.append(f"Person: {name or self.owner_user_id}")
        if self.department:
            parts.append(f"Department: {self.department}")
        if self.account:
            parts.append(f"Kling account: {self.account}")
        if self.output_type:
            parts.append({"video": "Output: video", "image": "Output: image", "none": "Output: none captured"}[self.output_type])
        if self.credits_min is not None or self.credits_max is not None:
            low = f"{self.credits_min:g}" if self.credits_min is not None else "0"
            high = f"{self.credits_max:g}" if self.credits_max is not None else "any"
            parts.append(f"Credits: {low} – {high}")
        labels = {
            "linked": {"task": "Linked to a task", "no_task": "No linked task", "client": "Linked to a client",
                       "no_client": "No linked client", "unlinked": "No task or client"},
            "quality": {"complete": "Complete records", "missing_any": "Missing any data",
                        "missing_credits": "Missing credits", "missing_prompt": "Missing prompt",
                        "missing_file": "Missing video file"},
            "duplicates": {"only": "Duplicates only", "exclude": "Duplicates hidden"},
            "capture": {"history": "History import", "live": "Live capture"},
        }
        for attr, mapping in labels.items():
            value = getattr(self, attr)
            if value:
                parts.append(mapping[value])
        if self.client_id is not None:
            parts.append(f"Client id: {self.client_id}")
        if self.collection_id is not None:
            parts.append(f"Collection id: {self.collection_id}")
        if self.ownership_status:
            parts.append(f"Ownership: {self.ownership_status}")
        if self.model:
            parts.append(f"Model: {self.model}")
        if self.resolution:
            parts.append(f"Resolution: {self.resolution}")
        if self.tag:
            parts.append(f"Tag: {self.tag}")
        if self.is_favorite:
            parts.append("Favourites only")
        return parts


def apply_kling_filters(query, f: KlingFilterParams):
    """Filter a query over GenerationRecord outer-joined to User and GenerationProject."""
    query = query.filter(GenerationRecord.provider == KLING_PROVIDER)
    if not f.include_archived:
        query = query.filter(GenerationRecord.archived_at.is_(None))
    if f.department:
        query = query.filter(func.lower(User.department) == f.department.lower())
    if f.owner_user_id is not None:
        query = query.filter(GenerationRecord.owner_user_id == f.owner_user_id)
    if f.project_id is not None:
        query = query.filter(GenerationRecord.project_id == f.project_id)
    if f.client_id is not None:
        query = query.filter(GenerationRecord.linked_client_id == f.client_id)
    if f.collection_id is not None:
        query = query.join(
            GenerationCollectionMember, GenerationCollectionMember.generation_id == GenerationRecord.id
        ).filter(GenerationCollectionMember.collection_id == f.collection_id)
    if f.model:
        query = query.filter(GenerationRecord.model_label.ilike(f"%{f.model}%"))
    if f.resolution:
        query = query.filter(GenerationRecord.resolution_label == f.resolution)
    if f.ownership_status:
        query = query.filter(GenerationRecord.ownership_status == f.ownership_status)
    if f.is_favorite is not None:
        query = query.filter(GenerationRecord.is_favorite == f.is_favorite)
    if f.tag:
        query = query.join(GenerationTag, GenerationTag.generation_id == GenerationRecord.id).filter(
            GenerationTag.normalized_tag == _normalize_tag(f.tag)
        )
    # date_from/date_to are India calendar days (what the dashboard shows);
    # created_at is naive UTC, so each IST day starts at 18:30 UTC the day
    # before. Comparing against UTC midnight put 00:00-05:30 IST work on the
    # previous day.
    if f.date_from:
        query = query.filter(GenerationRecord.created_at >= datetime.combine(f.date_from, datetime.min.time()) - IST_OFFSET)
    if f.date_to:
        query = query.filter(
            GenerationRecord.created_at < datetime.combine(f.date_to + timedelta(days=1), datetime.min.time()) - IST_OFFSET
        )
    if f.account:
        query = query.filter(kling_account_expr() == f.account)
    if f.output_type == "video":
        query = query.filter(kling_is_video_expr())
    elif f.output_type == "image":
        query = query.filter(kling_is_image_expr())
    elif f.output_type == "none":
        query = query.filter(~kling_is_video_expr(), ~kling_is_image_expr())
    credits = kling_effective_credits()
    if f.credits_min is not None:
        query = query.filter(credits >= f.credits_min)
    if f.credits_max is not None:
        query = query.filter(credits <= f.credits_max)
    if f.linked == "task":
        query = query.filter(GenerationRecord.linked_task_id.isnot(None))
    elif f.linked == "no_task":
        query = query.filter(GenerationRecord.linked_task_id.is_(None))
    elif f.linked == "client":
        query = query.filter(GenerationRecord.linked_client_id.isnot(None))
    elif f.linked == "no_client":
        query = query.filter(GenerationRecord.linked_client_id.is_(None))
    elif f.linked == "unlinked":
        query = query.filter(GenerationRecord.linked_task_id.is_(None), GenerationRecord.linked_client_id.is_(None))
    missing_credits = credits.is_(None)
    missing_prompt = kling_missing_prompt_expr()
    missing_file = GenerationRecord.canonical_asset_url.is_(None)
    if f.quality == "missing_credits":
        query = query.filter(missing_credits)
    elif f.quality == "missing_prompt":
        query = query.filter(missing_prompt)
    elif f.quality == "missing_file":
        query = query.filter(missing_file)
    elif f.quality == "missing_any":
        query = query.filter(or_(missing_credits, missing_prompt, missing_file))
    elif f.quality == "complete":
        query = query.filter(~missing_credits, ~missing_prompt, ~missing_file)
    if f.duplicates == "only":
        query = query.filter(kling_is_duplicate_expr())
    elif f.duplicates == "exclude":
        query = query.filter(~kling_is_duplicate_expr())
    if f.capture == "history":
        query = query.filter(_kling_meta_text("source") == KLING_HISTORY_SOURCE)
    elif f.capture == "live":
        query = query.filter(func.coalesce(_kling_meta_text("source"), "") != KLING_HISTORY_SOURCE)
    if f.q:
        like = f"%{f.q}%"
        query = query.filter(
            or_(
                GenerationRecord.prompt_text.ilike(like),
                GenerationRecord.model_label.ilike(like),
                GenerationRecord.canonical_asset_key.ilike(like),
                GenerationRecord.provider_task_id.ilike(like),
                GenerationRecord.provider_generation_id.ilike(like),
                GenerationRecord.linked_task_name.ilike(like),
                GenerationRecord.linked_client_name.ilike(like),
                kling_account_expr().ilike(like),
                User.name.ilike(like),
                GenerationProject.name.ilike(like),
            )
        )
    return query


@router.get("/search")
def search_generations(
    filters: KlingFilterParams = Depends(),
    sort: str = Query("latest"),
    limit: int = Query(DEFAULT_SEARCH_PAGE_SIZE, ge=1, le=MAX_SEARCH_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    if sort not in SEARCH_SORT_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid sort option. Expected one of {sorted(SEARCH_SORT_OPTIONS)}")

    resolved_limit, resolved_offset = _clamp_pagination(limit, offset, DEFAULT_SEARCH_PAGE_SIZE, MAX_SEARCH_PAGE_SIZE)

    query = (
        db.query(GenerationRecord, User, GenerationProject)
        .outerjoin(User, GenerationRecord.owner_user_id == User.id)
        .outerjoin(GenerationProject, GenerationRecord.project_id == GenerationProject.id)
    )
    query = apply_kling_filters(query, filters)

    # First page only: how many generations and credits the filters match,
    # so the toolbar can say "126 generations · 3,410 credits".
    summary = None
    if resolved_offset == 0:
        count, credit_sum = query.with_entities(
            func.count(func.distinct(GenerationRecord.id)), func.sum(kling_effective_credits())
        ).one()
        summary = {"count": int(count or 0), "credits": float(credit_sum or 0)}

    if sort == "oldest":
        query = query.order_by(GenerationRecord.created_at.asc(), GenerationRecord.id.asc())
    elif sort == "credits":
        query = query.order_by(kling_effective_credits().desc().nullslast(), GenerationRecord.created_at.desc())
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
        "summary": summary,
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
            GenerationRecord.provider == KLING_PROVIDER,
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
def list_generation_users_directory(
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
        .filter(GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None))
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
def get_generation_user_profile(
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
        .filter(
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.owner_user_id == user_id,
            GenerationRecord.archived_at.is_(None),
        )
        .first()
    )
    total = int(total or 0)
    video_count = int(video_count or 0)

    top_projects_rows = (
        db.query(GenerationProject.id, GenerationProject.name, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.project_id == GenerationProject.id)
        .filter(
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.owner_user_id == user_id,
            GenerationRecord.archived_at.is_(None),
        )
        .group_by(GenerationProject.id, GenerationProject.name)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(5)
        .all()
    )
    top_projects = [{"projectId": pid, "name": name, "count": int(count)} for pid, name, count in top_projects_rows]

    top_tags_rows = (
        db.query(GenerationTag.normalized_tag, func.count(GenerationTag.id).label("count"))
        .join(GenerationRecord, GenerationRecord.id == GenerationTag.generation_id)
        .filter(GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.owner_user_id == user_id)
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
def get_generation_analytics(
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
        .filter(
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.created_at >= thirty_days_ago,
            GenerationRecord.archived_at.is_(None),
        )
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    daily_generations = [{"date": str(day), "count": int(count)} for day, count in daily_rows]

    department_rows = (
        db.query(User.department, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.archived_at.is_(None),
            User.department.isnot(None),
        )
        .group_by(User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .all()
    )
    department_usage = [{"department": dept, "count": int(count)} for dept, count in department_rows]

    top_users_rows = (
        db.query(User.id, User.name, User.avatar, func.count(GenerationRecord.id).label("count"))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None))
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
        .filter(GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None))
        .group_by(GenerationProject.id, GenerationProject.name)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(10)
        .all()
    )
    top_projects = [{"projectId": pid, "name": name, "count": int(count)} for pid, name, count in top_projects_rows]

    top_tags_rows = (
        db.query(GenerationTag.normalized_tag, func.count(GenerationTag.id).label("count"))
        .join(GenerationRecord, GenerationRecord.id == GenerationTag.generation_id)
        .filter(GenerationRecord.provider == KLING_PROVIDER)
        .group_by(GenerationTag.normalized_tag)
        .order_by(func.count(GenerationTag.id).desc())
        .limit(10)
        .all()
    )
    top_tags = [{"tag": tag, "count": int(count)} for tag, count in top_tags_rows]

    credits_total = (
        db.query(func.coalesce(func.sum(GenerationRecord.credits_burned), 0))
        .filter(GenerationRecord.provider == KLING_PROVIDER, GenerationRecord.archived_at.is_(None))
        .scalar()
        or 0
    )
    credits_last_30 = (
        db.query(func.coalesce(func.sum(GenerationRecord.credits_burned), 0))
        .filter(
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= thirty_days_ago,
        )
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


def _generation_detail_payload(db: Session, generation_id: int) -> dict:
    row = (
        db.query(GenerationRecord, User, GenerationProject)
        .outerjoin(User, GenerationRecord.owner_user_id == User.id)
        .outerjoin(GenerationProject, GenerationRecord.project_id == GenerationProject.id)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    generation, owner, project = row
    tags_map = _tags_by_generation_id(db, [generation.id])
    return {"success": True, "data": _serialize_generation_row(generation, owner, project, tags_map.get(generation.id))}


@router.get("/{generation_id}")
def get_generation_detail(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    return _generation_detail_payload(db, generation_id)


@router.post("/{generation_id}/favorite")
def add_generation_favorite(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
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
def remove_generation_favorite(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
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
def list_generation_tags(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
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
def add_generation_tag(
    generation_id: int,
    payload: GenerationTagCreatePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
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


@router.post("/{generation_id}/claim")
def claim_generation(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Self-serve claim for a generation reconciliation recovered without an
    owner (ownership_status="unknown"). Reconciliation no longer guesses an
    owner from the re-discovering usage event, so these sit unclaimed until
    the actual creator says "this one is mine"."""
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    if generation.ownership_status == "resolved":
        if generation.owner_user_id == current_user.id:
            return {"success": True, "data": generation.to_dict()}
        raise HTTPException(status_code=409, detail="This generation has already been claimed by someone else")

    metadata_json = dict(generation.metadata_json or {})
    claim_history = list(metadata_json.get("claimHistory") or [])
    claim_history.append({
        "action": "claimed",
        "byUserId": current_user.id,
        "at": datetime.utcnow().isoformat(),
    })
    metadata_json["claimHistory"] = claim_history

    generation.owner_user_id = current_user.id
    generation.ownership_status = "resolved"
    generation.ownership_source = "user_claimed"
    generation.ownership_notes = None
    generation.metadata_json = metadata_json
    generation.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(generation)
    return {"success": True, "data": generation.to_dict()}


@router.delete("/{generation_id}/claim")
def revoke_generation_claim(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    """Admin-only undo of a self-serve claim, for when someone claims a
    generation that isn't actually theirs. Only reverts claims made via the
    claim endpoint above (ownership_source="user_claimed") — leaves
    live-capture attributions (ownership_source="usage_event_user_id") alone."""
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    if generation.ownership_source != "user_claimed":
        raise HTTPException(status_code=400, detail="This generation was not claimed by a user; nothing to revoke")

    metadata_json = dict(generation.metadata_json or {})
    claim_history = list(metadata_json.get("claimHistory") or [])
    claim_history.append({
        "action": "revoked",
        "byAdminId": current_user.id,
        "previousOwnerUserId": generation.owner_user_id,
        "at": datetime.utcnow().isoformat(),
    })
    metadata_json["claimHistory"] = claim_history

    generation.owner_user_id = None
    generation.ownership_status = "unknown"
    generation.ownership_source = None
    generation.assigned_by_admin_id = current_user.id
    generation.assigned_at = datetime.utcnow()
    generation.metadata_json = metadata_json
    generation.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(generation)
    return {"success": True, "data": generation.to_dict()}


@router.delete("/{generation_id}/tags/{tag}")
def remove_generation_tag(
    generation_id: int,
    tag: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    generation = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.id == generation_id, GenerationRecord.provider == KLING_PROVIDER)
        .first()
    )
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


def _active_kling_generation(db: Session, generation_id: int) -> GenerationRecord:
    generation = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.id == generation_id,
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.archived_at.is_(None),
        )
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    return generation


def _record_admin_edit(generation: GenerationRecord, admin_id: int, action: str, **details) -> dict:
    """Copy of the card's metadata with an audit entry appended; assigned back
    whole so SQLAlchemy sees the JSON change."""
    metadata_json = dict(generation.metadata_json or {})
    admin_edits = list(metadata_json.get("adminEdits") or [])
    admin_edits.append({"action": action, "byAdminId": admin_id, "at": datetime.utcnow().isoformat(), **details})
    metadata_json["adminEdits"] = admin_edits[-50:]
    return metadata_json


def _delete_r2_object_quietly(key: Optional[str]) -> None:
    # The card no longer points at it either way, so a failed cleanup only
    # leaves an orphaned object in the bucket.
    if not key:
        return
    try:
        r2_storage.delete_object(key)
    except Exception:
        pass


@router.put("/{generation_id}/video")
def upload_generation_video(
    generation_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Admin upload (or replacement) of a card's video - for jobs the capture
    never got a video for, or got the wrong one. Stored under
    metadata.adminVideo and served in place of the captured URL; the captured
    canonical_asset_url is left as it was, so removing the upload restores it."""
    extension = os.path.splitext(file.filename or "")[1].lower()
    content_type = ADMIN_VIDEO_EXTENSIONS.get(extension)
    if not content_type:
        raise HTTPException(status_code=400, detail="Upload an .mp4, .webm or .mov video")
    file.file.seek(0, os.SEEK_END)
    size_bytes = file.file.tell()
    file.file.seek(0)
    if size_bytes <= 0:
        raise HTTPException(status_code=400, detail="The video file is empty")
    if size_bytes > ADMIN_VIDEO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Video is larger than 90 MB")
    if not r2_storage.is_configured():
        raise HTTPException(status_code=503, detail="File storage is not configured")

    _active_kling_generation(db, generation_id)
    key = f"{ADMIN_VIDEO_KEY_PREFIX}/{generation_id}/{uuid4().hex[:12]}{extension}"

    # Don't hold a pooled connection idle-in-transaction across an upload of
    # up to ADMIN_VIDEO_MAX_BYTES (same reasoning as the Envato media mirror);
    # the card is re-read afterwards.
    db.close()
    try:
        r2_storage.put_fileobj(key, file.file, content_type=content_type)
    except Exception:
        raise HTTPException(status_code=502, detail="Could not store the video. Try again.")

    return _attach_admin_video(
        db, generation_id, current_user.id,
        key=key, file_name=file.filename, content_type=content_type, size_bytes=size_bytes,
    )


class UploadedVideoPayload(BaseModel):
    key: str
    fileName: Optional[str] = None


@router.put("/{generation_id}/video/uploaded")
def attach_uploaded_generation_video(
    generation_id: int,
    payload: UploadedVideoPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Same as PUT /{id}/video, for a file the browser already sent straight
    to R2 through /api/uploads/presign. Large videos go this way: a request
    carrying the file itself is cut off by the proxy in front of the API well
    before ADMIN_VIDEO_MAX_BYTES (6 MB uploaded fine, 68 MB failed with no
    error body, 2026-11-01). The upload is copied inside the bucket under
    this card's admin prefix and the staging copy removed."""
    source_key = (payload.key or "").strip()
    if not source_key.startswith(DIRECT_UPLOAD_KEY_PREFIX) or ".." in source_key:
        raise HTTPException(status_code=400, detail="Unknown upload")
    file_name = payload.fileName or source_key.rsplit("/", 1)[-1]
    extension = os.path.splitext(file_name)[1].lower() or os.path.splitext(source_key)[1].lower()
    content_type = ADMIN_VIDEO_EXTENSIONS.get(extension)
    if not content_type:
        raise HTTPException(status_code=400, detail="Upload an .mp4, .webm or .mov video")
    if not r2_storage.is_configured():
        raise HTTPException(status_code=503, detail="File storage is not configured")

    _active_kling_generation(db, generation_id)
    size_bytes = r2_storage.object_size(source_key)
    if not size_bytes:
        raise HTTPException(status_code=400, detail="The uploaded video was not found. Upload it again.")
    if size_bytes > ADMIN_VIDEO_DIRECT_MAX_BYTES:
        _delete_r2_object_quietly(source_key)
        raise HTTPException(status_code=413, detail=f"Video is larger than {ADMIN_VIDEO_DIRECT_MAX_BYTES // (1024 * 1024)} MB")

    key = f"{ADMIN_VIDEO_KEY_PREFIX}/{generation_id}/{uuid4().hex[:12]}{extension}"
    db.close()
    try:
        r2_storage.copy_object(source_key, key, content_type=content_type)
    except Exception:
        raise HTTPException(status_code=502, detail="Could not store the video. Try again.")
    _delete_r2_object_quietly(source_key)

    return _attach_admin_video(
        db, generation_id, current_user.id,
        key=key, file_name=file_name, content_type=content_type, size_bytes=size_bytes,
    )


def _attach_admin_video(db: Session, generation_id: int, admin_id: int, *, key: str, file_name: Optional[str],
                        content_type: str, size_bytes: int):
    """Points the card at an admin video already stored at `key`, records the
    edit, and removes the video it replaces."""
    try:
        generation = _active_kling_generation(db, generation_id)
    except HTTPException:
        _delete_r2_object_quietly(key)
        raise

    previous = (generation.metadata_json or {}).get("adminVideo") or {}
    metadata_json = _record_admin_edit(
        generation,
        admin_id,
        "video_replaced" if previous.get("key") else "video_uploaded",
        fileName=file_name,
    )
    metadata_json["adminVideo"] = {
        "key": key,
        "fileName": file_name,
        "contentType": content_type,
        "sizeBytes": size_bytes,
        "uploadedByAdminId": admin_id,
        "uploadedAt": datetime.utcnow().isoformat(),
    }
    generation.metadata_json = metadata_json
    generation.updated_at = datetime.utcnow()
    db.commit()

    _delete_r2_object_quietly(previous.get("key"))
    return _generation_detail_payload(db, generation_id)


@router.delete("/{generation_id}/video")
def remove_generation_video(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Drops the admin-uploaded video; the card falls back to whatever video
    capture recorded (if any)."""
    generation = _active_kling_generation(db, generation_id)
    previous = (generation.metadata_json or {}).get("adminVideo") or {}
    if not previous.get("key"):
        raise HTTPException(status_code=400, detail="This card has no uploaded video")
    metadata_json = _record_admin_edit(generation, current_user.id, "video_removed", fileName=previous.get("fileName"))
    metadata_json.pop("adminVideo", None)
    generation.metadata_json = metadata_json
    generation.updated_at = datetime.utcnow()
    db.commit()

    _delete_r2_object_quietly(previous.get("key"))
    return _generation_detail_payload(db, generation_id)


@router.delete("/{generation_id}")
def delete_generation(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Admin removal of a card. Archived rather than deleted: capture sync
    finds a card by its usage event / Kling task id and would re-create a
    hard-deleted one on the next report of the same job, while an archived
    one stays matched and hidden. Every Kling list already skips archived rows."""
    generation = _active_kling_generation(db, generation_id)
    generation.metadata_json = _record_admin_edit(generation, current_user.id, "card_deleted")
    generation.archived_at = datetime.utcnow()
    generation.updated_at = datetime.utcnow()
    db.commit()
    return {"success": True}


class GenerationCreditsPayload(BaseModel):
    credits: float


def _card_usage_event(db: Session, generation: GenerationRecord) -> Optional[ITPortalToolUsageEvent]:
    """The usage event the credit report reads this card's credits from."""
    if not generation.source_usage_event_id:
        return None
    return db.query(ITPortalToolUsageEvent).filter(ITPortalToolUsageEvent.id == generation.source_usage_event_id).first()


@router.put("/{generation_id}/credits")
def set_generation_credits(
    generation_id: int,
    payload: GenerationCreditsPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Admin-entered credits for a Kling card: written to the card and to its
    usage event (what the credit report reads), and held there against later
    capture writes - see utils/admin_card_credits.py."""
    try:
        value = validate_admin_credits(payload.credits, whole=False, maximum=ADMIN_KLING_MAX_CREDITS)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    generation = _active_kling_generation(db, generation_id)
    usage_event = _card_usage_event(db, generation)
    previous = (generation.metadata_json or {}).get("adminCredits") or {}
    metadata_json = _record_admin_edit(generation, current_user.id, "credits_set",
                                       fromValue=generation.credits_burned, toValue=value)
    metadata_json["adminCredits"] = {
        "value": value,
        # What capture recorded, restored on reset - kept from the first edit on.
        "capturedValue": previous["capturedValue"] if "capturedValue" in previous else generation.credits_burned,
        "capturedEventValue": (
            previous["capturedEventValue"] if "capturedEventValue" in previous
            else (usage_event.credits_burned if usage_event else None)
        ),
        "editedByAdminId": current_user.id,
        "editedAt": datetime.utcnow().isoformat(),
    }
    generation.metadata_json = metadata_json
    generation.admin_credits = value
    generation.credits_burned = value
    generation.updated_at = datetime.utcnow()
    if usage_event:
        usage_event.credits_burned = value
    db.commit()
    return _generation_detail_payload(db, generation_id)


@router.delete("/{generation_id}/credits")
def reset_generation_credits(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Drops the admin-entered credits, restoring the latest captured values."""
    generation = _active_kling_generation(db, generation_id)
    entry = (generation.metadata_json or {}).get("adminCredits")
    if generation.admin_credits is None or not isinstance(entry, dict):
        raise HTTPException(status_code=400, detail="This card has no admin-entered credits")
    usage_event = _card_usage_event(db, generation)
    metadata_json = _record_admin_edit(generation, current_user.id, "credits_reset",
                                       fromValue=entry.get("value"), toValue=entry.get("capturedValue"))
    metadata_json.pop("adminCredits", None)
    generation.metadata_json = metadata_json
    generation.admin_credits = None
    generation.credits_burned = entry.get("capturedValue")
    generation.updated_at = datetime.utcnow()
    if usage_event:
        usage_event.credits_burned = entry.get("capturedEventValue")
    db.commit()
    return _generation_detail_payload(db, generation_id)
