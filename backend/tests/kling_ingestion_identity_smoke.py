"""Kling ingestion: one job, one event, one card - owned by whoever clicked.

Run from backend/:  python tests/kling_ingestion_identity_smoke.py

Drives routers/it_tools_router.report_extension_usage_event (the endpoint the
extension posts to), with login/permission helpers stubbed, on SQLite. Each
case is a shape seen in production on a shared Kling account (2026-10-15..21):

  * A history scan that knows only the job's WORK id (Kling gives each job a
    task id and a work id) joins the click's event keyed by the TASK id -
    it used to become a second event/card under the viewer, credits counted
    twice (178 of 346 history-only cards).
  * That merge keeps the clicker as owner, the click's client, the click's
    source (not relabelled history-only) and its task id (not wiped by the
    scan's empty klingTaskId); the scan's video lands on the click's card.
  * A history scan that reaches the server BEFORE the clicker's report: the
    click takes ownership and the card is created under the clicker.
  * A history scan never moves ownership off an admin-owned event (only a
    real click does).
"""

import os
import time
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import (  # noqa: E402
    Base, GenerationProject, GenerationRecord, GenerationRecoveryAudit, ITPortalTool, ITPortalToolCredential,
    ITPortalToolUsageEvent, User,
)
from routers import it_tools_router as R  # noqa: E402
from utils.generation_backfill import _generation_tables_available  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)


@event.listens_for(engine, "connect")
def _sqlite_autocommit_off(dbapi_connection, _record):
    dbapi_connection.isolation_level = None


@event.listens_for(engine, "begin")
def _sqlite_begin(connection):
    connection.exec_driver_sql("BEGIN")


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
TABLES = [User.__table__, ITPortalTool.__table__, ITPortalToolCredential.__table__, ITPortalToolUsageEvent.__table__,
          GenerationProject.__table__, GenerationRecoveryAudit.__table__, GenerationRecord.__table__]
VIDEO = "https://v15-kling.klingai.com/bs2/upload-ylab-stunt/{}-output.mp4"
CLIENT = SimpleNamespace(id=7, name="VVIP YAMUNA")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


# ---- stub the request plumbing: who is posting, which tool/account ----
STATE = {"user": None, "tool": None, "credential": None}
R._find_extension_tool = lambda db, payload: STATE["tool"]
R._tool_uses_extension_autofill = lambda tool, **_: True
R._resolve_usage_event_actor = lambda **_: STATE["user"]
R.enforce_workplace_tools_access = lambda user, db: None
R._resolve_usage_event_credential = lambda db, **_: STATE["credential"]
R.validate_client_for_generation = lambda db, client_id: CLIENT if client_id == CLIENT.id else None
R._add_audit = lambda *a, **k: None


def post(db, user, **fields):
    STATE["user"] = user
    payload = R.ExtensionUsageEventPayload(tool_slug="kling", hostname="app.klingai.com", **fields)
    R.report_extension_usage_event(payload, request=None, db=db)
    db.commit()


def click(task_id, work_id, prompt, **extra):
    """What the clicker's tab posts once it has the job's ids."""
    return dict(event_type="generate_click", status="submitted", source="dom_balance_fallback", prompt_text=prompt,
                generation_id=task_id, external_event_id=f"kgen_{task_id}", client_id=CLIENT.id, event_date="2026-10-19",
                metadata={"klingTaskId": task_id, "taskId": task_id, "workId": work_id, "creativeId": work_id,
                          "discoveredTaskIds": [task_id, work_id], "ownershipStrategy": "kling_task_id",
                          "mediaAssets": [{"url": "https://s21-kling.klingai.com/kimg/upl:64x64.webp",
                                           "assetRole": "input", "assetType": "image"}]}, **extra)


def history(identity, prompt, *, task_id="", work_id="", video=None, at_ms=None):
    """What another tab's history scan posts (buildAssetHistoryDiscoverySnapshot)."""
    at_ms = at_ms or int(time.time() * 1000)  # Kling's createTime: seconds after the click
    return dict(event_type="network_generation", status="settled", source="asset_history_discovered",
                prompt_text=prompt, generation_id=identity, external_event_id=f"asset_discovery_{identity}_{at_ms}",
                fingerprint=f"asset_discovery_{identity}_{at_ms}", event_date="2026-10-19",
                metadata={"occurredAt": at_ms, "stage": "discovered", "source": "asset_history_discovered",
                          "klingTaskId": task_id, "discoveredTaskIds": [identity],
                          "assetHistory": {"taskId": task_id, "workId": work_id},
                          "mediaAssets": ([{"url": VIDEO.format(video), "assetRole": "output", "assetType": "video"}]
                                          if video else []), "historicalDiscovery": True})


def fresh():
    Base.metadata.drop_all(bind=engine, tables=TABLES)
    Base.metadata.create_all(bind=engine, tables=TABLES)
    db = SessionLocal()
    _generation_tables_available(db)
    users = {}
    for name, admin in (("kushi", False), ("divya", False), ("nikhil", False), ("admin", True)):
        users[name] = User(email=f"{name}@x.com", name=name, hashed_password="x", is_active=True, is_deleted=False,
                           is_admin=admin, position="admin" if admin else "employee")
        db.add(users[name])
    tool = ITPortalTool(name="Kling", slug="kling", category="AI", website_url="https://kling.ai", is_active=True,
                        status="active")
    db.add(tool)
    db.flush()
    credential = ITPortalToolCredential(tool_id=tool.id, scope="company", is_active=True)
    db.add(credential)
    db.commit()
    STATE.update(tool=tool, credential=credential)
    return db, users


def events(db):
    return db.query(ITPortalToolUsageEvent).order_by(ITPortalToolUsageEvent.id).all()


def cards(db):
    return db.query(GenerationRecord).filter(GenerationRecord.archived_at.is_(None)).order_by(GenerationRecord.id).all()


# 1. History scan with only the WORK id joins the click keyed by the TASK id.
db, u = fresh()
prompt = "animate this frame, the camera zooms in slowly on the family"
post(db, u["kushi"], **click("324378457520608", "324378457524638", prompt))
post(db, u["divya"], **history("324378457524638", prompt, work_id="324378457524638", video="familyclip"))
ev, cs = events(db), cards(db)
check(len(ev) == 1 and ev[0].metadata_json["lastDedupeDecision"]["reason"] == "kling_linked_id_same_credential",
      "work-id-only history scan merges into the click's event (no second event)")
check(len(cs) == 1, "one job, one card")
check(ev[0].user_id == u["kushi"].id and cs[0].owner_user_id == u["kushi"].id,
      "the viewer's scan leaves the clicker as owner")
check(cs[0].linked_client_name == CLIENT.name, "the click's client stays on the card")
check(ev[0].source == "dom_balance_fallback", "the event is not relabelled history-only")
check(ev[0].metadata_json.get("klingTaskId") == "324378457520608",
      "the scan's empty klingTaskId does not wipe the click's task id")
check((cs[0].canonical_asset_url or "").endswith("familyclip-output.mp4"), "the scan's video lands on the click's card")
db.close()

# 2. History scan arrives BEFORE the clicker's own report.
db, u = fresh()
prompt = "Create a photorealistic luxury automotive commercial in vertical 9:16"
post(db, u["divya"], **history("324541091311101", prompt, task_id="324541091311101", work_id="324541091304135",
                               video="carclip"))
check(not cards(db), "a history scan alone creates no card (nobody can be credited)")
post(db, u["nikhil"], **click("324541091311101", "324541091304135", prompt))
ev, cs = events(db), cards(db)
check(len(ev) == 1 and ev[0].user_id == u["nikhil"].id
      and ev[0].metadata_json.get("reassignedReason") == "history_scan_owner_replaced_by_click",
      "the click takes ownership of the event the scan created")
check(len(cs) == 1 and cs[0].owner_user_id == u["nikhil"].id and cs[0].linked_client_name == CLIENT.name
      and (cs[0].canonical_asset_url or "").endswith("carclip-output.mp4"),
      "card created under the clicker, with the client and the scan's video")
db.close()

# 3. A history scan never moves ownership off an admin-owned event.
db, u = fresh()
prompt = "a horse running on the beach at sunset"
post(db, u["admin"], **click("324500000000001", "324500000000009", prompt))
post(db, u["divya"], **history("324500000000001", prompt, task_id="324500000000001", video="horse"))
check(events(db)[0].user_id == u["admin"].id, "the admin's own click stays the admin's after Divya's scan")
db.close()

print("\nALL KLING INGESTION IDENTITY CHECKS PASSED")
