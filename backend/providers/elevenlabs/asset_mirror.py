# providers/elevenlabs/asset_mirror.py
"""
Mirrors ElevenLabs' own audio asset URLs into our own R2 storage, so a
generation stays viewable long after ElevenLabs' own link (however it turns
out to be shaped/expire) goes dead. Structurally copied from
providers/freepik/asset_mirror.py (see that file's own docstring for the
full "why a periodic sweep, not inline during capture" reasoning, ported
unchanged below) and providers/heygen/asset_mirror.py's identical convention.

Runs as a periodic sweep (main.py's _periodic_elevenlabs_asset_mirror_dispatch),
not inline during capture normalization - fetching and re-uploading an asset
is a real network round-trip with no business adding latency to the ingest
request path, and a sweep can be resumed/retried independently of capture
traffic. Each row is committed individually so a crash mid-sweep never
leaves a half-mirrored row in an ambiguous state, and one bad URL can't roll
back everyone else's progress in the same batch.

FLAGGED, NOT GUESSED (see CAPTURE_CONTRACT.md's known-gaps section): the
candidate URL list below is a placeholder pending a real captured `history`
row. It is entirely possible ElevenLabs' history row carries no directly
downloadable audio URL at all - if the real API pattern separates history
metadata from a per-item audio fetch (plausible, since ElevenLabs' public API
does this elsewhere), this module can never actually mirror anything until a
follow-up pass adds that second authenticated fetch (likely via a second
client-side network-observation path, the way Flow's
media.getMediaUrlRedirect handling works). Until then, every row without a
resolvable URL correctly (not incidentally) lands in "skipped" - the exact
same outcome a Speech-to-Text row (no audio output at all) produces, by
design, not as a bug.
"""
import logging
import time
from datetime import datetime
from mimetypes import guess_extension
from typing import Optional
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from sqlalchemy.orm import Session

from providers.elevenlabs.constants import PROVIDER
from providers.elevenlabs.models import ElevenlabsGeneration
from utils import r2_storage

logger = logging.getLogger(__name__)

FETCH_TIMEOUT_SECONDS = 20.0
MIRROR_KEY_PREFIX = "elevenlabs-mirror"
# Same pacing lesson Freepik's asset_mirror.py learned the hard way
# (2026-08-05 rate-limit incident against Pikaso's CDN) - kept identical here
# defensively, even though ElevenLabs' own CDN rate-limit behavior has not
# been observed yet.
REQUEST_PACING_SECONDS = 0.4

# Raw-payload candidate keys normalization.py's _extract_asset_url tries -
# duplicated here (not imported) so this module's own fallback scan of
# metadata_json below stays self-contained and doesn't need to reach back
# into normalization internals for what is, structurally, the same
# best-guess list.
_RAW_ASSET_URL_KEYS = ("audio_url", "url", "download_url")


def _asset_url_candidates(generation: ElevenlabsGeneration) -> list[str]:
    """Candidate URLs to try, in priority order - PLACEHOLDER field names
    pending a real confirmed `history` row (see this module's own docstring).
    `media_url` (populated by normalization.py's best-guess field extraction)
    is tried first; if it's empty, metadata_json is scanned directly for any
    of the same raw candidate keys, in case normalization ran before a
    candidate was recognized (e.g. an older row normalized before this list
    was extended) or the value lives somewhere normalization didn't pick up."""
    candidates: list[str] = []
    if generation.media_url:
        candidates.append(generation.media_url)

    metadata = generation.metadata_json or {}
    if isinstance(metadata, dict):
        for key in _RAW_ASSET_URL_KEYS:
            value = metadata.get(key)
            if value and value not in candidates:
                candidates.append(value)
        for nested_key in ("media", "audio"):
            nested = metadata.get(nested_key)
            if isinstance(nested, dict):
                nested_url = nested.get("url")
                if nested_url and nested_url not in candidates:
                    candidates.append(nested_url)

    return candidates


def _guess_extension(url: str, content_type: Optional[str]) -> str:
    if content_type:
        guessed = guess_extension(content_type.split(";")[0].strip())
        if guessed:
            return guessed
    tail = urlparse(url).path.rsplit(".", 1)
    suffix = tail[1] if len(tail) == 2 else ""
    suffix = "".join(char for char in suffix if char.isalnum())
    if suffix and len(suffix) <= 5:
        return f".{suffix.lower()}"
    return ".bin"


def _mirror_one_asset(http_client: httpx.Client, r2_client, *, source_urls: list[str], key_prefix: str) -> str:
    """Tries each candidate URL in order until one fetches successfully -
    same reasoning as providers/freepik/asset_mirror.py's identical function
    (different asset URL variants can carry independently expiring/valid
    tokens). Raises the last candidate's error only once every candidate has
    failed. Returns the R2 object KEY, not a URL - the bucket is private, so
    nothing should ever store a "permanent" link to it; a fresh presigned URL
    is minted from this key at serialization time instead (see models.py's
    to_dict())."""
    last_exc: Optional[Exception] = None
    for source_url in source_urls:
        try:
            response = http_client.get(source_url, timeout=FETCH_TIMEOUT_SECONDS)
            response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - try the next candidate, only the last failure is ever raised
            last_exc = exc
            continue
        finally:
            time.sleep(REQUEST_PACING_SECONDS)
        content_type = response.headers.get("content-type", "application/octet-stream")
        key = f"{key_prefix}{_guess_extension(source_url, content_type)}"
        r2_storage.put_object(key, response.content, content_type=content_type, client=r2_client)
        return key
    raise last_exc


def _mirror_generation(db: Session, generation: ElevenlabsGeneration, *, http_client: httpx.Client, r2_client) -> str:
    """Mirrors one row's asset and updates it in place. Returns "mirrored",
    "skipped" (nothing to mirror - e.g. a Speech-to-Text row with no audio
    output, or any row whose real shape hasn't surfaced a usable URL yet), or
    "failed" (every candidate URL failed - never raises, so one bad row can't
    take down the rest of the sweep)."""
    asset_candidates = _asset_url_candidates(generation)
    if not asset_candidates:
        generation.asset_mirror_status = "skipped"
        generation.asset_mirror_attempted_at = datetime.utcnow()
        generation.asset_mirror_error = None
        return "skipped"

    key_root = f"{MIRROR_KEY_PREFIX}/{generation.id}/{uuid4().hex[:8]}"
    try:
        generation.mirrored_asset_key = _mirror_one_asset(
            http_client, r2_client, source_urls=asset_candidates, key_prefix=f"{key_root}-asset",
        )
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any fetch/upload failure is just "failed", not a crash
        generation.asset_mirror_status = "failed"
        generation.asset_mirror_attempted_at = datetime.utcnow()
        generation.asset_mirror_error = str(exc)[:500]
        return "failed"

    generation.asset_mirror_status = "mirrored"
    generation.asset_mirror_attempted_at = datetime.utcnow()
    generation.asset_mirror_error = None

    # GenerationRecord.canonical_asset_url (the generic cross-tool browse
    # view) is deliberately left untouched here - see
    # providers/freepik/asset_mirror.py's identical comment: it's a plain
    # stored string with no presigning applied wherever it's read, so
    # pointing it at a bare R2 key would just trade one broken link for
    # another. This mirror only fixes ElevenlabsGeneration's own
    # mirroredAssetUrl, freshly presigned via to_dict() on every read.

    return "mirrored"


def mirror_pending_generations(db: Session, *, limit: int = 25) -> dict:
    """Sweeps up to `limit` un-mirrored rows, newest first - mirrors
    providers/freepik/asset_mirror.py's identical function/docstring
    (prioritizing newest gives the sweep the best odds of succeeding before a
    signed URL, if ElevenLabs' turns out to be one, dies un-mirrored). Rows
    already marked "failed" or "skipped" are terminal and not retried
    automatically here - same reasoning and behavior as Freepik/HeyGen's
    sweeps: a dead/absent URL will never start working again on its own, so
    an infinite auto-retry would just hammer it forever (or, for "skipped",
    pointlessly re-check a row that structurally has nothing to mirror on
    every single sweep interval). Resetting a row's asset_mirror_status back
    to "pending" (e.g. via an admin action, not built yet, or once a
    follow-up pass adds a real asset-resolution fetch) is what re-queues it."""
    stats = {"scanned": 0, "mirrored": 0, "skipped": 0, "failed": 0, "r2_not_configured": False}
    if not r2_storage.is_configured():
        stats["r2_not_configured"] = True
        return stats

    rows = (
        db.query(ElevenlabsGeneration)
        .filter(ElevenlabsGeneration.provider == PROVIDER, ElevenlabsGeneration.asset_mirror_status == "pending")
        .order_by(ElevenlabsGeneration.provider_created_at.desc())
        .limit(limit)
        .all()
    )
    if not rows:
        return stats

    r2_client = r2_storage.build_client()
    with httpx.Client(follow_redirects=True) as http_client:
        for generation in rows:
            stats["scanned"] += 1
            try:
                outcome = _mirror_generation(db, generation, http_client=http_client, r2_client=r2_client)
                db.commit()
            except Exception as exc:  # noqa: BLE001 - a DB-layer failure on one row must not kill the whole sweep
                db.rollback()
                logger.warning("ElevenLabs asset mirror commit failed for generation id=%s: %s", generation.id, exc)
                continue
            stats[outcome] += 1

    return stats
