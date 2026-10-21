"""Kling admin card edits: upload a video, replace it, remove it, delete the card.

Run from backend/:  python tests/kling_admin_card_edit_smoke.py

Calls routers/generation_records_router's endpoint functions directly on
SQLite, with R2 stubbed in memory.
"""

import io
import os
import sys
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationRecord, User  # noqa: E402
from routers import generation_records_router as R  # noqa: E402
from utils import r2_storage  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
Base.metadata.create_all(bind=engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

stored: dict[str, bytes] = {}
r2_storage.is_configured = lambda: True
r2_storage.put_fileobj = lambda key, fileobj, **_: stored.__setitem__(key, fileobj.read())
r2_storage.delete_object = lambda key, **_: stored.pop(key, None)
r2_storage.shared_client = lambda: None
r2_storage.generate_presigned_url = lambda key, **_: f"https://signed.example/{key}?sig=1"


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


def upload(db, generation_id, admin, name, data=b"video-bytes"):
    return R.upload_generation_video(generation_id, UploadFile(io.BytesIO(data), filename=name), db=db, current_user=admin)


with SessionLocal() as db:
    admin = User(email="admin@example.com", name="Admin", hashed_password="x", is_admin=True, position="admin")
    db.add(admin)
    db.flush()
    card = GenerationRecord(provider="kling", provider_task_id="900000000000001",
                            canonical_asset_url="https://kling.example/captured.mp4", metadata_json={})
    db.add(card)
    db.commit()
    admin_id, card_id = admin.id, card.id

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    data = upload(db, card_id, admin, "first.mp4")["data"]
    first_key = data["metadata"]["adminVideo"]["key"]
    check(data["canonicalAssetUrl"] == f"https://signed.example/{first_key}?sig=1", "uploaded video is what the card serves")
    check(data["capturedAssetUrl"] == "https://kling.example/captured.mp4", "captured URL is kept alongside")
    check(first_key.endswith(".mp4") and first_key in stored, "video stored in R2 under an .mp4 key")

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    data = upload(db, card_id, admin, "second.webm")["data"]
    second_key = data["metadata"]["adminVideo"]["key"]
    check(second_key != first_key and second_key in stored, "replacement stored under a new key")
    check(first_key not in stored, "replaced video removed from R2")
    check([e["action"] for e in data["metadata"]["adminEdits"]] == ["video_uploaded", "video_replaced"], "edits audited")

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    try:
        upload(db, card_id, admin, "notes.txt")
        raise AssertionError("non-video accepted")
    except HTTPException as error:
        check(error.status_code == 400, "non-video file rejected")

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    data = R.remove_generation_video(card_id, db=db, current_user=admin)["data"]
    check(data["canonicalAssetUrl"] == "https://kling.example/captured.mp4", "removing the upload restores the captured video")
    check(second_key not in stored and "adminVideo" not in data["metadata"], "removed upload deleted from R2")

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    R.delete_generation(card_id, db=db, current_user=admin)
    check(db.get(GenerationRecord, card_id).archived_at is not None, "deleted card is archived (kept for sync matching)")
    try:
        R.upload_generation_video(card_id, UploadFile(io.BytesIO(b"x"), filename="x.mp4"), db=db, current_user=admin)
        raise AssertionError("upload onto deleted card accepted")
    except HTTPException as error:
        check(error.status_code == 404, "deleted card can no longer be edited")

print("\nALL KLING ADMIN CARD EDIT CHECKS PASSED")
