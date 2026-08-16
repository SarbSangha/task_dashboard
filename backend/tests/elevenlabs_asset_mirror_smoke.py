"""Regression cover for providers/elevenlabs/asset_mirror.py - mirrors
tests/heygen_asset_mirror_smoke.py's structure/faking approach exactly (this
package's template for the feature, itself mirroring
tests/freepik_asset_mirror_smoke.py). Copies a generation's audio asset URL
into our own R2 storage.

Network and R2 calls are faked (no real HTTP or boto3 traffic) - this tests
asset_mirror.py's own control flow: that a row with no candidate URL at all
(e.g. simulating a Speech-to-Text row, which has no audio output) is skipped
without attempting any fetch, that a working candidate URL mirrors
successfully and ElevenlabsGeneration.to_dict() presigns a working
mirroredAssetUrl from the stored R2 key, and that every candidate URL
failing is recorded as "failed" per-row (never raised) and is NOT retried by
a later sweep - the same terminal-failure behavior
heygen_asset_mirror_smoke.py::test_already_resolved_rows_are_never_rescanned
confirms for HeyGen/Freepik. ElevenLabs has no reason to differ (a dead/
absent source URL is exactly as permanently dead here as anywhere else), so
this mirrors that behavior rather than diverging from it.

Run: python tests/elevenlabs_asset_mirror_smoke.py
"""
import os
import sys
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
from providers.elevenlabs.models import ElevenlabsGeneration  # noqa: E402
import providers.elevenlabs.asset_mirror as asset_mirror  # noqa: E402
from utils import r2_storage  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[User.__table__, ITPortalTool.__table__, GenerationRecord.__table__, ElevenlabsGeneration.__table__])


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class _FakeResponse:
    def __init__(self, *, content: bytes, content_type: str, status_error: bool = False):
        self.content = content
        self.headers = {"content-type": content_type}
        self._status_error = status_error

    def raise_for_status(self):
        if self._status_error:
            raise asset_mirror.httpx.HTTPStatusError("expired/unreachable", request=None, response=None)


class _FakeHttpClient:
    """Stands in for httpx.Client - routes by URL so each test controls what
    each fetch returns/raises without touching the network."""

    responses: dict = {}

    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def get(self, url, timeout=None):  # noqa: ARG002
        outcome = self.responses.get(url)
        if outcome is None:
            raise AssertionError(f"unexpected fetch for {url!r} - test forgot to register a response")
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _install_fakes(*, configured: bool = True):
    put_calls = []

    def fake_put_object(key, data, *, content_type="application/octet-stream", client=None):  # noqa: ARG001
        put_calls.append({"key": key, "size": len(data), "contentType": content_type})

    def fake_generate_presigned_url(key, *, expires_in=600, client=None):  # noqa: ARG001
        return f"https://r2.example.test/presigned/{key}?exp={expires_in}"

    r2_storage.is_configured = lambda: configured
    r2_storage.build_client = lambda: object()
    r2_storage.put_object = fake_put_object
    r2_storage.generate_presigned_url = fake_generate_presigned_url
    asset_mirror.httpx.Client = _FakeHttpClient
    return put_calls


def test_row_with_no_candidate_url_is_skipped_without_fetching() -> None:
    """Simulates a Speech-to-Text row (transcript only, no audio output) -
    media_url is null and metadata_json carries no candidate key either.
    Must be skipped without attempting any fetch at all."""
    _install_fakes()
    _FakeHttpClient.responses = {}

    with SessionLocal() as db:
        generation = ElevenlabsGeneration(
            provider="elevenlabs",
            provider_creation_id="stt-1",
            source="STT",
            metadata_json={"history_item_id": "stt-1", "text": "a transcript, no audio"},
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats == {"scanned": 1, "mirrored": 0, "skipped": 1, "failed": 0, "r2_not_configured": False}, f"unexpected stats: {stats}")

        refreshed = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "skipped", f"status not skipped: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is None, "no key should be set for a skipped row")
        db.rollback()
    print("ok  a row with no candidate asset URL (simulating STT) is skipped, no fetch attempted")


def test_mirror_success_stores_r2_key_and_to_dict_presigns_it() -> None:
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://api.elevenlabs.io/v1/history/tts-1/audio": _FakeResponse(content=b"audio-bytes", content_type="audio/mpeg"),
    }

    with SessionLocal() as db:
        generation = ElevenlabsGeneration(
            provider="elevenlabs",
            provider_creation_id="tts-1",
            source="TTS",
            media_url="https://api.elevenlabs.io/v1/history/tts-1/audio",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["mirrored"] == 1, f"expected 1 mirrored, got {stats}")

        refreshed = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "mirrored", f"status not mirrored: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is not None, "mirrored_asset_key was not set")
        _assert(refreshed.mirrored_asset_key.endswith(".mp3"), f"expected a .mp3 key from audio/mpeg content-type, got {refreshed.mirrored_asset_key!r}")
        _assert(refreshed.asset_mirror_error is None, f"unexpected error recorded: {refreshed.asset_mirror_error!r}")
        _assert(refreshed.asset_mirror_attempted_at is not None, "asset_mirror_attempted_at was not stamped")

        serialized = refreshed.to_dict()
        _assert(
            serialized["mirroredAssetUrl"] == f"https://r2.example.test/presigned/{refreshed.mirrored_asset_key}?exp=600",
            f"to_dict() did not presign mirroredAssetUrl: {serialized['mirroredAssetUrl']!r}",
        )
        db.rollback()
    print("ok  a working candidate URL mirrors successfully and to_dict() presigns a working mirroredAssetUrl")


def test_metadata_fallback_candidate_is_used_when_media_url_is_empty() -> None:
    """media_url can be null even when the raw payload actually carried a
    candidate key normalization.py didn't recognize yet (e.g. an older row
    normalized before a candidate key was added to the extraction list) -
    asset_mirror.py's own fallback scan of metadata_json must still find and
    use it."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://cdn.elevenlabs.test/download/fallback.mp3": _FakeResponse(content=b"fallback-bytes", content_type="audio/mpeg"),
    }

    with SessionLocal() as db:
        generation = ElevenlabsGeneration(
            provider="elevenlabs",
            provider_creation_id="fallback-1",
            source="TTS",
            media_url=None,
            metadata_json={"history_item_id": "fallback-1", "download_url": "https://cdn.elevenlabs.test/download/fallback.mp3"},
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["mirrored"] == 1, f"expected the metadata_json fallback candidate to be used and mirrored, got {stats}")

        refreshed = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.id == generation_id).one()
        _assert(refreshed.mirrored_asset_key is not None, "fallback candidate from metadata_json was not picked up")
        db.rollback()
    print("ok  a candidate URL is found in metadata_json even when media_url is empty")


def test_every_candidate_failing_is_recorded_as_failed_not_raised() -> None:
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://api.elevenlabs.io/v1/history/dead-1/audio": _FakeResponse(content=b"", content_type="text/html", status_error=True),
    }

    with SessionLocal() as db:
        generation = ElevenlabsGeneration(
            provider="elevenlabs",
            provider_creation_id="dead-1",
            source="TTS",
            media_url="https://api.elevenlabs.io/v1/history/dead-1/audio",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["failed"] == 1, f"expected 1 failed, got {stats}")
        _assert(stats["mirrored"] == 0, f"expected 0 mirrored, got {stats}")

        refreshed = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "failed", f"status not failed: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is None, "mirrored_asset_key should stay empty on failure")
        _assert(refreshed.asset_mirror_error, "no error message was recorded for the failed fetch")
        db.rollback()
    print("ok  every candidate URL failing is recorded as failed per-row, not raised out of the sweep")


def test_failed_row_is_never_rescanned_by_a_later_sweep() -> None:
    """Terminal statuses (mirrored/failed/skipped) must not be picked up
    again by a later sweep - matches Freepik/HeyGen's identical terminal-
    failure behavior (confirmed against heygen_asset_mirror_smoke.py's
    test_already_resolved_rows_are_never_rescanned). ElevenLabs has no
    reason to diverge: a dead source URL is exactly as permanently dead
    here."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://api.elevenlabs.io/v1/history/dead-2/audio": _FakeResponse(content=b"", content_type="text/html", status_error=True),
    }

    with SessionLocal() as db:
        db.add(ElevenlabsGeneration(
            provider="elevenlabs", provider_creation_id="dead-2", source="TTS",
            media_url="https://api.elevenlabs.io/v1/history/dead-2/audio",
        ))
        db.commit()

        first_pass = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(first_pass["failed"] == 1, f"expected the first pass to fail once, got {first_pass}")

        second_pass = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(second_pass["scanned"] == 0, f"a resolved row was rescanned on the next sweep: {second_pass}")
        db.rollback()
    print("ok  a resolved (failed/mirrored/skipped) row is never rescanned by a later sweep")


def test_r2_not_configured_leaves_rows_untouched() -> None:
    _install_fakes(configured=False)
    _FakeHttpClient.responses = {}

    with SessionLocal() as db:
        generation = ElevenlabsGeneration(
            provider="elevenlabs", provider_creation_id="unconfigured-1", source="TTS",
            media_url="https://api.elevenlabs.io/v1/history/unconfigured-1/audio",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["r2_not_configured"] is True, f"expected r2_not_configured=True, got {stats}")
        _assert(stats["scanned"] == 0, f"should not scan any rows when R2 isn't configured: {stats}")

        refreshed = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "pending", f"row status must stay pending, got {refreshed.asset_mirror_status!r}")
        db.rollback()
    print("ok  an unconfigured R2 leaves every row untouched instead of marking them failed")


def test_to_dict_never_raises_when_presigning_fails() -> None:
    _install_fakes()

    def _boom(key, *, expires_in=600, client=None):  # noqa: ARG001
        raise RuntimeError("boom")

    r2_storage.generate_presigned_url = _boom

    with SessionLocal() as db:
        generation = ElevenlabsGeneration(
            provider="elevenlabs", provider_creation_id="presign-boom",
            mirrored_asset_key="elevenlabs-mirror/1/x-asset.mp3",
        )
        db.add(generation)
        db.commit()
        serialized = generation.to_dict()
        _assert(serialized["mirroredAssetUrl"] is None, f"expected a graceful null on presign failure, got {serialized['mirroredAssetUrl']!r}")
        db.rollback()
    print("ok  a presign failure at serialization time degrades to null instead of raising")


if __name__ == "__main__":
    test_row_with_no_candidate_url_is_skipped_without_fetching()
    test_mirror_success_stores_r2_key_and_to_dict_presigns_it()
    test_metadata_fallback_candidate_is_used_when_media_url_is_empty()
    test_every_candidate_failing_is_recorded_as_failed_not_raised()
    test_failed_row_is_never_rescanned_by_a_later_sweep()
    test_r2_not_configured_leaves_rows_untouched()
    test_to_dict_never_raises_when_presigning_fails()
    print("\nall elevenlabs asset mirror smoke checks passed")
