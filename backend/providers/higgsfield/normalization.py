# providers/higgsfield/normalization.py
"""
Raw HiggsfieldCaptureEvent -> normalized HiggsfieldGeneration, plus a
projection into the generic GenerationRecord (models_new.py,
provider="higgsfield") so cross-tool reporting picks up Higgsfield with no
changes of its own. Mirrors providers/heygen/normalization.py (this
package's template) structurally, including the specific bug classes this
session already had to retrofit into HeyGen's own version of this file -
built in here from day one instead of reintroduced fresh:

  - _find_existing_generation resolves across the full identity chain
    (generation_id/job_id/request_id), not a single preferred key, checking
    an incoming identity value against ALL identity columns rather than
    only its own same-named column - see HeyGen's normalization.py
    docstring for the split-duplicate-record incident (2026-08-05) this
    guards against; no reason to assume Higgsfield's own endpoint shapes
    will be any more consistent about field naming.
  - list_generations (queries.py) sorts by COALESCE(provider_created_at,
    created_at), not created_at (DB insert time) alone - the same
    latest-to-oldest ordering bug this session found and fixed twice
    (HeyGen, then Freepik).
  - _is_stale_snapshot refuses to let an out-of-order/older snapshot null
    out columns a newer one already populated.
  - All timestamps are converted to naive UTC, never stripped-in-place.
  - Ownership is sticky: only ever set while unresolved.

No real Higgsfield network traffic has been observed while building this -
see constants.py's module docstring. payload_json is therefore an envelope
WE define in content-higgsfield.js (DOM-scraped prompt/preset/multi-shot/
credits, whatever shape-based network interception finds), the same
starting posture HeyGen shipped with. _extract_fields below is
intentionally tolerant: every field is looked up under several plausible
key-name variants, so a follow-up pass that tightens content-higgsfield.js's
envelope naming - or a real captured payload that turns out to use
different names - doesn't require a matching change here.
"""
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.higgsfield.constants import (
    GENERATION_SOURCE_LIVE_CAPTURE,
    GENERATION_SOURCE_RECONCILIATION,
    GENERATION_STATUS_CANCELLED,
    GENERATION_STATUS_COMPLETED,
    GENERATION_STATUS_FAILED,
    GENERATION_STATUS_PENDING,
    GENERATION_STATUS_PROCESSING,
    GENERATION_STATUS_QUEUED,
    GENERATION_STATUS_RENDERING,
    INGEST_COMMIT_CHUNK_SIZE,
    INGESTION_SOURCE_CAPTURED,
    INGESTION_SOURCE_RECOVERED,
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)
from providers.higgsfield.models import HiggsfieldCaptureEvent, HiggsfieldGeneration

logger = logging.getLogger("higgsfield_normalization")

# HiggsfieldGeneration.status -> GenerationRecord.capture_status. Only
# "completed" maps into reports_router.SUCCESS_STATUSES ("active",
# "completed"); a still-running generation is honestly not a success yet,
# and a failed/cancelled one never was.
_CAPTURE_STATUS_BY_PROVIDER_STATUS = {
    GENERATION_STATUS_COMPLETED: "completed",
    GENERATION_STATUS_FAILED: "failed",
    GENERATION_STATUS_CANCELLED: "cancelled",
    GENERATION_STATUS_PENDING: "pending",
    GENERATION_STATUS_QUEUED: "pending",
    GENERATION_STATUS_PROCESSING: "processing",
    GENERATION_STATUS_RENDERING: "processing",
}


def _s(value: Any, max_length: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_length] if max_length else text


def _i(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _f(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _b(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "on", "yes"):
            return True
        if lowered in ("false", "0", "off", "no"):
            return False
    return None


def _parse_dt(value: Any) -> Optional[datetime]:
    """Higgsfield's own timestamp shape is unconfirmed (no real traffic
    sample yet) - handles ISO-8601 with 'Z' or offset the same way every
    other provider's parser does, plus a bare epoch (seconds or
    milliseconds). Every datetime column in this codebase is naive UTC, so
    an offset-aware value is converted to UTC before tzinfo is dropped,
    never stripped in place (would silently shift wall-clock for any
    non-UTC offset and break the ownership freshness gate below)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            # Heuristic: values above this are almost certainly milliseconds
            # (a seconds-based epoch this large would be year ~5138).
            seconds = value / 1000.0 if value > 10_000_000_000 else value
            return datetime.utcfromtimestamp(seconds)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _first(source: dict, *keys: str) -> Any:
    """Returns the first non-None value found under any of the given keys,
    checked in order - the tolerance mechanism described in this module's
    docstring for a payload envelope whose exact naming isn't pinned down
    yet."""
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def _prompt_hash(prompt: Optional[str]) -> Optional[str]:
    if not prompt:
        return None
    return hashlib.sha256(prompt.encode("utf-8", errors="ignore")).hexdigest()


def _is_fresh_enough_for_attribution(provider_created_at: Optional[datetime], captured_at: Optional[datetime]) -> bool:
    """Hard server-side ownership safety net - identical reasoning to
    providers/heygen/normalization.py's version. No provider timestamp at
    all is treated as "not fresh" in the strict sense, but is still allowed
    to attribute (fail OPEN on missing information, same as HeyGen): a
    DOM-scraped submit-time snapshot legitimately has no provider timestamp
    yet (Higgsfield hasn't assigned one at click time), so captured_at
    (server receive time) is used as the generation's origin instead - a
    freshly-clicked Generate/Edit Video/Motion Control button is, by
    construction, always "now"."""
    reference_time = captured_at or datetime.utcnow()
    if not provider_created_at:
        return True
    age_seconds = (reference_time - provider_created_at).total_seconds()
    return -60 <= age_seconds <= OWNERSHIP_FRESHNESS_WINDOW_SECONDS


def _find_existing_generation(db: Session, *, generation_id, job_id, request_id, external_event_id) -> Optional[HiggsfieldGeneration]:
    """Every incoming generation_id/job_id/request_id value is still
    cross-matched against every DB column, not just its own same-named one
    (see this module's docstring for the HeyGen incident that made this
    mandatory: a submitted-time snapshot carrying only a client-side
    external_event_id and one identifier, followed by a network snapshot
    carrying the SAME real id under a differently-named field, must merge
    into the same generation, not mint an orphaned duplicate).

    What changed 2026-08-06: the DB column being matched, not the incoming
    parameter name, is what determines safety. generation_id and request_id
    are true 1:1 identities (DB-enforced unique per (provider, column)) - a
    match against EITHER of those two columns is always trustworthy,
    checked first via one OR'd query. job_id is different: it's populated
    from Higgsfield's job_set_id, a BATCH identifier multiple sibling
    generations legitimately share (see models.py's own comment on that
    column), so a match against the job_id COLUMN specifically needs an
    extra guard - only trusted against a row whose OWN generation_id/
    request_id are either still unset or already equal to what this event
    carries. Without that guard, an event for sibling A's own generation_id
    could resolve to sibling B's row purely because they share one job_id,
    then try to overwrite B's generation_id with A's - a real
    UniqueViolation caught live during a backfill_all run, right after
    job_id's own wrongly-unique DB constraint had been fixed (which is what
    first made two rows sharing one job_id possible at all).
    _project_into_generation_record below resolves GenerationRecord off the
    already-disambiguated HiggsfieldGeneration this function returns, not
    off raw incoming values, so it isn't exposed to this same risk."""
    query = db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.provider == PROVIDER)
    identity_values = [value for value in (generation_id, job_id, request_id) if value]

    if identity_values:
        found = query.filter(
            or_(
                HiggsfieldGeneration.generation_id.in_(identity_values),
                HiggsfieldGeneration.request_id.in_(identity_values),
            )
        ).first()
        if found:
            return found

        job_id_query = query.filter(HiggsfieldGeneration.job_id.in_(identity_values))
        if generation_id:
            job_id_query = job_id_query.filter(
                or_(HiggsfieldGeneration.generation_id.is_(None), HiggsfieldGeneration.generation_id == generation_id)
            )
        if request_id:
            job_id_query = job_id_query.filter(
                or_(HiggsfieldGeneration.request_id.is_(None), HiggsfieldGeneration.request_id == request_id)
            )
        found = job_id_query.first()
        if found:
            return found

    if external_event_id:
        # Weakest signal, checked last - the client-side intent id
        # content-higgsfield.js mints at click time, before Higgsfield has
        # assigned any real generation/job/request id. Kept as a single-
        # column check: it's client-minted, never a real Higgsfield
        # identifier, so it can't legitimately collide with the other three.
        found = query.filter(HiggsfieldGeneration.external_event_id == external_event_id).first()
        if found:
            return found
    return None


# ---- Credit-ledger matching (2026-08-06) ----
#
# CONFIRMED real shape (GET .../fnf/workspaces/credit-ledger?limit=<n>&
# page=<n>): {tx_id, display_name, workflow_id, total_credits, action:
# "spend"|"deduct"|"refund", credit_type, cost_breakdown, action_to_claim,
# created_at, tooltip}. Unlike HeyGen's own confirmed movio_bill.list (a
# real per-video action_id on every row), a Higgsfield ledger row carries no
# reliable per-generation identity - workflow_id is null on every real row
# observed so far. display_name only names the FEATURE used ("Nano Banana
# Pro", "Seedance 2.0"), never a specific generation instance, so linking a
# row to the ONE generation it paid for needs a second signal: creation
# time. Sarbjeet's own sample data proved why this can't be a blind
# nearest-timestamp match either - two "Nano Banana Pro" spends 8
# milliseconds apart, from the same batch generation. The rule here is
# therefore deliberately conservative: only auto-link when EXACTLY ONE
# HiggsfieldGeneration of the mapped feature falls inside the match window -
# any more than one candidate and this refuses to guess, leaving the row
# captured raw (never lost, see capture.py) but unlinked to any one
# generation. Wrong data is worse than missing data here.
#
# TWO windows, not one (found 2026-08-06: a 300s-only window let an
# UNRELATED nearby generation spoil an otherwise-obvious match - two
# distinct "Kling v3.0" generations 3m50s apart, each with its OWN
# ledger charge landing within tens of milliseconds of ITS OWN generation,
# still overlapped inside one shared 300s window and made both ambiguous).
# TIGHT covers the real observed gap between a generation's own creation and
# its own ledger charge (confirmed consistently under 100ms across every
# sample cross-referenced so far) with a wide safety margin, and is tried
# FIRST - most real rows resolve here without ever risking an unrelated
# nearby generation. WIDE (the original window) is the fallback, needed
# specifically for a REFUND, which real data shows can land minutes after
# its matching spend (observed 3-9 minutes) - a gap no tight window could
# ever cover, so ambiguity there is a real, currently-accepted limitation
# (see this function's own "wrong data is worse than missing data" rule),
# not a bug to chase further.
CREDIT_LEDGER_TIGHT_MATCH_WINDOW_SECONDS = 15
CREDIT_LEDGER_MATCH_WINDOW_SECONDS = 300

# Confirmed by cross-referencing real ledger rows against real captured
# job_set_type values from the SAME account, at matching (often
# millisecond-identical) timestamps - not a guess. "Qwen Camera Control" is
# deliberately left unmapped: no real ledger row for it has been
# cross-referenced against a captured generation yet, so there is nothing
# confirmed to map it to. Add an entry here only once a real correlation
# like that exists for it too - the whole point of this gate is refusing to
# guess. "Angles" maps to qwen_camera_control, not a feature literally
# named "Angles" - Higgsfield's billing UI shows the user-facing feature
# name, which doesn't always match the technical job_set_type (confirmed
# via a real -20 credit "Angles" row landing 70ms after a real
# qwen_camera_control generation, the only such generation in this account).
_DISPLAY_NAME_TO_PRESET_CATEGORY = {
    "Nano Banana Pro": "nano_banana_2",
    "Seedance 2.0": "seedance_2_0",
    "Seedance 1.5 Pro": "seedance1_5",
    "Kling v3.0": "kling3_0",
    "Angles": "qwen_camera_control",
    "Sora 2": "sora2_video",
    "Face Swap": "keyframes_faceswap",
}


def _is_credit_ledger_event(payload: dict) -> bool:
    """Mirrors content-higgsfield-network.js's hasCreditLedgerShape exactly -
    tx_id + total_credits + action co-occurring is precise to this one
    endpoint, checked here before _extract_fields' generic (generation-
    shaped) extraction ever runs, since a ledger row has none of the fields
    that pipeline reads."""
    return bool(
        isinstance(payload, dict)
        and isinstance(payload.get("tx_id"), str)
        and isinstance(payload.get("total_credits"), (int, float))
        and isinstance(payload.get("action"), str)
    )


def _credit_ledger_candidates(
    db: Session, event: HiggsfieldCaptureEvent, mapped_category: str, ledger_created_at: datetime, window_seconds: int,
) -> tuple[list[HiggsfieldGeneration], datetime, datetime]:
    window = timedelta(seconds=window_seconds)
    window_start = ledger_created_at - window
    window_end = ledger_created_at + window
    candidates = (
        db.query(HiggsfieldGeneration)
        .filter(
            HiggsfieldGeneration.provider == PROVIDER,
            HiggsfieldGeneration.tool_id == event.tool_id,
            HiggsfieldGeneration.preset_category == mapped_category,
            HiggsfieldGeneration.provider_created_at.isnot(None),
            HiggsfieldGeneration.provider_created_at >= window_start,
            HiggsfieldGeneration.provider_created_at <= window_end,
        )
        .order_by(HiggsfieldGeneration.id.asc())
        .all()
    )
    return candidates, window_start, window_end


def _resolve_credit_ledger_candidates(
    db: Session, event: HiggsfieldCaptureEvent, payload: dict,
    candidates: list[HiggsfieldGeneration], window_start: datetime, window_end: datetime,
) -> Optional[HiggsfieldGeneration]:
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) < 2:
        return None

    # Real case found 2026-08-06 (Sarbjeet: several same-batch generations
    # stayed permanently uncredited): a batch of N same-feature generations
    # created together typically has EXACTLY N same-feature ledger rows in
    # the same window, all charging the IDENTICAL amount (two "Nano Banana
    # Pro" images from one job_set, both -200 raw = 2 credits each). When
    # that holds, the exact pairing is provably irrelevant - any bijection
    # between the two equal-sized, equal-priced sets yields the same
    # per-generation number as the "true" one. Resolved with a fully
    # deterministic, replay-order-independent rule (sort both id sets, pair
    # by position) rather than "whichever has fewest links so far", which
    # would silently mis-pair on a backfill replay processing events in a
    # different order than the first pass - see backfill_all's own
    # "safe to re-run any number of times" guarantee this has to honor.
    this_amount = _f(payload.get("total_credits"))
    if this_amount is None:
        return None
    same_amount_sibling_tx_ids = sorted(
        _s(entry.get("tx_id")) or ""
        for entry in _find_sibling_credit_ledger_events(db, event, _s(payload.get("display_name")) or "")
        if _f(entry.get("total_credits")) == this_amount
        and (entry_dt := _parse_dt(entry.get("created_at")))
        and window_start <= entry_dt <= window_end
    )
    if len(same_amount_sibling_tx_ids) != len(candidates):
        return None
    this_tx_id = _s(payload.get("tx_id")) or ""
    if this_tx_id not in same_amount_sibling_tx_ids:
        return None
    return candidates[same_amount_sibling_tx_ids.index(this_tx_id)]


def _attempt_credit_ledger_match(db: Session, event: HiggsfieldCaptureEvent, payload: dict) -> Optional[HiggsfieldGeneration]:
    workflow_id = _s(payload.get("workflow_id"))
    if workflow_id:
        # A real, confirmed identity when present - exact match across the
        # full identity chain, same as every other lookup in this module.
        # Never observed non-null in a real capture yet, but the field
        # exists in the confirmed shape, so honor it if Higgsfield ever
        # populates it.
        matched = _find_existing_generation(db, generation_id=workflow_id, job_id=workflow_id, request_id=workflow_id, external_event_id=None)
        if matched:
            return matched

    mapped_category = _DISPLAY_NAME_TO_PRESET_CATEGORY.get(_s(payload.get("display_name")) or "")
    if not mapped_category:
        return None
    ledger_created_at = _parse_dt(payload.get("created_at"))
    if not ledger_created_at:
        return None

    # TIGHT first (see CREDIT_LEDGER_TIGHT_MATCH_WINDOW_SECONDS's own
    # comment) - resolves the overwhelming majority of real rows (a
    # generation's own charge lands within ~100ms of it) without ever
    # risking an unrelated nearby generation spoiling the match. Only falls
    # through to WIDE (the original, more permissive window) when the tight
    # window itself is inconclusive - empty (this row's real timing outlier,
    # or a refund landing minutes later) or still ambiguous even at 15s.
    tight_candidates, tight_start, tight_end = _credit_ledger_candidates(
        db, event, mapped_category, ledger_created_at, CREDIT_LEDGER_TIGHT_MATCH_WINDOW_SECONDS
    )
    matched = _resolve_credit_ledger_candidates(db, event, payload, tight_candidates, tight_start, tight_end)
    if matched is not None:
        return matched

    wide_candidates, wide_start, wide_end = _credit_ledger_candidates(
        db, event, mapped_category, ledger_created_at, CREDIT_LEDGER_MATCH_WINDOW_SECONDS
    )
    return _resolve_credit_ledger_candidates(db, event, payload, wide_candidates, wide_start, wide_end)


def _find_sibling_credit_ledger_events(db: Session, event: HiggsfieldCaptureEvent, display_name: str) -> list[dict]:
    """All OTHER captured credit-ledger payloads for this same display_name,
    scoped to this tool - deliberately filtered in Python, not a JSON-path
    SQL predicate, since payload_json is a plain JSON column (not JSONB) and
    this table's realistic volume (a full account's ledger history, observed
    at 62 rows) makes that unnecessary. Matched via _is_credit_ledger_event
    (the payload's own shape), not HiggsfieldCaptureEvent.event_type - that
    column is client-supplied metadata content-higgsfield.js happens to set
    correctly today, but the payload's own shape is the same ground truth
    normalize_capture_event itself trusts to route here in the first place,
    so this stays consistent even if that metadata field is ever missing or
    wrong on some row."""
    rows = (
        db.query(HiggsfieldCaptureEvent)
        .filter(
            HiggsfieldCaptureEvent.provider == PROVIDER,
            HiggsfieldCaptureEvent.tool_id == event.tool_id,
        )
        .all()
    )
    return [
        row.payload_json for row in rows
        if isinstance(row.payload_json, dict)
        and _is_credit_ledger_event(row.payload_json)
        and row.payload_json.get("display_name") == display_name
    ]


def _normalize_credit_ledger_event(db: Session, event: HiggsfieldCaptureEvent, payload: dict) -> Optional[HiggsfieldGeneration]:
    matched = _attempt_credit_ledger_match(db, event, payload)
    if matched is None:
        logger.info(
            "higgsfield credit ledger row tx_id=%s (%s, %s credits) could not be matched to exactly one "
            "generation - captured raw only (capture_event_id=%s), no HiggsfieldGeneration updated",
            payload.get("tx_id"), payload.get("display_name"), payload.get("total_credits"), event.id,
        )
        return None

    # Accumulate rather than overwrite: a failed generation's SPEND is
    # typically followed by a REFUND ledger row minutes (sometimes seconds)
    # later, both landing in the same match window against the same
    # generation - net credits_used should reflect that (0 for a fully
    # refunded generation), not just whichever row normalized last. tx_id
    # dedup keeps backfill_all's replay idempotent (see its own docstring's
    # "safe to re-run any number of times" guarantee) - without it, replaying
    # the same already-normalized event would double-count its own row.
    # list(...) - a genuine COPY, never the same object matched.credit_ledger_json
    # already holds (which _extract_fields' generic pipeline initializes to
    # [], not None, so this is usually already a list, not None). Mutating
    # that existing object in place and reassigning it back to itself is
    # invisible to SQLAlchemy's default (non-Mutable-wrapped) JSON change
    # detection - found live via a DB round-trip test: credits_used
    # persisted correctly, credit_ledger_json silently reverted to [] on
    # refresh. A genuinely new list object with different content compares
    # unequal to the old one and gets flushed correctly.
    ledger_list = list(matched.credit_ledger_json) if isinstance(matched.credit_ledger_json, list) else []
    tx_id = payload.get("tx_id")
    if not any(isinstance(entry, dict) and entry.get("tx_id") == tx_id for entry in ledger_list):
        ledger_list.append(payload)
    matched.credit_ledger_json = ledger_list
    # total_credits is in Higgsfield's own internal unit, exactly 100x the
    # "real" credit number shown everywhere in their UI (confirmed against
    # every sample in a real ledger capture via each row's OWN
    # cost_breakdown.tooltip - e.g. total_credits=-13500 self-describes as
    # "135.0 Subscription", -200 as "2.0 Subscription", consistently /100
    # across every display_name observed). credit_ledger_json still stores
    # the raw payload as-is for fidelity/debugging - only this derived
    # column applies the conversion.
    net_raw_credits = sum(_f(entry.get("total_credits")) or 0.0 for entry in ledger_list if isinstance(entry, dict))
    matched.credits_used = abs(net_raw_credits) / 100.0
    matched.source_capture_event_id = event.id
    db.flush()

    _project_into_generation_record(db, matched)
    return matched


def _find_media_url(medias: Any, role: str) -> Optional[str]:
    """Reads the real "job set" detail response's params.medias[] array -
    confirmed 2026-08-05 from a real DevTools capture (see module docstring's
    CONFIRMED SHAPE section). Each entry is {data: {id, url, type}, role},
    role e.g. "start_image"/"end_image" - only start_image is used as
    image_reference_url below (the generation's own starting reference),
    end_image is intentionally not surfaced as its own column yet (no
    confirmed use for it beyond metadata_json)."""
    if not isinstance(medias, list):
        return None
    for entry in medias:
        if not isinstance(entry, dict) or entry.get("role") != role:
            continue
        data = entry.get("data")
        if isinstance(data, dict) and data.get("url"):
            return data["url"]
    return None


def _first_input_image_url(input_images: Any) -> Optional[str]:
    """params.input_images (image jobs only, confirmed 2026-08-05) - a flat
    list of {id, url, type}, unlike video jobs' role-tagged medias[] handled
    by _find_media_url above. Takes the first entry's url, same "best-effort
    single reference" posture image_reference_url has everywhere else in
    this module."""
    if not isinstance(input_images, list):
        return None
    for entry in input_images:
        if isinstance(entry, dict) and entry.get("url"):
            return entry["url"]
    return None


def _extract_fields(payload: dict) -> dict:
    """Maps one captured Higgsfield event payload to a flat dict of
    HiggsfieldGeneration column values. Every access is defensive - a
    missing field degrades that one column to None, it never aborts
    normalization of the rest of the row.

    Three distinct payload shapes are handled here:

    1. content-higgsfield.js's own DOM-scrape envelope (submitted-click
       snapshots) - unconfirmed against real traffic, tolerant lookups under
       several plausible key-name variants, same posture HeyGen shipped with
       initially. See this module's earlier docstring.
    2. The real Higgsfield "job set" detail response - CONFIRMED 2026-08-05
       from two real DevTools captures, one video and one image (GET
       https://fnf-api-gw.higgsfield.ai/fnf/assets/{id}/detail, Bearer-JWT
       authenticated via a ~60s-lived Clerk session token, NOT a cookie - see
       content-higgsfield-network.js's looksLikeHiggsfieldJobDetailObject for
       the precise shape gate this module's callers rely on). Top level: id
       (the job's own identity - NOT job_set_id, which is the broader
       batch/set a multi-shot generation's several jobs share), job_set_id,
       job_set_type (e.g. "seedance_2_0" for video, "nano_banana_2" for
       image), status, created_at (epoch seconds, float), user_id
       (Higgsfield's OWN account id string - never conflated with our
       internal owner_user_id/ownership system). params: {prompt, width,
       height, resolution, aspect_ratio, duration, model (video jobs only,
       e.g. "seedance_2_0_fast"), mode, bitrate_mode, multi_shots, medias:
       [{data: {url}, role: "start_image"|"end_image"}, ...] (video jobs) OR
       input_images: [{id, url, type}, ...] (image jobs - a flat list, no
       role)}. results: {raw: {type: "video"|"image", url, thumbnail_url},
       min: {...}} - Higgsfield is NOT video-only (unlike HeyGen); results.raw.type
       is the confirmed, authoritative signal for output_type below, not a
       URL-extension guess. No credits field anywhere in this shape - see
       constants.py's EVENT_TYPE_CREDIT_LEDGER_ROW, still unconfirmed.
    3. The real Assets-page listing endpoint - CONFIRMED 2026-08-06 (GET
       https://fnf-api-gw.higgsfield.ai/fnf/assets?size=<n>&category=all,
       same Bearer-JWT auth as #2, response {items: [...], cursor}; see
       content-higgsfield-network.js's looksLikeHiggsfieldAssetListingRow).
       Each row: {id, user_id, created_at (epoch seconds, float), min_url
       (thumbnail-quality media), raw_url (full-quality media), thumbnail_url
       (populated for video rows, null for most image rows - min_url is the
       reliable thumbnail source for those), job_set_type, published_at,
       folder_ids, comments_count, artifacts, is_favourite}. Much thinner
       than #2 - no params/results, so no prompt/preset/resolution ever comes
       from this shape, only what's read as payload-level fallbacks below
       (raw_url/min_url/job_set_type). Every row returned by this endpoint is
       already finished (it only lists rendered assets), so status is
       inferred as "completed" when raw_url is present and no explicit status
       field exists, and output_type falls back to a raw_url/min_url
       extension guess (results.raw.type from shape #2 remains authoritative
       when present - this is only a fallback for the shape that doesn't have
       it).
    """
    payload = payload or {}
    preset = payload.get("preset") or {}
    video_config = payload.get("videoConfig") or payload.get("video_config") or {}
    credits = payload.get("credits") or {}
    output = payload.get("output") or {}
    timestamps = payload.get("timestamps") or {}
    # Real "job set" detail shape - params/results are always dicts on that
    # shape, {} everywhere else so every lookup below degrades to None
    # rather than raising on the DOM-envelope shape, which has neither.
    params = payload.get("params") or {}
    results = payload.get("results") or {}
    results_raw = results.get("raw") or {}
    results_min = results.get("min") or {}

    prompt_text = _first(payload, "promptText", "prompt_text") or params.get("prompt")
    multi_shot_raw = _first(payload, "multiShot", "multi_shot")
    if multi_shot_raw is None:
        multi_shot_raw = params.get("multi_shots")

    # Shape #3 (Assets listing row) only - raw_url/min_url are that shape's
    # own field names, checked here once and reused by video_url,
    # thumbnail_url, and the output_type extension guess below.
    listing_raw_url = payload.get("raw_url")
    listing_min_url = payload.get("min_url")

    def _extension_output_type(url: Optional[str]) -> Optional[str]:
        if not isinstance(url, str):
            return None
        lowered = url.split("?", 1)[0].lower()
        if lowered.endswith((".mp4", ".webm", ".mov", ".m4v")):
            return "video"
        if lowered.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            return "image"
        return None

    return {
        # job_set_id (the batch a multi-shot generation's several jobs
        # share) is a plausible job_id analog - NOT the same concept as this
        # job's own identity (payload["id"], already covered by the
        # "id" fallback below).
        "generation_id": _s(_first(payload, "generationId", "generation_id", "id"), 160),
        "job_id": _s(_first(payload, "jobId", "job_id", "job_set_id"), 160),
        "request_id": _s(_first(payload, "requestId", "request_id"), 160),
        "project_id": _s(_first(payload, "projectId", "project_id"), 160),
        "external_event_id": _s(_first(payload, "externalEventId", "intentId", "generateIntentId"), 160),

        # kind: which of the three top-level tabs produced this (see
        # constants.py's EVENT_TYPE_* split) - content-higgsfield.js sets
        # this directly from which button/tab it observed the click on. The
        # real job-set detail response has no equivalent field, so a network
        # snapshot alone never sets this - it only ever comes from the
        # DOM-scraped submit-time snapshot.
        "kind": _s(_first(payload, "kind"), 40),

        "prompt_text": _s(prompt_text),
        "prompt_length": len(prompt_text) if isinstance(prompt_text, str) else None,
        # preset_id/name: the real shape has no separate human-readable
        # preset name (the "Seedance Pro" label from the reference
        # screenshot is a UI-only concept) - params.model (e.g.
        # "seedance_2_0_fast") is the closest confirmed equivalent, used for
        # both id and name since nothing more readable is available.
        # job_set_type (e.g. "seedance_2_0") is a coarser categorization of
        # the same choice, used as preset_category.
        "preset_id": _s(_first(preset, "id", "presetId") or params.get("model"), 160),
        "preset_name": _s(_first(preset, "name", "presetName") or params.get("model"), 255),
        "preset_category": _s(_first(preset, "category", "presetCategory") or payload.get("job_set_type"), 120),
        "multi_shot": _b(multi_shot_raw),
        "enhance_prompt": _b(_first(payload, "enhancePrompt", "enhance_prompt")),
        "image_reference_url": _s(
            _first(payload, "imageReferenceUrl", "image_reference_url")
            or _find_media_url(params.get("medias"), "start_image")
            # Image jobs (job_set_type "nano_banana_2") carry their
            # reference images under params.input_images - a flat list of
            # {id, url, type}, no "role" key at all (unlike video jobs'
            # medias[]) - confirmed 2026-08-05.
            or _first_input_image_url(params.get("input_images"))
        ),

        "resolution": _s(_first(video_config, "resolution") or params.get("resolution"), 20),
        "aspect_ratio": _s(
            _first(video_config, "aspectRatio", "aspect_ratio")
            or _first(payload, "aspectRatio", "aspect_ratio")
            or params.get("aspect_ratio"),
            20,
        ),
        "fps": _i(_first(video_config, "fps")),
        "duration_seconds": _f(
            _first(video_config, "duration", "durationSeconds")
            or _first(payload, "duration")
            or params.get("duration")
        ),
        # params.mode (e.g. "std") is the closest confirmed equivalent of a
        # "quality" setting - params.bitrate_mode (e.g. "standard") is a
        # related but distinct concept, not surfaced as its own column,
        # still preserved verbatim in metadata_json below.
        "quality": _s(_first(video_config, "quality") or params.get("mode"), 40),

        "credits_before": _f(_first(credits, "before", "creditsBefore")),
        "credits_after": _f(_first(credits, "after", "creditsAfter")),
        "credits_used": _f(_first(credits, "used", "creditsUsed", "burned")),
        "credit_ledger_json": credits.get("ledger") or [],

        # Shape #3's listing endpoint only ever returns already-rendered
        # assets (there's no "pending"/"processing" concept in that
        # response), so a present raw_url with no explicit status is safely
        # inferred as "completed" rather than left None - never overrides a
        # real status value from shapes #1/#2.
        "status": _s(_first(payload, "status") or ("completed" if listing_raw_url else None), 40),
        "provider_created_at": _parse_dt(_first(payload, "createdAt", "created_at", "created_ts")),
        "provider_updated_at": _parse_dt(_first(payload, "updatedAt", "updated_at", "updated_ts")),
        "submitted_at": _parse_dt(_first(timestamps, "submitted", "submittedAt")),
        "completed_at": _parse_dt(_first(timestamps, "completed", "completedAt")),
        "failed_at": _parse_dt(_first(timestamps, "failed", "failedAt")),
        "cancelled_at": _parse_dt(_first(timestamps, "cancelled", "cancelledAt")),
        "generation_duration_ms": _i(_first(payload, "generationDurationMs", "generation_duration_ms")),

        # output_type ("video" | "image") - confirmed 2026-08-05: Higgsfield
        # is NOT video-only (unlike HeyGen). results.raw.type is the
        # authoritative real signal; falls back to results.min.type, then to
        # a payload-level hint for the DOM-scrape envelope (which has
        # neither, so this stays None there - the dashboard degrades to
        # treating an untyped output as a video, same default every
        # HiggsfieldGeneration had before this column existed).
        "output_type": _s(
            results_raw.get("type")
            or results_min.get("type")
            or _first(payload, "outputType", "output_type")
            or _extension_output_type(listing_raw_url)
            or _extension_output_type(listing_min_url),
            20,
        ),

        # results.raw/results.min (shape #2) both carry the same
        # url/thumbnail_url in every sample seen so far - raw preferred,
        # min as fallback, same "try the next candidate" posture asset_mirror
        # already uses for Freepik/HeyGen's independently-expiring variants.
        # raw_url/min_url (shape #3) are checked last since they only exist
        # on that thinner listing-row shape. Holds an image URL for an
        # image-type generation too (see output_type above) - the column is
        # still named video_url for continuity with every other provider's
        # schema in this file.
        "video_url": _s(
            _first(output, "videoUrl", "video_url")
            or _first(payload, "videoUrl", "video_url")
            or results_raw.get("url")
            or results_min.get("url")
            or listing_raw_url
            or listing_min_url
        ),
        "thumbnail_url": _s(
            _first(output, "thumbnailUrl", "thumbnail_url")
            or _first(payload, "thumbnailUrl", "thumbnail_url")
            or results_raw.get("thumbnail_url")
            or results_min.get("thumbnail_url")
            # Shape #3: thumbnail_url is null for most image rows - min_url
            # (the thumbnail-quality media) is the reliable fallback there.
            or listing_min_url
        ),
        "download_url": _s(
            _first(output, "downloadUrl", "download_url")
            or _first(payload, "downloadUrl", "download_url", "videoDownloadUrl", "video_download_url")
        ),
        "preview_url": _s(_first(output, "previewUrl", "preview_url")),

        "metadata_json": payload,
        "source_metadata_json": payload.get("rawNetworkPayload") or {},
    }


def _is_stale_snapshot(generation: HiggsfieldGeneration, fields: dict) -> bool:
    """True when this payload describes an OLDER state of the generation
    than the one already stored - see providers/heygen/normalization.py's
    version for the incident this guards against. Missing on either side is
    NOT treated as stale: the caller falls through to the weaker non-null
    merge rather than dropping data on a guess."""
    incoming = fields.get("provider_updated_at")
    stored = generation.provider_updated_at
    return bool(incoming and stored and incoming < stored)


def normalize_capture_event(db: Session, event: HiggsfieldCaptureEvent) -> Optional[HiggsfieldGeneration]:
    payload = event.payload_json or {}
    if _is_credit_ledger_event(payload):
        # A completely different (thinner, no generation-shaped fields at
        # all) payload from everything else this function handles - routed
        # to its own matching logic before _extract_fields' generic
        # generation-oriented pipeline ever runs, see
        # _normalize_credit_ledger_event's own docstring.
        return _normalize_credit_ledger_event(db, event, payload)

    fields = _extract_fields(payload)
    if not (
        fields["generation_id"] or fields["job_id"] or fields["request_id"]
        or fields["external_event_id"]
    ):
        # Genuinely no identity field at all (not even the client-side
        # external_event_id content-higgsfield.js embeds in every
        # submitted-click payload) - nothing to key a row on. The raw
        # HiggsfieldCaptureEvent is never lost either way (see capture.py) -
        # only the normalized projection is deferred.
        logger.warning(
            "higgsfield normalization skipped capture_event_id=%s: no identity field present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(
        db,
        generation_id=fields["generation_id"],
        job_id=fields["job_id"],
        request_id=fields["request_id"],
        external_event_id=fields["external_event_id"],
    )

    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or HiggsfieldGeneration(provider=PROVIDER)
    is_new = existing is None

    is_stale_snapshot = (not is_new) and _is_stale_snapshot(generation, fields)
    if is_stale_snapshot:
        logger.info(
            "higgsfield normalization: keeping stored columns for generation_id=%s - "
            "capture_event_id=%s describes an older state (payload updated_at=%s < stored %s)",
            generation.generation_id,
            event.id,
            fields.get("provider_updated_at"),
            generation.provider_updated_at,
        )
    else:
        # metadata_json/source_metadata_json are handled separately below by
        # merging rather than blindly replacing wholesale - both are always
        # a dict (never None), so the generic "value is not None" guard
        # every other column relies on can't protect them. Without this, a
        # thin-by-design event (e.g. a credit ledger row that only ever
        # carries generationId + credits.used) would silently erase the
        # full prompt/preset snapshot metadata_json already stored from an
        # earlier, richer capture of the SAME generation.
        for field_name, value in fields.items():
            if field_name in ("metadata_json", "source_metadata_json"):
                continue
            if is_new or value is not None:
                setattr(generation, field_name, value)

        for field_name in ("metadata_json", "source_metadata_json"):
            incoming = fields[field_name]
            stored = getattr(generation, field_name)
            if is_new or not stored:
                setattr(generation, field_name, incoming)
            elif incoming:
                merged = dict(stored)
                merged.update(incoming)
                setattr(generation, field_name, merged)

    if not is_stale_snapshot:
        generation.source_capture_event_id = event.id
    generation.tool_id = event.tool_id
    generation.credential_id = event.credential_id
    if event.linked_task_id is not None:
        generation.linked_task_id = event.linked_task_id
        generation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        generation.linked_client_id = event.linked_client_id
        generation.linked_client_name = event.linked_client_name
    if not is_stale_snapshot:
        generation.generation_method = "history_scan" if is_reconciliation else "network_intercept"
        generation.generation_source = GENERATION_SOURCE_RECONCILIATION if is_reconciliation else GENERATION_SOURCE_LIVE_CAPTURE

    is_attributable = _is_fresh_enough_for_attribution(fields["provider_created_at"], event.created_at)

    if is_reconciliation:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_RECOVERED
    else:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_CAPTURED

    if is_attributable:
        # Sticky ownership - only ever set while unresolved (see this
        # module's docstring for the incident this rule exists to prevent).
        if generation.ownership_status != OWNERSHIP_STATUS_RESOLVED:
            generation.owner_user_id = event.user_id
            generation.ownership_status = OWNERSHIP_STATUS_RESOLVED
            generation.ownership_source = event.ownership_confidence or "session"
    elif is_new:
        generation.ownership_status = OWNERSHIP_STATUS_UNKNOWN

    if is_new:
        db.add(generation)
    db.flush()

    _project_into_generation_record(db, generation)
    return generation


def _project_into_generation_record(db: Session, generation: HiggsfieldGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this
    HiggsfieldGeneration. provider_generation_id is the join key
    (partial-unique on GenerationRecord already, per its own schema) - no
    schema change to GenerationRecord was needed, since `provider` + the
    identity columns were already generic."""
    identity_keys = [key for key in (generation.generation_id, generation.job_id, generation.request_id) if key]
    if not identity_keys:
        return
    canonical_asset_key = identity_keys[0]

    record = None
    if generation.generation_record_id:
        record = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.id == generation.generation_record_id)
            .first()
        )
    if record is None:
        # Resolve across the whole identity chain, not a single preferred
        # key - see this module's docstring for the orphaned-duplicate bug
        # this prevents (a submitted-time snapshot carrying only a job_id,
        # followed by a completed-time snapshot that also carries
        # generation_id, must resolve to the same GenerationRecord both
        # times).
        record = (
            db.query(GenerationRecord)
            .filter(
                GenerationRecord.provider == PROVIDER,
                GenerationRecord.provider_generation_id.in_(identity_keys),
            )
            .first()
        )
    is_new = record is None
    if is_new:
        record = GenerationRecord(provider=PROVIDER, provider_generation_id=canonical_asset_key)
        record.created_at = generation.provider_created_at or generation.submitted_at or datetime.utcnow()

    record.canonical_asset_url = generation.video_url or generation.download_url or generation.preview_url
    record.canonical_asset_key = canonical_asset_key
    record.prompt_text = generation.prompt_text
    record.model_label = generation.preset_name
    record.duration_label = f"{generation.duration_seconds}s" if generation.duration_seconds is not None else None
    record.resolution_label = generation.resolution or generation.aspect_ratio
    record.credits_burned = (
        generation.credits_used
        if generation.credits_used is not None
        else (
            (generation.credits_before - generation.credits_after)
            if generation.credits_before is not None and generation.credits_after is not None
            else None
        )
    )
    record.ingestion_source = generation.ingestion_source
    mapped_capture_status = _CAPTURE_STATUS_BY_PROVIDER_STATUS.get((generation.status or "").strip().lower())
    if mapped_capture_status:
        record.capture_status = mapped_capture_status
    if generation.linked_task_id is not None:
        record.linked_task_id = generation.linked_task_id
        record.linked_task_name = generation.linked_task_name
    if generation.linked_client_id is not None:
        record.linked_client_id = generation.linked_client_id
        record.linked_client_name = generation.linked_client_name
    record.metadata_json = {
        "higgsfieldGenerationId": generation.id,
        "projectId": generation.project_id,
        "kind": generation.kind,
        "presetId": generation.preset_id,
        "presetName": generation.preset_name,
        "multiShot": generation.multi_shot,
        "creditsBefore": generation.credits_before,
        "creditsAfter": generation.credits_after,
    }

    # Sticky ownership, same rule as above.
    if record.ownership_status != OWNERSHIP_STATUS_RESOLVED and generation.ownership_status == OWNERSHIP_STATUS_RESOLVED:
        record.owner_user_id = generation.owner_user_id
        record.ownership_status = OWNERSHIP_STATUS_RESOLVED
        record.ownership_source = generation.ownership_source

    if is_new:
        db.add(record)
    db.flush()
    generation.generation_record_id = record.id


def normalize_capture_events_batch(db: Session, events: list[HiggsfieldCaptureEvent]) -> dict:
    """Best-effort relative to raw capture (each event is already durably
    committed by ingest_capture_event before this runs) - a normalization
    failure here must never turn a successful, lossless ingest into an
    error response. Each event is isolated in its own SAVEPOINT so one
    event losing a concurrent-insert race can't roll back its siblings; a
    real COMMIT lands once per INGEST_COMMIT_CHUNK_SIZE events."""
    stats = {"normalized": 0, "skipped": 0, "errors": 0}
    if not events:
        return stats
    pending_since_commit = 0
    for event in events:
        savepoint = db.begin_nested()
        try:
            generation = normalize_capture_event(db, event)
            savepoint.commit()
            stats["normalized" if generation is not None else "skipped"] += 1
        except Exception:
            savepoint.rollback()
            stats["errors"] += 1
            logger.exception(
                "higgsfield normalization failed for capture_event_id=%s - skipped this cycle, "
                "harmless if lost to a concurrent normalize of the same identity",
                event.id,
            )
        pending_since_commit += 1
        if pending_since_commit >= INGEST_COMMIT_CHUNK_SIZE:
            db.commit()
            pending_since_commit = 0
    if pending_since_commit:
        db.commit()
    return stats


def backfill_all(db: Session, *, batch_size: int = 500) -> dict:
    """Replays every historical HiggsfieldCaptureEvent through the same
    idempotent normalizer the live path uses. Safe to re-run any number of
    times; safe to interrupt and restart. Oldest-first so the same
    generation's snapshots (submitted -> settled) are replayed in their
    original sequence."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(HiggsfieldCaptureEvent)
            .filter(HiggsfieldCaptureEvent.provider == PROVIDER, HiggsfieldCaptureEvent.id > last_id)
            .order_by(HiggsfieldCaptureEvent.id.asc())
            .limit(batch_size)
            .all()
        )
        if not events:
            break
        last_id = events[-1].id
        stats["processed"] += len(events)
        batch_stats = normalize_capture_events_batch(db, events)
        for key, value in batch_stats.items():
            stats[key] += value
        logger.info(
            "higgsfield backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
