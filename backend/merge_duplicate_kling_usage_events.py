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
row owned by the real (non-admin) user, and removes the extra row(s) -- unless a
GenerationRecord already points at both rows, in which case it's flagged for manual
review instead of touched.
"""
import argparse
import json
import logging

from database_config import OperationalSessionLocal
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


def _choose_keep(events: list[ITPortalToolUsageEvent], users_by_id: dict[int, User]) -> ITPortalToolUsageEvent:
    non_admin = [e for e in events if not _is_admin_user(users_by_id.get(e.user_id))]
    pool = non_admin or events
    return sorted(pool, key=lambda e: e.created_at or e.id)[0]


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

    groups: dict[tuple, list[ITPortalToolUsageEvent]] = {}
    for event in events:
        identity = _identity_key(event)
        if not identity:
            continue
        key = (event.tool_id, event.credential_id, identity)
        groups.setdefault(key, []).append(event)

    clusters_found = 0
    clusters_merged = 0
    clusters_flagged = 0
    rows_deleted = 0
    details = []

    for (tool_id, credential_id, identity), group_events in groups.items():
        distinct_users = {e.user_id for e in group_events}
        if len(distinct_users) < 2:
            continue
        clusters_found += 1
        keep = _choose_keep(group_events, users_by_id)
        dup_events = [e for e in group_events if e.id != keep.id]

        conflicting = [
            dup for dup in dup_events
            if session.query(GenerationRecord.id)
            .filter(GenerationRecord.source_usage_event_id == dup.id)
            .first()
            and session.query(GenerationRecord.id)
            .filter(GenerationRecord.source_usage_event_id == keep.id)
            .first()
        ]
        if conflicting:
            clusters_flagged += 1
            details.append({
                "status": "flagged_manual_review",
                "reason": "both keep and duplicate rows have their own GenerationRecord",
                "toolId": tool_id,
                "credentialId": credential_id,
                "identity": identity,
                "keepEventId": keep.id,
                "keepUserId": keep.user_id,
                "conflictingEventIds": [d.id for d in conflicting],
            })
            continue

        changed_fields = []
        for dup in dup_events:
            changed_fields.extend(_merge_scalar(keep, dup))
            _merge_metadata(keep, dup)

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
        }
        details.append(cluster_detail)
        clusters_merged += 1

        if apply:
            for dup in dup_events:
                orphaned_record = (
                    session.query(GenerationRecord)
                    .filter(GenerationRecord.source_usage_event_id == dup.id)
                    .first()
                )
                if orphaned_record:
                    orphaned_record.source_usage_event_id = keep.id
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
        "clustersFlaggedForManualReview": clusters_flagged,
        "rowsDeleted": rows_deleted,
        "details": details,
    }
    logger.info(
        "Duplicate merge %s: clusters_found=%s merged=%s flagged=%s rows_deleted=%s",
        summary["mode"], clusters_found, clusters_merged, clusters_flagged, rows_deleted,
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
