"""Regression cover for providers/elevenlabs/normalization.py.

Fixture shapes are best-guess pending a real captured `history` row - update
this file's fixtures the moment real traffic is observed (see
providers/elevenlabs/CAPTURE_CONTRACT.md's known gaps).

Mirrors tests/freepik_normalization_smoke.py's structure/conventions:
in-process SQLite (StaticPool), normalize_capture_event called directly as a
plain Python function.

Run: python tests/elevenlabs_normalization_smoke.py
"""
import os
import sys
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationRecord, ITPortalTool, User  # noqa: E402
from providers.elevenlabs.models import ElevenlabsCaptureEvent, ElevenlabsGeneration  # noqa: E402
from providers.elevenlabs.normalization import _extract_fields, normalize_capture_event  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        GenerationRecord.__table__,
        ElevenlabsCaptureEvent.__table__,
        ElevenlabsGeneration.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor() -> tuple[int, int]:
    with SessionLocal() as db:
        user = User(email="elevenlabs-norm@example.com", name="ElevenLabs Norm User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="ElevenLabs", slug="elevenlabs", website_url="https://elevenlabs.io", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _capture(db, payload: dict, *, client_event_id: str, ownership_confidence: str = "ticket") -> ElevenlabsCaptureEvent:
    # Received right when the item was made, so it is attributable (an
    # owner-less item is not stored at all).
    event = ElevenlabsCaptureEvent(
        created_at=_extract_fields(payload)["provider_created_at"] or datetime.utcnow(),
        tool_id=TOOL_ID,
        user_id=USER_ID,
        provider="elevenlabs",
        event_type="history_row",
        client_event_id=client_event_id,
        payload_json=payload,
        capture_version=1,
        event_date=datetime.utcnow().date(),
        ownership_confidence=ownership_confidence,
    )
    db.add(event)
    db.flush()
    return event


def test_synthetic_row_extracts_expected_fields() -> None:
    """A synthetic best-guess-shape history row - the primary candidate keys
    for every logical field (history_item_id/text/source/voice_id/date_unix -
    see CAPTURE_CONTRACT.md's field mapping table)."""
    # Freshness-gated ownership attribution (see normalization.py's
    # _is_fresh_enough_for_attribution) requires the row's own timestamp to
    # be recent relative to "now", not any fixed point in the past - use the
    # current wall-clock time as unix seconds so this test exercises live
    # attribution rather than the "too old to attribute" branch. NOTE:
    # datetime.utcnow().timestamp() is wrong here - .timestamp() interprets a
    # naive datetime as LOCAL time, so on a non-UTC machine it silently
    # shifts by the local offset; compute the epoch directly against the
    # UTC epoch instead.
    now_unix = int((datetime.utcnow() - datetime(1970, 1, 1)).total_seconds())
    expected_created_at = datetime.utcfromtimestamp(now_unix)
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(
            db,
            {"history_item_id": "abc123", "voice_id": "v1", "voice_name": "Rachel", "text": "hello world", "source": "TTS", "date_unix": now_unix},
            client_event_id="evt-synthetic",
        ))
        db.flush()

        _assert(gen is not None, "expected a normalized ElevenlabsGeneration, got None")
        _assert(gen.provider_creation_id == "abc123", f"identity not extracted: {gen.provider_creation_id!r}")
        _assert(gen.voice_id == "v1", f"voice_id not extracted: {gen.voice_id!r}")
        _assert(gen.voice_name == "Rachel", f"voice_name not extracted: {gen.voice_name!r}")
        _assert(gen.prompt == "hello world", f"prompt not extracted: {gen.prompt!r}")
        _assert(gen.prompt_length == len("hello world"), f"prompt_length wrong: {gen.prompt_length!r}")
        _assert(gen.source == "TTS", f"source not extracted: {gen.source!r}")
        _assert(gen.provider_created_at == expected_created_at, f"date_unix not parsed as unix seconds: {gen.provider_created_at!r}")
        # No separate "updated" candidate present on this row - falls back to
        # the created timestamp (see _extract_fields' docstring).
        _assert(gen.provider_updated_at == gen.provider_created_at, "provider_updated_at should fall back to created when absent")
        _assert(gen.owner_user_id == USER_ID, f"expected live attribution, got owner_user_id={gen.owner_user_id!r}")
        _assert(gen.ownership_status == "resolved", f"expected resolved ownership, got {gen.ownership_status!r}")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.provider == "elevenlabs", f"GenerationRecord.provider wrong: {record.provider!r}")
        _assert(record.prompt_text == "hello world", f"GenerationRecord.prompt_text not projected: {record.prompt_text!r}")
        db.rollback()
    print("ok  a synthetic best-guess-shape row normalizes with correctly extracted fields")


def test_row_with_only_one_identity_key_normalizes_without_raising() -> None:
    """A pathological row carrying almost nothing - just one identity-like
    key - must still normalize without raising, proving the defensive
    multi-candidate extraction degrades gracefully rather than assuming any
    particular field is present."""
    fields = _extract_fields({"id": "xyz"})
    _assert(fields["provider_creation_id"] == "xyz", f"identity not extracted from fallback key 'id': {fields['provider_creation_id']!r}")
    _assert(fields["prompt"] is None, f"no prompt candidate was present, expected None, got {fields['prompt']!r}")
    _assert(fields["source"] is None, f"no source candidate was present, expected None, got {fields['source']!r}")
    _assert(fields["media_url"] is None, f"no asset URL candidate was present, expected None, got {fields['media_url']!r}")
    _assert(fields["provider_created_at"] is None, f"no timestamp candidate was present, expected None, got {fields['provider_created_at']!r}")
    with SessionLocal() as db:
        # No timestamp, so nobody can be credited with it: skipped, not raised.
        gen = normalize_capture_event(db, _capture(db, {"id": "xyz"}, client_event_id="evt-minimal"))
        _assert(gen is None, "an unattributable row is not stored")
        db.rollback()
    print("ok  a row with only one identity-like field normalizes without raising (defensive extraction)")


def test_totally_empty_payload_is_skipped_not_raised() -> None:
    """A row with NO identity candidate at all must be skipped (None
    returned), never raise - normalize_capture_events_batch relies on this
    to distinguish a deliberate skip from an error."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {"text": "no id anywhere"}, client_event_id="evt-no-identity"))
        _assert(gen is None, "a payload with no identity candidate should return None, not raise or fabricate a row")
        db.rollback()
    print("ok  a payload with no identity candidate at all is skipped cleanly")


def test_stale_snapshot_does_not_erase_stored_columns() -> None:
    """The extension can plausibly report the same history item twice out of
    order (e.g. a live capture followed by a later reconciliation walk that
    happens to replay an older cached copy) - a thinner/older snapshot must
    never walk stored columns back to null or an earlier value."""
    with SessionLocal() as db:
        normalize_capture_event(db, _capture(
            db,
            {"history_item_id": "stale-test", "text": "the final version", "source": "TTS",
             "voice_name": "Rachel", "date_unix": 1700000200},
            client_event_id="evt-newer",
        ))
        db.flush()

        # ...then an OLDER snapshot of the same item arrives late.
        normalize_capture_event(db, _capture(
            db,
            {"history_item_id": "stale-test", "text": "an earlier draft", "source": "TTS",
             "date_unix": 1700000100},
            client_event_id="evt-older",
        ))
        db.flush()

        gen = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.provider_creation_id == "stale-test").one()
        _assert(gen.prompt == "the final version", f"prompt was clobbered by the stale snapshot: {gen.prompt!r}")
        _assert(gen.voice_name == "Rachel", f"voice_name was clobbered by the stale snapshot: {gen.voice_name!r}")
        db.rollback()
    print("ok  a stale/older snapshot never overwrites already-stored richer columns")


def test_one_generation_produces_exactly_one_generation_record() -> None:
    """Calling normalize twice for the same provider_creation_id (e.g. a
    live capture followed by a reconciliation replay of the same item) must
    never create a second GenerationRecord."""
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(
            db, {"history_item_id": "one-record-test", "text": "first pass", "source": "TTS", "date_unix": 1700000300},
            client_event_id="evt-first-pass",
        ))
        db.flush()
        second = normalize_capture_event(db, _capture(
            db, {"history_item_id": "one-record-test", "text": "first pass", "source": "TTS", "date_unix": 1700000400},
            client_event_id="evt-second-pass",
        ))
        db.flush()

        _assert(first.id == second.id, "both normalize calls should resolve to the same ElevenlabsGeneration row")
        record_count = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.provider == "elevenlabs", GenerationRecord.provider_generation_id == "one-record-test")
            .count()
        )
        _assert(record_count == 1, f"expected exactly one GenerationRecord, found {record_count}")
        db.rollback()
    print("ok  one generation produces exactly one GenerationRecord even when normalized twice")


def _content_generation_row(gen_id: str, *, created_unix: int, status: str, modality: str = "video") -> dict:
    """Real GET /v1/content/generations row shape (Image & Video, observed
    2026-10-29) - signed GCS URLs replaced with placeholders."""
    done = status == "completed"
    ext = "mp4" if modality == "video" else "png"
    url = (lambda name: f"https://storage.googleapis.com/xi-backend/database/workspace/w/content_generation/{gen_id}/s/{name}?X-Goog-Signature=x") if done else (lambda name: None)
    return {
        "id": gen_id,
        "prompt": "Dadaji aur Pota yoga pose se naturally apni normal standing position mein aa jaate hain",
        "display_prompt": {"type": "doc", "content": []},
        "model_id": "gemini-omni-1.1-flash",
        "model_parameters": {"aspect_ratio": "9:16", "duration_secs": 8, "resolution": "720p", "start_frame": {"content_asset_id": "k80EQT5eqSVsG6F3Dq7r"}},
        "modality": modality,
        "mime_type": f"{'video' if modality == 'video' else 'image'}/{ext}",
        "status": status,
        "content_url": url(f"content.{ext}"),
        "download_url": url(f"content.{ext}"),
        "thumbnail_url": url("thumbnail.jpg"),
        "price": {"credits": 4892.709575138122, "price_cents": 7828.3, "cost_fiat_currency": "inr", "promotion": None},
        "created_at_unix": created_unix,
        "updated_at_unix": created_unix + (50 if done else 5),
        "finished_at_unix": created_unix + 50 if done else None,
    }


def test_image_video_generation_normalizes_and_requeues_mirror() -> None:
    """An Image & Video generation first captured while still generating (no
    URL yet - the mirror sweep marks that "skipped"), then again completed:
    one row, source Video, ElevenLabs' own credit price, the finished file's
    URL, and the mirror re-queued so the video actually gets copied."""
    now_unix = int((datetime.utcnow() - datetime(1970, 1, 1)).total_seconds())
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(
            db, _content_generation_row("FwNONsqNHOz2b9vngBki", created_unix=now_unix, status="processing"),
            client_event_id="evt-video-generating",
        ))
        db.flush()
        _assert(first is not None and first.source == "Video", f"expected source Video, got {first and first.source!r}")
        _assert(first.media_url is None, "a still-generating row has no asset URL yet")
        _assert(first.credits_used == 4893, f"credits should come from price.credits, got {first.credits_used!r}")
        _assert(first.to_dict()["mediaKind"] == "video", "dashboard should render this as a video")
        first.asset_mirror_status = "skipped"  # what the sweep does to a row with no URL
        db.flush()

        second = normalize_capture_event(db, _capture(
            db, _content_generation_row("FwNONsqNHOz2b9vngBki", created_unix=now_unix, status="completed"),
            client_event_id="evt-video-completed",
        ))
        db.flush()
        _assert(second.id == first.id, "the completed snapshot must update the same generation, not add one")
        _assert(second.status == "completed", f"status should advance, got {second.status!r}")
        _assert(second.media_url and "content.mp4" in second.media_url, f"finished file URL missing: {second.media_url!r}")
        _assert(second.thumbnail_url and "thumbnail.jpg" in second.thumbnail_url, "thumbnail URL missing")
        _assert(second.provider_updated_at > second.provider_created_at, "updated_at_unix should be read")
        _assert(second.asset_mirror_status == "pending", f"mirror should be re-queued, got {second.asset_mirror_status!r}")
        _assert(second.prompt.startswith("Dadaji aur Pota"), "prompt not extracted")
        db.rollback()

    image = _extract_fields(_content_generation_row("imgGen0000000000001", created_unix=now_unix, status="completed", modality="image"))
    _assert(image["source"] == "Image" and image["media_url"].split("?")[0].endswith("content.png"), "image rows map to source Image")
    print("ok  an Image & Video generation normalizes (generating -> completed) and its mirror is re-queued")


def test_uploaded_reference_file_is_not_a_generation() -> None:
    """A reference image the person uploaded (real upload response shape,
    2026-10-29) must not become a generation row."""
    now_unix = int((datetime.utcnow() - datetime(1970, 1, 1)).total_seconds())
    upload = {
        "id": "IqwxDFiig6Gd6v8RNdMz", "created_at_unix": now_unix, "status": "finalized", "source": None,
        "name": "kling_20261014_IMAGE_Mood__Cine_4789_1 (2).png", "mime_type": "image/png",
        "access_info": {"access_source": "creator", "is_creator": True, "role": "admin"},
        "content_url": "https://storage.googleapis.com/xi-backend/database/workspace/w/content_generation/content_asset/IqwxDFiig6Gd6v8RNdMz/asset.png?x",
        "download_url": "https://storage.googleapis.com/xi-backend/database/workspace/w/content_generation/content_asset/IqwxDFiig6Gd6v8RNdMz/asset.png?x",
    }
    with SessionLocal() as db:
        result = normalize_capture_event(db, _capture(db, upload, client_event_id="evt-upload"))
        _assert(result is None, "an uploaded file must not create a generation")
        _assert(db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.provider_creation_id == "IqwxDFiig6Gd6v8RNdMz").count() == 0,
                "no generation row for an upload")
        db.rollback()
    print("ok  an uploaded reference file is not recorded as a generation")


def test_music_and_tts_rows_unchanged_by_image_video_support() -> None:
    """Image & Video support must not change how Music/TTS rows normalize."""
    music = _extract_fields({
        "id": "chat1", "current_song_id": "song1", "created_at_utc": "2026-08-17T05:57:38.640000Z",
        "song": {"id": "song1", "created_at_utc": "2026-08-17T05:57:38.640000Z", "updated_at_utc": "2026-08-17T05:57:44.552000Z",
                 "generation_settings": {"model_id": "music_v2", "prompt": "jatt", "song_length_ms": 10000},
                 "download_url": "https://storage.googleapis.com/x/generated_task.mp4", "status": "completed", "product_type_source": "Music"},
    })
    _assert(music["source"] == "Music" and music["credits_used"] == 150 and music["thumbnail_url"] is None, f"music row changed: {music['source']!r} {music['credits_used']!r}")
    tts = _extract_fields({"history_item_id": "t1", "text": "hi", "source": "TTS", "date_unix": 1786610923,
                           "character_count_change_from": 1188, "character_count_change_to": 1215})
    _assert(tts["source"] == "TTS" and tts["credits_used"] == 27, "tts row changed")
    with SessionLocal() as db:
        gen = ElevenlabsGeneration(provider="elevenlabs", metadata_json={"song": {"id": "s"}})
        _assert(gen.to_dict()["mediaKind"] == "audio", "music/tts stay audio on the dashboard")
    print("ok  Music and TTS rows normalize exactly as before")


if __name__ == "__main__":
    test_image_video_generation_normalizes_and_requeues_mirror()
    test_music_and_tts_rows_unchanged_by_image_video_support()
    test_uploaded_reference_file_is_not_a_generation()
    test_synthetic_row_extracts_expected_fields()
    test_row_with_only_one_identity_key_normalizes_without_raising()
    test_totally_empty_payload_is_skipped_not_raised()
    test_stale_snapshot_does_not_erase_stored_columns()
    test_one_generation_produces_exactly_one_generation_record()
    print("\nall elevenlabs normalization smoke checks passed")
