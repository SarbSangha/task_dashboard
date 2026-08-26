# providers/suno/router.py
"""
API surface for the Suno (suno.com) provider. Raw capture ingestion mirrors
providers/elevenlabs/router.py's ticket-based per-event actor resolution
(not ChatGPT's plain-session one - see CAPTURE_CONTRACT.md for why), inline
normalization, and a minimal admin-gated read surface for manual
verification. No sync-cursor/reconciliation endpoints or health-ping endpoint
in this first pass - see CAPTURE_CONTRACT.md's scope note.
"""
import base64
import logging
from datetime import datetime
from mimetypes import guess_extension
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import desc, func
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.suno.capture import (
    ingest_capture_event,
    resolve_suno_actor,
    resolve_suno_credential,
    resolve_suno_tool,
)
from providers.suno.constants import INGEST_COMMIT_CHUNK_SIZE, PROVIDER
from providers.suno.models import SunoCaptureEvent, SunoGeneration
from providers.suno.normalization import normalize_capture_events_batch
from providers.suno.schemas import (
    CaptureAudioIn,
    CaptureAudioResult,
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    EventDetailOut,
    EventListOut,
    GenerationDetailOut,
    GenerationListOut,
    PaginationOut,
)
from utils import r2_storage
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/suno", tags=["suno"])
logger = logging.getLogger("suno_router")

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _attach_owner_names(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName into each already-serialized generation dict (batch-
    loaded, not per-row) - mirrors providers/elevenlabs/router.py's identical
    helper. SunoGeneration itself only stores owner_user_id (no cached
    display field, to avoid staleness if an employee is renamed), so the
    dashboard card/detail views need this or they fall back to
    "User #<id>"."""
    owner_ids = {item.get("ownerUserId") for item in dicts if item.get("ownerUserId")}
    if not owner_ids:
        return dicts
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(owner_ids)).all()}
    for item in dicts:
        user = users_by_id.get(item.get("ownerUserId"))
        item["ownerName"] = user.name if user else None
    return dicts


def _attach_event_user_names(db: Session, dicts: list[dict]) -> list[dict]:
    """Same idea as _attach_owner_names, for the raw event feed's userId
    (the actor who triggered/reported the event, not necessarily the same
    row as a generation's owner_user_id)."""
    user_ids = {item.get("userId") for item in dicts if item.get("userId")}
    if not user_ids:
        return dicts
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(user_ids)).all()}
    for item in dicts:
        user = users_by_id.get(item.get("userId"))
        item["userName"] = user.name if user else None
    return dicts


def _ownership_confidence(*, is_reconciliation: bool, has_ticket: bool) -> str:
    if is_reconciliation:
        return "reconciliation"
    return "ticket" if has_ticket else "session"


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_suno_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="suno tool is not configured")
                for item in payload.events
            ],
        )

    results = []
    newly_created_events = []
    pending_since_commit = 0
    # Memoized per unique (usage_ticket, extension_ticket, explicit_credential_id)
    # triple, NOT resolved once for the whole request - see
    # providers/elevenlabs/router.py's identical comment for why a shared
    # multi-tab queue makes per-request resolution unsafe here (unlike
    # ChatGPT's session-based router, where it's safe).
    resolution_cache: dict = {}

    for item in payload.events:
        cache_key = (item.usage_ticket, item.extension_ticket, item.credential_id)
        cached = resolution_cache.get(cache_key)
        if cached is not None:
            current_user, credential_id, cached_error = cached
            if cached_error is not None:
                results.append(
                    CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason=cached_error)
                )
                continue
        else:
            try:
                current_user = resolve_suno_actor(
                    request=request,
                    db=db,
                    tool=tool,
                    usage_ticket=item.usage_ticket,
                    extension_ticket=item.extension_ticket,
                )
            except HTTPException as error:
                resolution_cache[cache_key] = (None, None, str(error.detail))
                results.append(
                    CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason=str(error.detail))
                )
                continue

            credential = resolve_suno_credential(
                db,
                tool_id=tool.id,
                user_id=current_user.id,
                explicit_credential_id=item.credential_id,
            )
            credential_id = credential.id if credential else None
            resolution_cache[cache_key] = (current_user, credential_id, None)

        outcome = ingest_capture_event(
            db,
            tool=tool,
            credential_id=credential_id,
            user=current_user,
            event_type=item.event_type,
            client_event_id=item.client_event_id,
            creation_id=item.creation_id,
            family_id=item.family_id,
            payload=item.payload,
            capture_version=item.capture_version,
            extension_version=item.extension_version,
            browser=item.browser,
            tab_id=item.tab_id,
            session_id=item.session_id,
            extension_session_id=item.extension_session_id,
            event_date=item.event_date,
            task_id=item.linked_task_id,
            client_id=item.linked_client_id,
            ownership_confidence=_ownership_confidence(
                is_reconciliation=item.is_reconciliation,
                has_ticket=bool(item.usage_ticket or item.extension_ticket),
            ),
        )
        if outcome.status == "created" and outcome.event is not None:
            newly_created_events.append(outcome.event)
        results.append(
            CaptureEventResult(
                client_event_id=item.client_event_id,
                status=outcome.status,
                id=outcome.event.id if outcome.event else None,
                reason=outcome.reason,
            )
        )

        # ingest_capture_event flushes inside a savepoint but never commits -
        # the transaction is ours. Commit a chunk at a time.
        pending_since_commit += 1
        if pending_since_commit >= INGEST_COMMIT_CHUNK_SIZE:
            db.commit()
            pending_since_commit = 0

    if pending_since_commit:
        db.commit()

    if newly_created_events:
        # Normalization failure must never turn a successful, lossless
        # ingest into an error response - every event above is already
        # committed at this point, so nothing here can lose raw data.
        try:
            normalize_capture_events_batch(db, newly_created_events)
        except Exception:
            logger.exception("suno normalization batch failed for %d event(s)", len(newly_created_events))
            db.rollback()

    return CaptureEventsResponse(success=True, results=results)


# ==================== Audio asset push ====================
# Suno's confirmed `/api/feed/v3` clip carries `audio_url`/`media_urls`
# directly (audiopipe.suno.ai / cdn2.suno.ai) - unlike ElevenLabs' TTS
# history rows, which have no asset URL at all. Whether those URLs are
# fetchable by this backend directly (vs. requiring the browser's own
# session) has not been tested, so this endpoint is kept for parity with
# ElevenLabs' push model regardless: the extension observes the real audio
# response in the browser and pushes the bytes here directly, which is
# always correct even if a future pass confirms a pull-based mirror could
# also work. No periodic pull-based sweep exists for this provider in this
# pass (see main.py - same deliberate omission as ElevenLabs, no
# asset_mirror.py module for Suno).

MAX_AUDIO_BYTES = 25 * 1024 * 1024  # generous for a single music clip; guards against a pathological payload


@router.post("/capture/audio", response_model=CaptureAudioResult)
def capture_audio(
    payload: CaptureAudioIn,
    db: Session = Depends(get_operational_db),
):
    generation = (
        db.query(SunoGeneration)
        .filter(
            SunoGeneration.provider == PROVIDER,
            SunoGeneration.provider_creation_id == payload.clip_id,
        )
        .first()
    )
    if not generation:
        # The metadata row for this clip_id hasn't been captured/normalized
        # yet (e.g. the audio response was observed before the feed poll
        # picked up the row). Not an error - the extension re-observes and
        # re-sends the same audio every time this clip is played/downloaded,
        # so this is self-healing, not a lost event.
        return CaptureAudioResult(success=False, status="generation_not_found")

    # Recorded before the already_mirrored short-circuit below, on purpose:
    # a re-download of an already-mirrored clip is still a real Download
    # click and should still update downloaded_at (e.g. the Downloads view
    # should reflect the most recent download, not just the first).
    if payload.is_download:
        generation.downloaded_at = datetime.utcnow()
        db.commit()

    if generation.asset_mirror_status == "mirrored" and generation.mirrored_asset_key:
        return CaptureAudioResult(success=True, status="already_mirrored")

    if not r2_storage.is_configured():
        return CaptureAudioResult(success=False, status="not_configured")

    try:
        audio_bytes = base64.b64decode(payload.audio_base64, validate=True)
    except Exception:
        return CaptureAudioResult(success=False, status="invalid_audio")

    if not audio_bytes or len(audio_bytes) > MAX_AUDIO_BYTES:
        return CaptureAudioResult(success=False, status="invalid_audio")

    content_type = payload.content_type or "audio/mpeg"
    extension = guess_extension(content_type.split(";")[0].strip()) or ".mp3"
    generation_id = generation.id
    key = f"suno-mirror/{generation_id}/{uuid4().hex[:8]}-asset{extension}"

    # Release the connection for the upload - see the identical note in
    # providers/elevenlabs/router.py's capture_audio. `generation` is
    # detached by the close, so the write below re-queries by id instead of
    # mutating the stale instance.
    db.close()
    r2_storage.put_object(key, audio_bytes, content_type=content_type)

    generation = (
        db.query(SunoGeneration)
        .filter(SunoGeneration.id == generation_id)
        .first()
    )
    if not generation:
        # Deleted while the upload was in flight - nothing left to mark.
        return CaptureAudioResult(success=False, status="generation_not_found")

    generation.mirrored_asset_key = key
    generation.asset_mirror_status = "mirrored"
    generation.asset_mirror_attempted_at = datetime.utcnow()
    generation.asset_mirror_error = None
    db.commit()

    return CaptureAudioResult(success=True, status="mirrored")


# ==================== Minimal admin read surface ====================
# For manual verification only in this first pass (no dashboard viewer UI
# yet - see CAPTURE_CONTRACT.md's scope note). Deliberately plain
# limit/offset queries rather than a full filter framework, which this pass
# doesn't need yet.

@router.get("/generations", response_model=GenerationListOut)
def list_generations(
    owner_user_id: Optional[int] = None,
    model_name: Optional[str] = None,
    linked_task_id: Optional[int] = None,
    linked_client_id: Optional[int] = None,
    downloaded: Optional[bool] = None,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    query = db.query(SunoGeneration).filter(SunoGeneration.provider == PROVIDER)
    if owner_user_id is not None:
        query = query.filter(SunoGeneration.owner_user_id == owner_user_id)
    if model_name:
        query = query.filter(SunoGeneration.model_name == model_name)
    if linked_task_id is not None:
        query = query.filter(SunoGeneration.linked_task_id == linked_task_id)
    if linked_client_id is not None:
        query = query.filter(SunoGeneration.linked_client_id == linked_client_id)
    if downloaded is True:
        query = query.filter(SunoGeneration.downloaded_at.isnot(None))

    total = query.count()
    # Sort by the generation's real-world date (provider_created_at, the same
    # field the dashboard card displays via formatRelativeTime), not our own
    # row's insert time (created_at) - they diverge badly for reconciliation-
    # imported rows, which can all get inserted in the same backfill walk
    # (same created_at, give or take) regardless of how old the actual Suno
    # generation is. created_at is only a fallback for the brief window
    # before a live-captured row has any provider timestamp yet. Same fix as
    # providers/elevenlabs/router.py's list_generations and
    # providers/freepik/queries.py's identical sort_key.
    sort_key = func.coalesce(SunoGeneration.provider_created_at, SunoGeneration.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    data = _attach_owner_names(db, [item.to_dict() for item in items])
    return GenerationListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/generations/{generation_id}", response_model=GenerationDetailOut)
def get_generation(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    generation = (
        db.query(SunoGeneration)
        .filter(SunoGeneration.provider == PROVIDER, SunoGeneration.id == generation_id)
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Suno generation not found")
    data = _attach_owner_names(db, [generation.to_dict()])[0]
    return GenerationDetailOut(data=data)


@router.get("/events", response_model=EventListOut)
def list_events(
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    query = db.query(SunoCaptureEvent).filter(SunoCaptureEvent.provider == PROVIDER)
    if client_event_id:
        query = query.filter(SunoCaptureEvent.client_event_id == client_event_id)
    if event_type:
        query = query.filter(SunoCaptureEvent.event_type == event_type)
    if user_id is not None:
        query = query.filter(SunoCaptureEvent.user_id == user_id)

    total = query.count()
    items = query.order_by(desc(SunoCaptureEvent.created_at)).offset(offset).limit(limit).all()
    data = _attach_event_user_names(db, [item.to_dict() for item in items])
    return EventListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/events/{event_id}", response_model=EventDetailOut)
def get_event(
    event_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    event = (
        db.query(SunoCaptureEvent)
        .filter(SunoCaptureEvent.provider == PROVIDER, SunoCaptureEvent.id == event_id)
        .first()
    )
    if not event:
        raise HTTPException(status_code=404, detail="Suno capture event not found")
    data = _attach_event_user_names(db, [event.to_dict()])[0]
    return EventDetailOut(data=data)
