"""Regression cover for providers/heygen/asset_mirror.py - mirrors
tests/freepik_asset_mirror_smoke.py exactly (this package's template for the
feature). Copies HeyGen's own signed, time-limited asset URLs into our own
R2 storage so a generation stays viewable after HeyGen's own CDN link
expires (the same Expires=/Signature= failure mode as Freepik/Pikaso's
exp= token, which is what asset_mirror.py itself was built to fix there
first).

Network and R2 calls are faked (no real HTTP or boto3 traffic) - this tests
asset_mirror.py's own control flow: which URL gets picked as primary/
thumbnail, that a fetch failure is recorded per-row instead of aborting the
sweep, that a row with nothing to mirror is skipped rather than retried
forever, and that HeygenGeneration.to_dict() mints a working presigned URL
from the stored R2 key rather than exposing a permanently-stored (and, for
this app's private bucket, permanently broken) URL.

Run: python tests/heygen_asset_mirror_smoke.py
"""
import os
import sys
from datetime import timedelta
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
from providers.heygen.models import HeygenGeneration  # noqa: E402
import providers.heygen.asset_mirror as asset_mirror  # noqa: E402
from utils import r2_storage  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[User.__table__, ITPortalTool.__table__, GenerationRecord.__table__, HeygenGeneration.__table__])


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
            raise asset_mirror.httpx.HTTPStatusError("expired token", request=None, response=None)


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


def test_mirror_success_stores_r2_keys_and_to_dict_presigns_them() -> None:
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://files2.heygen.ai/example.mp4": _FakeResponse(content=b"video-bytes", content_type="video/mp4"),
        "https://dynamic.heygen.ai/example.jpeg": _FakeResponse(content=b"thumb-bytes", content_type="image/jpeg"),
    }

    with SessionLocal() as db:
        generation = HeygenGeneration(
            provider="heygen",
            video_id="video-1",
            video_url="https://files2.heygen.ai/example.mp4",
            thumbnail_url="https://dynamic.heygen.ai/example.jpeg",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats == {"scanned": 1, "mirrored": 1, "skipped": 0, "failed": 0, "r2_not_configured": False}, f"unexpected stats: {stats}")

        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "mirrored", f"status not mirrored: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is not None, "mirrored_asset_key was not set")
        _assert(refreshed.mirrored_asset_key.endswith(".mp4"), f"expected a .mp4 key from video/mp4 content-type, got {refreshed.mirrored_asset_key!r}")
        _assert(refreshed.mirrored_thumbnail_key is not None, "mirrored_thumbnail_key was not set")
        _assert(refreshed.asset_mirror_error is None, f"unexpected error recorded: {refreshed.asset_mirror_error!r}")
        _assert(refreshed.asset_mirror_attempted_at is not None, "asset_mirror_attempted_at was not stamped")

        # The regression this whole key/presign design exists for: to_dict()
        # must hand back an actually-fetchable URL, not the object key
        # itself and not a stale/broken permanent link - see models.py's
        # _presigned_mirror_url.
        serialized = refreshed.to_dict()
        _assert(serialized["mirroredAssetUrl"] == f"https://r2.example.test/presigned/{refreshed.mirrored_asset_key}?exp=600", f"to_dict() did not presign mirroredAssetUrl: {serialized['mirroredAssetUrl']!r}")
        _assert(serialized["mirroredThumbnailUrl"] is not None, "to_dict() did not presign mirroredThumbnailUrl")
        db.rollback()
    print("ok  a successful mirror stores R2 keys, and to_dict() presigns them into working URLs")


def test_download_url_falls_back_when_video_url_missing() -> None:
    """video_url and download_url are the same underlying file - if a row
    only ever captured download_url (e.g. a DOM-fallback snapshot), that
    must still be picked as the primary asset to mirror."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://files2.heygen.ai/download-only.mp4": _FakeResponse(content=b"video-bytes", content_type="video/mp4"),
    }

    with SessionLocal() as db:
        generation = HeygenGeneration(
            provider="heygen",
            video_id="video-2",
            download_url="https://files2.heygen.ai/download-only.mp4",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["mirrored"] == 1, f"expected 1 mirrored, got {stats}")

        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(refreshed.mirrored_asset_key is not None, "download_url was not picked up as the fallback primary asset")
        db.rollback()
    print("ok  download_url is used as the primary asset when video_url is missing")


def test_falls_back_to_next_candidate_when_first_url_is_expired() -> None:
    """Regression for the 2026-08-05 report, ported from
    freepik_asset_mirror_smoke.py's identical test: a provider's different
    asset variants (video/download/thumbnail/preview) can carry
    INDEPENDENTLY expiring signed tokens - the old code only ever tried the
    first non-null URL (video_url, per _asset_url_candidates' priority) and
    gave up on its failure, permanently stranding a generation that was
    still perfectly mirrorable via preview_url."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://files2.heygen.ai/expired.mp4": _FakeResponse(content=b"", content_type="text/html", status_error=True),
        "https://dynamic.heygen.ai/still-valid-preview.jpg": _FakeResponse(content=b"preview-bytes", content_type="image/jpeg"),
    }

    with SessionLocal() as db:
        generation = HeygenGeneration(
            provider="heygen",
            video_id="video-fallback",
            video_url="https://files2.heygen.ai/expired.mp4",
            preview_url="https://dynamic.heygen.ai/still-valid-preview.jpg",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["mirrored"] == 1, f"expected the sweep to fall back and still mirror successfully, got {stats}")

        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "mirrored", f"status not mirrored despite a working fallback candidate: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is not None, "mirrored_asset_key was not set from the fallback candidate")
        _assert(refreshed.mirrored_asset_key.endswith(".jpg"), f"expected the fallback (preview_url, .jpg) to win, got {refreshed.mirrored_asset_key!r}")
        db.rollback()
    print("ok  an expired first-choice URL falls back to the next candidate instead of failing the whole row")


def test_expired_source_url_is_recorded_as_failed_not_raised() -> None:
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://files2.heygen.ai/dead.mp4": _FakeResponse(content=b"", content_type="text/html", status_error=True),
    }

    with SessionLocal() as db:
        generation = HeygenGeneration(provider="heygen", video_id="video-3", video_url="https://files2.heygen.ai/dead.mp4")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["failed"] == 1, f"expected 1 failed, got {stats}")
        _assert(stats["mirrored"] == 0, f"expected 0 mirrored, got {stats}")

        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "failed", f"status not failed: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is None, "mirrored_asset_key should stay empty on failure")
        _assert(refreshed.asset_mirror_error, "no error message was recorded for the failed fetch")
        _assert(refreshed.to_dict()["mirroredAssetUrl"] is None, "to_dict() should not fabricate a URL when nothing was mirrored")
        db.rollback()
    print("ok  an expired/failing source URL is recorded as failed per-row, not raised out of the sweep")


def test_row_with_no_source_url_is_skipped() -> None:
    _install_fakes()
    _FakeHttpClient.responses = {}

    with SessionLocal() as db:
        generation = HeygenGeneration(provider="heygen", video_id="video-4")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["skipped"] == 1, f"expected 1 skipped, got {stats}")

        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "skipped", f"status not skipped: {refreshed.asset_mirror_status!r}")
        db.rollback()
    print("ok  a row with no captured asset URL at all is skipped, not retried forever")


def test_already_resolved_rows_are_never_rescanned() -> None:
    """Terminal statuses (mirrored/failed/skipped) must not be picked up
    again by a later sweep - the query filters on asset_mirror_status ==
    'pending', so a dead link is never hammered on every sweep interval."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://files2.heygen.ai/dead.mp4": _FakeResponse(content=b"", content_type="text/html", status_error=True),
    }

    with SessionLocal() as db:
        db.add(HeygenGeneration(provider="heygen", video_id="video-5", video_url="https://files2.heygen.ai/dead.mp4"))
        db.commit()

        first_pass = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(first_pass["failed"] == 1, f"expected the first pass to fail once, got {first_pass}")

        second_pass = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(second_pass["scanned"] == 0, f"a resolved row was rescanned on the next sweep: {second_pass}")
        db.rollback()
    print("ok  a resolved (failed/mirrored/skipped) row is never rescanned by a later sweep")


def test_requeue_revives_a_failed_row_only_after_it_is_recaptured() -> None:
    """The "No preview" card reported 2026-08-16: HeyGen serves thumbnails from
    short-lived .../avatar_tmp/... links, so a row whose link expired before
    the sweep reached it fails, becomes terminal (see the test above), and the
    card falls through every candidate URL to "No preview" forever.

    requeue_failed_mirrors is the missing admin action. It must NOT blanket-
    retry: a row that hasn't changed since it failed still has the same dead
    URL, and re-fetching it just burns requests. The signal that a retry is
    worth it is that normalization has re-captured the row (refreshing
    video_url/thumbnail_url) since the failed attempt."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://files2.heygen.ai/expired.mp4": _FakeResponse(content=b"", content_type="text/html", status_error=True),
        "https://files2.heygen.ai/refreshed.mp4": _FakeResponse(content=b"video-bytes", content_type="video/mp4"),
    }

    with SessionLocal() as db:
        # Earlier tests in this file commit their rows and leave them behind;
        # requeue_failed_mirrors sweeps the whole table, so this one has to
        # start from a clean slate to assert on exact counts.
        db.query(HeygenGeneration).delete()
        generation = HeygenGeneration(provider="heygen", video_id="video-requeue", video_url="https://files2.heygen.ai/expired.mp4")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        _assert(asset_mirror.mirror_pending_generations(db, limit=10)["failed"] == 1, "precondition: the first attempt must fail")

        # Not re-captured yet -> left alone, so the dead URL isn't re-fetched.
        #
        # This is the case a bare `updated_at > asset_mirror_attempted_at`
        # check got wrong: recording the failure writes both fields in one
        # commit, so updated_at lands microseconds after attempted_at and the
        # row looks re-captured when nothing happened. Asserted straight after
        # the failed attempt, with no clock manipulation, precisely so that
        # regression reappears here rather than in production as a retry storm
        # against dead URLs.
        stats = asset_mirror.requeue_failed_mirrors(db)
        _assert(stats["requeued"] == 0, f"an unchanged failed row must not be re-queued: {stats}")
        _assert(stats["unchanged_since_failure"] == 1, f"expected the row to be counted as unchanged: {stats}")

        # ...but an operator can force it anyway.
        _assert(asset_mirror.requeue_failed_mirrors(db, force=True)["requeued"] == 1, "force must re-queue regardless")

        # Simulate a fresh listing capture: new URL, updated_at moves past the
        # failed attempt - exactly what normalization does on re-capture.
        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        refreshed.asset_mirror_status = "failed"
        refreshed.video_url = "https://files2.heygen.ai/refreshed.mp4"
        refreshed.updated_at = refreshed.asset_mirror_attempted_at + timedelta(minutes=5)
        db.commit()

        stats = asset_mirror.requeue_failed_mirrors(db)
        _assert(stats["requeued"] == 1, f"a re-captured row must be re-queued: {stats}")

        after = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(after["mirrored"] == 1, f"the re-queued row must mirror on the next sweep: {after}")

        healed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(healed.mirrored_asset_key is not None, "the healed row must now have a permanent R2 copy")
        _assert(healed.asset_mirror_error is None, f"the stale error must be cleared, got {healed.asset_mirror_error!r}")
        db.rollback()
    print("ok  a failed mirror is re-queued once re-captured, and heals on the next sweep")


def test_requeue_leaves_rows_with_no_source_url_alone() -> None:
    """A "skipped" row has no URL to fetch at all - re-queueing it would only
    make the sweep re-derive that same verdict every interval."""
    _install_fakes()
    _FakeHttpClient.responses = {}

    with SessionLocal() as db:
        db.query(HeygenGeneration).delete()  # same isolation reason as the test above
        db.add(HeygenGeneration(provider="heygen", video_id="video-nourl", asset_mirror_status="skipped"))
        db.commit()

        stats = asset_mirror.requeue_failed_mirrors(db, force=True)
        _assert(stats["requeued"] == 0, f"a row with no candidate URL must not be re-queued: {stats}")
        _assert(stats["no_candidate_url"] == 1, f"expected it counted as no_candidate_url: {stats}")
        db.rollback()
    print("ok  a row with no source URL is never re-queued, even with force")


def test_r2_not_configured_leaves_rows_untouched() -> None:
    _install_fakes(configured=False)
    _FakeHttpClient.responses = {}

    with SessionLocal() as db:
        generation = HeygenGeneration(provider="heygen", video_id="video-6", video_url="https://files2.heygen.ai/example.mp4")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["r2_not_configured"] is True, f"expected r2_not_configured=True, got {stats}")
        _assert(stats["scanned"] == 0, f"should not scan any rows when R2 isn't configured: {stats}")

        refreshed = db.query(HeygenGeneration).filter(HeygenGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "pending", f"row status must stay pending, got {refreshed.asset_mirror_status!r}")
        db.rollback()
    print("ok  an unconfigured R2 leaves every row untouched instead of marking them failed")


def test_to_dict_never_raises_when_presigning_fails() -> None:
    """generate_presigned_url is a live boto3 call at serialization time (see
    models.py's _presigned_mirror_url) - a transient signing error or R2
    misconfiguration must degrade to a null field, never break the whole API
    response for every other field on the row."""
    _install_fakes()

    def _boom(key, *, expires_in=600, client=None):  # noqa: ARG001
        raise RuntimeError("boom")

    r2_storage.generate_presigned_url = _boom

    with SessionLocal() as db:
        generation = HeygenGeneration(provider="heygen", video_id="video-7", mirrored_asset_key="heygen-mirror/7/x-asset.mp4")
        db.add(generation)
        db.commit()
        serialized = generation.to_dict()
        _assert(serialized["mirroredAssetUrl"] is None, f"expected a graceful null on presign failure, got {serialized['mirroredAssetUrl']!r}")
        db.rollback()
    print("ok  a presign failure at serialization time degrades to null instead of raising")


if __name__ == "__main__":
    test_mirror_success_stores_r2_keys_and_to_dict_presigns_them()
    test_download_url_falls_back_when_video_url_missing()
    test_falls_back_to_next_candidate_when_first_url_is_expired()
    test_expired_source_url_is_recorded_as_failed_not_raised()
    test_row_with_no_source_url_is_skipped()
    test_already_resolved_rows_are_never_rescanned()
    test_requeue_revives_a_failed_row_only_after_it_is_recaptured()
    test_requeue_leaves_rows_with_no_source_url_alone()
    test_r2_not_configured_leaves_rows_untouched()
    test_to_dict_never_raises_when_presigning_fails()
    print("\nall heygen asset mirror smoke checks passed")
