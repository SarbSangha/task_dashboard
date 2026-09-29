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

import io
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import (
    BufferSelfUpload,
    BufferSelfUploadDownload,
    BufferSheetPurpose,
    BufferSheetRow,
    GenerationClient,
    User,
)
from services.feature_access_service import FEATURE_BUFFER_SHEET_EDIT, has_feature_access, is_feature_exempt
from utils.buffer_feed import MEDIA_AUDIO, MEDIA_IMAGE, MEDIA_OTHER, MEDIA_VIDEO, get_buffer_feed
from utils.permissions import has_any_role, require_buffer_access

router = APIRouter(prefix="/api/buffer", tags=["Buffer"])

BUFFER_CLIENT_NAME = "Buffer"

# Round-robin default color for a newly created purpose group, both in the
# UI and the xlsx export - so a fresh group is always visually distinct
# without whoever creates it having to pick a color themselves.
PURPOSE_COLOR_PALETTE = [
    "#22D3EE",  # cyan
    "#F472B6",  # pink
    "#FBBF24",  # amber
    "#34D399",  # emerald
    "#A78BFA",  # violet
    "#FB923C",  # orange
    "#60A5FA",  # blue
    "#F87171",  # red
]


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
    else in this app (utils/fileLinks.js).

    Also syncs this download into the Purpose Sheet (see _sync_purpose_sheet
    below): the client/purpose typed into this exact form is what the sheet
    groups and rows are built from, so someone filling this in to download a
    file is the same action as it showing up under that occasion in the
    sheet - not two separate things to keep in sync by hand."""
    row = db.query(BufferSelfUpload).filter(BufferSelfUpload.id == upload_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found.")

    client_name = payload.clientName.strip()
    purpose_name = payload.purpose.strip()

    log_row = BufferSelfUploadDownload(
        upload_id=row.id,
        downloaded_by_user_id=current_user.id,
        client_name=client_name,
        purpose=purpose_name,
    )
    db.add(log_row)

    audio_name = row.title or row.original_filename or "Self upload"
    editor_name = current_user.name or current_user.email
    sheet_purpose, sheet_row = _sync_purpose_sheet(
        db,
        purpose_name=purpose_name,
        audio_name=audio_name,
        client_name=client_name,
        editor_name=editor_name,
        actor_user_id=current_user.id,
    )

    db.commit()

    return {
        "success": True,
        "sheetPurpose": _purpose_to_dict(sheet_purpose, []),
        "sheetRow": _sheet_row_to_dict(sheet_row),
    }


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


# ---------------------------------------------------------------------------
# Purpose Sheet - a plannable, event-grouped tracking sheet (Audio Name /
# Client / Editor Name rows under a colored purpose header, e.g.
# "Janmashtami", "Teacher's Day"), replacing the hand-kept spreadsheet the
# team used for this before. See BufferSheetPurpose/BufferSheetRow's own
# docstrings in models_new.py for why this needed its own tables instead of
# reusing BufferSelfUploadDownload.
#
# Three access levels, all layered on the base require_buffer_access grant
# every Buffer endpoint already needs:
#   - view (GET /sheet, GET /sheet/export.xlsx): require_buffer_access alone.
#   - edit (create/rename a purpose, edit a row's fields): additionally
#     needs the buffer_sheet_edit grant (or admin) - see
#     _require_sheet_edit_access below. Unlike Buffer access itself, this is
#     NOT open to everyone who can see the sheet: an admin decides per
#     person who may actually change it, the same per-user grant mechanism
#     as Buffer access itself (services/feature_access_service.py), just a
#     second, narrower key.
#   - delete (a whole purpose or row): admin-only outright, see
#     delete_sheet_purpose/delete_sheet_row below - stricter than edit,
#     since there is no per-row owner to fall back on.
#
# There is deliberately no "create a row by hand" endpoint: every row is
# created by _sync_purpose_sheet, called from record_self_upload_download
# when someone fills in the Client/Purpose download gate - that keeps every
# row traceable to an actual download instead of free-typed entries that can
# drift from what was really sent out. Editing an existing row's text
# (correcting a typo, reassigning an editor) is still allowed for anyone
# with the edit grant; only the initial creation is exclusively automatic.
# ---------------------------------------------------------------------------

def _require_sheet_edit_access(current_user: User) -> None:
    if is_feature_exempt(current_user) or has_feature_access(current_user, FEATURE_BUFFER_SHEET_EDIT):
        return
    raise HTTPException(
        status_code=403,
        detail="You do not have edit access to the Purpose Sheet. Ask an administrator to grant it.",
    )


class BufferSheetPurposeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class BufferSheetPurposeUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    color: Optional[str] = Field(default=None, min_length=4, max_length=7)
    sortOrder: Optional[int] = Field(default=None)


class BufferSheetRowUpdate(BaseModel):
    audioName: Optional[str] = Field(default=None, min_length=1, max_length=512)
    clientName: Optional[str] = Field(default=None, max_length=200)
    editorName: Optional[str] = Field(default=None, max_length=200)
    purposeId: Optional[int] = Field(default=None)
    sortOrder: Optional[int] = Field(default=None)


def _next_purpose_color(db: Session) -> str:
    existing = db.query(BufferSheetPurpose).count()
    return PURPOSE_COLOR_PALETTE[existing % len(PURPOSE_COLOR_PALETTE)]


def _purpose_to_dict(row: BufferSheetPurpose, rows: list[BufferSheetRow]) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "color": row.color,
        "sortOrder": row.sort_order,
        "rows": [_sheet_row_to_dict(r) for r in rows],
    }


def _sheet_row_to_dict(row: BufferSheetRow) -> dict:
    return {
        "id": row.id,
        "purposeId": row.purpose_id,
        "audioName": row.audio_name,
        "clientName": row.client_name,
        "editorName": row.editor_name,
        "sortOrder": row.sort_order,
    }


def _sync_purpose_sheet(
    db: Session,
    *,
    purpose_name: str,
    audio_name: str,
    client_name: str,
    editor_name: Optional[str],
    actor_user_id: int,
) -> tuple[BufferSheetPurpose, BufferSheetRow]:
    """Finds-or-creates the BufferSheetPurpose group named `purpose_name`
    (case-insensitive - "Teacher's Day" and "teacher's day" land in the same
    group instead of splitting into two) and finds-or-creates a row under it
    keyed on audio_name + client_name (also case-insensitive), refreshing the
    editor on a repeat sync rather than piling up duplicate rows every time
    the same file is downloaded again for the same client/occasion. Called
    from record_self_upload_download - the Client/Purpose someone types into
    that download gate IS how a purpose group and its rows get populated, so
    this keeps the two in sync as one action rather than two features that
    could drift apart. Caller is responsible for committing."""
    clean_purpose_name = (purpose_name or "").strip()[:200] or "Uncategorized"
    clean_audio_name = (audio_name or "").strip()[:512] or "Untitled"
    clean_client_name = (client_name or "").strip()[:200] or None

    purpose = (
        db.query(BufferSheetPurpose)
        .filter(func.lower(BufferSheetPurpose.name) == clean_purpose_name.lower())
        .first()
    )
    if not purpose:
        purpose = BufferSheetPurpose(
            name=clean_purpose_name,
            color=_next_purpose_color(db),
            sort_order=db.query(BufferSheetPurpose).count(),
            created_by_user_id=actor_user_id,
        )
        db.add(purpose)
        db.flush()

    existing_rows = db.query(BufferSheetRow).filter(BufferSheetRow.purpose_id == purpose.id).all()
    row = next(
        (
            candidate
            for candidate in existing_rows
            if candidate.audio_name.strip().lower() == clean_audio_name.lower()
            and (candidate.client_name or "").strip().lower() == (clean_client_name or "").strip().lower()
        ),
        None,
    )

    if row:
        if editor_name:
            row.editor_name = editor_name
        row.updated_by_user_id = actor_user_id
    else:
        row = BufferSheetRow(
            purpose_id=purpose.id,
            audio_name=clean_audio_name,
            client_name=clean_client_name,
            editor_name=editor_name or None,
            sort_order=len(existing_rows),
            created_by_user_id=actor_user_id,
            updated_by_user_id=actor_user_id,
        )
        db.add(row)

    db.flush()
    return purpose, row


@router.get("/sheet")
def get_sheet(
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    purposes = db.query(BufferSheetPurpose).order_by(BufferSheetPurpose.sort_order, BufferSheetPurpose.id).all()
    all_rows = (
        db.query(BufferSheetRow)
        .order_by(BufferSheetRow.purpose_id, BufferSheetRow.sort_order, BufferSheetRow.id)
        .all()
    )
    rows_by_purpose: dict[int, list[BufferSheetRow]] = {}
    client_suggestions: set[str] = set()
    editor_suggestions: set[str] = set()
    for row in all_rows:
        rows_by_purpose.setdefault(row.purpose_id, []).append(row)
        if row.client_name:
            client_suggestions.add(row.client_name)
        if row.editor_name:
            editor_suggestions.add(row.editor_name)

    return {
        "success": True,
        "purposes": [_purpose_to_dict(p, rows_by_purpose.get(p.id, [])) for p in purposes],
        "clientSuggestions": sorted(client_suggestions, key=str.lower),
        "editorSuggestions": sorted(editor_suggestions, key=str.lower),
    }


@router.post("/sheet/purposes")
def create_sheet_purpose(
    payload: BufferSheetPurposeCreate,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    _require_sheet_edit_access(current_user)
    max_order = db.query(BufferSheetPurpose).count()
    row = BufferSheetPurpose(
        name=payload.name.strip(),
        color=_next_purpose_color(db),
        sort_order=max_order,
        created_by_user_id=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"success": True, "purpose": _purpose_to_dict(row, [])}


@router.patch("/sheet/purposes/{purpose_id}")
def update_sheet_purpose(
    purpose_id: int,
    payload: BufferSheetPurposeUpdate,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    _require_sheet_edit_access(current_user)
    row = db.query(BufferSheetPurpose).filter(BufferSheetPurpose.id == purpose_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Purpose not found.")

    if payload.name is not None:
        row.name = payload.name.strip()
    if payload.color is not None:
        row.color = payload.color.strip()
    if payload.sortOrder is not None:
        row.sort_order = payload.sortOrder

    db.commit()
    db.refresh(row)
    rows = (
        db.query(BufferSheetRow)
        .filter(BufferSheetRow.purpose_id == row.id)
        .order_by(BufferSheetRow.sort_order, BufferSheetRow.id)
        .all()
    )
    return {"success": True, "purpose": _purpose_to_dict(row, rows)}


@router.delete("/sheet/purposes/{purpose_id}")
def delete_sheet_purpose(
    purpose_id: int,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Deletes the group and every row under it - the FK's ON DELETE CASCADE
    (see BufferSheetRow.purpose_id) drops the rows at the database level, the
    same way delete_self_upload above relies on
    buffer_self_upload_downloads' cascade instead of deleting them here.

    Admin-only: unlike create/edit (open to anyone with Buffer access, like a
    shared spreadsheet - see this section's module docstring), deleting a
    whole occasion's worth of rows is destructive enough that it needs the
    same admin-or-owner posture as delete_self_upload above, minus the owner
    half - a sheet row has no single owner to defer to, so it's admin-only
    outright rather than admin-or-owner."""
    if not has_any_role(current_user, {"admin"}):
        raise HTTPException(status_code=403, detail="Only an admin can delete a purpose.")
    row = db.query(BufferSheetPurpose).filter(BufferSheetPurpose.id == purpose_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Purpose not found.")
    db.delete(row)
    db.commit()
    return {"success": True}


@router.patch("/sheet/rows/{row_id}")
def update_sheet_row(
    row_id: int,
    payload: BufferSheetRowUpdate,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Partial update - fields left out of the payload are left unchanged;
    to clear clientName/editorName, send an empty string, same convention as
    update_self_upload above. There is no matching create_sheet_row: every
    row's initial creation comes only from _sync_purpose_sheet (see this
    section's module docstring) - this endpoint is for correcting/
    reassigning an already-synced row, not adding new ones by hand."""
    _require_sheet_edit_access(current_user)
    row = db.query(BufferSheetRow).filter(BufferSheetRow.id == row_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Row not found.")

    if payload.audioName is not None:
        stripped = payload.audioName.strip()
        if not stripped:
            raise HTTPException(status_code=400, detail="Audio name cannot be empty.")
        row.audio_name = stripped[:512]
    if payload.clientName is not None:
        row.client_name = payload.clientName.strip()[:200] or None
    if payload.editorName is not None:
        row.editor_name = payload.editorName.strip()[:200] or None
    if payload.purposeId is not None:
        new_purpose = db.query(BufferSheetPurpose).filter(BufferSheetPurpose.id == payload.purposeId).first()
        if not new_purpose:
            raise HTTPException(status_code=404, detail="Target purpose not found.")
        row.purpose_id = payload.purposeId
    if payload.sortOrder is not None:
        row.sort_order = payload.sortOrder

    row.updated_by_user_id = current_user.id
    db.commit()
    db.refresh(row)
    return {"success": True, "row": _sheet_row_to_dict(row)}


@router.delete("/sheet/rows/{row_id}")
def delete_sheet_row(
    row_id: int,
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Admin-only, same reasoning as delete_sheet_purpose above - a row can
    come from anyone (typed in by hand, or auto-synced by someone else's
    download), so there's no owner to defer to."""
    if not has_any_role(current_user, {"admin"}):
        raise HTTPException(status_code=403, detail="Only an admin can delete a row.")
    row = db.query(BufferSheetRow).filter(BufferSheetRow.id == row_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Row not found.")
    db.delete(row)
    db.commit()
    return {"success": True}


@router.get("/sheet/export.xlsx")
def export_sheet_xlsx(
    purposeIds: Optional[str] = Query(None, description="Comma-separated purpose ids to include; default all."),
    columns: Optional[str] = Query(None, description="Comma-separated subset of client,editor to include; default both."),
    onlyFilled: bool = Query(False, description="Skip rows with no client and no editor set."),
    current_user: User = Depends(require_buffer_access),
    db: Session = Depends(get_operational_db),
):
    """Downloadable version of the Purpose Sheet, reproducing the colored
    per-purpose header block layout the team used to keep by hand - see
    reports_router.py's kling_export_xlsx for the header-styling/response
    conventions this follows (PatternFill header, auto_filter-free here since
    the sheet has multiple stacked header rows instead of one, Content-
    Disposition attachment)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    include_client = True
    include_editor = True
    if columns is not None:
        selected = {c.strip().lower() for c in columns.split(",") if c.strip()}
        include_client = "client" in selected
        include_editor = "editor" in selected

    purposes_q = db.query(BufferSheetPurpose).order_by(BufferSheetPurpose.sort_order, BufferSheetPurpose.id)
    if purposeIds:
        try:
            wanted_ids = {int(pid.strip()) for pid in purposeIds.split(",") if pid.strip()}
        except ValueError:
            raise HTTPException(status_code=400, detail="purposeIds must be a comma-separated list of integers.")
        purposes_q = purposes_q.filter(BufferSheetPurpose.id.in_(wanted_ids))
    purposes = purposes_q.all()

    headers = ["Audio Name"]
    if include_client:
        headers.append("Client")
    if include_editor:
        headers.append("Editor Name")
    col_count = len(headers)

    wb = Workbook()
    ws = wb.active
    ws.title = "Buffer Sheet"

    header_font = Font(bold=True, color="000000")
    header_alignment = Alignment(horizontal="left", vertical="center")

    excel_row = 1
    for purpose in purposes:
        rows_q = (
            db.query(BufferSheetRow)
            .filter(BufferSheetRow.purpose_id == purpose.id)
            .order_by(BufferSheetRow.sort_order, BufferSheetRow.id)
        )
        rows = rows_q.all()
        if onlyFilled:
            rows = [r for r in rows if r.client_name or r.editor_name]

        # Purpose title row - merged across every visible column, filled
        # with this group's color, matching the reference sheet's colored
        # header bar.
        ws.cell(row=excel_row, column=1, value=purpose.name.upper())
        ws.merge_cells(start_row=excel_row, start_column=1, end_row=excel_row, end_column=col_count)
        title_fill = PatternFill("solid", fgColor=purpose.color.lstrip("#").upper())
        for col_idx in range(1, col_count + 1):
            cell = ws.cell(row=excel_row, column=col_idx)
            cell.fill = title_fill
            cell.font = header_font
        excel_row += 1

        # Column header row.
        for col_idx, label in enumerate(headers, start=1):
            cell = ws.cell(row=excel_row, column=col_idx, value=label)
            cell.font = header_font
            cell.alignment = header_alignment
        excel_row += 1

        for data_row in rows:
            values = [data_row.audio_name]
            if include_client:
                values.append(data_row.client_name or "")
            if include_editor:
                values.append(data_row.editor_name or "")
            for col_idx, value in enumerate(values, start=1):
                ws.cell(row=excel_row, column=col_idx, value=value)
            excel_row += 1

        excel_row += 1  # blank spacer row before the next purpose group

    widths = [34]
    if include_client:
        widths.append(26)
    if include_editor:
        widths.append(22)
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width

    buf = io.BytesIO()
    wb.save(buf)
    filename = f"Buffer-Sheet_{date.today().isoformat()}.xlsx"
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
