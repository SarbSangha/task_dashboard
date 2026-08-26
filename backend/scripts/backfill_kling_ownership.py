"""
One-off backfill: reassign ownership on Kling usage-event rows that are
currently owned by an admin/shared account but were also reported by a real,
non-admin employee (see scripts/diagnose_kling_ownership.py for the read-only
version of this scan, and routers/it_tools_router.py's report_extension_usage_event
for the forward-looking ingestion fix this backfill complements).

These rows are NOT duplicate rows -- report_extension_usage_event already
merges a same-task report from a second portal user into the first existing
row rather than creating a second one, so merge_duplicate_kling_usage_events.py
(which only merges/deletes duplicate ROWS) cannot fix them. This script instead
reassigns usage_event.user_id in place on the single row, for the unambiguous
case: exactly one distinct non-admin "duplicate reporter" recorded on a row
currently owned by an admin/shared account. Ambiguous rows (more than one
distinct non-admin reporter) are listed but skipped -- pick the real owner by
hand for those.

Dry-run by default; pass --apply to write.

Usage:
    python scripts/backfill_kling_ownership.py                 # dry run
    python scripts/backfill_kling_ownership.py --apply          # write changes
    python scripts/backfill_kling_ownership.py --apply --start 2026-01-01
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime

sys.path.insert(0, __file__.rsplit("scripts", 1)[0])

from database_config import OperationalSessionLocal  # noqa: E402
from models_new import ITPortalTool, ITPortalToolUsageEvent, User  # noqa: E402
from utils.datetime_utils import serialize_utc_datetime as _serialize_utc_datetime  # noqa: E402

KLING_SLUGS = {"kling", "kling-ai", "klingai"}


def _is_admin_user(user: User | None) -> bool:
    if user is None:
        return False
    if bool(getattr(user, "is_admin", False)):
        return True
    return (getattr(user, "position", None) or "").strip().lower() == "admin"


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%d").date()


def run(session, start: date | None, end: date | None, apply: bool) -> None:
    tools = session.query(ITPortalTool).filter(ITPortalTool.slug.in_(KLING_SLUGS)).all()
    tool_ids = [t.id for t in tools]
    if not tool_ids:
        print("No ITPortalTool rows matched the Kling slugs; nothing to do.")
        return

    q = session.query(ITPortalToolUsageEvent).filter(ITPortalToolUsageEvent.tool_id.in_(tool_ids))
    if start:
        q = q.filter(ITPortalToolUsageEvent.event_date >= start)
    if end:
        q = q.filter(ITPortalToolUsageEvent.event_date <= end)
    events = q.order_by(ITPortalToolUsageEvent.event_date.asc()).all()

    users_by_id = {u.id: u for u in session.query(User).all()}

    reassigned = 0
    skipped_ambiguous = 0

    for ev in events:
        meta = ev.metadata_json if isinstance(ev.metadata_json, dict) else {}
        reporters = meta.get("duplicateReporters")
        if not isinstance(reporters, list) or not reporters:
            continue
        if not _is_admin_user(users_by_id.get(ev.user_id)):
            continue
        other_user_ids = {
            r.get("userId") for r in reporters
            if isinstance(r, dict) and r.get("userId") and r.get("userId") != ev.user_id
        }
        non_admin_others = sorted({uid for uid in other_user_ids if not _is_admin_user(users_by_id.get(uid))})
        if not non_admin_others:
            continue
        if len(non_admin_others) > 1:
            names = ", ".join(f"#{uid}" for uid in non_admin_others)
            print(f"SKIP event #{ev.id} (date={ev.event_date}): ambiguous, reported by more than one "
                  f"non-admin user ({names}) -- resolve by hand.")
            skipped_ambiguous += 1
            continue

        real_uid = non_admin_others[0]
        real_user = users_by_id.get(real_uid)
        print(f"{'REASSIGN' if apply else 'WOULD REASSIGN'} event #{ev.id} (date={ev.event_date}, "
              f"credits={ev.credits_burned}): Administrator/#{ev.user_id} -> "
              f"{real_user.name if real_user else real_uid} (#{real_uid})")

        if apply:
            new_meta = dict(meta)
            new_meta["reassignedFromUserId"] = ev.user_id
            new_meta["reassignedAt"] = _serialize_utc_datetime(datetime.utcnow())
            new_meta["reassignedBy"] = "backfill_kling_ownership"
            ev.user_id = real_uid
            ev.metadata_json = new_meta
        reassigned += 1

    print()
    print(f"{'Reassigned' if apply else 'Would reassign'}: {reassigned}")
    print(f"Skipped (ambiguous): {skipped_ambiguous}")

    if apply:
        session.commit()
        print("Committed.")
    else:
        session.rollback()
        print("Dry run only -- no changes written. Re-run with --apply to commit.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill Kling usage-event ownership for admin-owned rows with a real duplicate reporter.")
    parser.add_argument("--apply", action="store_true", help="Write changes. Omit for dry-run.")
    parser.add_argument("--start", help="Window start date (YYYY-MM-DD).")
    parser.add_argument("--end", help="Window end date (YYYY-MM-DD).")
    args = parser.parse_args()

    session = OperationalSessionLocal()
    try:
        run(session, _parse_date(args.start), _parse_date(args.end), args.apply)
        return 0
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
