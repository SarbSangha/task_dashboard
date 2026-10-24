"""
AI Library API - drag-and-drop uploads into the connected Google Drive.

Visibility is the "ai_library" Section Access grant (Admin Queue -> Section
Access); admins always have it, and only admins can connect or disconnect
the Google account.

The file bytes never touch this server. For each file:

1. POST /uploads with the name, size, type and client. The server works out
   the folder - AI Library / <IST date> / <user> / <client> - creating any
   missing level, asks Drive for a resumable upload session in it, records a
   "pending" row and returns the session URL.
2. The browser PUTs the file to that URL in chunks (see
   my-dashboard/src/utils/driveResumableUpload.js), resuming from Drive's
   own byte count if the connection drops.
3. POST /uploads/{id}/complete with the Drive file id Drive returned. The
   server looks the file up on Drive itself and only marks the row
   "complete" if it is in the expected folder with the expected size.
"""

import logging
import os
import secrets
from datetime import date, datetime, timedelta
from typing import Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import AiLibraryUpload, GenerationClient, User
from services import google_drive_service as drive
from utils.credential_crypto import decrypt_secret
from utils.permissions import has_any_role, require_admin, require_ai_library_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai-library", tags=["AI Library"])

IST_OFFSET = timedelta(minutes=330)
# Drive requires every chunk but the last to be a multiple of 256 KiB.
CHUNK_SIZE_BYTES = 32 * 256 * 1024  # 8 MiB
OAUTH_STATE_SALT = "ai-library-google-oauth"
OAUTH_STATE_MAX_AGE_SECONDS = 600
CALLBACK_PATH = "/api/ai-library/google/callback"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _drive_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, drive.DriveNotConfigured):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, drive.DriveNotConnected):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, drive.DriveError):
        return HTTPException(status_code=502, detail=f"Google Drive: {exc}")
    if isinstance(exc, httpx.HTTPError):
        return HTTPException(status_code=502, detail="Could not reach Google Drive. Try again in a moment.")
    raise exc


def _state_serializer() -> URLSafeTimedSerializer:
    secret = (os.getenv("SECRET_KEY") or "").strip() or "rmw-dev-ai-library-state"
    return URLSafeTimedSerializer(secret_key=secret, salt=OAUTH_STATE_SALT)


def _redirect_uri(request: Request) -> str:
    """Must match an Authorized redirect URI on the Google OAuth client
    exactly. Set GOOGLE_OAUTH_REDIRECT_URI in production: behind nginx the
    request's own URL can come through as http:// and fail that match."""
    configured = (os.getenv("GOOGLE_OAUTH_REDIRECT_URI") or "").strip()
    if configured:
        return configured
    return f"{str(request.base_url).rstrip('/')}{CALLBACK_PATH}"


def _frontend_origin() -> str:
    parsed = urlparse((os.getenv("FRONTEND_URL") or "http://localhost:5173").strip())
    return f"{parsed.scheme}://{parsed.netloc}"


def _frontend_panel_url(**params) -> str:
    base = (os.getenv("FRONTEND_URL") or "http://localhost:5173").strip().rstrip("/")
    query = f"?{urlencode(params)}" if params else ""
    return f"{base}/dashboard/ai-library{query}"


def _ist_today() -> date:
    return (datetime.utcnow() + IST_OFFSET).date()


def _is_admin(user: User) -> bool:
    return has_any_role(user, {"admin"})


def _owned_upload(db: Session, upload_id: int, user: User) -> AiLibraryUpload:
    record = db.query(AiLibraryUpload).filter(AiLibraryUpload.id == upload_id).first()
    if not record or record.user_id != user.id:
        raise HTTPException(status_code=404, detail="Upload not found")
    return record


def _resolve_target_folder(db: Session, access_token: str, root_id: str, upload_day: date,
                           user: User, client: GenerationClient, chain: list[str]) -> str:
    """Folder id for AI Library / <day> / <user> / <client>. Appends each
    level's id to `chain` as it goes, so a caller that hits a stale cached
    folder knows which cache entries to drop."""
    parent = root_id
    for cache_key, name in (
        (upload_day.isoformat(), upload_day.isoformat()),
        (f"user:{user.id}", drive.clean_folder_name(user.name, f"User {user.id}")),
        (f"client:{client.id}", drive.clean_folder_name(client.name, f"Client {client.id}")),
    ):
        parent = drive.ensure_folder(db, access_token, parent, cache_key, name)
        chain.append(parent)
    return parent


def _first_stale_folder(access_token: str, path_ids: list[str]) -> Optional[str]:
    """The first folder, walking root -> leaf, that is gone or trashed."""
    for folder_id in path_ids:
        info = drive.get_file(access_token, folder_id, "id,trashed", missing_ok=True)
        if not info or info.get("trashed"):
            return folder_id
    return None


# ─── Connection ──────────────────────────────────────────────────────────────

@router.get("/status")
def ai_library_status(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    return {
        "success": True,
        **drive.connection_status(db),
        "canManage": _is_admin(current_user),
        "maxFileSizeBytes": drive.max_file_size_bytes(),
        "chunkSizeBytes": CHUNK_SIZE_BYTES,
    }


@router.get("/google/connect")
def ai_library_google_connect(request: Request, current_user: User = Depends(require_admin)):
    """The Google consent URL. The frontend navigates the window to it;
    Google sends the admin back to /google/callback below."""
    try:
        state = _state_serializer().dumps({"uid": current_user.id, "n": secrets.token_urlsafe(12)})
        return {"success": True, "url": drive.build_auth_url(state, _redirect_uri(request))}
    except Exception as exc:  # noqa: BLE001 - mapped to an HTTP error
        raise _drive_http_error(exc)


@router.get("/google/callback", name="ai_library_google_callback")
def ai_library_google_callback(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
):
    """Google's redirect target. A browser redirect carries no X-Session-Id
    header, so the admin is identified by the signed `state` minted in
    /google/connect, and re-checked against the database here."""
    if error:
        return RedirectResponse(_frontend_panel_url(drive_error=f"Google sign-in was cancelled ({error})."))
    if not code or not state:
        return RedirectResponse(_frontend_panel_url(drive_error="Google did not return a sign-in code."))

    try:
        payload = _state_serializer().loads(state, max_age=OAUTH_STATE_MAX_AGE_SECONDS)
    except SignatureExpired:
        return RedirectResponse(_frontend_panel_url(drive_error="The sign-in took too long. Please try again."))
    except BadSignature:
        return RedirectResponse(_frontend_panel_url(drive_error="Invalid sign-in request."))

    admin = db.query(User).filter(User.id == payload.get("uid")).first()
    if not admin or admin.is_deleted or not admin.is_active or not _is_admin(admin):
        return RedirectResponse(_frontend_panel_url(drive_error="Only an admin can connect Google Drive."))

    try:
        tokens = drive.exchange_code(code, _redirect_uri(request))
        previous = drive.load_connection(db)
        value = drive.build_connection(tokens, previous, admin.id, datetime.utcnow().isoformat() + "Z")
    except (drive.DriveNotConfigured, drive.DriveError, httpx.HTTPError) as exc:
        logger.warning("ai_library: Google connect failed: %s", exc)
        return RedirectResponse(_frontend_panel_url(drive_error=_drive_http_error(exc).detail))

    if previous.get("rootFolderId") != value["rootFolderId"]:
        # A different account (or a deleted root) means none of the cached
        # folder ids exist in the new tree.
        drive.forget_folders(db, [previous.get("rootFolderId")])
    drive.save_connection(db, value, admin.id)
    db.commit()
    logger.info("ai_library: Google Drive connected as %s by user_id=%s", value.get("accountEmail"), admin.id)
    return RedirectResponse(_frontend_panel_url(drive="connected"))


@router.post("/google/disconnect")
def ai_library_google_disconnect(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    value = drive.load_connection(db)
    refresh_token = decrypt_secret(value.get("refreshTokenEnc")) if value.get("refreshTokenEnc") else None
    if refresh_token:
        drive.revoke(refresh_token)
    # The root folder id is kept, so reconnecting the same account carries
    # on in the same "AI Library" folder.
    drive.save_connection(db, {
        "accountEmail": value.get("accountEmail"),
        "rootFolderId": value.get("rootFolderId"),
        "rootFolderName": value.get("rootFolderName"),
    }, current_user.id)
    db.commit()
    return {"success": True, **drive.connection_status(db)}


# ─── Uploads ─────────────────────────────────────────────────────────────────

class UploadCreateIn(BaseModel):
    fileName: str = Field(..., min_length=1, max_length=500)
    sizeBytes: int = Field(..., ge=0)
    mimeType: Optional[str] = Field(None, max_length=255)
    clientId: int


class UploadCompleteIn(BaseModel):
    driveFileId: str = Field(..., min_length=1, max_length=128)


class UploadFailIn(BaseModel):
    error: Optional[str] = Field(None, max_length=1000)


@router.post("/uploads")
def create_ai_library_upload(
    body: UploadCreateIn,
    request: Request,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    max_size = drive.max_file_size_bytes()
    if body.sizeBytes > max_size:
        raise HTTPException(status_code=413, detail=f"File is larger than the {max_size / 1024 ** 3:g} GB limit.")

    client = db.query(GenerationClient).filter(GenerationClient.id == body.clientId).first()
    if not client or not client.is_active:
        raise HTTPException(status_code=400, detail="Pick an active client for this upload.")

    file_name = body.fileName.strip().replace("/", "-").replace("\\", "-")[:500] or "file"
    mime_type = (body.mimeType or "").strip() or "application/octet-stream"
    upload_day = _ist_today()
    # The browser always sends Origin on this cross-origin POST, and script
    # cannot forge it. A non-browser caller can, but that only decides which
    # site Drive lets PUT to the session that caller already holds.
    # Without one, Drive opens the session for no origin and the browser's
    # PUTs fail CORS, so fall back to the dashboard's own origin.
    origin = request.headers.get("origin") or _frontend_origin()

    try:
        access_token, connection = drive.connected_access_token(db)
        root_id = connection["rootFolderId"]
        for attempt in range(2):
            chain: list[str] = []
            try:
                folder_id = _resolve_target_folder(db, access_token, root_id, upload_day, current_user, client, chain)
                # Drive happily accepts uploads into a trashed folder - the file
                # just lands in the trash too. `trashed` is also true when any
                # parent is trashed, so checking the leaf covers the whole path.
                leaf = drive.get_file(access_token, folder_id, "id,trashed", missing_ok=True)
                if not leaf or leaf.get("trashed"):
                    raise drive.DriveError(404, "The upload folder was deleted or trashed in Drive.")
                upload_url = drive.start_resumable_session(
                    access_token, name=file_name, mime_type=mime_type, size_bytes=body.sizeBytes,
                    parent_id=folder_id, origin=origin,
                )
                break
            except drive.DriveError as exc:
                if exc.status_code != 404 or attempt:
                    raise
                # Someone deleted or trashed a folder in Drive by hand. Forget
                # only that folder (and what is cached beneath it): dropping the
                # whole chain would also forget the still-valid date folder and
                # make the next upload create a second one beside it.
                stale = _first_stale_folder(access_token, [root_id, *chain]) or (chain[-1] if chain else None)
                if stale == root_id:
                    drive.forget_folders(db, [root_id])
                    root_id = drive.create_folder(access_token, drive.ROOT_FOLDER_NAME, None)
                    connection = {**connection, "rootFolderId": root_id}
                    drive.save_connection(db, connection, connection.get("connectedByUserId"))
                    db.commit()
                elif stale:
                    drive.forget_folders(db, [stale])
    except Exception as exc:  # noqa: BLE001 - mapped to an HTTP error
        raise _drive_http_error(exc)

    record = AiLibraryUpload(
        user_id=current_user.id,
        client_id=client.id,
        user_name=current_user.name,
        client_name=client.name,
        upload_date=upload_day,
        file_name=file_name,
        mime_type=mime_type,
        size_bytes=body.sizeBytes,
        folder_path=" / ".join([
            connection.get("rootFolderName") or drive.ROOT_FOLDER_NAME,
            upload_day.isoformat(),
            drive.clean_folder_name(current_user.name, f"User {current_user.id}"),
            drive.clean_folder_name(client.name, f"Client {client.id}"),
        ]),
        drive_folder_id=folder_id,
        status="pending",
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {
        "success": True,
        "upload": record.to_dict(),
        "uploadUrl": upload_url,
        "chunkSizeBytes": CHUNK_SIZE_BYTES,
    }


@router.post("/uploads/{upload_id}/complete")
def complete_ai_library_upload(
    upload_id: int,
    body: UploadCompleteIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    record = _owned_upload(db, upload_id, current_user)
    if record.status == "complete":
        return {"success": True, "upload": record.to_dict()}

    try:
        access_token, _ = drive.connected_access_token(db)
        info = drive.get_file(access_token, body.driveFileId, "id,name,size,mimeType,webViewLink,parents,trashed",
                              missing_ok=True)
    except Exception as exc:  # noqa: BLE001 - mapped to an HTTP error
        raise _drive_http_error(exc)

    # The browser reports the id, so check it really is this upload's file
    # before the history points anyone at it.
    if (
        not info
        or info.get("trashed")
        or record.drive_folder_id not in (info.get("parents") or [])
        or info.get("name") != record.file_name
        or int(info.get("size") or 0) != int(record.size_bytes or 0)
    ):
        raise HTTPException(status_code=400, detail="That file was not found in this upload's Drive folder.")

    record.drive_file_id = info["id"]
    record.drive_web_link = info.get("webViewLink")
    record.status = "complete"
    record.error = None
    record.completed_at = datetime.utcnow()
    db.commit()
    return {"success": True, "upload": record.to_dict()}


@router.post("/uploads/{upload_id}/fail")
def fail_ai_library_upload(
    upload_id: int,
    body: UploadFailIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    record = _owned_upload(db, upload_id, current_user)
    if record.status == "pending":
        record.status = "failed"
        record.error = (body.error or "Upload did not finish.").strip()[:1000]
        db.commit()
    return {"success": True, "upload": record.to_dict()}


def _history_query(db: Session, current_user: User, *, start, end, client_id, user_id, status, q):
    query = db.query(AiLibraryUpload)
    # Everyone sees their own uploads; admins see everyone's.
    if not _is_admin(current_user):
        query = query.filter(AiLibraryUpload.user_id == current_user.id)
    elif user_id:
        query = query.filter(AiLibraryUpload.user_id == user_id)
    if start:
        query = query.filter(AiLibraryUpload.upload_date >= start)
    if end:
        query = query.filter(AiLibraryUpload.upload_date <= end)
    if client_id:
        query = query.filter(AiLibraryUpload.client_id == client_id)
    if status:
        query = query.filter(AiLibraryUpload.status == status)
    if q:
        query = query.filter(AiLibraryUpload.file_name.ilike(f"%{q.strip()}%"))
    return query


@router.get("/uploads")
def list_ai_library_uploads(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    clientId: Optional[int] = Query(None),
    userId: Optional[int] = Query(None),
    status: Optional[str] = Query(None, pattern="^(pending|complete|failed)$"),
    q: Optional[str] = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    pageSize: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    if start and end and start > end:
        raise HTTPException(status_code=400, detail='"From" date must be on or before the "To" date.')
    query = _history_query(db, current_user, start=start, end=end, client_id=clientId,
                           user_id=userId, status=status, q=q)
    total = query.count()
    rows = (
        query.order_by(AiLibraryUpload.created_at.desc(), AiLibraryUpload.id.desc())
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .all()
    )
    return {"success": True, "total": total, "page": page, "pageSize": pageSize,
            "items": [row.to_dict() for row in rows]}


@router.get("/uploads/options")
def ai_library_upload_options(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    """Users and clients that appear in the caller's visible history, for
    the history filters. Users are only listed for admins."""
    base = _history_query(db, current_user, start=None, end=None, client_id=None, user_id=None, status=None, q=None)
    clients = (
        base.with_entities(AiLibraryUpload.client_id, func.max(AiLibraryUpload.client_name))
        .filter(AiLibraryUpload.client_id.isnot(None))
        .group_by(AiLibraryUpload.client_id)
        .all()
    )
    users = []
    if _is_admin(current_user):
        users = (
            base.with_entities(AiLibraryUpload.user_id, func.max(AiLibraryUpload.user_name))
            .filter(AiLibraryUpload.user_id.isnot(None))
            .group_by(AiLibraryUpload.user_id)
            .all()
        )
    return {
        "success": True,
        "clients": sorted(({"id": cid, "name": name} for cid, name in clients), key=lambda c: (c["name"] or "").lower()),
        "users": sorted(({"id": uid, "name": name} for uid, name in users), key=lambda u: (u["name"] or "").lower()),
    }
