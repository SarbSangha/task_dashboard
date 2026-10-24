"""Google Drive access for the AI Library (routers/ai_library_router.py).

One Google account is connected by an admin; every upload goes into that
account's Drive. Only its refresh token is stored (encrypted, in
app_settings under SETTING_KEY) - access tokens are minted from it on demand
and cached in memory per worker until shortly before they expire.

Scope is drive.file on purpose: the app can only see files and folders it
created itself, never the rest of the account's Drive. That is also why the
root "AI Library" folder is created by the app at connect time rather than
picked from existing folders - an existing folder would be invisible to it.

The file bytes never pass through here. start_resumable_session() asks Drive
for a one-time upload URL that the browser then PUTs the file to directly.
"""

import hashlib
import logging
import os
import threading
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import AiLibraryDriveFolder, AppSetting
from utils.credential_crypto import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)

SETTING_KEY = "ai_library_drive"
SCOPES = ("https://www.googleapis.com/auth/drive.file",)
ROOT_FOLDER_NAME = "AI Library"
FOLDER_MIME = "application/vnd.google-apps.folder"

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
FILES_URL = "https://www.googleapis.com/drive/v3/files"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
ABOUT_URL = "https://www.googleapis.com/drive/v3/about"

HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
# Refresh this long before Google's stated expiry, so a token is never used
# in the last seconds of its life by a request that is already in flight.
TOKEN_EXPIRY_MARGIN_SECONDS = 120


class DriveNotConfigured(RuntimeError):
    """GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set."""


class DriveNotConnected(RuntimeError):
    """No Google account is connected, or its grant was revoked."""


class DriveError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


# ─── Config ──────────────────────────────────────────────────────────────────

def client_credentials() -> tuple[str, str]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise DriveNotConfigured(
            "Google Drive is not configured on the server. Set GOOGLE_CLIENT_ID and "
            "GOOGLE_CLIENT_SECRET in backend/.env."
        )
    return client_id, client_secret


def is_configured() -> bool:
    try:
        client_credentials()
        return True
    except DriveNotConfigured:
        return False


def max_file_size_bytes() -> int:
    raw = (os.getenv("AI_LIBRARY_MAX_FILE_SIZE_GB") or "").strip()
    try:
        gb = float(raw) if raw else 10.0
    except ValueError:
        gb = 10.0
    return int(max(gb, 0.001) * 1024 ** 3)


# ─── Stored connection ───────────────────────────────────────────────────────

def _setting_row(db: Session) -> Optional[AppSetting]:
    return db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()


def load_connection(db: Session) -> dict:
    row = _setting_row(db)
    return dict(row.value_json or {}) if row else {}


def save_connection(db: Session, value: dict, user_id: Optional[int]) -> None:
    """Does not commit - the caller owns the transaction."""
    row = _setting_row(db)
    if row:
        row.value_json = value
        row.updated_by_user_id = user_id
    else:
        db.add(AppSetting(key=SETTING_KEY, value_json=value, updated_by_user_id=user_id))


def connection_status(db: Session) -> dict:
    value = load_connection(db)
    return {
        "configured": is_configured(),
        "connected": bool(value.get("refreshTokenEnc") and value.get("rootFolderId")),
        "accountEmail": value.get("accountEmail"),
        "rootFolderName": value.get("rootFolderName") or ROOT_FOLDER_NAME,
        "rootFolderLink": _folder_link(value.get("rootFolderId")),
        "connectedAt": value.get("connectedAt"),
    }


def _folder_link(folder_id: Optional[str]) -> Optional[str]:
    return f"https://drive.google.com/drive/folders/{folder_id}" if folder_id else None


# ─── OAuth ───────────────────────────────────────────────────────────────────

def build_auth_url(state: str, redirect_uri: str) -> str:
    client_id, _ = client_credentials()
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        # offline + consent: Google only issues a refresh token on the first
        # consent unless asked again, and a reconnect needs a fresh one.
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(code: str, redirect_uri: str) -> dict:
    client_id, client_secret = client_credentials()
    response = httpx.post(
        TOKEN_URL,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code != 200:
        raise DriveError(response.status_code, _google_error(response, "Google rejected the sign-in code."))
    tokens = response.json()
    if not tokens.get("refresh_token"):
        raise DriveError(400, "Google did not return a refresh token. Remove the app's access in your Google "
                              "account settings and connect again.")
    _remember_access_token(tokens["refresh_token"], tokens.get("access_token"), tokens.get("expires_in"))
    return tokens


def revoke(refresh_token: str) -> None:
    try:
        httpx.post(REVOKE_URL, data={"token": refresh_token}, timeout=HTTP_TIMEOUT)
    except httpx.HTTPError:
        logger.warning("ai_library: token revoke request failed; clearing the stored grant anyway")
    _forget_access_token(refresh_token)


# ─── Access tokens ───────────────────────────────────────────────────────────

_token_cache: dict[str, tuple[str, float]] = {}
_token_lock = threading.Lock()


def _cache_key(refresh_token: str) -> str:
    return hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()


def _remember_access_token(refresh_token: str, access_token: Optional[str], expires_in) -> None:
    if not access_token:
        return
    try:
        lifetime = float(expires_in or 3600)
    except (TypeError, ValueError):
        lifetime = 3600.0
    with _token_lock:
        _token_cache[_cache_key(refresh_token)] = (
            access_token,
            time.monotonic() + lifetime - TOKEN_EXPIRY_MARGIN_SECONDS,
        )


def _forget_access_token(refresh_token: str) -> None:
    with _token_lock:
        _token_cache.pop(_cache_key(refresh_token), None)


def access_token_for(refresh_token: str) -> str:
    key = _cache_key(refresh_token)
    with _token_lock:
        cached = _token_cache.get(key)
        if cached and cached[1] > time.monotonic():
            return cached[0]

    client_id, client_secret = client_credentials()
    response = httpx.post(
        TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code != 200:
        if _google_error_code(response) == "invalid_grant":
            _forget_access_token(refresh_token)
            raise DriveNotConnected(
                "The Google Drive connection has expired or was revoked. An admin needs to connect it again."
            )
        raise DriveError(response.status_code, _google_error(response, "Could not refresh the Google token."))

    tokens = response.json()
    _remember_access_token(refresh_token, tokens.get("access_token"), tokens.get("expires_in"))
    return tokens["access_token"]


def connected_access_token(db: Session) -> tuple[str, dict]:
    """(access token, stored connection) for the connected account."""
    value = load_connection(db)
    refresh_token = decrypt_secret(value.get("refreshTokenEnc")) if value.get("refreshTokenEnc") else None
    if not refresh_token or not value.get("rootFolderId"):
        raise DriveNotConnected("Google Drive is not connected yet. An admin needs to connect it first.")
    return access_token_for(refresh_token), value


def build_connection(tokens: dict, previous: dict, user_id: int, now_iso: str) -> dict:
    """The app_settings value for a freshly connected account.

    Keeps the previous root folder when the same account reconnects and the
    folder is still there, so a reconnect does not start a second
    "AI Library" tree beside the first.
    """
    access_token = tokens["access_token"]
    email = account_email(access_token)

    root_id = None
    if previous.get("rootFolderId") and previous.get("accountEmail") == email:
        existing = get_file(access_token, previous["rootFolderId"], "id,trashed", missing_ok=True)
        if existing and not existing.get("trashed"):
            root_id = existing["id"]
    if not root_id:
        root_id = create_folder(access_token, ROOT_FOLDER_NAME, None)

    return {
        "refreshTokenEnc": encrypt_secret(tokens["refresh_token"]),
        "accountEmail": email,
        "rootFolderId": root_id,
        "rootFolderName": ROOT_FOLDER_NAME,
        "connectedAt": now_iso,
        "connectedByUserId": user_id,
    }


# ─── Drive calls ─────────────────────────────────────────────────────────────

def _auth(access_token: str) -> dict:
    return {"Authorization": f"Bearer {access_token}"}


def _google_error_code(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    error = body.get("error")
    return error if isinstance(error, str) else ""


def _google_error(response: httpx.Response, fallback: str) -> str:
    try:
        body = response.json()
    except ValueError:
        return fallback
    error = body.get("error")
    if isinstance(error, dict):
        return error.get("message") or fallback
    return body.get("error_description") or (error if isinstance(error, str) else "") or fallback


def account_email(access_token: str) -> Optional[str]:
    response = httpx.get(ABOUT_URL, params={"fields": "user(emailAddress)"},
                         headers=_auth(access_token), timeout=HTTP_TIMEOUT)
    if response.status_code != 200:
        raise DriveError(response.status_code, _google_error(response, "Could not read the Google account."))
    return (response.json().get("user") or {}).get("emailAddress")


def get_file(access_token: str, file_id: str, fields: str, missing_ok: bool = False) -> Optional[dict]:
    response = httpx.get(f"{FILES_URL}/{file_id}", params={"fields": fields, "supportsAllDrives": "true"},
                         headers=_auth(access_token), timeout=HTTP_TIMEOUT)
    if response.status_code == 404 and missing_ok:
        return None
    if response.status_code != 200:
        raise DriveError(response.status_code, _google_error(response, "Could not read the file on Drive."))
    return response.json()


def create_folder(access_token: str, name: str, parent_id: Optional[str]) -> str:
    metadata = {"name": name, "mimeType": FOLDER_MIME}
    if parent_id:
        metadata["parents"] = [parent_id]
    response = httpx.post(FILES_URL, params={"fields": "id", "supportsAllDrives": "true"},
                          json=metadata, headers=_auth(access_token), timeout=HTTP_TIMEOUT)
    if response.status_code != 200:
        raise DriveError(response.status_code, _google_error(response, "Could not create a folder on Drive."))
    return response.json()["id"]


def delete_file(access_token: str, file_id: str) -> None:
    try:
        httpx.delete(f"{FILES_URL}/{file_id}", params={"supportsAllDrives": "true"},
                     headers=_auth(access_token), timeout=HTTP_TIMEOUT)
    except httpx.HTTPError:
        logger.warning("ai_library: could not delete duplicate Drive folder %s", file_id)


def start_resumable_session(
    access_token: str,
    *,
    name: str,
    mime_type: str,
    size_bytes: int,
    parent_id: str,
    origin: Optional[str],
) -> str:
    """Open a resumable upload session and return its one-time upload URL.

    The Origin header matters: Drive only answers the browser's
    cross-origin PUTs to the session URL when the session was opened on
    behalf of that same origin. Without it the upload fails in the browser
    with a CORS error even though this call succeeded.
    """
    headers = {
        **_auth(access_token),
        "X-Upload-Content-Type": mime_type,
        "X-Upload-Content-Length": str(size_bytes),
    }
    if origin:
        headers["Origin"] = origin
    response = httpx.post(
        UPLOAD_URL,
        params={
            "uploadType": "resumable",
            "supportsAllDrives": "true",
            "fields": "id,name,size,mimeType,webViewLink,parents",
        },
        json={"name": name, "parents": [parent_id]},
        headers=headers,
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code != 200 or not response.headers.get("location"):
        raise DriveError(response.status_code, _google_error(response, "Could not start the upload on Drive."))
    return response.headers["location"]


# ─── Folder tree ─────────────────────────────────────────────────────────────

def clean_folder_name(name: str, fallback: str) -> str:
    # Drive allows slashes in names, but "2026-10-23 / A/B" then reads as an
    # extra level in every breadcrumb, so they are swapped out.
    value = " ".join(str(name or "").replace("/", "-").replace("\\", "-").split())
    return (value or fallback)[:200]


def ensure_folder(db: Session, access_token: str, parent_id: str, cache_key: str, name: str) -> str:
    """The Drive id of the child folder `cache_key` under `parent_id`,
    creating and caching it the first time.

    Two uploads can race to create the same folder. The unique constraint
    picks one winner; the loser deletes the Drive folder it just made and
    uses the winner's, so the tree never ends up with twin folders.
    """
    cached = (
        db.query(AiLibraryDriveFolder)
        .filter(AiLibraryDriveFolder.parent_drive_id == parent_id, AiLibraryDriveFolder.cache_key == cache_key)
        .first()
    )
    if cached:
        return cached.drive_folder_id

    folder_id = create_folder(access_token, name, parent_id)
    try:
        db.add(AiLibraryDriveFolder(parent_drive_id=parent_id, cache_key=cache_key,
                                    name=name, drive_folder_id=folder_id))
        db.commit()
        return folder_id
    except IntegrityError:
        db.rollback()
        winner = (
            db.query(AiLibraryDriveFolder)
            .filter(AiLibraryDriveFolder.parent_drive_id == parent_id, AiLibraryDriveFolder.cache_key == cache_key)
            .first()
        )
        if not winner:
            raise
        delete_file(access_token, folder_id)
        return winner.drive_folder_id


def forget_folders(db: Session, drive_folder_ids: list[str]) -> None:
    """Drop cached folders (and everything cached beneath them) after Drive
    reported one missing - someone deleted it by hand - so the next attempt
    recreates the path instead of failing on the stale id forever."""
    pending = [fid for fid in drive_folder_ids if fid]
    while pending:
        rows = db.query(AiLibraryDriveFolder).filter(
            (AiLibraryDriveFolder.drive_folder_id.in_(pending))
            | (AiLibraryDriveFolder.parent_drive_id.in_(pending))
        ).all()
        pending = [row.drive_folder_id for row in rows if row.parent_drive_id in pending]
        for row in rows:
            db.delete(row)
    db.commit()
