"""AI Library: Google connect, folder tree, direct-upload sessions, history, access.

Run from backend/:  python tests/ai_library_smoke.py

Google is replaced by an in-memory fake (FakeGoogle below) patched over the
httpx calls in services/google_drive_service.py, so this needs no network
and no Google credentials.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
os.environ["GOOGLE_CLIENT_ID"] = "test-client-id"
os.environ["GOOGLE_CLIENT_SECRET"] = "test-client-secret"
os.environ["AI_LIBRARY_MAX_FILE_SIZE_GB"] = "1"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import routers.ai_library_router as R  # noqa: E402
from database_config import get_operational_db  # noqa: E402
from models_new import (AiLibraryDriveFolder, AiLibraryUpload, AppSetting, Base, GenerationClient,  # noqa: E402
                        User, UserFeatureAccess, UserRole)
from services import google_drive_service as drive  # noqa: E402
from utils.permissions import get_current_user  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[
    User.__table__, UserRole.__table__, UserFeatureAccess.__table__, GenerationClient.__table__,
    AppSetting.__table__, AiLibraryDriveFolder.__table__, AiLibraryUpload.__table__,
])


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


class FakeGoogle:
    """Just enough of OAuth + Drive v3 for the service's calls."""

    def __init__(self):
        self.items = {}          # id -> {name, parents, mimeType, size, trashed}
        self.sessions = {}       # upload url -> {name, parents, size, origin}
        self.next_id = 0
        self.refreshes = 0
        self.revoked = []
        self.grant_valid = True

    def _id(self, prefix):
        self.next_id += 1
        return f"{prefix}{self.next_id}"

    @staticmethod
    def _resp(status, json=None, headers=None):
        return httpx.Response(status, json=json, headers=headers or {}, request=httpx.Request("GET", "http://x"))

    def post(self, url, data=None, json=None, params=None, headers=None, timeout=None):
        if url == drive.TOKEN_URL:
            if data["grant_type"] == "authorization_code":
                if data["code"] != "good-code":
                    return self._resp(400, {"error": "invalid_grant", "error_description": "Bad code"})
                return self._resp(200, {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
            if not self.grant_valid:
                return self._resp(400, {"error": "invalid_grant"})
            self.refreshes += 1
            return self._resp(200, {"access_token": f"at-r{self.refreshes}", "expires_in": 3600})
        if url == drive.REVOKE_URL:
            self.revoked.append(data["token"])
            return self._resp(200, {})
        if url == drive.FILES_URL:
            parents = json.get("parents") or []
            if any(p not in self.items or self.items[p]["trashed"] for p in parents):
                return self._resp(404, {"error": {"message": "File not found"}})
            fid = self._id("fold")
            self.items[fid] = {"name": json["name"], "parents": parents, "mimeType": json["mimeType"],
                               "size": None, "trashed": False}
            return self._resp(200, {"id": fid})
        if url == drive.UPLOAD_URL:
            parent = json["parents"][0]
            if parent not in self.items:   # trashed parents are accepted, as on real Drive
                return self._resp(404, {"error": {"message": "File not found: " + parent}})
            session = f"https://upload.fake/session/{self._id('s')}"
            self.sessions[session] = {"name": json["name"], "parent": parent,
                                      "size": int(headers["X-Upload-Content-Length"]),
                                      "origin": headers.get("Origin"),
                                      "mime": headers["X-Upload-Content-Type"]}
            return self._resp(200, {}, {"location": session})
        raise AssertionError(f"unexpected POST {url}")

    def get(self, url, params=None, headers=None, timeout=None):
        if url == drive.ABOUT_URL:
            return self._resp(200, {"user": {"emailAddress": "library@example.com"}})
        fid = url.rsplit("/", 1)[-1]
        item = self.items.get(fid)
        if not item:
            return self._resp(404, {"error": {"message": "File not found"}})
        return self._resp(200, {"id": fid, **item, "size": str(item["size"]) if item["size"] is not None else None,
                                "trashed": self.is_trashed(fid),
                                "webViewLink": f"https://drive.google.com/file/d/{fid}/view"})

    def is_trashed(self, fid):
        """Like Drive: true when the item or any parent is trashed."""
        while fid:
            item = self.items.get(fid)
            if not item:
                return False
            if item["trashed"]:
                return True
            fid = (item["parents"] or [None])[0]
        return False

    def folders_named(self, name):
        return [k for k, v in self.items.items() if v["mimeType"] == drive.FOLDER_MIME and v["name"] == name]

    def delete(self, url, params=None, headers=None, timeout=None):
        self.items.pop(url.rsplit("/", 1)[-1], None)
        return self._resp(204)

    def finish_upload(self, session_url, size=None):
        """What the browser's last PUT does: Drive creates the file."""
        s = self.sessions[session_url]
        fid = self._id("file")
        self.items[fid] = {"name": s["name"], "parents": [s["parent"]], "mimeType": s["mime"],
                           "size": s["size"] if size is None else size, "trashed": False}
        return fid

    def path_of(self, fid):
        names = []
        while fid:
            item = self.items[fid]
            names.append(item["name"])
            fid = (item["parents"] or [None])[0]
        return " / ".join(reversed(names))


google = FakeGoogle()
drive.httpx = SimpleNamespace(post=google.post, get=google.get, delete=google.delete,
                              HTTPError=httpx.HTTPError, Timeout=httpx.Timeout, Response=httpx.Response)
drive._token_cache.clear()

IDS = {}
with SessionLocal() as db:
    for name, admin in (("Admin", True), ("Asha", False), ("Asha Twin", False), ("Nobody", False)):
        u = User(email=f"{name.lower().replace(' ', '')}@example.com", name=name, hashed_password="x",
                 is_active=True, is_admin=admin)
        db.add(u)
        db.flush()
        IDS[name] = u.id
    db.query(User).filter(User.id == IDS["Asha Twin"]).update({"name": "Asha"})   # same display name
    for name in ("Asha", "Asha Twin"):
        db.add(UserFeatureAccess(user_id=IDS[name], feature="ai_library"))
    for name, active in (("Acme / Corp", True), ("Globex", True), ("Gone Co", False)):
        c = GenerationClient(name=name, is_active=active)
        db.add(c)
        db.flush()
        IDS[name] = c.id
    db.commit()

app = FastAPI()
app.include_router(R.router)
who = {"id": IDS["Admin"]}


def _db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _user():
    with SessionLocal() as db:
        u = db.query(User).filter(User.id == who["id"]).one()
        u.feature_grants, u.role_assignments
        db.expunge(u)
        return u


app.dependency_overrides[get_operational_db] = _db
app.dependency_overrides[get_current_user] = _user
api = TestClient(app)
ORIGIN = {"Origin": "http://dash.test"}


def as_user(name):
    who["id"] = IDS[name]


# ── Access ────────────────────────────────────────────────────────────────
as_user("Nobody")
check(api.get("/api/ai-library/status").status_code == 403, "ungranted user cannot open the AI Library")
as_user("Asha")
status = api.get("/api/ai-library/status").json()
check(status["connected"] is False and status["configured"] is True and status["canManage"] is False,
      "granted user sees 'not connected' and cannot manage")
check(api.get("/api/ai-library/google/connect").status_code == 403, "non-admin cannot start the Google connect")
r = api.post("/api/ai-library/uploads", json={"fileName": "a.png", "sizeBytes": 10, "clientId": IDS["Globex"]})
check(r.status_code == 409 and "not connected" in r.json()["detail"], "upload before connecting -> 409 with a clear message")

# ── Connect ───────────────────────────────────────────────────────────────
as_user("Admin")
url = api.get("/api/ai-library/google/connect").json()["url"]
qs = parse_qs(urlparse(url).query)
check(qs["scope"] == ["https://www.googleapis.com/auth/drive.file"] and qs["access_type"] == ["offline"]
      and qs["prompt"] == ["consent"], "consent URL asks for drive.file, offline access, fresh consent")
check(qs["redirect_uri"][0].endswith("/api/ai-library/google/callback"), "redirect URI points at the callback")
state = qs["state"][0]

r = api.get("/api/ai-library/google/callback", params={"code": "good-code", "state": "tampered"}, follow_redirects=False)
check(r.status_code == 307 and "drive_error" in r.headers["location"], "tampered state is refused")
r = api.get("/api/ai-library/google/callback", params={"code": "bad-code", "state": state}, follow_redirects=False)
check("drive_error" in r.headers["location"] and "Bad+code" in r.headers["location"], "Google's error reaches the panel")
r = api.get("/api/ai-library/google/callback", params={"code": "good-code", "state": state}, follow_redirects=False)
check(r.headers["location"] == R._frontend_panel_url(drive="connected") and "ai-library?drive=connected" in r.headers["location"], "good code -> back to the panel")

with SessionLocal() as db:
    stored = db.query(AppSetting).filter(AppSetting.key == drive.SETTING_KEY).one().value_json
check("rt-1" not in str(stored) and stored["refreshTokenEnc"], "refresh token is stored encrypted, never in clear")
root_id = stored["rootFolderId"]
check(google.items[root_id]["name"] == "AI Library" and google.items[root_id]["parents"] == [],
      "app created its own 'AI Library' root folder")
status = api.get("/api/ai-library/status").json()
check(status["connected"] and status["accountEmail"] == "library@example.com", "status shows the connected account")

# ── Upload: session + folder tree ────────────────────────────────────────
as_user("Asha")
r = api.post("/api/ai-library/uploads", json={"fileName": "big.mov", "sizeBytes": 2 * 1024 ** 3, "clientId": IDS["Globex"]})
check(r.status_code == 413, "file over the size limit is refused before Drive is asked")
r = api.post("/api/ai-library/uploads", json={"fileName": "x.png", "sizeBytes": 1, "clientId": IDS["Gone Co"]})
check(r.status_code == 400, "inactive client is refused")

r = api.post("/api/ai-library/uploads", headers=ORIGIN,
             json={"fileName": "hero.png", "sizeBytes": 1234, "mimeType": "image/png", "clientId": IDS["Acme / Corp"]})
check(r.status_code == 200, "upload session created")
body = r.json()
session_url, up = body["uploadUrl"], body["upload"]
today = R._ist_today().isoformat()
check(google.sessions[session_url]["origin"] == "http://dash.test", "session opened for the browser's origin (CORS)")
no_origin = api.post("/api/ai-library/uploads",
                     json={"fileName": "o.png", "sizeBytes": 3, "clientId": IDS["Acme / Corp"]}).json()
check(google.sessions[no_origin["uploadUrl"]]["origin"] == R._frontend_origin(),
      "no Origin header -> session falls back to the dashboard's origin")
folder_id = google.sessions[session_url]["parent"]
check(google.path_of(folder_id) == f"AI Library / {today} / Asha / Acme - Corp",
      "folder is AI Library / date / user / client (slash in client name made safe)")
check(up["status"] == "pending" and up["folderPath"] == f"AI Library / {today} / Asha / Acme - Corp",
      "pending record carries the folder path")
check(body["chunkSizeBytes"] % (256 * 1024) == 0, "chunk size is a multiple of 256 KiB")

folders_before = len([i for i in google.items.values() if i["mimeType"] == drive.FOLDER_MIME])
r2 = api.post("/api/ai-library/uploads", headers=ORIGIN,
              json={"fileName": "second.png", "sizeBytes": 50, "clientId": IDS["Acme / Corp"]}).json()
folders_after = len([i for i in google.items.values() if i["mimeType"] == drive.FOLDER_MIME])
check(google.sessions[r2["uploadUrl"]]["parent"] == folder_id and folders_before == folders_after,
      "second upload reuses the cached folders - nothing new created")

as_user("Asha Twin")
twin = api.post("/api/ai-library/uploads", headers=ORIGIN,
                json={"fileName": "t.png", "sizeBytes": 5, "clientId": IDS["Acme / Corp"]}).json()
twin_folder = google.sessions[twin["uploadUrl"]]["parent"]
check(twin_folder != folder_id and google.path_of(twin_folder) == google.path_of(folder_id),
      "two users with the same name get separate folders (keyed by id)")

# ── Complete ──────────────────────────────────────────────────────────────
as_user("Asha")
file_id = google.finish_upload(session_url)
check(api.post(f"/api/ai-library/uploads/{up['id']}/complete", json={"driveFileId": twin_folder}).status_code == 400,
      "completing with a file that is not this upload's is refused")
short_id = google.finish_upload(r2["uploadUrl"], size=10)
check(api.post(f"/api/ai-library/uploads/{r2['upload']['id']}/complete", json={"driveFileId": short_id}).status_code == 400,
      "completing with a size mismatch is refused")
r = api.post(f"/api/ai-library/uploads/{up['id']}/complete", json={"driveFileId": file_id})
done = r.json()["upload"]
check(r.status_code == 200 and done["status"] == "complete" and done["driveLink"].endswith(f"/{file_id}/view"),
      "verified upload marked complete with its Drive link")
as_user("Asha Twin")
check(api.post(f"/api/ai-library/uploads/{up['id']}/complete", json={"driveFileId": file_id}).status_code == 404,
      "another user cannot complete someone else's upload")
check(api.post(f"/api/ai-library/uploads/{twin['upload']['id']}/fail", json={"error": "Cancelled"}).json()["upload"]["status"]
      == "failed", "owner can mark an upload failed")

# ── History ───────────────────────────────────────────────────────────────
mine = api.get("/api/ai-library/uploads").json()
check(mine["total"] == 1 and mine["items"][0]["userId"] == IDS["Asha Twin"], "non-admin history shows only own uploads")
check(api.get("/api/ai-library/uploads/options").json()["users"] == [], "non-admin gets no user filter list")
as_user("Admin")
everyone = api.get("/api/ai-library/uploads").json()
check(everyone["total"] == 4, "admin history shows everyone's uploads")
check(api.get("/api/ai-library/uploads", params={"status": "complete"}).json()["total"] == 1, "status filter")
check(api.get("/api/ai-library/uploads", params={"q": "HERO"}).json()["total"] == 1, "file name search is case-insensitive")
check(api.get("/api/ai-library/uploads", params={"userId": IDS["Asha"]}).json()["total"] == 3, "admin user filter")
check(api.get("/api/ai-library/uploads", params={"start": "2026-12-02", "end": "2026-12-01"}).status_code == 400,
      "reversed date range is refused")
opts = api.get("/api/ai-library/uploads/options").json()
check([c["name"] for c in opts["clients"]] == ["Acme / Corp"] and len(opts["users"]) == 2, "filter options")

# ── Folder deleted by hand in Drive ──────────────────────────────────────
as_user("Asha")
google.items.pop(folder_id)                      # someone deleted the client folder
r = api.post("/api/ai-library/uploads", headers=ORIGIN,
             json={"fileName": "again.png", "sizeBytes": 7, "clientId": IDS["Acme / Corp"]})
new_parent = google.sessions[r.json()["uploadUrl"]]["parent"]
check(r.status_code == 200 and new_parent != folder_id and google.path_of(new_parent).endswith("Asha / Acme - Corp"),
      "a hand-deleted folder is recreated instead of failing forever")
as_user("Asha Twin")
twin2 = api.post("/api/ai-library/uploads", headers=ORIGIN,
                 json={"fileName": "t2.png", "sizeBytes": 5, "clientId": IDS["Acme / Corp"]}).json()
check(google.sessions[twin2["uploadUrl"]]["parent"] == twin_folder and len(google.folders_named(today)) == 1,
      "after one folder was deleted, other users' folders are reused - no duplicate date folder")

as_user("Asha")
asha_client_folder = new_parent
asha_user_folder = google.items[asha_client_folder]["parents"][0]
google.items[asha_user_folder]["trashed"] = True  # trashed (not deleted) - its children look trashed too
r = api.post("/api/ai-library/uploads", headers=ORIGIN,
             json={"fileName": "fromtrash.png", "sizeBytes": 7, "clientId": IDS["Acme / Corp"]})
p = google.sessions[r.json()["uploadUrl"]]["parent"]
check(r.status_code == 200 and not google.is_trashed(p) and p != asha_client_folder
      and len(google.folders_named(today)) == 1,
      "a trashed folder is detected and rebuilt (uploads never land in the trash)")

google.items[root_id]["trashed"] = True          # ... or the whole root
r = api.post("/api/ai-library/uploads", headers=ORIGIN,
             json={"fileName": "again2.png", "sizeBytes": 7, "clientId": IDS["Globex"]})
check(r.status_code == 200 and google.path_of(google.sessions[r.json()["uploadUrl"]]["parent"]).startswith("AI Library / "),
      "a trashed root is replaced with a new one")

# ── Token refresh / revoke ───────────────────────────────────────────────
drive._token_cache.clear()
api.post("/api/ai-library/uploads", headers=ORIGIN, json={"fileName": "r.png", "sizeBytes": 1, "clientId": IDS["Globex"]})
api.post("/api/ai-library/uploads", headers=ORIGIN, json={"fileName": "r2.png", "sizeBytes": 1, "clientId": IDS["Globex"]})
check(google.refreshes == 1, "access token is refreshed once and then cached")
drive._token_cache.clear()
google.grant_valid = False
r = api.post("/api/ai-library/uploads", json={"fileName": "x.png", "sizeBytes": 1, "clientId": IDS["Globex"]})
check(r.status_code == 409 and "connect it again" in r.json()["detail"], "revoked grant -> 409 asking for a reconnect")
google.grant_valid = True

as_user("Admin")
r = api.post("/api/ai-library/google/disconnect").json()
check(r["connected"] is False and google.revoked == ["rt-1"], "disconnect revokes the token at Google")

print("\nALL AI LIBRARY CHECKS PASSED")
