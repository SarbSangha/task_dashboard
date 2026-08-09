"""Regression cover for providers/freepik/asset_mirror.py - the sweep that
copies Freepik/Pikaso's own signed, time-limited asset URLs into our own R2
storage so a generation stays viewable after Freepik's own CDN link expires
(the 2026-08-05 "unable to view the generation" / Akamai error report this
exists to fix).

Network and R2 calls are faked (no real HTTP or boto3 traffic) - this tests
asset_mirror.py's own control flow: which URL gets picked as primary/
thumbnail, that a fetch failure is recorded per-row instead of aborting the
sweep, that a row with nothing to mirror is skipped rather than retried
forever, and that FreepikGeneration.to_dict() mints a working presigned URL
from the stored R2 key rather than exposing a permanently-stored (and, for
this app's private bucket, permanently broken) URL.

Run: python tests/freepik_asset_mirror_smoke.py
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
from providers.freepik.models import FreepikGeneration  # noqa: E402
import providers.freepik.asset_mirror as asset_mirror  # noqa: E402
from utils import r2_storage  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[User.__table__, ITPortalTool.__table__, GenerationRecord.__table__, FreepikGeneration.__table__])


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
    """Monkeypatches r2_storage + httpx.Client for the duration of one test.
    Returns the list `put_calls` gets appended to, so a test can assert on
    which keys/content-types were actually written."""
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
        "https://pikaso.cdnpk.net/example.png": _FakeResponse(content=b"asset-bytes", content_type="image/png"),
        "https://pikaso.cdnpk.net/example-thumb.webp": _FakeResponse(content=b"thumb-bytes", content_type="image/webp"),
    }

    with SessionLocal() as db:
        generation = FreepikGeneration(
            provider="freepik",
            creation_id="creation-1",
            download_url="https://pikaso.cdnpk.net/example.png",
            thumbnail_url="https://pikaso.cdnpk.net/example-thumb.webp",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats == {"scanned": 1, "mirrored": 1, "skipped": 0, "failed": 0, "r2_not_configured": False}, f"unexpected stats: {stats}")

        refreshed = db.query(FreepikGeneration).filter(FreepikGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "mirrored", f"status not mirrored: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is not None, "mirrored_asset_key was not set")
        _assert(refreshed.mirrored_asset_key.endswith(".png"), f"expected a .png key from image/png content-type, got {refreshed.mirrored_asset_key!r}")
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


def test_falls_back_to_next_candidate_when_first_url_is_expired() -> None:
    """Regression for the 2026-08-05 report: Pikaso's different asset
    variants (download/thumbnail/preview) carry INDEPENDENTLY expiring
    signed tokens - a real generation's download_url had already expired
    while its preview_url token was still good for days. The old code only
    ever tried the first non-null URL (download_url, per _asset_url_
    candidates' priority) and gave up on its failure, permanently stranding
    a generation that was still perfectly mirrorable via preview_url."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://pikaso.cdnpk.net/expired-download.png": _FakeResponse(content=b"", content_type="text/html", status_error=True),
        "https://pikaso.cdnpk.net/still-valid-preview.jpg": _FakeResponse(content=b"preview-bytes", content_type="image/jpeg"),
    }

    with SessionLocal() as db:
        generation = FreepikGeneration(
            provider="freepik",
            creation_id="creation-fallback",
            download_url="https://pikaso.cdnpk.net/expired-download.png",
            preview_url="https://pikaso.cdnpk.net/still-valid-preview.jpg",
        )
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["mirrored"] == 1, f"expected the sweep to fall back and still mirror successfully, got {stats}")

        refreshed = db.query(FreepikGeneration).filter(FreepikGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "mirrored", f"status not mirrored despite a working fallback candidate: {refreshed.asset_mirror_status!r}")
        _assert(refreshed.mirrored_asset_key is not None, "mirrored_asset_key was not set from the fallback candidate")
        _assert(refreshed.mirrored_asset_key.endswith(".jpg"), f"expected the fallback (preview_url, .jpg) to win, got {refreshed.mirrored_asset_key!r}")
        db.rollback()
    print("ok  an expired first-choice URL falls back to the next candidate instead of failing the whole row")


def test_expired_source_url_is_recorded_as_failed_not_raised() -> None:
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://pikaso.cdnpk.net/dead.png": _FakeResponse(content=b"", content_type="text/html", status_error=True),
    }

    with SessionLocal() as db:
        generation = FreepikGeneration(provider="freepik", creation_id="creation-2", download_url="https://pikaso.cdnpk.net/dead.png")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["failed"] == 1, f"expected 1 failed, got {stats}")
        _assert(stats["mirrored"] == 0, f"expected 0 mirrored, got {stats}")

        refreshed = db.query(FreepikGeneration).filter(FreepikGeneration.id == generation_id).one()
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
        generation = FreepikGeneration(provider="freepik", creation_id="creation-3")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["skipped"] == 1, f"expected 1 skipped, got {stats}")

        refreshed = db.query(FreepikGeneration).filter(FreepikGeneration.id == generation_id).one()
        _assert(refreshed.asset_mirror_status == "skipped", f"status not skipped: {refreshed.asset_mirror_status!r}")
        db.rollback()
    print("ok  a row with no captured asset URL at all is skipped, not retried forever")


def test_already_resolved_rows_are_never_rescanned() -> None:
    """Terminal statuses (mirrored/failed/skipped) must not be picked up
    again by a later sweep - the query filters on asset_mirror_status ==
    'pending', so a dead link is never hammered on every sweep interval."""
    _install_fakes()
    _FakeHttpClient.responses = {
        "https://pikaso.cdnpk.net/dead.png": _FakeResponse(content=b"", content_type="text/html", status_error=True),
    }

    with SessionLocal() as db:
        db.add(FreepikGeneration(provider="freepik", creation_id="creation-4", download_url="https://pikaso.cdnpk.net/dead.png"))
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
        generation = FreepikGeneration(provider="freepik", creation_id="creation-5", download_url="https://pikaso.cdnpk.net/example.png")
        db.add(generation)
        db.commit()
        generation_id = generation.id

        stats = asset_mirror.mirror_pending_generations(db, limit=10)
        _assert(stats["r2_not_configured"] is True, f"expected r2_not_configured=True, got {stats}")
        _assert(stats["scanned"] == 0, f"should not scan any rows when R2 isn't configured: {stats}")

        refreshed = db.query(FreepikGeneration).filter(FreepikGeneration.id == generation_id).one()
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
        generation = FreepikGeneration(provider="freepik", creation_id="creation-6", mirrored_asset_key="freepik-mirror/6/x-asset.png")
        db.add(generation)
        db.commit()
        serialized = generation.to_dict()
        _assert(serialized["mirroredAssetUrl"] is None, f"expected a graceful null on presign failure, got {serialized['mirroredAssetUrl']!r}")
        db.rollback()
    print("ok  a presign failure at serialization time degrades to null instead of raising")


if __name__ == "__main__":
    test_mirror_success_stores_r2_keys_and_to_dict_presigns_them()
    test_falls_back_to_next_candidate_when_first_url_is_expired()
    test_expired_source_url_is_recorded_as_failed_not_raised()
    test_row_with_no_source_url_is_skipped()
    test_already_resolved_rows_are_never_rescanned()
    test_r2_not_configured_leaves_rows_untouched()
    test_to_dict_never_raises_when_presigning_fails()
    print("\nall freepik asset mirror smoke checks passed")
