"""A Kling history scan must not become a second card under whoever viewed it.

On a shared Kling account every teammate's extension lists everyone's jobs and
reports them (source "asset_history_discovered"). Those reports must either
join the Generate-click card of the person who ran the job, or stay unclaimed -
never create a duplicate owned by the viewer.
"""

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import (  # noqa: E402
    Base,
    GenerationProject,
    GenerationRecord,
    GenerationRecoveryAudit,
    ITPortalTool,
    ITPortalToolUsageEvent,
    User,
)
from utils.generation_backfill import (  # noqa: E402
    _generation_tables_available,
    sync_generation_record_from_usage_event,
)

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)


# The sync uses session.begin_nested(). pysqlite's own transaction handling
# breaks SAVEPOINTs (a released savepoint can take the outer work with it), so
# use SQLAlchemy's documented recipe to make SQLite behave like Postgres here.
@event.listens_for(engine, "connect")
def _sqlite_autocommit_off(dbapi_connection, _record):
    dbapi_connection.isolation_level = None


@event.listens_for(engine, "begin")
def _sqlite_begin(connection):
    connection.exec_driver_sql("BEGIN")
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
TABLES = [
    User.__table__,
    ITPortalTool.__table__,
    ITPortalToolUsageEvent.__table__,
    GenerationProject.__table__,
    GenerationRecoveryAudit.__table__,
    GenerationRecord.__table__,
]

T0 = datetime(2026, 10, 18, 10, 0, 0)
VIDEO = "https://v15-kling.klingai.com/bs2/upload-ylab-stunt/abc/{}.mp4"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def fresh_session():
    Base.metadata.drop_all(bind=engine, tables=TABLES)
    Base.metadata.create_all(bind=engine, tables=TABLES)
    db = SessionLocal()
    # The sync's one-time table check inspects the engine; with this single
    # shared SQLite connection that resets (rolls back) the session's open
    # work, so run it now while there is nothing to lose.
    _generation_tables_available(db)
    return db


def setup(db):
    users = {}
    for name in ("devraj", "divya", "rhyna"):
        user = User(email=f"{name}@example.com", name=name, hashed_password="x", is_active=True,
                    is_deleted=False, is_admin=False, position="employee")
        db.add(user)
        users[name] = user
    tool = ITPortalTool(name="Kling", slug="kling", category="AI", website_url="https://kling.ai",
                        is_active=True, status="active")
    db.add(tool)
    db.commit()
    return users, tool


def report(db, tool, user, *, source, prompt, at, generation_id, metadata, client_id=None):
    event = ITPortalToolUsageEvent(
        tool_id=tool.id, user_id=user.id, event_type="generate_click" if source == "generate_intent" else "network_generation",
        event_date=date(2026, 10, 18), status="captured", prompt_text=prompt, generation_id=generation_id,
        source=source, created_at=at, metadata_json=metadata, linked_client_id=client_id,
        linked_client_name="RMW" if client_id else None,
    )
    db.add(event)
    db.flush()
    result = sync_generation_record_from_usage_event(db, event)
    db.commit()
    return result


def discovery_metadata(task_id, name):
    return {
        "klingTaskId": task_id,
        "mediaAssets": [{"url": VIDEO.format(name), "assetRole": "output", "assetType": "video"}],
    }


def cards(db):
    return db.query(GenerationRecord).order_by(GenerationRecord.id).all()


def test_scan_joins_the_clickers_card():
    with fresh_session() as db:
        users, tool = setup(db)
        prompt = "Use the exact reference frame. In smooth cinematic reverse slow motion, the same"
        report(db, tool, users["devraj"], source="generate_intent", prompt=prompt, at=T0,
               generation_id="kgen_1", metadata={"generationMode": "video", "generationId": "kgen_1"}, client_id=None)
        # Divya's browser lists Devraj's finished job a few minutes later.
        report(db, tool, users["divya"], source="asset_history_discovered", prompt="  " + prompt.upper() + " ",
               at=T0 + timedelta(seconds=20), generation_id="900000000001",
               metadata=discovery_metadata("900000000001", "a"))
        rows = cards(db)
        check(len(rows) == 1, f"expected one card, got {len(rows)}")
        card = rows[0]
        check(card.owner_user_id == users["devraj"].id, "the clicker must stay the owner")
        check(card.provider_task_id == "900000000001", "the card must pick up the Kling task id")
        check(card.canonical_asset_url == VIDEO.format("a"), "the card must pick up the video")
    print("ok  history scan joins the Generate-click card and keeps the clicker as owner")


def test_unmatched_scan_is_unclaimed_not_the_viewers():
    with fresh_session() as db:
        users, tool = setup(db)
        report(db, tool, users["divya"], source="asset_history_discovered", prompt="A job nobody here clicked",
               at=T0, generation_id="900000000002", metadata=discovery_metadata("900000000002", "b"))
        card = cards(db)[0]
        check(card.owner_user_id is None, "a scan must not make the viewer the owner")
        check(card.ownership_status == "unknown", f"expected unclaimed, got {card.ownership_status}")
        # A second viewer re-scanning the same job must not claim it either.
        report(db, tool, users["rhyna"], source="asset_history_discovered", prompt="A job nobody here clicked",
               at=T0, generation_id="900000000002", metadata=discovery_metadata("900000000002", "b"))
        rows = cards(db)
        check(len(rows) == 1 and rows[0].owner_user_id is None, "re-scan must not claim or duplicate")
    print("ok  an unmatched scan stays unclaimed and is not duplicated by re-scans")


def test_ambiguous_prompt_is_left_alone():
    with fresh_session() as db:
        users, tool = setup(db)
        prompt = "Shot 1 - Preparing the First Bite (Macro Close-Up)"
        for n, who in enumerate(("rhyna", "devraj")):
            report(db, tool, users[who], source="generate_intent", prompt=prompt, at=T0 + timedelta(seconds=n),
                   generation_id=f"kgen_{n + 10}", metadata={"generationMode": "video", "generationId": f"kgen_{n + 10}"})
        report(db, tool, users["divya"], source="asset_history_discovered", prompt=prompt,
               at=T0 + timedelta(seconds=30), generation_id="900000000003",
               metadata=discovery_metadata("900000000003", "c"))
        rows = cards(db)
        check(len(rows) == 3, f"two clicks + one unpaired scan expected, got {len(rows)}")
        check([r.owner_user_id for r in rows[:2]] == [users["rhyna"].id, users["devraj"].id], "click owners unchanged")
        check(rows[2].owner_user_id is None, "an ambiguous scan must stay unclaimed")
    print("ok  two clicks with the same prompt are never guessed between")


def test_scan_outside_the_window_is_not_paired():
    with fresh_session() as db:
        users, tool = setup(db)
        prompt = "animate this frame showing the jam over the road"
        report(db, tool, users["devraj"], source="generate_intent", prompt=prompt, at=T0,
               generation_id="kgen_20", metadata={"generationMode": "video", "generationId": "kgen_20"})
        report(db, tool, users["divya"], source="asset_history_discovered", prompt=prompt,
               at=T0 + timedelta(hours=3), generation_id="900000000004",
               metadata=discovery_metadata("900000000004", "d"))
        rows = cards(db)
        check(len(rows) == 2 and rows[1].owner_user_id is None, "a re-run hours later is a different job")
    print("ok  a same-prompt job hours later is not merged into an old click")


def main():
    test_scan_joins_the_clickers_card()
    test_unmatched_scan_is_unclaimed_not_the_viewers()
    test_ambiguous_prompt_is_left_alone()
    test_scan_outside_the_window_is_not_paired()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
