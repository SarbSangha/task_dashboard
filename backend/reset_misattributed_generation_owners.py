"""
One-off remediation for generations whose ownership was clobbered by the old
reconciliation/backfill behavior: sync_generation_record_from_usage_event used
to always overwrite owner_user_id with whoever's usage event re-matched an
existing record by task_id/asset_key, even if the record already had a
different real owner (see utils/generation_backfill.py's assign_owner flag,
added to stop this going forward for reconciliation-recovered rows).

This script resets specific already-affected rows back to unclaimed
(ownership_status="unknown") so the real creator can claim them via
POST /api/generations/{id}/claim. It targets a single owner_user_id (the
account the ownership was incorrectly reassigned to) and only touches rows
whose normalization metadata shows an "update" action -- i.e. rows that were
never originally created with this owner, only reassigned to it later.

Dry run by default; pass --apply to write changes.
"""
import argparse
import logging
from datetime import datetime

from database_config import OperationalSessionLocal
from models_new import GenerationRecord

LOGGER = logging.getLogger(__name__)


def find_reassigned_rows(session, owner_user_id: int) -> list[GenerationRecord]:
    rows = session.query(GenerationRecord).filter(GenerationRecord.owner_user_id == owner_user_id).all()
    reassigned = []
    for row in rows:
        metadata = row.metadata_json or {}
        normalization = metadata.get("generationRecordNormalization") or {}
        if normalization.get("action") == "update":
            reassigned.append(row)
    return reassigned


def run(session, *, owner_user_id: int, apply: bool) -> dict:
    rows = find_reassigned_rows(session, owner_user_id)
    reset_at = datetime.utcnow()
    for row in rows:
        if apply:
            metadata_json = dict(row.metadata_json or {})
            reset_history = list(metadata_json.get("ownershipResets") or [])
            reset_history.append({
                "resetAt": reset_at.isoformat(),
                "reason": "misattributed_via_reconciliation_owner_overwrite",
                "previousOwnerUserId": row.owner_user_id,
                "previousOwnershipSource": row.ownership_source,
            })
            metadata_json["ownershipResets"] = reset_history
            row.metadata_json = metadata_json
            row.owner_user_id = None
            row.ownership_status = "unknown"
            row.ownership_source = None
            row.updated_at = reset_at
            session.add(row)
    if apply:
        session.commit()
    return {
        "mode": "apply" if apply else "dry-run",
        "owner_user_id": owner_user_id,
        "matched_count": len(rows),
        "record_ids": [row.id for row in rows],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-user-id", type=int, required=True, help="User id whose generations were misattributed and should be reset to unclaimed")
    parser.add_argument("--apply", action="store_true", help="Write the reset. Omit for dry-run analysis.")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=args.log_level)
    with OperationalSessionLocal() as session:
        summary = run(session, owner_user_id=args.owner_user_id, apply=args.apply)
    LOGGER.info("Ownership reset summary: %s", summary)
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
