"""Buffer tab - cross-tool feed of every generation/download tagged with the
"Buffer" GenerationClient (see utils/client_gate.py for how the Task/Client
picker gates Generate/Download in every provider's capture flow, and
utils/buffer_feed.py for why this needs its own fan-out query instead of one
table).

Also owns the Buffer self-upload endpoints - a way for someone to add a file
into Buffer directly, for something they did that no provider's own capture
flow could tag with the Buffer client. See BufferSelfUpload's own docstring
in models_new.py for the storage shape.

Access: every endpoint here requires the per-user `buffer` grant
(services/feature_access_service.py), which an admin hands out in Admin
Queue -> Section Access. Admins bypass the grant table, so they keep the
access they always had. This replaced two older rules - /feed was
admin-only, and the self-uploads were open to any authenticated user -
because a grant that did not actually open the feed would have been
meaningless: the point of granting Buffer to one person is that they can
then use it. Ownership checks inside the self-upload handlers are unchanged
and still apply on top of the grant."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import BufferSelfUpload, BufferSelfUploadDownload, GenerationClient, User
from utils.buffer_feed import MEDIA_AUDIO, MEDIA_IMAGE, MEDIA_OTHER, MEDIA_VIDEO, get_buffer_feed
from utils.permissions import has_any_role, require_buffer_access

router = APIRouter(prefix="/api/buffer", tags=["Buffer"])

BUFFER_CLIENT_NAME = "Buffer"


def _resolve_buffer_client_id(db: Session) -> int:
    client = (
        db.query(GenerationClient)
        .filter(GenerationClient.name.ilike(BUFFER_CLIENT_NAME))
        .first()
    )
    if not client:
        raise HTTPException(status_code=404, detail="The Buffer client has not been created yet.")
    return client.id


@router.get("/feed")
def get_feed(
    media_type: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 24,
    offset: int = 0,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    client_id = _resolve_buffer_client_id(db)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    result = get_buffer_feed(db, client_id=client_id, media_type=media_type, q=q, limit=limit, offset=offset)
    return {"success": True, **result}


class BufferSelfUploadCreate(BaseModel):
    # Matches the attachment record shape routers/upload.py's
    # /api/uploads/presign already returns after the browser PUTs the file
    # straight to R2 - the frontend uploads first via fileAPI.uploadFiles,
    # then posts that result here to record it. No file bytes cross this
    # endpoint.
    url: str = Field(min_length=1, max_length=2048)
    title: Optional[str] = Field(default=None, max_length=512)
    tags: Optional[list[str]] = Field(default=None, max_items=20)
    path: Optional[str] = Field(default=None, max_length=2048)
    mimetype: Optional[str] = Field(default=None, max_length=255)
    size: Optional[int] = Field(default=None, ge=0)
    originalName: Optional[str] = Field(default=None, max_length=512)


class BufferSelfUploadUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=512)
    tags: Optional[list[str]] = Field(default=None, max_items=20)


class BufferSelfUploadDownloadCreate(BaseModel):
    clientName: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=2000)


def _classify_self_upload_media_type(mime_type: Optional[str]) -> str:
    value = (mime_type or "").strip().lower()
    if value.startswith("image/"):
        return MEDIA_IMAGE
    if value.startswith("video/"):
        return MEDIA_VIDEO
    if value.startswith("audio/"):
        return MEDIA_AUDIO
    return MEDIA_OTHER


def _parse_tags(raw: Optional[str]) -> list[str]:
    return [tag.strip() for tag in (raw or "").split(",") if tag.strip()]


def _serialize_tags(tags: Optional[list[str]]) -> Optional[str]:
    if tags is None:
        return None
    cleaned = [f"{tag}".strip()[:60] for tag in tags if f"{tag}".strip()]
    return ", ".join(cleaned[:20]) or None


def _self_upload_to_dict(row: BufferSelfUpload, owner_name: Optional[str] = None) -> dict:
    return {
        "id": f"self-upload-{row.id}",
        "rawId": row.id,
        "provider": "self-upload",
        "kind": "upload",
        "mediaType": row.media_type,
        "title": row.title or row.original_filename or "Self upload",
        "tags": _parse_tags(row.tags),
        "assetUrl": row.asset_url,
        "filePath": row.file_path,
        "ownerUserId": row.owner_user_id,
        "ownerName": owner_name,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/self-uploads")
def create_self_upload(
    payload: BufferSelfUploadCreate,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    title = (payload.title or payload.originalName or "").strip()[:512] or None
    row = BufferSelfUpload(
        owner_user_id=current_user.id,
        title=title,
        tags=_serialize_tags(payload.tags),
        media_type=_classify_self_upload_media_type(payload.mimetype),
        asset_url=payload.url.strip(),
        file_path=(payload.path or "").strip() or None,
        mime_type=(payload.mimetype or "").strip() or None,
        size_bytes=payload.size,
        original_filename=(payload.originalName or "").strip() or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"success": True, "item": _self_upload_to_dict(row, owner_name=current_user.name)}


@router.get("/self-uploads/mine")
def list_my_self_uploads(
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    query = (
        db.query(BufferSelfUpload)
        .filter(BufferSelfUpload.owner_user_id == current_user.id)
        .order_by(BufferSelfUpload.created_at.desc())
    )
    total = query.count()
    rows = query.offset(offset).limit(limit).all()
    # Every row here belongs to current_user (filtered above), so no extra
    # per-row User lookup is needed to fill in ownerName.
    return {
        "success": True,
        "items": [_self_upload_to_dict(row, owner_name=current_user.name) for row in rows],
        "total": total,
    }


@router.patch("/self-uploads/{upload_id}")
def update_self_upload(
    upload_id: int,
    payload: BufferSelfUploadUpdate,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Rename and/or re-tag a self-upload - owner or admin only, same rule
    as delete. Fields left out of the payload (None) are left unchanged;
    to clear the title/tags, send an empty string / empty list."""
    row = db.query(BufferSelfUpload).filter(BufferSelfUpload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found.")
    if row.owner_user_id != current_user.id and not has_any_role(current_user, {"admin"}):
        raise HTTPException(status_code=403, detail="You can only edit your own uploads.")

    if payload.title is not None:
        row.title = payload.title.strip()[:512] or None
    if payload.tags is not None:
        row.tags = _serialize_tags(payload.tags)

    db.commit()
    db.refresh(row)
    # Usually row.owner_user_id == current_user.id, but an admin editing
    # someone else's upload is allowed too (see the check above) - don't
    # assume the editor is the owner.
    owner_name = current_user.name
    if row.owner_user_id != current_user.id:
        owner_name = db.query(User.name).filter(User.id == row.owner_user_id).scalar()
    return {"success": True, "item": _self_upload_to_dict(row, owner_name=owner_name)}


@router.delete("/self-uploads/{upload_id}")
def delete_self_upload(
    upload_id: int,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    row = db.query(BufferSelfUpload).filter(BufferSelfUpload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found.")
    if row.owner_user_id != current_user.id and not has_any_role(current_user, {"admin"}):
        raise HTTPException(status_code=403, detail="You can only delete your own uploads.")
    db.delete(row)
    db.commit()
    return {"success": True}


@router.post("/self-uploads/{upload_id}/download")
def record_self_upload_download(
    upload_id: int,
    payload: BufferSelfUploadDownloadCreate,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Logs who downloaded a self-upload, and which real client/purpose the
    download is for (see BufferSelfUploadDownload's own docstring for why a
    self-upload needs this recorded separately instead of just carrying its
    own client, the way every other provider's captured row does). Any
    authenticated user may download - not owner-only, since a self-upload's
    whole point is to be available to the team - but every download must
    name a client and a purpose. The frontend already holds this upload's
    assetUrl/filePath (it fetched the item to render the card), so this just
    records the log entry and confirms it; building the actual
    /api/files/download link stays the frontend's job, same as everywhere
    else in this app (utils/fileLinks.js)."""
    row = db.query(BufferSelfUpload).filter(BufferSelfUpload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found.")

    log_row = BufferSelfUploadDownload(
        upload_id=row.id,
        downloaded_by_user_id=current_user.id,
        client_name=payload.clientName.strip(),
        purpose=payload.purpose.strip(),
    )
    db.add(log_row)
    db.commit()

    return {"success": True}


@router.get("/self-uploads/{upload_id}/downloads")
def list_self_upload_downloads(
    upload_id: int,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Download history for one self-upload - owner or admin only, so the
    person who added something to Buffer can see who's used it for what."""
    row = db.query(BufferSelfUpload).filter(BufferSelfUpload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found.")
    if row.owner_user_id != current_user.id and not has_any_role(current_user, {"admin"}):
        raise HTTPException(status_code=403, detail="You can only view download history for your own uploads.")

    logs = (
        db.query(BufferSelfUploadDownload)
        .filter(BufferSelfUploadDownload.upload_id == upload_id)
        .order_by(BufferSelfUploadDownload.created_at.desc())
        .limit(200)
        .all()
    )
    return {
        "success": True,
        "downloads": [
            {
                "id": log.id,
                "downloadedByUserId": log.downloaded_by_user_id,
                "clientName": log.client_name,
                "purpose": log.purpose,
                "createdAt": log.created_at.isoformat() if log.created_at else None,
            }
            for log in logs
        ],
    }
