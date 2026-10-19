"""A Flow video must be kept (and mirrored) as the clip, not its poster frame.

Flow resolves two URLs under one media id for a video generation:
flow-content.google/image/<id> (the poster) and flow-content.google/video/<id>
(the clip). Only the poster used to be kept, so every Flow video was mirrored
as a still JPG.
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationRecord  # noqa: E402
from providers.flow.constants import flow_media_kind  # noqa: E402
from providers.flow.models import FlowGeneration  # noqa: E402
from providers.flow.normalization import _normalize_media_url_event  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[FlowGeneration.__table__, GenerationRecord.__table__])

MEDIA_ID = "5469bf9c-2eb0-4e2e-ab2e-a0677e3ab238"
POSTER = f"https://flow-content.google/image/{MEDIA_ID}?Expires=1&KeyName=k&Signature=s"
CLIP = f"https://flow-content.google/video/{MEDIA_ID}?Expires=2&KeyName=k&Signature=s"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def media_event(url, event_id=1):
    return SimpleNamespace(id=event_id, payload_json={"mediaId": MEDIA_ID, "url": url})


def fresh_generation(db, **fields):
    db.query(FlowGeneration).delete()
    generation = FlowGeneration(provider="flow", provider_creation_id=MEDIA_ID, primary_media_id=MEDIA_ID, **fields)
    db.add(generation)
    db.flush()
    return generation


def test_media_kind():
    check(flow_media_kind(CLIP) == "video", "clip URL must be a video")
    check(flow_media_kind(POSTER) == "image", "poster URL must be an image")
    check(flow_media_kind(None) == "image", "no URL defaults to image")
    print("ok  media kind is read from the flow-content.google path")


def test_clip_after_mirrored_poster_replaces_it():
    with SessionLocal() as db:
        fresh_generation(db, media_url=POSTER, asset_mirror_status="mirrored", mirrored_asset_key="flow-mirror/33/x-asset.jpg")
        generation = _normalize_media_url_event(db, media_event(CLIP))
        check(generation.media_url == CLIP, "the clip must become the asset")
        check(generation.thumbnail_url == POSTER, "the poster must become the thumbnail")
        check(generation.asset_mirror_status == "pending", "a poster-only mirror must be redone for the clip")
        check(generation.to_dict()["mediaKind"] == "video", "API must report a video")
        db.rollback()
    print("ok  clip arriving after a mirrored poster takes over and is re-mirrored")


def test_poster_after_clip_does_not_replace_it():
    with SessionLocal() as db:
        fresh_generation(db, media_url=CLIP, asset_mirror_status="mirrored", mirrored_asset_key="flow-mirror/33/x-asset.mp4")
        generation = _normalize_media_url_event(db, media_event(POSTER))
        check(generation.media_url == CLIP, "a poster must never displace the clip")
        check(generation.thumbnail_url == POSTER, "the poster is kept as the thumbnail")
        check(generation.asset_mirror_status == "mirrored", "the clip mirror must not be redone for a poster")
        db.rollback()
    print("ok  poster arriving after the clip only fills the thumbnail")


def test_images_unchanged():
    with SessionLocal() as db:
        fresh_generation(db, media_url=None)
        generation = _normalize_media_url_event(db, media_event(POSTER))
        check(generation.media_url == POSTER and generation.thumbnail_url is None, "an image row works as before")
        check(generation.to_dict()["mediaKind"] == "image", "API must report an image")
        db.rollback()
    print("ok  plain image generations behave as before")


def main():
    test_media_kind()
    test_clip_after_mirrored_poster_replaces_it()
    test_poster_after_clip_does_not_replace_it()
    test_images_unchanged()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
