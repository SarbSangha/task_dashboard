# providers/flow/asset_mirror.py
"""
Mirrors Flow's own media asset URLs into our own R2 storage, so a generation
stays viewable long after Google's signed CDN link expires. Flow's media_url
(flow-content.google/image/...?Expires=...&KeyName=...&Signature=...) is a
Google Cloud signed URL - confirmed live 2026-08-14 (a 403 "Forbidden"
reported on a 2-day-old generation, Expires timestamp decoded to ~46 hours in
the past) - once it lapses the original URL goes dead permanently even though
the generation was captured correctly. Same bug class Freepik's/HeyGen's
asset_mirror.py already exist to fix (see providers/freepik/asset_mirror.py's
own docstring for the original incident) - this is that same fix, not yet
built for this provider until now.

Runs as a periodic sweep (main.py's _periodic_flow_asset_mirror_dispatch),
not inline during capture normalization - same reasoning as Freepik's:
fetching and re-uploading an asset is a real network round-trip with no
business adding latency to the ingest request path.

One real difference from Freepik: media_url does not exist at the moment a
FlowGeneration row is first created - it starts null and is patched in later,
sometimes much later, by a SEPARATE capture event once
content-flow-network.js observes the page's own media.getMediaUrlRedirect
response (see normalization.py's _normalize_media_url_event). So the sweep
below only ever selects rows that already HAVE a media_url - a row with none
yet simply stays at its default asset_mirror_status="pending" indefinitely,
picked up automatically the moment a later capture event supplies one,
rather than being prematurely marked "skipped" (which is terminal - see
mirror_pending_generations' own docstring) before Flow ever had a chance to
resolve it.
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

from providers.flow.constants import PROVIDER
from providers.flow.models import FlowGeneration
from utils import r2_storage

logger = logging.getLogger(__name__)

FETCH_TIMEOUT_SECONDS = 20.0
MIRROR_KEY_PREFIX = "flow-mirror"
# Same pacing precaution as Freepik's identical constant - see that file's
# own comment for the 2026-08-05 incident this guards against (a sweep
# firing requests back-to-back got rate-limited into false "failed"
# verdicts on tokens that hadn't actually expired).
REQUEST_PACING_SECONDS = 0.4


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


def _mirror_one_asset(http_client: httpx.Client, r2_client, *, source_url: str, key_prefix: str) -> str:
    """Returns the R2 object KEY, not a URL - the bucket is private (see
    utils/r2_storage.py), so nothing should ever store a "permanent" link to
    it; a fresh presigned URL is minted from this key at serialization time
    instead (see models.py's _presigned_mirror_url)."""
    response = http_client.get(source_url, timeout=FETCH_TIMEOUT_SECONDS)
    try:
        response.raise_for_status()
    finally:
        time.sleep(REQUEST_PACING_SECONDS)
    content_type = response.headers.get("content-type", "application/octet-stream")
    key = f"{key_prefix}{_guess_extension(source_url, content_type)}"
    r2_storage.put_object(key, response.content, content_type=content_type, client=r2_client)
    return key


def _mirror_generation(db: Session, generation: FlowGeneration, *, http_client: httpx.Client, r2_client) -> str:
    """Mirrors one row's asset(s) and updates it in place. Returns "mirrored",
    "skipped" (nothing to mirror - shouldn't normally happen given the sweep
    query already filters on media_url IS NOT NULL, kept as a defensive
    fallback), or "failed" (never raises, so one bad row can't take down the
    rest of the sweep)."""
    if not generation.media_url and not generation.thumbnail_url:
        generation.asset_mirror_status = "skipped"
        generation.asset_mirror_attempted_at = datetime.utcnow()
        generation.asset_mirror_error = None
        return "skipped"

    key_root = f"{MIRROR_KEY_PREFIX}/{generation.id}/{uuid4().hex[:8]}"
    try:
        if generation.media_url:
            generation.mirrored_asset_key = _mirror_one_asset(
                http_client, r2_client, source_url=generation.media_url, key_prefix=f"{key_root}-asset",
            )
        if generation.thumbnail_url:
            generation.mirrored_thumbnail_key = _mirror_one_asset(
                http_client, r2_client, source_url=generation.thumbnail_url, key_prefix=f"{key_root}-thumb",
            )
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any fetch/upload failure is just "failed", not a crash
        generation.asset_mirror_status = "failed"
        generation.asset_mirror_attempted_at = datetime.utcnow()
        generation.asset_mirror_error = str(exc)[:500]
        return "failed"

    generation.asset_mirror_status = "mirrored"
    generation.asset_mirror_attempted_at = datetime.utcnow()
    generation.asset_mirror_error = None
    return "mirrored"


def mirror_pending_generations(db: Session, *, limit: int = 25) -> dict:
    """Sweeps up to `limit` un-mirrored rows that already have a media_url,
    newest first - a generation's Google signed token is most likely still
    valid the more recently it resolved, so prioritizing newest gives the
    sweep the best odds of actually succeeding before a link dies un-mirrored.
    Rows already marked "failed" are terminal here (a dead signed URL never
    starts working again on its own) UNLESS normalization later patches in a
    genuinely different media_url, which resets the row back to "pending" -
    see normalization.py's _normalize_media_url_event."""
    stats = {"scanned": 0, "mirrored": 0, "skipped": 0, "failed": 0, "r2_not_configured": False}
    if not r2_storage.is_configured():
        stats["r2_not_configured"] = True
        return stats

    rows = (
        db.query(FlowGeneration)
        .filter(
            FlowGeneration.provider == PROVIDER,
            FlowGeneration.asset_mirror_status == "pending",
            FlowGeneration.media_url.isnot(None),
        )
        .order_by(FlowGeneration.created_at.desc())
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
                logger.warning("Flow asset mirror commit failed for generation id=%s: %s", generation.id, exc)
                continue
            stats[outcome] += 1

    return stats
