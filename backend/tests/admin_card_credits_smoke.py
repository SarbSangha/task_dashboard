"""Admin-entered card credits (provider capture cards + Kling): set, held
against later capture/repricing writes, reset to the latest captured value.

Run from backend/:  python tests/admin_card_credits_smoke.py

Calls the routers' endpoint functions directly on SQLite; the "capture
writes" are plain ORM writes + commits, the same thing normalization and
Flow's repricing sweep do.
"""

import os
import sys
from datetime import date, datetime
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationRecord, ITPortalToolUsageEvent, User  # noqa: E402
from routers import generation_records_router as K  # noqa: E402
from routers import provider_card_admin_router as R  # noqa: E402
from utils import r2_storage  # noqa: E402
from utils.admin_card_credits import CARD_CREDIT_COLUMNS  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
Base.metadata.create_all(bind=engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
r2_storage.is_configured = lambda: False
r2_storage.build_client = lambda: None


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


def rejected(call, status=400):
    try:
        call()
    except HTTPException as error:
        return error.status_code == status
    return False


def make_row(db, model, n, **values):
    for column in model.__table__.columns:
        if column.primary_key or column.name in values or column.foreign_keys:
            continue
        is_identity = column.name.endswith(("_id", "_uuid")) or column.name in {"identifier", "reference"}
        if is_identity and column.type.python_type is str:
            values[column.name] = f"{column.name}-{n}"
        elif not (column.nullable or column.default is not None or column.server_default is not None):
            t = column.type
            values[column.name] = (False if isinstance(t, Boolean) else n if isinstance(t, (Integer, Numeric, Float))
                                   else datetime.utcnow() if isinstance(t, DateTime) else date.today()
                                   if isinstance(t, Date) else f"{column.name}-{n}")
    row = model(**values)
    db.add(row)
    db.flush()
    return row


with SessionLocal() as db:
    admin = User(email="admin@example.com", name="Admin", hashed_password="x", is_admin=True, position="admin")
    db.add(admin)
    db.commit()
    admin_id = admin.id

for n, (provider, (model, _)) in enumerate(R.CARD_PROVIDERS.items(), start=1):
    column = CARD_CREDIT_COLUMNS[model.__tablename__]
    whole = model.__table__.c[column].type.python_type is int
    print(f"\n[{provider}] ({column}{', whole numbers' if whole else ''})")
    with SessionLocal() as db:
        record = make_row(db, GenerationRecord, n, provider=provider, credits_burned=10, metadata_json={})
        card = make_row(db, model, n, provider=provider, generation_record_id=record.id, **{column: 10})
        db.commit()
        card_id, record_id = card.id, record.id

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        check(rejected(lambda: R.set_generation_credits(provider, card_id, R.CreditsPayload(credits=-1), db=db, current_user=admin)),
              "negative credits rejected")
        if whole:
            check(rejected(lambda: R.set_generation_credits(provider, card_id, R.CreditsPayload(credits=2.5), db=db, current_user=admin)),
                  "fractional credits rejected for a whole-number column")
        data = R.set_generation_credits(provider, card_id, R.CreditsPayload(credits=25), db=db, current_user=admin)["data"]
        check(data["adminCredits"]["value"] == 25 and data["adminCredits"]["capturedValue"] == 10, "admin credits set, captured value kept")
        check(getattr(db.get(model, card_id), column) == 25, "written into the column the credit report reads")
        check(db.get(GenerationRecord, record_id).credits_burned == 25, "and into the cross-tool GenerationRecord")

    with SessionLocal() as db:  # capture / repricing writes a new number
        setattr(db.get(model, card_id), column, 40)
        db.get(GenerationRecord, record_id).credits_burned = 40
        db.commit()
    with SessionLocal() as db:
        card = db.get(model, card_id)
        check(getattr(card, column) == 25, "a later capture write is held off")
        check(card.admin_edit_json["credits"]["capturedValue"] == 40, "and remembered as the latest captured value")
        check(db.get(GenerationRecord, record_id).credits_burned == 25, "GenerationRecord copy held too")

    with SessionLocal() as db:
        admin = db.get(User, admin_id)
        R.set_generation_credits(provider, card_id, R.CreditsPayload(credits=30), db=db, current_user=admin)
        check(db.get(model, card_id).admin_edit_json["credits"]["capturedValue"] == 40, "re-editing keeps the captured value")
        data = R.reset_generation_credits(provider, card_id, db=db, current_user=admin)["data"]
        check(data["adminCredits"] is None and getattr(db.get(model, card_id), column) == 40, "reset restores the latest captured value")
        record = db.get(GenerationRecord, record_id)
        check(record.admin_credits is None and record.credits_burned == 40, "GenerationRecord released")
        actions = [e["action"] for e in db.get(model, card_id).admin_edit_json["edits"]]
        check(actions == ["credits_set", "credits_set", "credits_reset"], "credit edits audited")
        check(rejected(lambda: R.reset_generation_credits(provider, card_id, db=db, current_user=admin)), "reset without admin credits rejected")

    with SessionLocal() as db:  # released: capture writes go through again
        setattr(db.get(model, card_id), column, 55)
        db.commit()
        check(getattr(db.get(model, card_id), column) == 55, "after reset, capture writes apply normally")

print("\n[kling]")
with SessionLocal() as db:
    usage_event = make_row(db, ITPortalToolUsageEvent, 900, credits_burned=60.0, tool_id=1, user_id=admin_id)
    card = make_row(db, GenerationRecord, 900, provider="kling", credits_burned=60.0, metadata_json={},
                    source_usage_event_id=usage_event.id)
    db.commit()
    card_id, event_id = card.id, usage_event.id

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    check(rejected(lambda: K.set_generation_credits(card_id, K.GenerationCreditsPayload(credits=3001), db=db, current_user=admin)),
          "credits above the report's 3000 sanity cap rejected")
    data = K.set_generation_credits(card_id, K.GenerationCreditsPayload(credits=80), db=db, current_user=admin)["data"]
    check(data["creditsBurned"] == 80 and data["metadata"]["adminCredits"]["value"] == 80, "Kling card shows the admin credits")
    check(db.get(ITPortalToolUsageEvent, event_id).credits_burned == 80, "usage event (what the credit report reads) updated")

with SessionLocal() as db:  # Kling capture rewrites both
    db.get(ITPortalToolUsageEvent, event_id).credits_burned = 70.0
    db.get(GenerationRecord, card_id).credits_burned = 71.0
    db.commit()
with SessionLocal() as db:
    card = db.get(GenerationRecord, card_id)
    check(card.credits_burned == 80 and db.get(ITPortalToolUsageEvent, event_id).credits_burned == 80, "Kling capture writes held off")
    entry = card.metadata_json["adminCredits"]
    check(entry["capturedValue"] == 71.0 and entry["capturedEventValue"] == 70.0, "latest captured values remembered")

with SessionLocal() as db:
    admin = db.get(User, admin_id)
    data = K.reset_generation_credits(card_id, db=db, current_user=admin)["data"]
    check(data["creditsBurned"] == 71.0 and "adminCredits" not in data["metadata"], "Kling reset restores the captured card value")
    check(db.get(ITPortalToolUsageEvent, event_id).credits_burned == 70.0, "and the captured usage-event value")

print("\nALL ADMIN CARD CREDIT CHECKS PASSED")
