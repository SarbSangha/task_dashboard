"""
One-off cleanup for historical Kling usage-event duplicates.

Before the ingestion fix in routers/it_tools_router.py (report_extension_usage_event),
dedupe lookups were scoped by portal user_id instead of by the real Kling account
(credential_id) + task identity. That let the extension's background history scan
create a second usage-event row under whichever portal user happened to be logged
in (often "Administrator") instead of updating the original user's row, producing
duplicate rows for the same task attributed to two different users.

This script finds those historical duplicate clusters (same tool + same task
identity + same credential, different user_id), merges the missing fields into the
row owned by the real (non-admin) user, and removes the extra row(s).

If both the canonical usage event and the duplicate usage event already spawned
their own GenerationRecord rows, the script now merges those records too:
  - keeps the GenerationRecord tied to the canonical usage event,
  - gap-fills any fields it is missing from the duplicate record,
  - re-points tags / collection members / project events from the duplicate
    record onto the canonical one,
  - then deletes the duplicate GenerationRecord before deleting the duplicate
    usage event.
"""
import argparse
import json
import logging

from database_config import OperationalSessionLocal
from merge_duplicate_generation_records import (
    _merge_metadata as _merge_generation_record_metadata,
    _merge_scalar as _merge_generation_record_scalar,
    _repoint_child_rows as _repoint_generation_record_child_rows,
)
from models_new import GenerationRecord, ITPortalTool, ITPortalToolUsageEvent, User

KLING_SLUGS = {"kling", "kling-ai", "klingai"}


def _is_admin_user(user: User) -> bool:
    if user is None:
        return False
    if bool(getattr(user, "is_admin", False)):
        return True
    return (getattr(user, "position", None) or "").strip().lower() == "admin"


def _identity_key(event: ITPortalToolUsageEvent):
    for value in (event.generation_id, event.external_event_id, event.request_id, event.fingerprint):
        text = (value or "").strip()
        if text:
            return text
    return None


def _task_id_count(event: ITPortalToolUsageEvent) -> int:
    metadata = event.metadata_json if isinstance(event.metadata_json, dict) else {}
    ownership = metadata.get("ownership") if isinstance(metadata.get("ownership"), dict) else {}
    pipeline = metadata.get("pipelineDiagnostics") if isinstance(metadata.get("pipelineDiagnostics"), dict) else {}
    seen: set[str] = set()

    def push(value: object) -> None:
        text = f"{value or ''}".strip()
        if not text:
            return
        if text.lower().startswith(("kgen_", "net_", "dom_", "trade_")):
            return
        seen.add(text)

    for value in (
        event.generation_id,
        event.request_id,
        metadata.get("klingTaskId"),
        ownership.get("klingTaskId"),
    ):
        push(value)
    for value in pipeline.get("taskIds") if isinstance(pipeline.get("taskIds"), list) else []:
        push(value)
    for value in metadata.get("discoveredTaskIds") if isinstance(metadata.get("discoveredTaskIds"), list) else []:
        push(value)
    return len(seen)


def _media_asset_count(event: ITPortalToolUsageEvent) -> int:
    metadata = event.metadata_json if isinstance(event.metadata_json, dict) else {}
    media_assets = metadata.get("mediaAssets") if isinstance(metadata.get("mediaAssets"), list) else []
    return sum(1 for item in media_assets if isinstance(item, dict) and f"{item.get('url') or ''}".strip())


def _choose_keep(events: list[ITPortalToolUsageEvent], users_by_id: dict[int, User]) -> ITPortalToolUsageEvent:
    def sort_key(event: ITPortalToolUsageEvent):
        created_rank = -(event.created_at.timestamp() if event.created_at else float(event.id))
        return (
            1 if not _is_admin_user(users_by_id.get(event.user_id)) else 0,
            _task_id_count(event),
            _media_asset_count(event),
            1 if (event.prompt_text or "").strip() else 0,
            created_rank,
            -event.id,
        )

    return max(events, key=sort_key)


def _merge_scalar(keep: ITPortalToolUsageEvent, dup: ITPortalToolUsageEvent) -> list[str]:
    changed = []
    for field in (
        "prompt_text",
        "model_label",
        "duration_label",
        "resolution_label",
        "external_event_id",
        "generation_id",
        "request_id",
        "fingerprint",
        "source",
    ):
        if not getattr(keep, field) and getattr(dup, field):
            setattr(keep, field, getattr(dup, field))
            changed.append(field)
    for field in ("expected_credits", "credits_before", "credits_after", "credits_burned", "confidence"):
        if getattr(keep, field) is None and getattr(dup, field) is not None:
            setattr(keep, field, getattr(dup, field))
            changed.append(field)
    if not keep.schema_version and dup.schema_version:
        keep.schema_version = dup.schema_version
        changed.append("schema_version")
    return changed


def _merge_metadata(keep: ITPortalToolUsageEvent, dup: ITPortalToolUsageEvent) -> None:
    keep_meta = dict(keep.metadata_json or {})
    dup_meta = dict(dup.metadata_json or {})

    keep_assets = keep_meta.get("mediaAssets") if isinstance(keep_meta.get("mediaAssets"), list) else []
    dup_assets = dup_meta.get("mediaAssets") if isinstance(dup_meta.get("mediaAssets"), list) else []
    if dup_assets:
        seen_urls = {f"{a.get('url') or ''}".strip() for a in keep_assets if isinstance(a, dict)}
        for asset in dup_assets:
            if not isinstance(asset, dict):
                continue
            url = f"{asset.get('url') or ''}".strip()
            if url and url not in seen_urls:
                keep_assets.append(asset)
                seen_urls.add(url)
        keep_meta["mediaAssets"] = keep_assets

    for key, value in dup_meta.items():
        if key == "mediaAssets":
            continue
        if key not in keep_meta or keep_meta.get(key) in (None, "", [], {}):
            keep_meta[key] = value

    merge_history = list(keep_meta.get("duplicateMergeHistory") or [])
    merge_history.append({
        "mergedEventId": dup.id,
        "mergedUserId": dup.user_id,
        "mergedCreatedAt": dup.created_at.isoformat() if dup.created_at else None,
    })
    keep_meta["duplicateMergeHistory"] = merge_history
    keep.metadata_json = keep_meta


def _repair_generation_record_owner(
    record: GenerationRecord,
    *,
    keep_event: ITPortalToolUsageEvent,
    users_by_id: dict[int, User],
) -> list[str]:
    changed = []
    keep_user = users_by_id.get(keep_event.user_id)
    current_owner = users_by_id.get(record.owner_user_id) if record.owner_user_id else None
    if (
        keep_event.user_id
        and keep_user is not None
        and not _is_admin_user(keep_user)
        and (record.owner_user_id is None or _is_admin_user(current_owner))
    ):
        record.owner_user_id = keep_event.user_id
        record.ownership_status = "resolved"
        if not record.ownership_source:
            record.ownership_source = "usage_event_user_id"
        changed.append("owner_user_id")
    return changed


def _merge_generation_record_cluster(
    session,
    *,
    keep_event: ITPortalToolUsageEvent,
    dup_event: ITPortalToolUsageEvent,
    generation_records_by_source_event_id: dict[int, GenerationRecord],
    users_by_id: dict[int, User],
    apply: bool,
) -> dict:
    keep_record = generation_records_by_source_event_id.get(keep_event.id)
    dup_record = generation_records_by_source_event_id.get(dup_event.id)
    summary = {
        "keepRecordId": keep_record.id if keep_record else None,
        "removedRecordId": dup_record.id if dup_record else None,
        "changedFields": [],
        "repointedChildRows": {"tags": 0, "tags_skipped_conflict": 0, "collection_members": 0, "project_events": 0},
        "adoptedDuplicateRecord": False,
    }

    if keep_record is not None:
        if keep_record.source_usage_event_id != keep_event.id:
            keep_record.source_usage_event_id = keep_event.id
            summary["changedFields"].append("source_usage_event_id")
        summary["changedFields"].extend(
            _repair_generation_record_owner(keep_record, keep_event=keep_event, users_by_id=users_by_id)
        )

    if dup_record is None:
        summary["changedFields"] = sorted(set(summary["changedFields"]))
        return summary

    if keep_record is None:
        dup_record.source_usage_event_id = keep_event.id
        summary["keepRecordId"] = dup_record.id
        summary["adoptedDuplicateRecord"] = True
        summary["changedFields"].append("source_usage_event_id")
        summary["changedFields"].extend(
            _repair_generation_record_owner(dup_record, keep_event=keep_event, users_by_id=users_by_id)
        )
        generation_records_by_source_event_id.pop(dup_event.id, None)
        generation_records_by_source_event_id[keep_event.id] = dup_record
        summary["changedFields"] = sorted(set(summary["changedFields"]))
        return summary

    child_summary = _repoint_generation_record_child_rows(
        session,
        keep_id=keep_record.id,
        dup_id=dup_record.id,
        apply=apply,
    )
    for key, value in child_summary.items():
        summary["repointedChildRows"][key] += value

    if apply:
        session.delete(dup_record)
        session.flush()
        generation_records_by_source_event_id.pop(dup_event.id, None)

    summary["changedFields"].extend(_merge_generation_record_scalar(keep_record, dup_record))
    _merge_generation_record_metadata(keep_record, dup_record)
    summary["changedFields"] = sorted(set(summary["changedFields"]))

    return summary


def run(session, apply: bool, logger: logging.Logger) -> dict:
    tools = session.query(ITPortalTool).filter(ITPortalTool.slug.in_(KLING_SLUGS)).all()
    tool_ids = [t.id for t in tools]
    events = (
        session.query(ITPortalToolUsageEvent)
        .filter(ITPortalToolUsageEvent.tool_id.in_(tool_ids))
        .order_by(ITPortalToolUsageEvent.created_at.asc(), ITPortalToolUsageEvent.id.asc())
        .all()
    )
    users_by_id = {u.id: u for u in session.query(User).all()}
    event_ids = [event.id for event in events]
    generation_records_by_source_event_id = {
        record.source_usage_event_id: record
        for record in session.query(GenerationRecord)
        .filter(GenerationRecord.source_usage_event_id.in_(event_ids) if event_ids else False)
        .all()
        if record.source_usage_event_id is not None
    }

    groups: dict[tuple, list[ITPortalToolUsageEvent]] = {}
    for event in events:
        identity = _identity_key(event)
        if not identity:
            continue
        key = (event.tool_id, event.credential_id, identity)
        groups.setdefault(key, []).append(event)

    clusters_found = 0
    clusters_merged = 0
    rows_deleted = 0
    generation_records_deleted = 0
    details = []

    for (tool_id, credential_id, identity), group_events in groups.items():
        distinct_users = {e.user_id for e in group_events}
        if len(distinct_users) < 2:
            continue
        clusters_found += 1
        keep = _choose_keep(group_events, users_by_id)
        dup_events = [e for e in group_events if e.id != keep.id]

        changed_fields = []
        generation_record_merges = []
        for dup in dup_events:
            changed_fields.extend(_merge_scalar(keep, dup))
            _merge_metadata(keep, dup)
            generation_summary = _merge_generation_record_cluster(
                session,
                keep_event=keep,
                dup_event=dup,
                generation_records_by_source_event_id=generation_records_by_source_event_id,
                users_by_id=users_by_id,
                apply=apply,
            )
            generation_record_merges.append(generation_summary)
            if (
                generation_summary.get("removedRecordId") is not None
                and generation_summary.get("keepRecordId") is not None
                and not generation_summary.get("adoptedDuplicateRecord")
            ):
                generation_records_deleted += 1

        cluster_detail = {
            "status": "merged" if apply else "would_merge",
            "toolId": tool_id,
            "credentialId": credential_id,
            "identity": identity,
            "keepEventId": keep.id,
            "keepUserId": keep.user_id,
            "removedEventIds": [d.id for d in dup_events],
            "removedUserIds": [d.user_id for d in dup_events],
            "changedFields": sorted(set(changed_fields)),
            "generationRecordMerges": generation_record_merges,
        }
        details.append(cluster_detail)
        clusters_merged += 1

        if apply:
            for dup in dup_events:
                session.delete(dup)
                rows_deleted += 1
            session.flush()

    if apply:
        session.commit()
    else:
        session.rollback()

    summary = {
        "mode": "apply" if apply else "dry-run",
        "eventsScanned": len(events),
        "clustersFound": clusters_found,
        "clustersMerged": clusters_merged,
        "rowsDeleted": rows_deleted,
        "generationRecordsDeleted": generation_records_deleted,
        "details": details,
    }
    logger.info(
        "Duplicate merge %s: clusters_found=%s merged=%s rows_deleted=%s generation_records_deleted=%s",
        summary["mode"], clusters_found, clusters_merged, rows_deleted, generation_records_deleted,
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge duplicate Kling usage-event rows created under different portal users."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write merges and delete duplicate rows. Omit for dry-run analysis.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logger verbosity.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logger = logging.getLogger("merge_duplicate_kling_usage_events")

    session = OperationalSessionLocal()
    try:
        summary = run(session, apply=args.apply, logger=logger)
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        session.rollback()
        logger.exception("Duplicate merge failed: %s", exc)
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
