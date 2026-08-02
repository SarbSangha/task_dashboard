"""
Cleanup for duplicate GenerationRecord rows produced by the old Freepik
projection keying.

FreepikGeneration dedupes across four identity fields, but
normalization._project_into_generation_record used to look its GenerationRecord
up by the single preferred key alone (creation_id or identifier or reference).
A first snapshot carrying only `identifier`, followed by a later one that also
carried `creation_id`, therefore matched nothing the second time and minted a
SECOND GenerationRecord. FreepikGeneration.generation_record_id repointed to
the new row and the orphan was left behind - invisible to the capture UI, but
still counted in every report that reads GenerationRecord.

The projection now resolves through the existing link first and then across
the whole identity chain, so no new duplicates can appear. This script cleans
up the ones the old code already created.

Why not merge_duplicate_generation_records.py? That one clusters on
(provider, provider_task_id), which Freepik rows never populate - it would
scan straight past these. The clustering key here is the owning
FreepikGeneration's identity chain instead. The actual merge/repoint/delete
logic is imported from that script rather than reimplemented, so both tools
stay in agreement about what a safe merge is.

For each FreepikGeneration whose identity chain resolves to more than one
GenerationRecord:
  - Keeps the row the generation currently points at, else the oldest
    (by created_at, then id).
  - Merges scalar fields the canonical row is missing, never overwriting a
    value it already has (merge_duplicate_generation_records._merge_scalar).
  - Re-points GenerationTag / GenerationCollectionMember /
    GenerationProjectEvent children onto the canonical row.
  - Repoints FreepikGeneration.generation_record_id at the canonical row.
  - Only then deletes the duplicates.

Dry-run by default. Nothing is written without --apply.

Usage (from backend/):
    python merge_duplicate_freepik_generation_records.py            # dry-run
    python merge_duplicate_freepik_generation_records.py --apply
"""
import argparse
import json
import logging
from datetime import datetime

from database_config import OperationalSessionLocal
from merge_duplicate_generation_records import (
    _merge_metadata,
    _merge_scalar,
    _repoint_child_rows,
)
from models_new import GenerationRecord
from providers.freepik.constants import PROVIDER
from providers.freepik.models import FreepikGeneration

logger = logging.getLogger("merge_duplicate_freepik_generation_records")

BATCH_SIZE = 500


def _identity_keys(generation: FreepikGeneration) -> list[str]:
    """Same chain, in the same priority order, that the projection uses."""
    return [key for key in (generation.creation_id, generation.identifier, generation.reference) if key]


def _pick_canonical(generation: FreepikGeneration, records: list[GenerationRecord]) -> GenerationRecord:
    """Prefer the row the generation is currently linked to - that is the one
    the capture UI and any recent writes have been treating as real. Fall back
    to the oldest, matching merge_duplicate_generation_records' rule. A null
    created_at sorts first so it can never win over a row with a real
    timestamp on the tiebreak."""
    if generation.generation_record_id:
        for record in records:
            if record.id == generation.generation_record_id:
                return record
    return sorted(records, key=lambda r: (r.created_at or datetime.min, r.id))[0]


def run(session, apply: bool) -> dict:
    generations_scanned = 0
    clusters_found = 0
    rows_deleted = 0
    details = []

    last_id = 0
    while True:
        generations = (
            session.query(FreepikGeneration)
            .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.id > last_id)
            .order_by(FreepikGeneration.id.asc())
            .limit(BATCH_SIZE)
            .all()
        )
        if not generations:
            break
        last_id = generations[-1].id

        for generation in generations:
            generations_scanned += 1
            keys = _identity_keys(generation)
            if not keys:
                continue

            records = (
                session.query(GenerationRecord)
                .filter(
                    GenerationRecord.provider == PROVIDER,
                    GenerationRecord.provider_generation_id.in_(keys),
                )
                .all()
            )
            if len(records) < 2:
                continue

            clusters_found += 1
            keep = _pick_canonical(generation, records)
            duplicates = [record for record in records if record.id != keep.id]

            changed_fields: list[str] = []
            repoint_summary = {"tags": 0, "tags_skipped_conflict": 0, "collection_members": 0, "project_events": 0}
            for duplicate in duplicates:
                changed_fields.extend(_merge_scalar(keep, duplicate))
                _merge_metadata(keep, duplicate)
                child_summary = _repoint_child_rows(session, keep_id=keep.id, dup_id=duplicate.id, apply=apply)
                for key, value in child_summary.items():
                    repoint_summary[key] += value

            details.append({
                "status": "merged" if apply else "would_merge",
                "freepikGenerationId": generation.id,
                "identityKeys": keys,
                "keepRecordId": keep.id,
                "removedRecordIds": [d.id for d in duplicates],
                "changedFields": sorted(set(changed_fields)),
                "repointedChildRows": repoint_summary,
            })

            if apply:
                generation.generation_record_id = keep.id
                for duplicate in duplicates:
                    session.delete(duplicate)
                    rows_deleted += 1
                session.flush()

        if apply:
            # Commit per page so an interrupted run keeps the merges it has
            # already made, and no single transaction spans the whole table.
            session.commit()
        else:
            session.rollback()

    summary = {
        "mode": "apply" if apply else "dry-run",
        "generationsScanned": generations_scanned,
        "clustersFound": clusters_found,
        "rowsDeleted": rows_deleted,
        "details": details,
    }
    logger.info(
        "Duplicate Freepik GenerationRecord merge %s: generations_scanned=%s clusters_found=%s rows_deleted=%s",
        summary["mode"], generations_scanned, clusters_found, rows_deleted,
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge duplicate GenerationRecord rows sharing one FreepikGeneration's identity chain.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--apply", action="store_true", help="Write merges and delete duplicate rows. Omit for dry-run analysis.")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    session = OperationalSessionLocal()
    try:
        summary = run(session, apply=args.apply)
        print(json.dumps(summary, indent=2, sort_keys=True, default=str))
        return 0
    except Exception:
        session.rollback()
        logger.exception("Duplicate Freepik GenerationRecord merge failed")
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
