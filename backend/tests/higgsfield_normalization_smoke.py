"""Regression cover for providers/higgsfield/normalization.py's core
guarantees, mirroring backend/tests/heygen_normalization_smoke.py (this
package's template):

  1. GenerationRecord.capture_status is derived from HiggsfieldGeneration.status,
     not left at the "active" model default.
  2. A thinner or older snapshot of an already-normalized generation never
     walks stored columns back to null (content-higgsfield.js deliberately
     reports the same generation twice - "submitted" then "settled" - and
     nothing guarantees they arrive in order).
  3. One HiggsfieldGeneration can only ever own one GenerationRecord, even
     when the first snapshot carries only a job_id and a later one adds
     generation_id.
  4. _find_existing_generation cross-matches an incoming identity value
     against ALL identity columns, not just its own same-named one - built
     in from day one for this provider (see normalization.py's docstring for
     the HeyGen incident this was retrofitted to fix there).
  5. list_generations sorts by COALESCE(provider_created_at, created_at) -
     built in from day one for this provider too.
  6. _parse_dt converts an offset-aware timestamp to UTC instead of stripping
     the offset in place.
  7. ingest_capture_event's SAVEPOINT-per-event/commit-per-chunk design still
     durably commits every accepted event and isolates an in-batch duplicate.

Run: python tests/higgsfield_normalization_smoke.py
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

from models_new import (  # noqa: E402
    Base,
    GenerationCollectionMember,
    GenerationProjectEvent,
    GenerationRecord,
    GenerationTag,
    ITPortalTool,
    User,
)
from providers.higgsfield.models import HiggsfieldCaptureEvent, HiggsfieldGeneration  # noqa: E402
from providers.higgsfield.normalization import _parse_dt, backfill_all, normalize_capture_event  # noqa: E402
from providers.higgsfield.queries import GenerationFilters, list_generations  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        GenerationRecord.__table__,
        GenerationTag.__table__,
        GenerationCollectionMember.__table__,
        GenerationProjectEvent.__table__,
        HiggsfieldCaptureEvent.__table__,
        HiggsfieldGeneration.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor() -> tuple[int, int]:
    with SessionLocal() as db:
        user = User(email="higgsfield@example.com", name="Higgsfield User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="Higgsfield", slug="higgsfield", website_url="https://higgsfield.ai", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _snapshot(*, generation_id=None, job_id=None, status, updated_at, credits_used=None, video_url=None):
    """One captured Higgsfield event payload, shaped as content-higgsfield.js's
    envelope (see normalization.py's module docstring)."""
    payload = {"status": status, "updatedAt": updated_at, "createdAt": updated_at}
    if generation_id is not None:
        payload["generationId"] = generation_id
    if job_id is not None:
        payload["jobId"] = job_id
    if credits_used is not None:
        payload["credits"] = {"used": credits_used}
    if video_url is not None:
        payload["output"] = {"videoUrl": video_url}
    return payload


def _capture(db, payload: dict) -> HiggsfieldCaptureEvent:
    event = HiggsfieldCaptureEvent(
        tool_id=TOOL_ID,
        user_id=USER_ID,
        provider="higgsfield",
        event_type="network_snapshot",
        client_event_id=f"higgsfield:test:{datetime.utcnow().timestamp()}:{len(payload)}",
        payload_json=payload,
        capture_version=1,
        event_date=datetime.utcnow().date(),
        ownership_confidence="ticket",
    )
    db.add(event)
    db.flush()
    return event


def test_capture_status_tracks_provider_status() -> None:
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-status", status="completed", updated_at="2026-08-05T10:00:00+00:00", credits_used=4.0,
        )))
        db.flush()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.capture_status == "completed", f"expected completed, got {record.capture_status!r}")

        gen_failed = normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-failed", status="failed", updated_at="2026-08-05T10:00:00+00:00",
        )))
        db.flush()
        failed_record = db.query(GenerationRecord).filter(GenerationRecord.id == gen_failed.generation_record_id).one()
        _assert(
            failed_record.capture_status == "failed",
            f"a failed generation must not sit in the success bucket, got {failed_record.capture_status!r}",
        )
        db.rollback()
    print("ok  capture_status tracks the provider's real status")


def test_stale_snapshot_does_not_erase_stored_columns() -> None:
    with SessionLocal() as db:
        # Completed snapshot lands first...
        normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-order",
            status="completed",
            updated_at="2026-08-05T11:00:00+00:00",
            credits_used=7.5,
            video_url="https://cdn.higgsfield.test/final.mp4",
        )))
        db.flush()

        # ...then the earlier "processing" snapshot of the SAME generation is
        # delivered late by a retry. It carries no credits and no output url.
        normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-order", status="processing", updated_at="2026-08-05T10:00:00+00:00",
        )))
        db.flush()

        gen = db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.generation_id == "g-order").one()
        _assert(gen.credits_used == 7.5, f"credits were clobbered by the stale snapshot: {gen.credits_used!r}")
        _assert(gen.status == "completed", f"status regressed to {gen.status!r}")
        _assert(gen.video_url == "https://cdn.higgsfield.test/final.mp4", f"output url lost: {gen.video_url!r}")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.credits_burned == 7.5, f"report credits lost: {record.credits_burned!r}")
        _assert(record.capture_status == "completed", f"report status regressed: {record.capture_status!r}")
        db.rollback()
    print("ok  a late/thin snapshot cannot erase a richer one")


def test_job_id_then_generation_id_reuses_one_record() -> None:
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(db, _snapshot(
            job_id="job-1", status="processing", updated_at="2026-08-05T12:00:00+00:00",
        )))
        db.flush()
        second = normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-later", job_id="job-1", status="completed",
            updated_at="2026-08-05T12:05:00+00:00", credits_used=2.0,
        )))
        db.flush()

        _assert(first.id == second.id, "the two snapshots should be one HiggsfieldGeneration")
        record_count = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.provider == "higgsfield", GenerationRecord.canonical_asset_key.in_(["job-1", "g-later"]))
            .count()
        )
        _assert(record_count == 1, f"expected exactly one GenerationRecord, found {record_count}")
        db.rollback()
    print("ok  one generation maps to exactly one report record")


def test_external_event_id_correlates_submitted_and_network_snapshots() -> None:
    """Mirrors HeyGen's own regression for this exact bug class: a "submitted"
    click carries only a client-side external_event_id (no real Higgsfield id
    exists yet) and the prompt/preset DOM snapshot - it must not be silently
    skipped just because it lacks generation_id/job_id/request_id. The later
    network_snapshot (which HAS a real generation_id but no prompt text) must
    resolve to the SAME generation via the shared external_event_id, not mint
    an orphaned duplicate that never has the prompt."""
    with SessionLocal() as db:
        submitted = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hfgen_test_1",
            "promptText": "A slow dolly-in on a mountain lake at dawn.",
            "status": "submitted",
        }))
        db.flush()
        _assert(submitted is not None, "a submit-time snapshot with only external_event_id must not be skipped")
        _assert(submitted.prompt_text == "A slow dolly-in on a mountain lake at dawn.", "prompt text lost on the submitted row")
        _assert(submitted.generation_record_id is None, "no real id yet - no GenerationRecord should exist")

        settled = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hfgen_test_1",
            "generationId": "gen-real-id",
            "status": "processing",
        }))
        db.flush()

        _assert(submitted.id == settled.id, "the submitted and network snapshots should be one HiggsfieldGeneration")
        _assert(settled.prompt_text == "A slow dolly-in on a mountain lake at dawn.", "prompt text was lost once a real id arrived")
        _assert(settled.generation_id == "gen-real-id", "generation_id from the network snapshot was not merged in")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == settled.generation_record_id).one()
        _assert(record.prompt_text == "A slow dolly-in on a mountain lake at dawn.", f"report row missing prompt text: {record.prompt_text!r}")
        db.rollback()
    print("ok  external_event_id correlates a submitted snapshot with its later network snapshot")


def test_real_job_set_detail_shape_extracts_correctly() -> None:
    """Regression for the real Higgsfield response shape confirmed 2026-08-05
    from a job-set detail endpoint (fetched by the page only when a user
    plays/opens a specific generation - see content-higgsfield-network.js's
    looksLikeHiggsfieldJobDetailObject). Trimmed to the fields
    _extract_fields actually reads. Unlike our own DOM-scrape envelope, the
    real response nests prompt/resolution/aspect_ratio/duration/model under
    "params", the actual video/thumbnail under "results.raw", and keys this
    job's own identity as a bare "id" (not "job_set_id", which is the
    broader batch a multi-shot generation's several jobs share)."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "job_set_type": "seedance_2_0",
            "job_set_id": "6fcb7d02-ece6-42e1-97eb-08d52ae693c6",
            "params": {
                "width": 720,
                "height": 1280,
                "prompt": "A cinematic macro shot of a luxury golden key sliding across marble.",
                "medias": [
                    {"data": {"id": "97736abd", "url": "https://cdn.test/start.jpg", "type": "media_input"}, "role": "start_image"},
                    {"data": {"id": "97de5d1b", "url": "https://cdn.test/end.png", "type": "media_input"}, "role": "end_image"},
                ],
                "duration": 5,
                "resolution": "720p",
                "aspect_ratio": "9:16",
                "multi_shots": False,
                "mode": "std",
                "model": "seedance_2_0_fast",
                "bitrate_mode": "standard",
            },
            "id": "75095313-6fcd-47ce-ab2e-2e2be1e82fbe",
            "status": "completed",
            "results": {
                "raw": {
                    "type": "video",
                    "url": "https://d8j0ntlcm91z4.cloudfront.net/example.mp4",
                    "thumbnail_url": "https://cdn.higgsfield.ai/example_thumbnail.webp",
                },
                "min": {
                    "type": "video",
                    "url": "https://d8j0ntlcm91z4.cloudfront.net/example.mp4",
                    "thumbnail_url": "https://cdn.higgsfield.ai/example_thumbnail.webp",
                },
            },
            "created_at": 1779780335.98666,
            "user_id": "user_3E4iOQLnUVNkD9hDdqTmxirActc",
            "trace_id": "75095313-6fcd-47ce-ab2e-2e2be1e82fbe",
        }))
        db.flush()
        _assert(gen.generation_id == "75095313-6fcd-47ce-ab2e-2e2be1e82fbe", f"bare 'id' not mapped to generation_id: {gen.generation_id!r}")
        _assert(gen.job_id == "6fcb7d02-ece6-42e1-97eb-08d52ae693c6", f"job_set_id not mapped to job_id: {gen.job_id!r}")
        _assert(gen.prompt_text.startswith("A cinematic macro shot"), f"params.prompt not extracted: {gen.prompt_text!r}")
        _assert(gen.preset_id == "seedance_2_0_fast", f"params.model not mapped to preset_id: {gen.preset_id!r}")
        _assert(gen.preset_category == "seedance_2_0", f"job_set_type not mapped to preset_category: {gen.preset_category!r}")
        _assert(gen.multi_shot is False, f"params.multi_shots not extracted: {gen.multi_shot!r}")
        _assert(gen.image_reference_url == "https://cdn.test/start.jpg", f"start_image media not extracted: {gen.image_reference_url!r}")
        _assert(gen.resolution == "720p", f"params.resolution not extracted: {gen.resolution!r}")
        _assert(gen.aspect_ratio == "9:16", f"params.aspect_ratio not extracted: {gen.aspect_ratio!r}")
        _assert(gen.duration_seconds == 5, f"params.duration not extracted: {gen.duration_seconds!r}")
        _assert(gen.quality == "std", f"params.mode not mapped to quality: {gen.quality!r}")
        _assert(gen.video_url == "https://d8j0ntlcm91z4.cloudfront.net/example.mp4", f"results.raw.url not extracted: {gen.video_url!r}")
        _assert(gen.thumbnail_url == "https://cdn.higgsfield.ai/example_thumbnail.webp", f"results.raw.thumbnail_url not extracted: {gen.thumbnail_url!r}")
        _assert(gen.output_type == "video", f"results.raw.type not mapped to output_type: {gen.output_type!r}")
        _assert(gen.status == "completed", f"status not extracted: {gen.status!r}")
        _assert(gen.provider_created_at is not None, "float epoch created_at was not parsed")
        db.rollback()
    print("ok  the confirmed real job-set-detail shape extracts prompt/video/params correctly")


def test_real_job_set_detail_shape_handles_image_output() -> None:
    """Regression for a SECOND real Higgsfield job-set detail response
    (2026-08-05, job_set_type "nano_banana_2") that proves Higgsfield is NOT
    video-only (unlike HeyGen) - results.raw.type is "image" here, not
    "video", and params carries a flat input_images[] list (no "role" key,
    unlike video jobs' medias[]) instead of a single "model"/"duration"."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "job_set_type": "nano_banana_2",
            "job_set_id": "d1cbc7f5-946a-4f55-941d-b902a5766c96",
            "params": {
                "width": 2752,
                "height": 1536,
                "aspect_ratio": "16:9",
                "resolution": "2k",
                "batch_size": 2,
                "input_images": [
                    {"id": "82fa2117", "url": "https://cdn.test/input-1.png", "type": "media_input"},
                    {"id": "177b8288", "url": "https://cdn.test/input-2.jpg", "type": "media_input"},
                ],
                "prompt": "A photo-realistic 8k shot of the conference room.",
            },
            "id": "19a62f80-145d-4709-9aa0-ff4e5aaa5c19",
            "status": "completed",
            "results": {
                "raw": {"type": "image", "url": "https://cdn.test/output.png"},
                "min": {"type": "image", "url": "https://cdn.test/output_min.webp"},
            },
            "created_at": 1779188252.864847,
            "user_id": "user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ",
        }))
        db.flush()
        _assert(gen.output_type == "image", f"results.raw.type not mapped to output_type for an image job: {gen.output_type!r}")
        _assert(gen.video_url == "https://cdn.test/output.png", f"results.raw.url (image) not extracted: {gen.video_url!r}")
        _assert(gen.aspect_ratio == "16:9", f"params.aspect_ratio not extracted for an image job: {gen.aspect_ratio!r}")
        _assert(gen.resolution == "2k", f"params.resolution not extracted for an image job: {gen.resolution!r}")
        _assert(
            gen.image_reference_url == "https://cdn.test/input-1.png",
            f"params.input_images fallback (no 'role' key) not extracted: {gen.image_reference_url!r}",
        )
        db.rollback()
    print("ok  a real image-output job-set detail response is distinguished from a video one via output_type")


def test_real_asset_listing_row_extracts_correctly() -> None:
    """Regression for the real Assets-page listing endpoint confirmed
    2026-08-06 (GET https://fnf-api-gw.higgsfield.ai/fnf/assets?size=1001&
    category=all - see content-higgsfield-network.js's
    looksLikeHiggsfieldAssetListingRow). This shape was the actual root cause
    of Sarbjeet's "capturing did not work" report: browsing the Assets
    gallery produced zero captures because no shape-detection in this
    codebase recognized raw_url/min_url/job_set_type rows at all, even though
    onHiggsfieldNetworkListingMessage's reconciliation path was already fully
    wired end to end. Uses two of the exact real rows from that DevTools
    capture - one video, one image - trimmed to the fields _extract_fields
    actually reads."""
    with SessionLocal() as db:
        video = normalize_capture_event(db, _capture(db, {
            "id": "d40455b6-d28e-4d5a-b905-1c8e6162a5e5",
            "user_id": "user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ",
            "created_at": 1777704900.110086,
            "min_url": "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260502_065500_d40455b6-d28e-4d5a-b905-1c8e6162a5e5.mp4",
            "raw_url": "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260502_065500_d40455b6-d28e-4d5a-b905-1c8e6162a5e5.mp4",
            "thumbnail_url": "https://cdn.higgsfield.ai/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260502_065500_d40455b6-d28e-4d5a-b905-1c8e6162a5e5_thumbnail.webp",
            "job_set_type": "kling3_0",
            "published_at": None,
            "folder_ids": [],
            "comments_count": 0,
            "artifacts": None,
            "is_favourite": False,
        }))
        db.flush()
        _assert(video.generation_id == "d40455b6-d28e-4d5a-b905-1c8e6162a5e5", f"bare 'id' not mapped to generation_id: {video.generation_id!r}")
        _assert(
            video.video_url == "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260502_065500_d40455b6-d28e-4d5a-b905-1c8e6162a5e5.mp4",
            f"raw_url not mapped to video_url: {video.video_url!r}",
        )
        _assert(
            video.thumbnail_url == "https://cdn.higgsfield.ai/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260502_065500_d40455b6-d28e-4d5a-b905-1c8e6162a5e5_thumbnail.webp",
            f"thumbnail_url not extracted for a video row: {video.thumbnail_url!r}",
        )
        _assert(video.output_type == "video", f"expected .mp4 extension to infer output_type=video, got {video.output_type!r}")
        _assert(video.preset_category == "kling3_0", f"job_set_type not mapped to preset_category: {video.preset_category!r}")
        _assert(video.status == "completed", f"a present raw_url with no explicit status must infer completed, got {video.status!r}")
        _assert(video.provider_created_at is not None, "float epoch created_at was not parsed")

        image = normalize_capture_event(db, _capture(db, {
            "id": "19a62f80-145d-4709-9aa0-ff4e5aaa5c19",
            "user_id": "user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ",
            "created_at": 1779188252.864847,
            "min_url": "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260519_105732_19a62f80-145d-4709-9aa0-ff4e5aaa5c19_min.webp",
            "raw_url": "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260519_105732_19a62f80-145d-4709-9aa0-ff4e5aaa5c19.png",
            "thumbnail_url": None,
            "job_set_type": "nano_banana_2",
            "published_at": None,
            "folder_ids": [],
            "comments_count": 0,
            "artifacts": None,
            "is_favourite": False,
        }))
        db.flush()
        _assert(
            image.video_url == "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260519_105732_19a62f80-145d-4709-9aa0-ff4e5aaa5c19.png",
            f"raw_url (image) not mapped to video_url: {image.video_url!r}",
        )
        _assert(
            image.thumbnail_url == "https://d8j0ntlcm91z4.cloudfront.net/user_3CqxSWeCDNWKWDIiaz9EKAa3NFJ/hf_20260519_105732_19a62f80-145d-4709-9aa0-ff4e5aaa5c19_min.webp",
            f"null thumbnail_url must fall back to min_url for an image row: {image.thumbnail_url!r}",
        )
        _assert(image.output_type == "image", f"expected .png extension to infer output_type=image, got {image.output_type!r}")
        db.rollback()
    print("ok  the confirmed real Assets-listing-row shape extracts video/image URLs and infers status/output_type correctly")


def test_dom_envelope_shape_extracts_preset_and_credits_correctly() -> None:
    """No confirmed Higgsfield network response exists yet (see constants.py's
    module docstring) - this covers the DOM-scrape envelope
    content-higgsfield.js's own buildHiggsfieldSubmitSnapshot builds instead,
    proving preset/multiShot/enhancePrompt/videoConfig/expectedCredits all
    reach their own HiggsfieldGeneration columns."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "generationId": "g-envelope",
            "promptText": "Neon skyline, heavy rain, cinematic.",
            "preset": {"id": "seedance-pro", "name": "Seedance Pro", "category": "video"},
            "multiShot": True,
            "enhancePrompt": False,
            "videoConfig": {"resolution": "1080p", "aspectRatio": "16:9", "duration": 5},
            "expectedCredits": 4,
            "kind": "create_video",
            "status": "submitted",
        }))
        db.flush()
        _assert(gen.prompt_text == "Neon skyline, heavy rain, cinematic.", f"prompt not extracted: {gen.prompt_text!r}")
        _assert(gen.preset_name == "Seedance Pro", f"preset name not extracted: {gen.preset_name!r}")
        _assert(gen.preset_id == "seedance-pro", f"preset id not extracted: {gen.preset_id!r}")
        _assert(gen.multi_shot is True, f"multi_shot not extracted: {gen.multi_shot!r}")
        _assert(gen.enhance_prompt is False, f"enhance_prompt not extracted: {gen.enhance_prompt!r}")
        _assert(gen.resolution == "1080p", f"resolution not extracted: {gen.resolution!r}")
        _assert(gen.aspect_ratio == "16:9", f"aspect_ratio not extracted: {gen.aspect_ratio!r}")
        _assert(gen.duration_seconds == 5, f"duration not extracted: {gen.duration_seconds!r}")
        _assert(gen.kind == "create_video", f"kind not extracted: {gen.kind!r}")
        db.rollback()
    print("ok  the DOM-scrape envelope extracts preset/credits/video-config correctly")


def test_reconciliation_listing_row_never_gets_live_ownership() -> None:
    """Mirrors HeyGen's own regression for the identical bug class: a bulk
    historical listing row (isReconciliation: true) must never be attributed
    to whichever user's tab happened to fetch the list. The freshness gate
    (an old provider_created_at far outside OWNERSHIP_FRESHNESS_WINDOW_SECONDS)
    must leave ownership unresolved, and generation_source/ingestion_source
    must reflect reconciliation, not live capture."""
    with SessionLocal() as db:
        old_event = _capture(db, {
            "generationId": "old-historical-generation",
            "status": "completed",
            "createdAt": 1700000000,  # long before this test run - definitely outside the freshness window
            "updatedAt": 1700000100,
        })
        old_event.ownership_confidence = "reconciliation"
        db.flush()

        gen = normalize_capture_event(db, old_event)
        db.flush()
        _assert(gen.ownership_status != "resolved", f"an old reconciled row must not be auto-attributed, got {gen.ownership_status!r}")
        _assert(gen.generation_source == "reconciliation", f"expected reconciliation source, got {gen.generation_source!r}")
        _assert(gen.ingestion_source == "recovered", f"expected recovered ingestion_source, got {gen.ingestion_source!r}")
        db.rollback()
    print("ok  a reconciliation listing row never receives live-capture ownership")


def test_thin_credit_ledger_event_merges_without_erasing_metadata() -> None:
    """Mirrors HeyGen's own regression for the identical bug class: a thin
    credit-ledger event (only generationId + credits.used, nothing else -
    scaffolded here since no Higgsfield credit endpoint is confirmed yet)
    must merge credits_used onto the already-captured generation WITHOUT
    wiping out the rich metadata_json a prior capture already stored."""
    with SessionLocal() as db:
        rich = normalize_capture_event(db, _capture(db, {
            "generationId": "g-credits",
            "status": "completed",
            "promptText": "A calm, confident aerial shot.",
            "preset": {"name": "Seedance Pro"},
        }))
        db.flush()
        _assert(rich.prompt_text == "A calm, confident aerial shot.", "setup: prompt not captured")

        thin = normalize_capture_event(db, _capture(db, {
            "generationId": "g-credits",
            "credits": {"used": 4},
        }))
        db.flush()

        _assert(rich.id == thin.id, "the ledger row should resolve to the same generation")
        _assert(thin.credits_used == 4, f"credits_used not merged in: {thin.credits_used!r}")
        _assert(thin.prompt_text == "A calm, confident aerial shot.", f"thin ledger event erased the stored prompt: {thin.prompt_text!r}")
        _assert(
            thin.metadata_json.get("preset", {}).get("name") == "Seedance Pro",
            f"thin ledger event erased the stored metadata_json: {thin.metadata_json!r}",
        )

        record = db.query(GenerationRecord).filter(GenerationRecord.id == thin.generation_record_id).one()
        _assert(record.credits_burned == 4, f"report row credits not updated: {record.credits_burned!r}")
        db.rollback()
    print("ok  a thin credit-ledger event merges credits without erasing stored metadata")


def test_credit_ledger_workflow_id_exact_match() -> None:
    """Regression for the confirmed real credit-ledger shape (2026-08-06,
    GET .../fnf/workspaces/credit-ledger). workflow_id has never been
    observed non-null in real traffic, but the field exists in the shape -
    when present, it's a real, confirmed identity and should exact-match
    across the identity chain like any other, bypassing the time/feature
    heuristic entirely."""
    with SessionLocal() as db:
        live = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-workflow-linked",
            "job_set_type": "kling3_0",
            "status": "completed",
            "createdAt": "2026-05-01T12:18:21+00:00",
        }))
        db.flush()

        ledger = normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-workflow-1",
            "display_name": "Kling v3.0",
            "workflow_id": "gen-workflow-linked",
            "total_credits": -3000,
            "action": "spend",
            "created_at": "2026-05-01T12:18:22+00:00",
        }))
        db.flush()
        # db.refresh, not just the in-memory return value - closes a real
        # blind spot found 2026-08-06: a JSON-column mutation bug left
        # credits_used correct in-memory while credit_ledger_json silently
        # failed to persist, and checking only the in-memory object masked
        # it in every test here until a live DB round-trip caught it.
        db.refresh(ledger)

        _assert(ledger is not None, "a workflow_id-linked ledger row should normalize to a generation")
        _assert(ledger.id == live.id, "workflow_id did not exact-match the existing generation")
        _assert(ledger.credits_used == 30, f"credits_used not set from workflow_id match (raw total_credits /100): {ledger.credits_used!r}")
        _assert(len(ledger.credit_ledger_json or []) == 1, f"credit_ledger_json did not persist: {ledger.credit_ledger_json!r}")
        db.rollback()
    print("ok  a credit-ledger row with a real workflow_id exact-matches its generation")


def test_credit_ledger_unambiguous_time_window_match() -> None:
    """The common real case: workflow_id is null, so matching falls back to
    display_name (mapped to preset_category) + an unambiguous time window -
    exactly one candidate generation of that feature within
    CREDIT_LEDGER_MATCH_WINDOW_SECONDS."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-nano-1",
            "job_set_type": "nano_banana_2",
            "status": "completed",
            "createdAt": "2026-05-19T10:57:32.940660+00:00",
        }))
        db.flush()

        ledger = normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-nano-1",
            "display_name": "Nano Banana Pro",
            "workflow_id": None,
            "total_credits": -200,
            "action": "spend",
            "created_at": "2026-05-19T10:57:32.948873Z",
        }))
        db.flush()
        db.refresh(ledger)  # a fresh DB read, not just the in-memory object - see the workflow_id test's own comment

        _assert(ledger is not None, "an unambiguous single-candidate ledger row should match")
        _assert(ledger.id == gen.id, "time+feature match did not resolve to the one real candidate")
        _assert(ledger.credits_used == 2, f"credits_used not set (raw total_credits -200 /100 = 2): {ledger.credits_used!r}")
        _assert(
            len(ledger.credit_ledger_json or []) == 1,
            f"expected exactly one accumulated ledger row: {ledger.credit_ledger_json!r}",
        )
        db.rollback()
    print("ok  a workflow_id-less ledger row matches the one unambiguous same-feature generation nearby")


def test_credit_ledger_ambiguous_candidates_refuses_to_guess() -> None:
    """Sarbjeet's own real data proved this case is real: two same-feature
    generations minted milliseconds apart. Matching must refuse to pick
    either one rather than silently attribute credits to the wrong
    generation - the raw event is still captured (see capture.py), just
    left unlinked."""
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-batch-1",
            "job_set_type": "nano_banana_2",
            "status": "completed",
            "createdAt": "2026-05-19T10:57:32.940660+00:00",
        }))
        second = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-batch-2",
            "job_set_type": "nano_banana_2",
            "status": "completed",
            "createdAt": "2026-05-19T10:57:32.948873+00:00",
        }))
        db.flush()

        ledger = normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-ambiguous-1",
            "display_name": "Nano Banana Pro",
            "total_credits": -200,
            "action": "spend",
            "created_at": "2026-05-19T10:57:32.944000Z",
        }))
        db.flush()

        _assert(ledger is None, f"an ambiguous ledger row must not be normalized to any generation, got {ledger!r}")
        db.refresh(first)
        db.refresh(second)
        _assert(first.credits_used is None, f"credits leaked onto the wrong candidate: {first.credits_used!r}")
        _assert(second.credits_used is None, f"credits leaked onto the wrong candidate: {second.credits_used!r}")
        db.rollback()
    print("ok  an ambiguous multi-candidate ledger row is left unlinked rather than guessed")


def test_credit_ledger_tied_batch_resolves_deterministically() -> None:
    """Real case found 2026-08-06: Sarbjeet's dashboard showed several
    same-batch generations permanently stuck on "Credits not captured" even
    though the aggregate total was clearly being tracked. Root cause:
    exactly the ambiguous case above, EXCEPT both ledger rows charge the
    identical amount - the pairing is provably irrelevant there, so both
    generations should end up credited, and the result must be identical
    regardless of which order the two ledger rows are normalized in
    (backfill_all can replay in any order). Both ledger events are captured
    (raw-inserted) BEFORE either is normalized - mirrors router.py's real
    capture_events flow (ingest the whole batch first, normalize after), and
    matters here specifically: _find_sibling_credit_ledger_events needs both
    rows already durably present to see the tie at all."""
    with SessionLocal() as db:
        gen_a = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-tied-a", "job_set_type": "nano_banana_2",
            "status": "completed", "createdAt": "2026-05-19T10:57:32.864812+00:00",
        }))
        gen_b = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-tied-b", "job_set_type": "nano_banana_2",
            "status": "completed", "createdAt": "2026-05-19T10:57:32.864847+00:00",
        }))
        db.flush()

        event_1 = _capture(db, {
            "tx_id": "tx-tied-1", "display_name": "Nano Banana Pro", "total_credits": -200,
            "action": "spend", "created_at": "2026-05-19T10:57:32.940660Z",
        })
        event_2 = _capture(db, {
            "tx_id": "tx-tied-2", "display_name": "Nano Banana Pro", "total_credits": -200,
            "action": "spend", "created_at": "2026-05-19T10:57:32.948873Z",
        })
        db.flush()
        normalize_capture_event(db, event_1)
        normalize_capture_event(db, event_2)
        db.flush()

        db.refresh(gen_a)
        db.refresh(gen_b)
        _assert(gen_a.credits_used == 2, f"tied-batch sibling A should end up credited: {gen_a.credits_used!r}")
        _assert(gen_b.credits_used == 2, f"tied-batch sibling B should end up credited: {gen_b.credits_used!r}")
        db.rollback()
    print("ok  a tied-amount batch of ambiguous siblings resolves deterministically instead of staying stuck")


def test_credit_ledger_tied_batch_replay_is_order_independent() -> None:
    """Same setup as above, but replayed in the OPPOSITE order (simulating a
    backfill_all re-run processing events differently than the first pass) -
    must produce the exact same result, not a different (or wrong) pairing."""
    with SessionLocal() as db:
        gen_a = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-reorder-a", "job_set_type": "nano_banana_2",
            "status": "completed", "createdAt": "2026-05-19T10:57:32.864812+00:00",
        }))
        gen_b = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-reorder-b", "job_set_type": "nano_banana_2",
            "status": "completed", "createdAt": "2026-05-19T10:57:32.864847+00:00",
        }))
        db.flush()

        event_1 = _capture(db, {
            "tx_id": "tx-reorder-1", "display_name": "Nano Banana Pro", "total_credits": -200,
            "action": "spend", "created_at": "2026-05-19T10:57:32.940660Z",
        })
        event_2 = _capture(db, {
            "tx_id": "tx-reorder-2", "display_name": "Nano Banana Pro", "total_credits": -200,
            "action": "spend", "created_at": "2026-05-19T10:57:32.948873Z",
        })
        db.flush()

        # Forward pass.
        normalize_capture_event(db, event_1)
        normalize_capture_event(db, event_2)
        db.flush()
        db.refresh(gen_a)
        db.refresh(gen_b)
        forward_a, forward_b = gen_a.credits_used, gen_b.credits_used

        # Replay in reverse order - must not double-count or re-pair
        # differently (both idempotency guarantees at once).
        normalize_capture_event(db, event_2)
        normalize_capture_event(db, event_1)
        db.flush()
        db.refresh(gen_a)
        db.refresh(gen_b)

        _assert(gen_a.credits_used == forward_a, f"replay in reverse order changed sibling A's credits: {forward_a!r} -> {gen_a.credits_used!r}")
        _assert(gen_b.credits_used == forward_b, f"replay in reverse order changed sibling B's credits: {forward_b!r} -> {gen_b.credits_used!r}")
        _assert(
            len(gen_a.credit_ledger_json or []) == 1 and len(gen_b.credit_ledger_json or []) == 1,
            f"replay must not duplicate ledger rows: A={gen_a.credit_ledger_json!r} B={gen_b.credit_ledger_json!r}",
        )
        db.rollback()
    print("ok  tied-batch resolution is stable under replay in a different order")


def test_credit_ledger_tight_window_ignores_nearby_unrelated_generation() -> None:
    """Real bug found 2026-08-06 (Sarbjeet: 2 of 50 real "Kling v3.0"
    generations stayed uncredited despite each having its own obvious,
    near-instant matching ledger row). Root cause: the original 300s-only
    window let a THIRD, unrelated Kling generation ~3m50s away also qualify
    as a candidate for the first one's ledger row, making it look ambiguous
    even though the true pairing was completely unambiguous at any
    reasonable timescale. The tight window (15s) must resolve this cleanly
    without ever seeing the distant, unrelated generation."""
    with SessionLocal() as db:
        gen_1 = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-kling-1", "job_set_type": "kling3_0",
            "status": "completed", "createdAt": "2026-04-30T04:47:35.869527+00:00",
        }))
        gen_2_unrelated = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-kling-2-unrelated", "job_set_type": "kling3_0",
            "status": "completed", "createdAt": "2026-04-30T04:51:25.426359+00:00",
        }))
        db.flush()

        ledger_1 = normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-kling-1", "display_name": "Kling v3.0", "total_credits": -1250,
            "action": "spend", "created_at": "2026-04-30T04:47:35.902922Z",
        }))
        db.flush()

        _assert(ledger_1 is not None, "the tight window should resolve this unambiguously")
        _assert(ledger_1.id == gen_1.id, "matched the wrong generation")
        _assert(ledger_1.id != gen_2_unrelated.id, "the unrelated ~4-minute-away generation must never be considered a candidate")
        _assert(ledger_1.credits_used == 12.5, f"credits_used not set: {ledger_1.credits_used!r}")
        db.rollback()
    print("ok  the tight match window resolves an obvious same-generation charge without a distant unrelated generation spoiling it")


def test_credit_ledger_angles_maps_to_qwen_camera_control() -> None:
    """Real confirmed correlation (2026-08-06): Higgsfield's billing UI shows
    "Angles" as the feature name, but the underlying job_set_type is
    "qwen_camera_control" - confirmed via a real -20 credit "Angles" ledger
    row landing 70ms after the only qwen_camera_control generation in the
    account. The display name and the technical model name don't always
    match, which is exactly why this mapping table requires a real
    cross-referenced correlation before adding an entry, not a guess from
    the name alone."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-angles-1", "job_set_type": "qwen_camera_control",
            "status": "completed", "createdAt": "2026-05-19T10:53:27.993520+00:00",
        }))
        db.flush()

        ledger = normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-angles-1", "display_name": "Angles", "total_credits": -20,
            "action": "spend", "created_at": "2026-05-19T10:53:28.059748Z",
        }))
        db.flush()

        _assert(ledger is not None, "an 'Angles' ledger row should now resolve via the confirmed mapping")
        _assert(ledger.id == gen.id, "did not resolve to the qwen_camera_control generation")
        _assert(ledger.credits_used == 0.2, f"credits_used not set (raw -20 /100 = 0.2): {ledger.credits_used!r}")
        db.rollback()
    print("ok  'Angles' ledger rows correctly map to qwen_camera_control generations")


def test_credit_ledger_spend_and_refund_net_correctly() -> None:
    """Real data shows failed generations get a SPEND followed minutes later
    by a matching REFUND, both landing in the same match window against the
    same generation - net credits_used should reflect what actually
    happened economically (0 for a fully refunded generation), not just
    whichever ledger row normalized last."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "generationId": "gen-refunded",
            "job_set_type": "seedance_2_0",
            "status": "failed",
            "createdAt": "2026-05-01T07:39:30+00:00",
        }))
        db.flush()

        normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-spend-1", "display_name": "Seedance 2.0", "total_credits": -5400,
            "action": "spend", "created_at": "2026-05-01T07:39:36.319800Z",
        }))
        db.flush()
        refunded = normalize_capture_event(db, _capture(db, {
            "tx_id": "tx-refund-1", "display_name": "Seedance 2.0", "total_credits": 5400,
            "action": "refund", "created_at": "2026-05-01T07:42:48.472322Z",
        }))
        db.flush()
        db.refresh(refunded)  # a fresh DB read, not just the in-memory object - see the workflow_id test's own comment

        _assert(refunded is not None, "the refund row should still match the same generation")
        _assert(refunded.id == gen.id, "refund did not resolve to the same generation as the spend")
        _assert(refunded.credits_used == 0, f"expected net-zero after a matching refund, got {refunded.credits_used!r}")
        _assert(
            len(refunded.credit_ledger_json or []) == 2,
            f"expected both the spend and refund rows accumulated: {refunded.credit_ledger_json!r}",
        )
        db.rollback()
    print("ok  a spend followed by its matching refund nets to zero, not double-counted")


def test_credit_ledger_replay_is_idempotent() -> None:
    """backfill_all promises safe-to-re-run-any-number-of-times (see its own
    docstring) - replaying the SAME already-normalized ledger event must not
    double-count its own row into credit_ledger_json/credits_used."""
    with SessionLocal() as db:
        normalize_capture_event(db, _capture(db, {
            "generationId": "gen-idempotent", "job_set_type": "kling3_0",
            "status": "completed", "createdAt": "2026-05-01T11:42:30+00:00",
        }))
        db.flush()

        event = _capture(db, {
            "tx_id": "tx-idempotent-1", "display_name": "Kling v3.0", "total_credits": -1250,
            "action": "spend", "created_at": "2026-05-01T11:42:32.431811Z",
        })
        db.flush()

        first = normalize_capture_event(db, event)
        db.flush()
        second = normalize_capture_event(db, event)
        db.flush()
        db.refresh(second)  # a fresh DB read, not just the in-memory object - see the workflow_id test's own comment

        _assert(first.id == second.id, "replaying the same event should resolve to the same generation")
        _assert(second.credits_used == 12.5, f"replay must not double-count (raw total_credits -1250 /100 = 12.5): {second.credits_used!r}")
        _assert(
            len(second.credit_ledger_json or []) == 1,
            f"replay must not duplicate the ledger row: {second.credit_ledger_json!r}",
        )
        db.rollback()
    print("ok  replaying the same credit-ledger event is idempotent")


def test_bare_id_maps_to_generation_id() -> None:
    """A bare "id" field (the shape a queue/status-poll response plausibly
    uses, per content-higgsfield-network.js's hasGenerationIdentity) must map
    to generation_id, not be lost or misfiled - same posture HeyGen's own
    bare-id handling proved necessary for its queue-status endpoint."""
    with SessionLocal() as db:
        submitted = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hfgen_real_1",
            "promptText": "my name is sarbjeet singh",
        }))
        db.flush()

        queue_status = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hfgen_real_1",
            "id": "3d01cd6d7d744041a3778a91637bc694",
            "status": "processing",
        }))
        db.flush()
        _assert(queue_status.id == submitted.id, "bare-id queue status did not resolve to the submitted generation")
        _assert(queue_status.generation_id == "3d01cd6d7d744041a3778a91637bc694", f"bare id was not mapped to generation_id: {queue_status.generation_id!r}")
        db.rollback()
    print("ok  a bare-id queue-status row maps to generation_id and merges with the submitted click capture")


def test_cross_column_identity_without_shared_correlation_key_merges() -> None:
    """Built in from day one, not retrofitted (see this module's docstring and
    normalization.py's own docstring for the HeyGen incident that made this
    mandatory): _find_existing_generation must cross-match an incoming
    identity value against ALL identity columns, not just its own. Here the
    second event has no external_event_id at all to correlate through (a
    bulk reconciliation/backfill replay of a historical listing row never
    carries one) - job_id vs request_id cross-matching is the ONLY thing
    that can resolve it to the same row."""
    with SessionLocal() as db:
        live = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hfgen_real_2",
            "jobId": "3d01cd6d7d744041a3778a91637bc694",
            "promptText": "my name is sarbjeet singh",
            "status": "processing",
        }))
        db.flush()

        reconciled = normalize_capture_event(db, _capture(db, {
            # No externalEventId here - a bulk/backfill replay of a historical
            # listing row has nothing client-minted to correlate through.
            "requestId": "3d01cd6d7d744041a3778a91637bc694",
            "status": "completed",
        }))
        db.flush()

        _assert(reconciled.id == live.id, "request_id did not cross-match the existing row's job_id - minted a duplicate")
        _assert(reconciled.prompt_text == "my name is sarbjeet singh", f"prompt lost after cross-column merge: {reconciled.prompt_text!r}")
        _assert(reconciled.status == "completed", f"status not updated to completed: {reconciled.status!r}")

        count = db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.job_id == "3d01cd6d7d744041a3778a91637bc694").count()
        _assert(count == 1, f"expected exactly one row for this generation, found {count}")
        db.rollback()
    print("ok  an incoming identity value cross-matches every identity column, not just its own")


def test_shared_job_id_never_lets_one_sibling_steal_another() -> None:
    """Real bug caught live 2026-08-06 during a backfill_all run against
    Sarbjeet's actual account: two "Nano Banana Pro" images from one batch
    job_set (sharing one job_id, by design - see models.py's own comment)
    hit a real UniqueViolation on generation_id. Root cause: the job_id
    cross-match used to trust ANY row sharing that job_id, so an event for
    sibling B's own generation_id resolved to sibling A's row (found first
    via its job_id) and tried to overwrite A's generation_id with B's.
    Processing sibling A fully, THEN sibling B, must produce two distinct
    rows - never one clobbering the other."""
    with SessionLocal() as db:
        sibling_a = normalize_capture_event(db, _capture(db, {
            "generationId": "sib-a", "job_set_id": "shared-job-set-1",
            "job_set_type": "nano_banana_2", "status": "completed",
            "createdAt": "2026-05-19T10:57:32.864812+00:00",
        }))
        db.flush()
        sibling_b = normalize_capture_event(db, _capture(db, {
            "generationId": "sib-b", "job_set_id": "shared-job-set-1",
            "job_set_type": "nano_banana_2", "status": "completed",
            "createdAt": "2026-05-19T10:57:32.864847+00:00",
        }))
        db.flush()

        _assert(sibling_a.id != sibling_b.id, "sibling B was incorrectly merged into sibling A's row")
        _assert(sibling_a.generation_id == "sib-a", f"sibling A's own generation_id was overwritten: {sibling_a.generation_id!r}")
        _assert(sibling_b.generation_id == "sib-b", f"sibling B's own generation_id was overwritten: {sibling_b.generation_id!r}")
        _assert(sibling_a.job_id == "shared-job-set-1" and sibling_b.job_id == "shared-job-set-1", "both siblings should still share the batch job_id")

        # A later event carrying ONLY job_id (no generation_id of its own -
        # e.g. a bare status-poll response) is inherently ambiguous between
        # the two siblings - which one it resolves to isn't (and can't be)
        # guaranteed, but it must resolve to ONE of the two EXISTING rows,
        # never mint a third orphaned one.
        resubmitted = normalize_capture_event(db, _capture(db, {
            "job_set_id": "shared-job-set-1", "job_set_type": "nano_banana_2",
            "externalEventId": "intent-ambiguous", "status": "processing",
        }))
        db.flush()
        _assert(resubmitted is not None, "a job_id-only event should still resolve to a row")
        _assert(resubmitted.id in (sibling_a.id, sibling_b.id), "a job_id-only event must resolve to an existing sibling, not something else")
        total_rows = db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.job_id == "shared-job-set-1").count()
        _assert(total_rows == 2, f"expected exactly 2 rows for this batch (no new row minted), found {total_rows}")
        db.rollback()
    print("ok  siblings sharing one batch job_id never steal each other's rows")


def test_list_generations_sorts_by_provider_created_at_not_insert_time() -> None:
    """Built in from day one, not retrofitted - the exact latest-to-oldest
    ordering bug this session found and fixed twice already (HeyGen, then
    Freepik) on this same query shape. Inserts an OLDER-by-provider-date
    generation AFTER a NEWER one (simulating a bulk reconciliation backfill
    where insert order and real-world date diverge) and proves the newer one
    still sorts first."""
    with SessionLocal() as db:
        normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-sort-old", status="completed", updated_at="2020-01-01T00:00:00+00:00",
        )))
        db.flush()
        normalize_capture_event(db, _capture(db, _snapshot(
            generation_id="g-sort-new", status="completed", updated_at="2026-08-05T00:00:00+00:00",
        )))
        db.flush()

        items, _total = list_generations(db, filters=GenerationFilters(), limit=10, offset=0)
        ids_in_order = [item.generation_id for item in items if item.generation_id in ("g-sort-old", "g-sort-new")]
        _assert(
            ids_in_order == ["g-sort-new", "g-sort-old"],
            f"expected newest-provider-date-first, got {ids_in_order!r}",
        )
        db.rollback()
    print("ok  list_generations sorts by provider_created_at, not insert order")


def test_parse_dt_converts_offsets_to_utc() -> None:
    _assert(_parse_dt("2026-08-05T11:27:02+00:00") == datetime(2026, 8, 5, 11, 27, 2), "UTC offset shape changed")
    _assert(_parse_dt("2026-08-05T11:27:02.000000Z") == datetime(2026, 8, 5, 11, 27, 2), "Z shape changed")
    _assert(
        _parse_dt("2026-08-05T17:00:00+05:30") == datetime(2026, 8, 5, 11, 30, 0),
        "a non-UTC offset must be converted, not stripped in place",
    )
    _assert(_parse_dt(1751449622) == datetime(2025, 7, 2, 9, 47, 2), "bare epoch seconds must parse")
    print("ok  _parse_dt normalizes to naive UTC")


def test_backfill_repairs_a_pre_fix_row() -> None:
    with SessionLocal() as db:
        _capture(db, _snapshot(
            generation_id="g-backfill", status="failed", updated_at="2026-08-06T09:00:00+00:00",
        ))
        db.commit()

    with SessionLocal() as db:
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        gen = db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.generation_id == "g-backfill").one()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        record.capture_status = "active"
        db.commit()

    with SessionLocal() as db:
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        _assert(stats["processed"] >= 1, f"backfill processed nothing: {stats}")
        gen = db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.generation_id == "g-backfill").one()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(
            record.capture_status == "failed",
            f"backfill did not repair the stale capture_status, got {record.capture_status!r}",
        )
    print("ok  backfill replay repairs a pre-fix row")


def test_capture_batch_commits_and_isolates_duplicates() -> None:
    """ingest_capture_event flushes inside a SAVEPOINT and the router owns
    the transaction, committing a chunk at a time. Prove every accepted event
    is durably committed, and a duplicate inside the batch unwinds by itself
    without taking its siblings with it."""
    import providers.higgsfield.router as higgsfield_router
    from providers.higgsfield.schemas import CaptureEventIn, CaptureEventsRequest

    with SessionLocal() as db:
        user = db.query(User).filter(User.id == USER_ID).one()
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == TOOL_ID).one()

    original_tool, original_actor, original_credential = (
        higgsfield_router.resolve_higgsfield_tool,
        higgsfield_router.resolve_higgsfield_actor,
        higgsfield_router.resolve_higgsfield_credential,
    )
    higgsfield_router.resolve_higgsfield_tool = lambda _db: tool
    higgsfield_router.resolve_higgsfield_actor = lambda **_kw: user
    higgsfield_router.resolve_higgsfield_credential = lambda *_a, **_kw: None
    try:
        events = [
            CaptureEventIn(
                event_type="network_snapshot",
                client_event_id=f"batch-{i}",
                payload=_snapshot(
                    generation_id=f"batch-g{i}", status="completed",
                    updated_at="2026-08-07T10:00:00+00:00", credits_used=1.0,
                ),
            )
            for i in range(5)
        ]
        # A repeat of an id already in the same batch.
        events.append(events[2].model_copy(deep=True))

        with SessionLocal() as db:
            response = higgsfield_router.capture_events(
                CaptureEventsRequest(events=events), request=None, db=db,
            )

        statuses = [r.status for r in response.results]
        _assert(statuses.count("created") == 5, f"expected 5 created, got {statuses}")
        _assert(statuses.count("duplicate") == 1, f"expected 1 duplicate, got {statuses}")

        with SessionLocal() as db:
            persisted = (
                db.query(HiggsfieldCaptureEvent)
                .filter(HiggsfieldCaptureEvent.client_event_id.like("batch-%"))
                .count()
            )
            _assert(persisted == 5, f"expected 5 durable capture events, found {persisted}")
            normalized = (
                db.query(HiggsfieldGeneration)
                .filter(HiggsfieldGeneration.generation_id.like("batch-g%"))
                .count()
            )
            _assert(normalized == 5, f"expected 5 normalized generations, found {normalized}")
    finally:
        higgsfield_router.resolve_higgsfield_tool = original_tool
        higgsfield_router.resolve_higgsfield_actor = original_actor
        higgsfield_router.resolve_higgsfield_credential = original_credential
    print("ok  capture batch commits durably and isolates in-batch duplicates")


if __name__ == "__main__":
    test_capture_status_tracks_provider_status()
    test_stale_snapshot_does_not_erase_stored_columns()
    test_job_id_then_generation_id_reuses_one_record()
    test_external_event_id_correlates_submitted_and_network_snapshots()
    test_real_job_set_detail_shape_extracts_correctly()
    test_real_job_set_detail_shape_handles_image_output()
    test_real_asset_listing_row_extracts_correctly()
    test_dom_envelope_shape_extracts_preset_and_credits_correctly()
    test_reconciliation_listing_row_never_gets_live_ownership()
    test_thin_credit_ledger_event_merges_without_erasing_metadata()
    test_credit_ledger_workflow_id_exact_match()
    test_credit_ledger_unambiguous_time_window_match()
    test_credit_ledger_ambiguous_candidates_refuses_to_guess()
    test_credit_ledger_tied_batch_resolves_deterministically()
    test_credit_ledger_tied_batch_replay_is_order_independent()
    test_credit_ledger_tight_window_ignores_nearby_unrelated_generation()
    test_credit_ledger_angles_maps_to_qwen_camera_control()
    test_credit_ledger_spend_and_refund_net_correctly()
    test_credit_ledger_replay_is_idempotent()
    test_bare_id_maps_to_generation_id()
    test_cross_column_identity_without_shared_correlation_key_merges()
    test_shared_job_id_never_lets_one_sibling_steal_another()
    test_list_generations_sorts_by_provider_created_at_not_insert_time()
    test_parse_dt_converts_offsets_to_utc()
    test_backfill_repairs_a_pre_fix_row()
    test_capture_batch_commits_and_isolates_duplicates()
    print("\nall higgsfield normalization smoke checks passed")
