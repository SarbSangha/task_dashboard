# providers/heygen/asset_mirror.py
"""
Mirrors HeyGen's own asset URLs into our own R2 storage, so a generation
stays viewable long after HeyGen's CDN link expires. Mirrors
providers/freepik/asset_mirror.py exactly (this package's template for the
feature, built first for Freepik after a captured generation's "Open
Original" turned into an Akamai error page once its Pikaso token had
lapsed) - HeyGen's own video_url/download_url/thumbnail_url/preview_url
(see models.py) are signed with the identical kind of short-lived `Expires=`/
`Signature=` token, so the same failure mode applies here too.

Runs as a periodic sweep (main.py's _periodic_heygen_asset_mirror_dispatch),
not inline during capture normalization - fetching and re-uploading an asset
is a real network round-trip with no business adding latency to the ingest
request path, and a sweep can be resumed/retried independently of capture
traffic. Each row is committed individually so a crash mid-sweep never
leaves a half-mirrored row in an ambiguous state, and one bad URL can't roll
back everyone else's progress in the same batch.
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

from providers.heygen.constants import PROVIDER
from providers.heygen.models import HeygenGeneration
from utils import r2_storage

logger = logging.getLogger(__name__)

FETCH_TIMEOUT_SECONDS = 20.0
MIRROR_KEY_PREFIX = "heygen-mirror"
# See providers/freepik/asset_mirror.py's identical constant - a bulk sweep
# firing many rapid requests at a provider's CDN risks tripping its own
# rate-limit/WAF into 403s that look identical to a genuinely expired token
# but aren't. Paced defensively here too even though HeyGen's own backlog is
# far smaller today.
REQUEST_PACING_SECONDS = 0.4


def _asset_url_candidates(generation: HeygenGeneration) -> list[str]:
    # Same priority normalization.py's _project_into_generation_record uses
    # for GenerationRecord.canonical_asset_url (video_url first) - kept in
    # lockstep so the mirrored copy is the same asset the rest of the app
    # already treats as canonical, not a different one. video_url and
    # download_url are the same underlying file (download_url just adds a
    # response-content-disposition=attachment query param), so mirroring one
    # covers both the "Open Original" and "Download" buttons. Every non-null
    # candidate is tried in order (see _mirror_one_asset), not just the
    # first: Freepik's own asset_mirror.py (this module's template) found a
    # real 2026-08-05 case where a provider's different asset variants carry
    # INDEPENDENTLY expiring signed tokens - the same risk applies here since
    # HeyGen's video/download/thumbnail/preview URLs are each signed
    # separately (see models.py).
    return [url for url in (generation.video_url, generation.download_url, generation.preview_url) if url]


def _thumbnail_url_candidates(generation: HeygenGeneration) -> list[str]:
    return [url for url in (generation.thumbnail_url, generation.preview_url) if url]


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
    see _asset_url_candidates' docstring for why a single dead candidate
    must not abort the whole asset. Raises the last candidate's error only
    once every candidate has failed. Returns the R2 object KEY, not a URL -
    the bucket is private (see r2_storage.py's module docstring), so nothing
    should ever store a "permanent" link to it; a fresh presigned URL is
    minted from this key at serialization time instead."""
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


def _mirror_generation(db: Session, generation: HeygenGeneration, *, http_client: httpx.Client, r2_client) -> str:
    """Mirrors one row's assets and updates it in place. Returns "mirrored",
    "skipped" (nothing to mirror), or "failed" (every candidate URL for at
    least one asset slot failed - never raises, so one bad row can't take
    down the rest of the sweep)."""
    asset_candidates = _asset_url_candidates(generation)
    thumbnail_candidates = _thumbnail_url_candidates(generation)
    if not asset_candidates and not thumbnail_candidates:
        generation.asset_mirror_status = "skipped"
        generation.asset_mirror_attempted_at = datetime.utcnow()
        generation.asset_mirror_error = None
        return "skipped"

    key_root = f"{MIRROR_KEY_PREFIX}/{generation.id}/{uuid4().hex[:8]}"
    try:
        if asset_candidates:
            generation.mirrored_asset_key = _mirror_one_asset(
                http_client, r2_client, source_urls=asset_candidates, key_prefix=f"{key_root}-asset",
            )
        if thumbnail_candidates:
            generation.mirrored_thumbnail_key = _mirror_one_asset(
                http_client, r2_client, source_urls=thumbnail_candidates, key_prefix=f"{key_root}-thumb",
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
    # providers/freepik/asset_mirror.py's identical comment for why.

    return "mirrored"


def mirror_pending_generations(db: Session, *, limit: int = 25) -> dict:
    """Sweeps up to `limit` un-mirrored rows, newest first - a generation's
    HeyGen token is most likely still valid the more recently it was
    captured, so prioritizing newest gives the sweep the best odds of
    actually succeeding before a link dies un-mirrored. Rows already marked
    "failed" or "skipped" are terminal and not retried automatically here -
    a dead signed URL will never start working again on its own, so an
    infinite auto-retry would just hammer it forever. requeue_failed_mirrors
    below is what puts such a row back into this sweep, once its URLs have
    actually been re-captured."""
    stats = {"scanned": 0, "mirrored": 0, "skipped": 0, "failed": 0, "r2_not_configured": False}
    if not r2_storage.is_configured():
        stats["r2_not_configured"] = True
        return stats

    rows = (
        db.query(HeygenGeneration)
        .filter(HeygenGeneration.provider == PROVIDER, HeygenGeneration.asset_mirror_status == "pending")
        .order_by(HeygenGeneration.created_at.desc())
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
                logger.warning("HeyGen asset mirror commit failed for generation id=%s: %s", generation.id, exc)
                continue
            stats[outcome] += 1

    return stats


def requeue_failed_mirrors(db: Session, *, limit: int = 200, force: bool = False) -> dict:
    """Puts terminal ("failed"/"skipped") rows back into the sweep above.

    Without this, a row whose HeyGen URL expired before the sweep first
    reached it stays preview-less forever: the Capture Center card exhausts
    every candidate URL and renders "No preview", and nothing ever tries
    again. That is not a hypothetical - HeyGen serves thumbnails from
    short-lived `.../avatar_tmp/...` links, and rows have already failed here
    with a 403 for exactly that reason.

    Retrying blindly would just hammer a dead link, which is why the original
    sweep made these states terminal. The condition that makes a retry
    worthwhile is that the row has been RE-CAPTURED since the failed attempt:
    normalization refreshes video_url/thumbnail_url every time a new listing
    row arrives for the same video, so `updated_at > asset_mirror_attempted_at`
    means the URLs on the row now are not the ones that failed. Rows that
    haven't changed are left alone unless `force` is set (an operator
    explicitly deciding to spend the requests anyway).

    Only flips status back to "pending" - the actual fetch/upload stays with
    mirror_pending_generations, so there is one code path that mirrors, and
    this stays cheap enough to call from a request handler."""
    stats = {"scanned": 0, "requeued": 0, "unchanged_since_failure": 0, "no_candidate_url": 0}

    rows = (
        db.query(HeygenGeneration)
        .filter(
            HeygenGeneration.provider == PROVIDER,
            HeygenGeneration.asset_mirror_status.in_(("failed", "skipped")),
        )
        .order_by(HeygenGeneration.created_at.desc())
        .limit(limit)
        .all()
    )

    for generation in rows:
        stats["scanned"] += 1
        # Nothing to fetch means "skipped" was the honest answer and still is;
        # re-queueing would only make the sweep re-derive that same verdict.
        if not (_asset_url_candidates(generation) or _thumbnail_url_candidates(generation)):
            stats["no_candidate_url"] += 1
            continue
        if not force:
            attempted_at = generation.asset_mirror_attempted_at
            updated_at = generation.updated_at
            if attempted_at and updated_at and updated_at <= attempted_at:
                stats["unchanged_since_failure"] += 1
                continue
        generation.asset_mirror_status = "pending"
        generation.asset_mirror_error = None
        db.add(generation)
        stats["requeued"] += 1

    if stats["requeued"]:
        db.commit()
    return stats
