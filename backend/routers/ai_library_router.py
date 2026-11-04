"""
AI Library API - drag-and-drop uploads into the connected Google Drive.

Visibility is the "ai_library" Section Access grant (Admin Queue -> Section
Access); admins always have it, and only admins can connect or disconnect
the Google account.

The file bytes never touch this server. For each file:

1. POST /uploads with the name, size, type and client. The server works out
   the folder - AI Library / <IST date> / <user> / <client> / <kind>, the
   kind folder (Images, Videos, Music, ...) from the file's type, so a mixed
   drop (or a whole folder) lands sorted - creating any missing level, asks
   Drive for a resumable upload session in it, records a "pending" row and
   returns the session URL.
2. The browser PUTs the file to that URL in chunks (see
   my-dashboard/src/utils/driveResumableUpload.js), resuming from Drive's
   own byte count if the connection drops.
3. POST /uploads/{id}/complete with the Drive file id Drive returned. The
   server looks the file up on Drive itself and only marks the row
   "complete" if it is in the expected folder with the expected size.
"""

import logging
import mimetypes
import os
import secrets
from datetime import date, datetime, timedelta
from typing import Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import AiLibraryUpload, GenerationClient, User
from services import google_drive_service as drive
from utils.credential_crypto import decrypt_secret
from utils.permissions import has_any_role, require_admin, require_ai_library_access
from utils.xlsx_compat import excel_safe

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


# A file's kind decides its folder under the client (history filters by it too).
KIND_FOLDERS = {"image": "Images", "video": "Videos", "audio": "Music", "document": "Documents",
                "archive": "Archives", "other": "Other"}
_VIDEO_EXTS = (".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp", ".mts", ".m2ts")
_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif", ".raw",
               ".cr2", ".nef", ".arw", ".dng", ".ico")
_AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wma", ".aif", ".aiff", ".mid", ".midi")


def file_mime_type(file_name: str, mime_type: Optional[str]) -> str:
    """The browser's type, else one guessed from the extension (browsers send
    none for some files, e.g. .mkv)."""
    given = (mime_type or "").strip().lower()
    if given and given != "application/octet-stream":
        return given
    return mimetypes.guess_type(file_name)[0] or given or "application/octet-stream"


def file_kind(file_name: str, mime_type: str) -> str:
    """One of FILE_KINDS, by the same rules as file_kind_expr (the history's)."""
    mime, name = (mime_type or "").lower(), file_name.lower()
    if mime.startswith("video/") or name.endswith(_VIDEO_EXTS):
        return "video"
    if mime.startswith("image/") or name.endswith(_IMAGE_EXTS):
        return "image"
    if mime.startswith("audio/") or name.endswith(_AUDIO_EXTS):
        return "audio"
    if name.endswith(_ARCHIVE_EXTS) or any(k in mime for k in ("zip", "rar", "7z")):
        return "archive"
    if (mime.startswith("text/") or mime == "application/pdf" or "officedocument" in mime or "msword" in mime
            or name.endswith(_DOC_EXTS)):
        return "document"
    return "other"


def _resolve_target_folder(db: Session, access_token: str, root_id: str, upload_day: date,
                           user: User, client: GenerationClient, kind: str, chain: list[str]) -> str:
    """Folder id for AI Library / <day> / <user> / <client> / <kind folder>.
    Appends each level's id to `chain` as it goes, so a caller that hits a
    stale cached folder knows which cache entries to drop."""
    parent = root_id
    for cache_key, name in (
        (upload_day.isoformat(), upload_day.isoformat()),
        (f"user:{user.id}", drive.clean_folder_name(user.name, f"User {user.id}")),
        (f"client:{client.id}", drive.clean_folder_name(client.name, f"Client {client.id}")),
        (f"kind:{kind}", KIND_FOLDERS[kind]),
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
    mime_type = file_mime_type(file_name, body.mimeType)
    kind = file_kind(file_name, mime_type)
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
                folder_id = _resolve_target_folder(db, access_token, root_id, upload_day, current_user, client, kind,
                                                   chain)
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
            KIND_FOLDERS[kind],
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


# ── History filters (list, options, Excel export) ───────────────────────────

FILE_KINDS = ("video", "image", "audio", "document", "archive", "other")
FILE_KIND_LABELS = {
    "video": "Video", "image": "Image", "audio": "Audio", "document": "Document",
    "archive": "Archive", "other": "Other",
}
STATUS_LABELS = {"complete": "Uploaded", "pending": "Incomplete", "failed": "Failed"}
SORTS = {"newest", "oldest", "largest", "smallest", "name"}
_ARCHIVE_EXTS = (".zip", ".rar", ".7z", ".tar", ".gz", ".tgz")
_DOC_EXTS = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".psd", ".ai", ".svg")


def file_kind_expr():
    """File type from MIME type, falling back to the extension (archives and
    design files often arrive as application/octet-stream)."""
    mime = func.lower(func.coalesce(AiLibraryUpload.mime_type, ""))
    name = func.lower(AiLibraryUpload.file_name)
    return case(
        (or_(mime.like("video/%"), *[name.like(f"%{ext}") for ext in _VIDEO_EXTS]), "video"),
        (or_(mime.like("image/%"), *[name.like(f"%{ext}") for ext in _IMAGE_EXTS]), "image"),
        (or_(mime.like("audio/%"), *[name.like(f"%{ext}") for ext in _AUDIO_EXTS]), "audio"),
        (or_(*[name.like(f"%{ext}") for ext in _ARCHIVE_EXTS], mime.like("%zip%"), mime.like("%rar%"),
             mime.like("%7z%")), "archive"),
        (or_(mime.like("text/%"), mime.like("application/pdf"), mime.like("%officedocument%"), mime.like("%msword%"),
             *[name.like(f"%{ext}") for ext in _DOC_EXTS]), "document"),
        else_="other",
    )


class HistoryFilters:
    """Every history filter as one dependency, shared by the list, the
    options counts and the Excel export so they always agree."""

    def __init__(
        self,
        start: Optional[date] = Query(None),
        end: Optional[date] = Query(None),
        clientId: Optional[int] = Query(None),
        userId: Optional[int] = Query(None),
        status: Optional[str] = Query(None, pattern="^(pending|complete|failed)$"),
        q: Optional[str] = Query(None, max_length=200),
        kind: Optional[str] = Query(None),
        minMb: Optional[float] = Query(None, ge=0),
        maxMb: Optional[float] = Query(None, ge=0),
    ):
        if start and end and start > end:
            raise HTTPException(status_code=400, detail='"From" date must be on or before the "To" date.')
        if kind and kind not in FILE_KINDS:
            raise HTTPException(status_code=400, detail=f"Unknown file type. Expected one of {list(FILE_KINDS)}")
        if minMb is not None and maxMb is not None and minMb > maxMb:
            raise HTTPException(status_code=400, detail="Minimum size is above the maximum size.")
        self.start, self.end, self.client_id, self.user_id = start, end, clientId, userId
        self.status, self.q, self.kind, self.min_mb, self.max_mb = status, (q or "").strip() or None, kind, minMb, maxMb

    def describe(self, db: Session) -> list[str]:
        fmt = "%d %b %Y"
        parts = []
        if self.start or self.end:
            parts.append(f"Dates: {self.start.strftime(fmt) if self.start else 'start'} – "
                         f"{self.end.strftime(fmt) if self.end else 'today'}")
        if self.client_id:
            name = db.query(func.max(AiLibraryUpload.client_name)).filter(AiLibraryUpload.client_id == self.client_id).scalar()
            parts.append(f"Client: {name or self.client_id}")
        if self.user_id:
            name = db.query(User.name).filter(User.id == self.user_id).scalar()
            parts.append(f"Uploaded by: {name or self.user_id}")
        if self.status:
            parts.append(f"Status: {STATUS_LABELS[self.status]}")
        if self.kind:
            parts.append(f"File type: {FILE_KIND_LABELS[self.kind]}")
        if self.min_mb is not None or self.max_mb is not None:
            parts.append(f"Size: {self.min_mb or 0:g} – {'any' if self.max_mb is None else f'{self.max_mb:g}'} MB")
        if self.q:
            parts.append(f'File name contains "{self.q}"')
        return parts


def _visible_uploads(db: Session, current_user: User):
    query = db.query(AiLibraryUpload)
    # Everyone sees their own uploads; admins see everyone's.
    if not _is_admin(current_user):
        query = query.filter(AiLibraryUpload.user_id == current_user.id)
    return query


def _apply_history_filters(query, f: HistoryFilters, current_user: User, *, skip: tuple = ()):
    if f.user_id and "user" not in skip and _is_admin(current_user):
        query = query.filter(AiLibraryUpload.user_id == f.user_id)
    if f.start and "date" not in skip:
        query = query.filter(AiLibraryUpload.upload_date >= f.start)
    if f.end and "date" not in skip:
        query = query.filter(AiLibraryUpload.upload_date <= f.end)
    if f.client_id and "client" not in skip:
        query = query.filter(AiLibraryUpload.client_id == f.client_id)
    if f.status and "status" not in skip:
        query = query.filter(AiLibraryUpload.status == f.status)
    if f.kind and "kind" not in skip:
        query = query.filter(file_kind_expr() == f.kind)
    if f.min_mb is not None and "size" not in skip:
        query = query.filter(AiLibraryUpload.size_bytes >= f.min_mb * 1024 * 1024)
    if f.max_mb is not None and "size" not in skip:
        query = query.filter(AiLibraryUpload.size_bytes <= f.max_mb * 1024 * 1024)
    if f.q and "q" not in skip:
        query = query.filter(AiLibraryUpload.file_name.ilike(f"%{f.q}%"))
    return query


def _history_query(db: Session, current_user: User, *, start, end, client_id, user_id, status, q):
    """Kept for callers that pass the original keyword set."""
    f = HistoryFilters.__new__(HistoryFilters)
    f.start, f.end, f.client_id, f.user_id = start, end, client_id, user_id
    f.status, f.q, f.kind, f.min_mb, f.max_mb = status, (q or "").strip() or None, None, None, None
    return _apply_history_filters(_visible_uploads(db, current_user), f, current_user)


def _order(query, sort: str):
    if sort == "oldest":
        return query.order_by(AiLibraryUpload.created_at.asc(), AiLibraryUpload.id.asc())
    if sort == "largest":
        return query.order_by(AiLibraryUpload.size_bytes.desc(), AiLibraryUpload.id.desc())
    if sort == "smallest":
        return query.order_by(AiLibraryUpload.size_bytes.asc(), AiLibraryUpload.id.asc())
    if sort == "name":
        return query.order_by(func.lower(AiLibraryUpload.file_name).asc(), AiLibraryUpload.id.asc())
    return query.order_by(AiLibraryUpload.created_at.desc(), AiLibraryUpload.id.desc())


def _summary(query) -> dict:
    count, total, clients, users = query.with_entities(
        func.count(AiLibraryUpload.id),
        func.coalesce(func.sum(AiLibraryUpload.size_bytes), 0),
        func.count(func.distinct(AiLibraryUpload.client_id)),
        func.count(func.distinct(AiLibraryUpload.user_id)),
    ).one()
    return {"count": int(count or 0), "totalBytes": int(total or 0), "clients": int(clients or 0), "uploaders": int(users or 0)}


@router.get("/uploads")
def list_ai_library_uploads(
    filters: HistoryFilters = Depends(),
    sort: str = Query("newest"),
    page: int = Query(1, ge=1),
    pageSize: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    if sort not in SORTS:
        raise HTTPException(status_code=400, detail=f"Unknown sort. Expected one of {sorted(SORTS)}")
    query = _apply_history_filters(_visible_uploads(db, current_user), filters, current_user)
    summary = _summary(query)
    rows = _order(query, sort).offset((page - 1) * pageSize).limit(pageSize).all()
    kinds = dict(
        db.query(AiLibraryUpload.id, file_kind_expr()).filter(AiLibraryUpload.id.in_([r.id for r in rows])).all()
    ) if rows else {}
    items = []
    for row in rows:
        item = row.to_dict()
        item["fileKind"] = kinds.get(row.id, "other")
        items.append(item)
    return {"success": True, "total": summary["count"], "summary": summary, "page": page, "pageSize": pageSize,
            "items": items}


@router.get("/uploads/options")
def ai_library_upload_options(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    """Values (with upload counts) for every history filter, from the
    caller's visible history. Users are only listed for admins."""
    base = _visible_uploads(db, current_user)
    clients = (
        base.with_entities(AiLibraryUpload.client_id, func.max(AiLibraryUpload.client_name), func.count(AiLibraryUpload.id))
        .filter(AiLibraryUpload.client_id.isnot(None))
        .group_by(AiLibraryUpload.client_id)
        .all()
    )
    users = []
    if _is_admin(current_user):
        users = (
            base.with_entities(AiLibraryUpload.user_id, func.max(AiLibraryUpload.user_name), func.count(AiLibraryUpload.id))
            .filter(AiLibraryUpload.user_id.isnot(None))
            .group_by(AiLibraryUpload.user_id)
            .all()
        )
    kind = file_kind_expr()
    kinds = dict(base.with_entities(kind, func.count(AiLibraryUpload.id)).group_by(kind).all())
    statuses = dict(base.with_entities(AiLibraryUpload.status, func.count(AiLibraryUpload.id)).group_by(AiLibraryUpload.status).all())
    first, last, largest = base.with_entities(
        func.min(AiLibraryUpload.upload_date), func.max(AiLibraryUpload.upload_date), func.max(AiLibraryUpload.size_bytes)
    ).one()
    return {
        "success": True,
        "clients": sorted(({"id": cid, "name": name, "count": int(n)} for cid, name, n in clients),
                          key=lambda c: (c["name"] or "").lower()),
        "users": sorted(({"id": uid, "name": name, "count": int(n)} for uid, name, n in users),
                        key=lambda u: (u["name"] or "").lower()),
        "kinds": [{"value": k, "label": FILE_KIND_LABELS[k], "count": int(kinds[k])} for k in FILE_KINDS if kinds.get(k)],
        "statuses": [{"value": k, "label": STATUS_LABELS[k], "count": int(statuses[k])} for k in STATUS_LABELS if statuses.get(k)],
        "dateRange": {"from": first.isoformat() if first else None, "to": last.isoformat() if last else None},
        "largestMb": round(float(largest or 0) / (1024 * 1024), 1),
        "summary": _summary(base),
    }


@router.get("/uploads/export")
def export_ai_library_uploads(
    filters: HistoryFilters = Depends(),
    sort: str = Query("newest"),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_ai_library_access),
):
    """Excel workbook of the (filtered) upload history: Summary with
    breakdowns, then every upload with a clickable Drive link."""
    import io
    from collections import defaultdict
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from routers.rmw_data_export_router import IST, TITLE_FONT, _style_header, _write_table

    if sort not in SORTS:
        sort = "newest"
    query = _apply_history_filters(_visible_uploads(db, current_user), filters, current_user)
    rows = _order(query, sort).limit(50_000).all()
    kinds = dict(
        query.with_entities(AiLibraryUpload.id, file_kind_expr()).all()
    )

    def mb(value):
        return round(float(value or 0) / (1024 * 1024), 2)

    def ist(value):
        return (value + IST_OFFSET) if value else None

    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    summary["A1"] = "AI Library — upload history"
    summary["A1"].font = TITLE_FONT
    meta = [
        ("Generated", datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST")),
        ("Generated by", f"{current_user.name} ({current_user.email})"),
        ("Visibility", "Everyone's uploads" if _is_admin(current_user) else "Your uploads"),
        ("Filters", "; ".join(filters.describe(db)) or "None (everything)"),
    ]
    for offset, (label, value) in enumerate(meta, start=3):
        summary.cell(row=offset, column=1, value=label).font = Font(bold=True)
        summary.cell(row=offset, column=2, value=value).alignment = Alignment(wrap_text=True, vertical="top")

    total_bytes = sum(int(r.size_bytes or 0) for r in rows)
    row_no = _write_table(summary, 4 + len(meta), "Totals", ["Measure", "Value"], [
        ["Uploads", len(rows)],
        ["Total size (MB)", mb(total_bytes)],
        ["Uploaded", sum(1 for r in rows if r.status == "complete")],
        ["Incomplete", sum(1 for r in rows if r.status == "pending")],
        ["Failed", sum(1 for r in rows if r.status == "failed")],
        ["Clients", len({r.client_id for r in rows if r.client_id})],
        ["Uploaders", len({r.user_id for r in rows if r.user_id})],
    ])

    def breakdown(title, key_fn, sort_by_key=False):
        nonlocal row_no
        buckets = defaultdict(lambda: [0, 0])
        for r in rows:
            b = buckets[key_fn(r)]
            b[0] += 1
            b[1] += int(r.size_bytes or 0)
        items = sorted(buckets.items(), key=(lambda kv: kv[0]) if sort_by_key else (lambda kv: (-kv[1][0], kv[0])))
        total = len(rows) or 1
        row_no = _write_table(summary, row_no, title, [title.split("By ")[-1].capitalize(), "Uploads", "Share", "Size (MB)"],
                              [[k, n, f"{n / total:.0%}", mb(size)] for k, (n, size) in items[:40]])

    breakdown("By client", lambda r: r.client_name or "No client")
    breakdown("By uploader", lambda r: r.user_name or "Unknown")
    breakdown("By month", lambda r: r.upload_date.strftime("%Y-%m (%b)") if r.upload_date else "Unknown", sort_by_key=True)
    breakdown("By file type", lambda r: FILE_KIND_LABELS.get(kinds.get(r.id, "other"), "Other"))
    breakdown("By status", lambda r: STATUS_LABELS.get(r.status, r.status))
    for letter, width in zip("ABCD", (30, 60, 12, 14)):
        summary.column_dimensions[letter].width = width

    ws = wb.create_sheet("Uploads")
    headers = ["Uploaded (IST)", "Upload day", "File", "File type", "Size (MB)", "Client", "Uploaded by",
               "Status", "Folder", "Drive link", "Error", "Record ID"]
    widths = [19, 12, 48, 11, 11, 20, 20, 12, 44, 16, 30, 10]
    ws.append(headers)
    _style_header(ws, 1, len(headers))
    for r in rows:
        ws.append([
            ist(r.completed_at or r.created_at), r.upload_date, r.file_name,
            FILE_KIND_LABELS.get(kinds.get(r.id, "other"), "Other"), mb(r.size_bytes), r.client_name,
            r.user_name, STATUS_LABELS.get(r.status, r.status), r.folder_path,
            "Open in Drive" if r.drive_web_link else None, r.error, r.id,
        ])
        if r.drive_web_link:
            cell = ws.cell(row=ws.max_row, column=10)
            cell.hyperlink = r.drive_web_link
            cell.style = "Hyperlink"
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=index).column_letter].width = width
    for cell in ws["A"][1:]:
        cell.number_format = "dd mmm yyyy, hh:mm"
    for cell in ws["B"][1:]:
        cell.number_format = "dd mmm yyyy"
    for cell in ws["E"][1:]:
        cell.number_format = "#,##0.00"
    ws.freeze_panes = "C2"
    if rows:
        ws.auto_filter.ref = f"A1:L{len(rows) + 1}"

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer = io.BytesIO(excel_safe(buffer.getvalue()))
    stamp = datetime.now(IST).strftime("%Y-%m-%d")
    filename = f"ai-library_uploads_{stamp}.xlsx"
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )
