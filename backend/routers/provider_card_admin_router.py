"""Admin card edits for the per-provider Capture Center generation cards:
replace a card's media with an uploaded file, drop that upload again, or
delete (archive) the card. The provider-generic twin of the Kling-only
endpoints in routers/generation_records_router.py - see
utils/admin_card_media.py for where the state is kept and why."""
import os
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationRecord, User
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.envato.models import EnvatoGeneration
from providers.flow.models import FlowGeneration
from providers.freepik.models import FreepikGeneration
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.suno.models import SunoGeneration
from utils import r2_storage
from utils.admin_card_credits import CARD_CREDIT_COLUMNS, admin_credits_entry, validate_admin_credits
from utils.admin_card_media import ADMIN_MEDIA_EXTENSIONS
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers", tags=["Provider Card Admin"])

ADMIN_MEDIA_MAX_BYTES = 90 * 1024 * 1024  # requests pass the proxy only under ~100 MB; same cap as Kling's ADMIN_VIDEO_MAX_BYTES

# provider slug (its /api/providers/<slug> prefix) -> (generations model, media kinds an admin may upload)
CARD_PROVIDERS = {
    "freepik": (FreepikGeneration, {"image", "video"}),
    "higgsfield": (HiggsfieldGeneration, {"image", "video"}),
    "heygen": (HeygenGeneration, {"video"}),
    "suno": (SunoGeneration, {"audio"}),
    "elevenlabs": (ElevenlabsGeneration, {"audio"}),
    "envato": (EnvatoGeneration, {"image", "video", "audio"}),
    "flow": (FlowGeneration, {"image", "video"}),
}


def _provider_config(provider: str):
    config = CARD_PROVIDERS.get(provider)
    if not config:
        raise HTTPException(status_code=404, detail="Unknown provider")
    return config


def _active_generation(db: Session, model, generation_id: int, *, for_update: bool = False):
    query = db.query(model).filter(model.id == generation_id, model.archived_at.is_(None))
    if for_update:
        # Serializes concurrent edits of one card: each must see the media key
        # the previous one stored, or the replaced R2 object is never deleted.
        query = query.with_for_update()
    generation = query.first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    return generation


def _record_admin_edit(generation, admin_id: int, action: str, **details) -> dict:
    """Copy of the card's admin_edit_json with an audit entry appended;
    assigned back whole so SQLAlchemy sees the JSON change."""
    admin_edit_json = dict(generation.admin_edit_json or {})
    edits = list(admin_edit_json.get("edits") or [])
    edits.append({"action": action, "byAdminId": admin_id, "at": datetime.utcnow().isoformat(), **details})
    admin_edit_json["edits"] = edits[-50:]
    return admin_edit_json


class CreditsPayload(BaseModel):
    credits: float


def _projected_record(db: Session, generation) -> Optional[GenerationRecord]:
    """The card's cross-tool GenerationRecord, which carries its own copy of the credits."""
    if not generation.generation_record_id:
        return None
    return db.query(GenerationRecord).filter(GenerationRecord.id == generation.generation_record_id).first()


def _delete_r2_object_quietly(key: Optional[str]) -> None:
    # The card no longer points at it either way, so a failed cleanup only
    # leaves an orphaned object in the bucket.
    if not key:
        return
    try:
        r2_storage.delete_object(key)
    except Exception:
        pass


@router.put("/{provider}/generations/{generation_id}/media")
def upload_generation_media(
    provider: str,
    generation_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Admin upload (or replacement) of a card's media. Served in place of the
    captured media; the captured fields are left as they were, so removing
    the upload restores them."""
    model, allowed_kinds = _provider_config(provider)
    extension = os.path.splitext(file.filename or "")[1].lower()
    content_type, kind = ADMIN_MEDIA_EXTENSIONS.get(extension, (None, None))
    if kind not in allowed_kinds:
        allowed = sorted(ext for ext, (_, ext_kind) in ADMIN_MEDIA_EXTENSIONS.items() if ext_kind in allowed_kinds)
        raise HTTPException(status_code=400, detail=f"Upload a {', '.join(allowed)} file")
    file.file.seek(0, os.SEEK_END)
    size_bytes = file.file.tell()
    file.file.seek(0)
    if size_bytes <= 0:
        raise HTTPException(status_code=400, detail="The file is empty")
    if size_bytes > ADMIN_MEDIA_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File is larger than 90 MB")
    if not r2_storage.is_configured():
        raise HTTPException(status_code=503, detail="File storage is not configured")

    _active_generation(db, model, generation_id)
    admin_id = current_user.id
    key = f"{provider}-admin-uploads/{generation_id}/{uuid4().hex[:12]}{extension}"

    # Don't hold a pooled connection idle-in-transaction across an upload of
    # up to ADMIN_MEDIA_MAX_BYTES (same reasoning as Kling's video upload);
    # the card is re-read afterwards.
    db.close()
    try:
        r2_storage.put_fileobj(key, file.file, content_type=content_type)
    except Exception:
        raise HTTPException(status_code=502, detail="Could not store the file. Try again.")

    try:
        generation = _active_generation(db, model, generation_id, for_update=True)
    except HTTPException:
        _delete_r2_object_quietly(key)
        raise

    previous = (generation.admin_edit_json or {}).get("media") or {}
    admin_edit_json = _record_admin_edit(
        generation,
        admin_id,
        "media_replaced" if previous.get("key") else "media_uploaded",
        fileName=file.filename,
    )
    admin_edit_json["media"] = {
        "key": key,
        "kind": kind,
        "fileName": file.filename,
        "contentType": content_type,
        "sizeBytes": size_bytes,
        "uploadedByAdminId": admin_id,
        "uploadedAt": datetime.utcnow().isoformat(),
    }
    generation.admin_edit_json = admin_edit_json
    try:
        db.commit()
    except Exception:
        db.rollback()
        _delete_r2_object_quietly(key)  # nothing points at it now
        raise

    _delete_r2_object_quietly(previous.get("key"))
    return {"success": True, "data": generation.to_dict()}


@router.delete("/{provider}/generations/{generation_id}/media")
def remove_generation_media(
    provider: str,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Drops the admin-uploaded media; the card falls back to whatever capture
    recorded (if anything)."""
    model, _ = _provider_config(provider)
    generation = _active_generation(db, model, generation_id, for_update=True)
    previous = (generation.admin_edit_json or {}).get("media") or {}
    if not previous.get("key"):
        raise HTTPException(status_code=400, detail="This card has no uploaded media")
    admin_edit_json = _record_admin_edit(generation, current_user.id, "media_removed", fileName=previous.get("fileName"))
    admin_edit_json.pop("media", None)
    generation.admin_edit_json = admin_edit_json
    db.commit()

    _delete_r2_object_quietly(previous.get("key"))
    return {"success": True, "data": generation.to_dict()}


@router.put("/{provider}/generations/{generation_id}/credits")
def set_generation_credits(
    provider: str,
    generation_id: int,
    payload: CreditsPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Admin-entered credits for the card. Written into the credit column the
    reports read, and held there against later capture/repricing writes - see
    utils/admin_card_credits.py."""
    model, _ = _provider_config(provider)
    column = CARD_CREDIT_COLUMNS[model.__tablename__]
    try:
        value = validate_admin_credits(payload.credits, whole=model.__table__.c[column].type.python_type is int)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))

    generation = _active_generation(db, model, generation_id, for_update=True)
    current = getattr(generation, column)
    previous = admin_credits_entry(generation.admin_edit_json)
    admin_edit_json = _record_admin_edit(generation, current_user.id, "credits_set", fromValue=current, toValue=value)
    admin_edit_json["credits"] = {
        "value": value,
        # What capture recorded, restored on reset - kept from the first edit on.
        "capturedValue": previous.get("capturedValue") if previous else current,
        "editedByAdminId": current_user.id,
        "editedAt": datetime.utcnow().isoformat(),
    }
    generation.admin_edit_json = admin_edit_json
    setattr(generation, column, value)
    record = _projected_record(db, generation)
    if record:
        record.admin_credits = value
        record.credits_burned = value
    db.commit()
    return {"success": True, "data": generation.to_dict()}


@router.delete("/{provider}/generations/{generation_id}/credits")
def reset_generation_credits(
    provider: str,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Drops the admin-entered credits, restoring the latest captured value."""
    model, _ = _provider_config(provider)
    column = CARD_CREDIT_COLUMNS[model.__tablename__]
    generation = _active_generation(db, model, generation_id, for_update=True)
    entry = admin_credits_entry(generation.admin_edit_json)
    if not entry:
        raise HTTPException(status_code=400, detail="This card has no admin-entered credits")
    captured = entry.get("capturedValue")
    admin_edit_json = _record_admin_edit(generation, current_user.id, "credits_reset", fromValue=entry["value"], toValue=captured)
    admin_edit_json.pop("credits", None)
    generation.admin_edit_json = admin_edit_json
    setattr(generation, column, captured)
    record = _projected_record(db, generation)
    if record:
        record.admin_credits = None
        record.credits_burned = captured
    db.commit()
    return {"success": True, "data": generation.to_dict()}


@router.delete("/{provider}/generations/{generation_id}")
def delete_generation(
    provider: str,
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Admin removal of a card. Archived rather than deleted: capture
    normalization finds a row by its provider ids and would re-create a
    hard-deleted one on the next report of the same generation, while an
    archived one stays matched and hidden.

    The generation's projected GenerationRecord is archived too, as Kling's
    delete does, so the card also leaves Generation Projects/Collections and
    the reports_router analytics. Normalization never resets archived_at, and
    the credit report doesn't filter on it, so spent credits still count."""
    model, _ = _provider_config(provider)
    generation = _active_generation(db, model, generation_id, for_update=True)
    now = datetime.utcnow()
    generation.admin_edit_json = _record_admin_edit(generation, current_user.id, "card_deleted")
    generation.archived_at = now
    if generation.generation_record_id:
        record = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.id == generation.generation_record_id, GenerationRecord.archived_at.is_(None))
            .first()
        )
        if record:
            record.archived_at = now
    db.commit()
    return {"success": True}
