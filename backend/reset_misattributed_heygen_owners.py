"""
One-off remediation for HeyGen generations that the pre-2026-08-16 ownership
freshness gate handed to the wrong user.

The bug (fixed in providers/heygen/normalization.py): the gate read only the
INCOMING payload's provider_created_at and treated a missing timestamp as
"fresh". content-heygen.js's credit_ledger_row payload is `{videoId,
credits:{used}}` and carries no timestamp by construction, so the proactive
movio_bill.list lookup - fired for every settled row a passive listing
response mentions - re-attributed month-old videos to whoever merely had
HeyGen open, seconds after the listing row had correctly left them unclaimed.

This resets the affected rows back to unclaimed (ownership_status="unknown")
so the real creator can claim them, on BOTH the provider table
(heygen_generations) and its cross-tool projection (generation_records) -
leaving either side attributed would keep the wrong name on a card, since the
Capture Center reads the former and reporting reads the latter.

Targeting mirrors the FIXED gate rather than "everything reconciliation
touched": a reconciliation walk that discovers a genuinely fresh generation
still attributes it legitimately (see providers/freepik/normalization.py's
_is_fresh_enough_for_attribution docstring), so a row is only reset when its
own provider_created_at proves it was already old by the time we stored it.

Dry run by default; pass --apply to write changes.

    python reset_misattributed_heygen_owners.py                # dry run
    python reset_misattributed_heygen_owners.py --apply        # write
    python reset_misattributed_heygen_owners.py --owner-user-id 1
"""
import argparse
import logging
from datetime import datetime, timedelta
from typing import Optional

from database_config import OperationalSessionLocal
from models_new import GenerationRecord
from providers.heygen.constants import (
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)
from providers.heygen.models import HeygenGeneration

LOGGER = logging.getLogger(__name__)

RESET_REASON = "misattributed_via_timestampless_reconciliation_event"


def find_misattributed_rows(session, owner_user_id: Optional[int]) -> list[HeygenGeneration]:
    """Rows whose ownership was resolved BY a reconciliation event
    (ownership_source == "reconciliation") and which the fixed gate would now
    refuse to attribute - i.e. the generation was already older than the
    freshness window when our row for it was created, or it has no provider
    timestamp at all to justify the attribution."""
    query = (
        session.query(HeygenGeneration)
        .filter(
            HeygenGeneration.provider == PROVIDER,
            HeygenGeneration.ownership_status == OWNERSHIP_STATUS_RESOLVED,
            HeygenGeneration.ownership_source == "reconciliation",
        )
    )
    if owner_user_id is not None:
        query = query.filter(HeygenGeneration.owner_user_id == owner_user_id)

    window = timedelta(seconds=OWNERSHIP_FRESHNESS_WINDOW_SECONDS)
    misattributed = []
    for row in query.all():
        # created_at is when WE first stored the row; provider_created_at is
        # when HeyGen actually made the video. A gap wider than the freshness
        # window is exactly what the fixed gate now rejects.
        if row.provider_created_at is None:
            misattributed.append(row)
            continue
        reference = row.created_at or datetime.utcnow()
        if reference - row.provider_created_at > window:
            misattributed.append(row)
    return misattributed


def _reset_generation_record(session, generation: HeygenGeneration, reset_at: datetime) -> Optional[int]:
    """Clears the paired GenerationRecord too. Resolved by the stored
    generation_record_id first, falling back to the identity chain the way
    normalization.py's own projection does - a row whose link was never
    written still has to be cleaned up, or reporting keeps the wrong owner."""
    record = None
    if generation.generation_record_id:
        record = session.query(GenerationRecord).filter(GenerationRecord.id == generation.generation_record_id).first()
    if record is None:
        identity_keys = [
            key for key in (generation.video_id, generation.render_id, generation.job_id, generation.workflow_id) if key
        ]
        if identity_keys:
            record = (
                session.query(GenerationRecord)
                .filter(
                    GenerationRecord.provider == PROVIDER,
                    GenerationRecord.provider_generation_id.in_(identity_keys),
                )
                .first()
            )
    if record is None:
        return None

    metadata_json = dict(record.metadata_json or {})
    reset_history = list(metadata_json.get("ownershipResets") or [])
    reset_history.append({
        "resetAt": reset_at.isoformat(),
        "reason": RESET_REASON,
        "previousOwnerUserId": record.owner_user_id,
        "previousOwnershipSource": record.ownership_source,
    })
    metadata_json["ownershipResets"] = reset_history
    record.metadata_json = metadata_json
    record.owner_user_id = None
    record.ownership_status = OWNERSHIP_STATUS_UNKNOWN
    record.ownership_source = None
    record.updated_at = reset_at
    session.add(record)
    return record.id


def run(session, *, owner_user_id: Optional[int], apply: bool) -> dict:
    rows = find_misattributed_rows(session, owner_user_id)
    reset_at = datetime.utcnow()
    record_ids: list[int] = []

    for row in rows:
        if not apply:
            continue
        metadata_json = dict(row.metadata_json or {})
        reset_history = list(metadata_json.get("ownershipResets") or [])
        reset_history.append({
            "resetAt": reset_at.isoformat(),
            "reason": RESET_REASON,
            "previousOwnerUserId": row.owner_user_id,
            "previousOwnershipSource": row.ownership_source,
        })
        metadata_json["ownershipResets"] = reset_history
        row.metadata_json = metadata_json
        row.owner_user_id = None
        row.ownership_status = OWNERSHIP_STATUS_UNKNOWN
        row.ownership_source = None
        row.updated_at = reset_at
        session.add(row)

        record_id = _reset_generation_record(session, row, reset_at)
        if record_id is not None:
            record_ids.append(record_id)

    if apply:
        session.commit()

    owners = sorted({row.owner_user_id for row in rows if row.owner_user_id is not None})
    oldest = min((row.provider_created_at for row in rows if row.provider_created_at), default=None)
    newest = max((row.provider_created_at for row in rows if row.provider_created_at), default=None)
    return {
        "mode": "apply" if apply else "dry-run",
        "matched_generations": len(rows),
        "matched_generation_records": len(record_ids) if apply else None,
        "affected_owner_user_ids": owners,
        "provider_created_at_range": [
            oldest.isoformat() if oldest else None,
            newest.isoformat() if newest else None,
        ],
        "generation_ids": [row.id for row in rows],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--owner-user-id",
        type=int,
        default=None,
        help="Only reset rows currently attributed to this user id. Omit to reset every misattributed row.",
    )
    parser.add_argument("--apply", action="store_true", help="Write the reset. Omit for dry-run analysis.")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=args.log_level)
    with OperationalSessionLocal() as session:
        summary = run(session, owner_user_id=args.owner_user_id, apply=args.apply)
    LOGGER.info("HeyGen ownership reset summary: %s", summary)
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
