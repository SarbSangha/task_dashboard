"""
Safety-net cleanup for duplicate GenerationRecord rows sharing the same
Provider Task ID.

This is a defensive tool, not a response to an active incident: as of writing,
`ux_generation_records_provider_task_id` (a partial UNIQUE index on
(provider, provider_task_id) WHERE provider_task_id IS NOT NULL) already exists
in the schema, and the recovery/reconciliation import path
(utils.generation_recovery.import_generation_recovery_audit) now delegates to
utils.generation_backfill.sync_generation_record_from_usage_event, which finds
an existing record by identity and updates it in place instead of inserting a
second row. A dry run of this script should report zero clusters on a healthy
database. Keep it in the repo so a future regression (or a restore from an
older backup taken before either fix) has a ready, safe remediation path
instead of a hand-written one-off query under time pressure.

For each cluster of GenerationRecord rows sharing the same
(provider, provider_task_id):
  - Keeps the oldest (by created_at, then id) as the canonical record.
  - Merges any scalar fields the canonical record is missing from the
    duplicate(s), without ever overwriting a value the canonical row
    already has.
  - OR's is_favorite across the cluster (if any duplicate was favorited,
    the canonical one ends up favorited too).
  - Re-points GenerationTag, GenerationCollectionMember, and
    GenerationProjectEvent rows that reference a duplicate's id onto the
    canonical id instead of leaving them to cascade-delete, and skips
    re-pointing a tag if the canonical record already has that exact tag
    (the unique (generation_id, normalized_tag) constraint would reject it).
  - Only then deletes the duplicate row(s).
"""
import argparse
import json
import logging

from database_config import OperationalSessionLocal
from models_new import (
    GenerationCollectionMember,
    GenerationProjectEvent,
    GenerationRecord,
    GenerationTag,
)

logger = logging.getLogger("merge_duplicate_generation_records")


def _merge_scalar(keep: GenerationRecord, dup: GenerationRecord) -> list[str]:
    changed = []
    for field in (
        "provider_generation_id",
        "canonical_asset_url",
        "canonical_asset_key",
        "prompt_text",
        "model_label",
        "duration_label",
        "resolution_label",
        "ownership_source",
        "ownership_notes",
        "project_id",
        "source_usage_event_id",
    ):
        if not getattr(keep, field) and getattr(dup, field):
            setattr(keep, field, getattr(dup, field))
            changed.append(field)
    if keep.credits_burned is None and dup.credits_burned is not None:
        keep.credits_burned = dup.credits_burned
        changed.append("credits_burned")
    if keep.owner_user_id is None and dup.owner_user_id is not None:
        keep.owner_user_id = dup.owner_user_id
        keep.ownership_status = "resolved"
        changed.append("owner_user_id")
    if not keep.is_favorite and dup.is_favorite:
        keep.is_favorite = True
        changed.append("is_favorite")
    return changed


def _merge_metadata(keep: GenerationRecord, dup: GenerationRecord) -> None:
    keep_meta = dict(keep.metadata_json or {})
    dup_meta = dict(dup.metadata_json or {})
    for key, value in dup_meta.items():
        if key not in keep_meta or keep_meta.get(key) in (None, "", [], {}):
            keep_meta[key] = value
    merge_history = list(keep_meta.get("duplicateGenerationRecordMergeHistory") or [])
    merge_history.append({"mergedRecordId": dup.id, "mergedCreatedAt": dup.created_at.isoformat() if dup.created_at else None})
    keep_meta["duplicateGenerationRecordMergeHistory"] = merge_history
    keep.metadata_json = keep_meta


def _repoint_child_rows(session, *, keep_id: int, dup_id: int, apply: bool) -> dict:
    repointed = {"tags": 0, "tags_skipped_conflict": 0, "collection_members": 0, "project_events": 0}

    for tag in session.query(GenerationTag).filter(GenerationTag.generation_id == dup_id).all():
        conflict = (
            session.query(GenerationTag.id)
            .filter(GenerationTag.generation_id == keep_id, GenerationTag.normalized_tag == tag.normalized_tag)
            .first()
        )
        if conflict:
            # Canonical record already has this exact tag — dropping the
            # duplicate tag row (via cascade on delete) is correct here,
            # not data loss, since the information already exists on keep.
            repointed["tags_skipped_conflict"] += 1
            continue
        if apply:
            tag.generation_id = keep_id
        repointed["tags"] += 1

    member_rows = session.query(GenerationCollectionMember).filter(GenerationCollectionMember.generation_id == dup_id).all()
    for member in member_rows:
        conflict = (
            session.query(GenerationCollectionMember.id)
            .filter(
                GenerationCollectionMember.generation_id == keep_id,
                GenerationCollectionMember.collection_id == member.collection_id,
            )
            .first()
        )
        if conflict:
            continue
        if apply:
            member.generation_id = keep_id
        repointed["collection_members"] += 1

    event_rows = session.query(GenerationProjectEvent).filter(GenerationProjectEvent.generation_id == dup_id).all()
    for event in event_rows:
        if apply:
            event.generation_id = keep_id
        repointed["project_events"] += 1

    return repointed


def run(session, apply: bool) -> dict:
    groups: dict[tuple, list[GenerationRecord]] = {}
    records = (
        session.query(GenerationRecord)
        .filter(GenerationRecord.provider_task_id.isnot(None))
        .order_by(GenerationRecord.created_at.asc(), GenerationRecord.id.asc())
        .all()
    )
    for record in records:
        groups.setdefault((record.provider, record.provider_task_id), []).append(record)

    clusters_found = 0
    clusters_merged = 0
    rows_deleted = 0
    details = []

    for (provider, task_id), group_records in groups.items():
        if len(group_records) < 2:
            continue
        clusters_found += 1
        keep, *dup_records = group_records  # already sorted oldest-first

        changed_fields: list[str] = []
        repoint_summary = {"tags": 0, "tags_skipped_conflict": 0, "collection_members": 0, "project_events": 0}
        for dup in dup_records:
            changed_fields.extend(_merge_scalar(keep, dup))
            _merge_metadata(keep, dup)
            child_summary = _repoint_child_rows(session, keep_id=keep.id, dup_id=dup.id, apply=apply)
            for key, value in child_summary.items():
                repoint_summary[key] += value

        details.append({
            "status": "merged" if apply else "would_merge",
            "provider": provider,
            "providerTaskId": task_id,
            "keepRecordId": keep.id,
            "removedRecordIds": [d.id for d in dup_records],
            "changedFields": sorted(set(changed_fields)),
            "repointedChildRows": repoint_summary,
        })
        clusters_merged += 1

        if apply:
            for dup in dup_records:
                session.delete(dup)
                rows_deleted += 1
            session.flush()

    if apply:
        session.commit()
    else:
        session.rollback()

    summary = {
        "mode": "apply" if apply else "dry-run",
        "recordsScanned": len(records),
        "clustersFound": clusters_found,
        "clustersMerged": clusters_merged,
        "rowsDeleted": rows_deleted,
        "details": details,
    }
    logger.info(
        "Duplicate GenerationRecord merge %s: clusters_found=%s merged=%s rows_deleted=%s",
        summary["mode"], clusters_found, clusters_merged, rows_deleted,
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge duplicate GenerationRecord rows sharing the same (provider, provider_task_id)."
    )
    parser.add_argument("--apply", action="store_true", help="Write merges and delete duplicate rows. Omit for dry-run analysis.")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s %(message)s")

    session = OperationalSessionLocal()
    try:
        summary = run(session, apply=args.apply)
        print(json.dumps(summary, indent=2, sort_keys=True, default=str))
        return 0
    except Exception:
        session.rollback()
        logger.exception("Duplicate GenerationRecord merge failed")
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
