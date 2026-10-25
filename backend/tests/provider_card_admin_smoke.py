"""Provider capture-card admin edits (Freepik, Higgsfield, HeyGen, Suno,
ElevenLabs, Envato, Flow): upload media, replace it, reject the wrong kind,
remove it, delete the card - and the deleted card drops out of the
provider's own detail lookup.

Run from backend/:  python tests/provider_card_admin_smoke.py

Calls routers/provider_card_admin_router's endpoint functions directly on
SQLite, with R2 stubbed in memory.
"""

import io
import os
import sys
from datetime import date, datetime
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationRecord, User  # noqa: E402
from providers.elevenlabs import router as elevenlabs_router  # noqa: E402
from providers.envato import queries as envato_queries  # noqa: E402
from providers.flow import router as flow_router  # noqa: E402
from providers.freepik import queries as freepik_queries  # noqa: E402
from providers.heygen import queries as heygen_queries  # noqa: E402
from providers.higgsfield import queries as higgsfield_queries  # noqa: E402
from providers.suno import router as suno_router  # noqa: E402
from routers import provider_card_admin_router as R  # noqa: E402
from utils import r2_storage  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
Base.metadata.create_all(bind=engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

stored: dict[str, bytes] = {}
r2_storage.is_configured = lambda: True
r2_storage.put_fileobj = lambda key, fileobj, **_: stored.__setitem__(key, fileobj.read())
r2_storage.delete_object = lambda key, **_: stored.pop(key, None)
r2_storage.shared_client = lambda: None
r2_storage.build_client = lambda: None
r2_storage.generate_presigned_url = lambda key, **_: f"https://signed.example/{key}?sig=1"

# provider -> (an accepted file, a rejected file, provider's own detail lookup)
CASES = {
    "freepik": ("a.png", "a.mp3", lambda db, i, _: freepik_queries.get_generation(db, i)),
    "higgsfield": ("a.mp4", "a.wav", lambda db, i, _: higgsfield_queries.get_generation(db, i)),
    "heygen": ("a.mov", "a.png", lambda db, i, _: heygen_queries.get_generation(db, i)),
    "suno": ("a.mp3", "a.mp4", lambda db, i, admin: suno_router.get_generation(i, db=db, current_user=admin)),
    "elevenlabs": ("a.wav", "a.jpg", lambda db, i, admin: elevenlabs_router.get_generation(i, db=db, current_user=admin)),
    "envato": ("a.m4a", "a.txt", lambda db, i, _: envato_queries.get_generation(db, i)),
    "flow": ("a.webp", "a.ogg", lambda db, i, admin: flow_router.get_generation(i, db=db, current_user=admin)),
}


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


def required_value(column, n):
    """Placeholder for a NOT NULL column with no default, by type."""
    if isinstance(column.type, Boolean):
        return False
    if isinstance(column.type, (Integer, Numeric, Float)):
        return n
    if isinstance(column.type, DateTime):
        return datetime.utcnow()
    if isinstance(column.type, Date):
        return date.today()
    if column.name == "provider":
        return None  # set per model below
    return f"{column.name}-{n}"


def make_card(db, provider, model, n):
    values = {}
    for column in model.__table__.columns:
        if column.primary_key:
            continue
        # Each table CHECKs that at least one provider identity is present.
        is_identity = (
            column.name.endswith(("_id", "_uuid")) or column.name in {"identifier", "reference"}
        ) and not column.foreign_keys
        if is_identity and column.type.python_type is str:
            values[column.name] = f"{column.name}-{n}"
            continue
        if column.nullable or column.default is not None or column.server_default is not None:
            continue
        values[column.name] = required_value(column, n)
    values["provider"] = provider
    # The cross-tool projection Generation Projects/Collections list.
    record = GenerationRecord(provider=provider, provider_task_id=f"{provider}-task-{n}", metadata_json={})
    db.add(record)
    db.flush()
    values["generation_record_id"] = record.id
    card = model(**values)
    db.add(card)
    db.commit()
    return card.id


def upload(db, provider, card_id, admin, name):
    return R.upload_generation_media(provider, card_id, UploadFile(io.BytesIO(b"media-bytes"), filename=name), db=db, current_user=admin)


def lookup_hidden(lookup, db, card_id, admin):
    try:
        return lookup(db, card_id, admin) is None
    except HTTPException as error:
        return error.status_code == 404


with SessionLocal() as db:
    admin = User(email="admin@example.com", name="Admin", hashed_password="x", is_admin=True, position="admin")
    db.add(admin)
    db.commit()
    admin_id = admin.id

for n, (provider, (good_file, bad_file, lookup)) in enumerate(CASES.items(), start=1):
    model, _ = R.CARD_PROVIDERS[provider]
    print(f"\n[{provider}]")
    with SessionLocal() as db:
        card_id = make_card(db, provider, model, n)

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        data = upload(db, provider, card_id, admin, good_file)["data"]
        first_key = data["adminMedia"] and db.get(model, card_id).admin_edit_json["media"]["key"]
        check(data["adminMedia"]["url"] == f"https://signed.example/{first_key}?sig=1", "uploaded media is served on the card")
        check(first_key.startswith(f"{provider}-admin-uploads/") and first_key in stored, "media stored in R2 under the provider prefix")

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        upload(db, provider, card_id, admin, good_file)
        card = db.get(model, card_id)
        second_key = card.admin_edit_json["media"]["key"]
        check(second_key != first_key and second_key in stored and first_key not in stored, "replacement swaps the R2 object")
        check([e["action"] for e in card.admin_edit_json["edits"]] == ["media_uploaded", "media_replaced"], "edits audited")

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        try:
            upload(db, provider, card_id, admin, bad_file)
            raise AssertionError(f"{bad_file} accepted")
        except HTTPException as error:
            check(error.status_code == 400, f"{bad_file} rejected for {provider}")

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        data = R.remove_generation_media(provider, card_id, db=db, current_user=admin)["data"]
        check(data["adminMedia"] is None and second_key not in stored, "removing the upload restores the captured media")

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        check(not lookup_hidden(lookup, db, card_id, admin), "card visible before delete")
        R.delete_generation(provider, card_id, db=db, current_user=admin)
        card = db.get(model, card_id)
        check(card.archived_at is not None, "deleted card is archived (kept for sync matching)")
        check(db.get(GenerationRecord, card.generation_record_id).archived_at is not None,
              "its GenerationRecord is archived too (leaves Projects/Collections, like Kling)")
        check(lookup_hidden(lookup, db, card_id, admin), "deleted card hidden from the provider's detail lookup")
        try:
            upload(db, provider, card_id, admin, good_file)
            raise AssertionError("upload onto deleted card accepted")
        except HTTPException as error:
            check(error.status_code == 404, "deleted card can no longer be edited")

print("\n[failure paths]")
with SessionLocal() as db:
    card_id = make_card(db, "freepik", R.CARD_PROVIDERS["freepik"][0], 99)

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    keys_before = set(stored)
    real_commit = db.commit

    def failing_commit():
        db.commit = real_commit
        raise RuntimeError("simulated commit failure")

    db.commit = failing_commit
    try:
        upload(db, "freepik", card_id, admin, "a.png")
        raise AssertionError("commit failure swallowed")
    except RuntimeError:
        pass
    check(set(stored) == keys_before, "upload whose save fails leaves no orphaned R2 object")
    check((db.get(R.CARD_PROVIDERS["freepik"][0], card_id).admin_edit_json or {}).get("media") is None, "and the card is unchanged")

with SessionLocal() as db:
    locked = []
    real_with_for_update = type(db.query(GenerationRecord)).with_for_update

    def spy(self, *args, **kwargs):
        locked.append(True)
        return real_with_for_update(self, *args, **kwargs)

    type(db.query(GenerationRecord)).with_for_update = spy
    try:
        upload(db, "freepik", card_id, db.get(User, admin_id), "a.png")
    finally:
        type(db.query(GenerationRecord)).with_for_update = real_with_for_update
    check(bool(locked), "upload re-reads the card under a row lock (concurrent replaces can't orphan a file)")

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    try:
        R.delete_generation("kling", 1, db=db, current_user=admin)
        raise AssertionError("unknown provider accepted")
    except HTTPException as error:
        check(error.status_code == 404, "unknown provider rejected")

print("\nALL PROVIDER CARD ADMIN CHECKS PASSED")
