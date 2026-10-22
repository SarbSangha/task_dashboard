"""Kling card video repair: every card ends up on its own job's video.

Run from backend/:  python tests/repair_kling_card_videos_smoke.py

Shape seen in production (2026-10-22): someone runs four jobs back to back and
replays earlier outputs while they render. A replayed video was captured on a
later card (source mediasource_upload), and since a video sits on one card
only, the rightful card ended up on the next video in its list - every card a
few jobs off.
"""

import logging
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationRecord  # noqa: E402
from repair_kling_card_videos import run  # noqa: E402
from utils.generation_backfill import _canonical_asset_choices, _canonical_asset_key  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
Base.metadata.create_all(bind=engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def video(name):
    return f"https://v15-kling.klingai.com/bs2/upload-ylab-stunt/{name}-output.mp4"


def asset(name, source):
    return {"url": video(name), "assetType": "video", "assetRole": "output", "source": source}


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


check(
    _canonical_asset_choices({"mediaAssets": [asset("replayed", "mediasource_upload"), asset("own", "asset_history")]})[0] == video("own"),
    "a card's Kling history video outranks a replayed one",
)

start = datetime(2026, 10, 21, 10, 0, 0)
cards = {
    # job: (own history video, other captured assets, video it shows today)
    "A": ([asset("A", "asset_history")], None),
    "B": ([asset("B", "asset_history"), asset("A", "mediasource_upload")], "A"),
    "C": ([asset("C", "asset_history"), asset("B", "dom")], "B"),
    "D": ([asset("A", "mediasource_upload")], None),  # never got its history row
}
ids = {}
with SessionLocal() as db:
    for index, (job, (assets, showing)) in enumerate(cards.items()):
        record = GenerationRecord(
            provider="kling",
            provider_task_id=f"90000000000000{index}",
            canonical_asset_url=video(showing) if showing else None,
            canonical_asset_key=_canonical_asset_key(video(showing)) if showing else None,
            metadata_json={"mediaAssets": assets},
            created_at=start + timedelta(minutes=index),
            updated_at=start,
        )
        db.add(record)
        db.flush()
        ids[job] = record.id
    db.commit()

logger = logging.getLogger("repair_kling_card_videos_smoke")
with SessionLocal() as db:
    dry = run(db, apply=False, logger=logger)
with SessionLocal() as db:
    check(db.get(GenerationRecord, ids["B"]).canonical_asset_url == video("A"), "dry run changes nothing")
check(dry["cardsChanged"] == 3, f"dry run reports the three cards to fix (got {dry['cardsChanged']})")

with SessionLocal() as db:
    summary = run(db, apply=True, logger=logger)
with SessionLocal() as db:
    showing = {job: db.get(GenerationRecord, record_id).canonical_asset_url for job, record_id in ids.items()}
check(showing["A"] == video("A"), "A gets its own video back")
check(showing["B"] == video("B"), "B moves off A's replayed video onto its own")
check(showing["C"] == video("C"), "C moves off B's video onto its own")
check(showing["D"] is None, "D, holding only a replay of A's video, never takes it from A")
check(summary["clearedToNoPreview"] == 0 and summary["movedToKlingHistoryVideo"] == 3, "summary counts the moves")

with SessionLocal() as db:
    again = run(db, apply=False, logger=logger)
check(again["cardsChanged"] == 0, "a second run finds nothing left to fix")

print("\nALL KLING CARD VIDEO REPAIR CHECKS PASSED")
