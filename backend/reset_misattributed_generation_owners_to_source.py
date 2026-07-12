"""
One-off remediation for generations whose ownership was clobbered by the old
sticky-ownership bug in _apply_candidate_to_generation_record: any later
re-capture of the same task_id (e.g. a teammate's extension re-syncing a
shared Kling account's generation history) used to silently overwrite an
already-correct owner_user_id with whoever most recently synced it (see the
assign_owner/sticky-ownership fix in utils/generation_backfill.py).

Unlike reset_misattributed_generation_owners.py (which resets to unclaimed
because there's no reliable original owner on record), this script has a
positive source of truth for each affected row: the user_id on the usage
event that originally created it (GenerationRecord.source_usage_event_id).
It restores owner_user_id to that user wherever it currently differs.

Dry run by default; pass --apply to write changes.
"""
import argparse
import logging
from datetime import datetime

from database_config import OperationalSessionLocal
from models_new import GenerationRecord, ITPortalToolUsageEvent

LOGGER = logging.getLogger(__name__)


def find_misattributed_rows(session) -> list[tuple[GenerationRecord, int]]:
    records = (
        session.query(GenerationRecord)
        .filter(GenerationRecord.source_usage_event_id.isnot(None), GenerationRecord.owner_user_id.isnot(None))
        .all()
    )
    event_ids = [record.source_usage_event_id for record in records]
    event_owner_by_id = {
        event_id: user_id
        for event_id, user_id in session.query(ITPortalToolUsageEvent.id, ITPortalToolUsageEvent.user_id)
        .filter(ITPortalToolUsageEvent.id.in_(event_ids))
        .all()
    }
    mismatched = []
    for record in records:
        true_owner_id = event_owner_by_id.get(record.source_usage_event_id)
        if true_owner_id and true_owner_id != record.owner_user_id:
            mismatched.append((record, true_owner_id))
    return mismatched


def run(session, *, apply: bool) -> dict:
    mismatched = find_misattributed_rows(session)
    repaired_at = datetime.utcnow()
    for record, true_owner_id in mismatched:
        if apply:
            metadata_json = dict(record.metadata_json or {})
            reset_history = list(metadata_json.get("ownershipResets") or [])
            reset_history.append({
                "resetAt": repaired_at.isoformat(),
                "reason": "misattributed_via_live_capture_owner_overwrite",
                "previousOwnerUserId": record.owner_user_id,
                "restoredOwnerUserId": true_owner_id,
            })
            metadata_json["ownershipResets"] = reset_history
            record.metadata_json = metadata_json
            record.owner_user_id = true_owner_id
            record.ownership_status = "resolved"
            record.ownership_source = "usage_event_user_id"
            record.updated_at = repaired_at
            session.add(record)
    if apply:
        session.commit()
    return {
        "mode": "apply" if apply else "dry-run",
        "matched_count": len(mismatched),
        "record_ids": [record.id for record, _true_owner_id in mismatched],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write the ownership restoration. Omit for dry-run analysis.")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=args.log_level)
    with OperationalSessionLocal() as session:
        summary = run(session, apply=args.apply)
    LOGGER.info("Ownership restoration summary: matched_count=%s mode=%s", summary["matched_count"], summary["mode"])
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
