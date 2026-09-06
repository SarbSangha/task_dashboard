"""
Read-only diagnostic: find Kling usage-event rows that are currently owned by
one portal user but were also reported by a different, non-admin user via the
"duplicateReporters" metadata trail left by report_extension_usage_event
(routers/it_tools_router.py).

Why this exists: that ingestion path merges a same-task report from a second
portal user into the FIRST row it finds for that task (matched by tool +
credential + generation_id/external_event_id/request_id/fingerprint) instead
of creating a duplicate row. It records the second reporter in
metadata_json["duplicateReporters"], but never reassigns usage_event.user_id.
If the first reporter was an admin/shared-account background scan and the
real generating employee reported later, the row stays owned by the admin
forever -- the employee's generation never counts toward their own totals in
_apply_kling_aggregates (utils/ai_report/dataset.py) or the Kling Report
sheet, so they can appear to be "missing" from that report even though they
really generated the videos.

This script makes NO writes. It only reads and prints a summary so the actual
scope can be reviewed before any ownership-reassignment fix is written.

Usage:
    python scripts/diagnose_kling_ownership.py [--start YYYY-MM-DD] [--end YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from datetime import date, datetime

sys.path.insert(0, __file__.rsplit("scripts", 1)[0])

from database_config import OperationalSessionLocal  # noqa: E402
from models_new import ITPortalTool, ITPortalToolUsageEvent, User  # noqa: E402

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


def _user_label(user: User | None, user_id) -> str:
    if user is None:
        return f"user #{user_id} (not found)"
    tag = " [admin]" if _is_admin_user(user) else ""
    return f"{user.name or user.email} (#{user.id}){tag}"


def run(session, start: date | None, end: date | None) -> None:
    tools = session.query(ITPortalTool).filter(ITPortalTool.slug.in_(KLING_SLUGS)).all()
    tool_ids = [t.id for t in tools]
    if not tool_ids:
        print("No ITPortalTool rows matched the Kling slugs; nothing to check.")
        return

    q = session.query(ITPortalToolUsageEvent).filter(ITPortalToolUsageEvent.tool_id.in_(tool_ids))
    if start:
        q = q.filter(ITPortalToolUsageEvent.event_date >= start)
    if end:
        q = q.filter(ITPortalToolUsageEvent.event_date <= end)
    events = q.order_by(ITPortalToolUsageEvent.event_date.asc()).all()

    users_by_id = {u.id: u for u in session.query(User).all()}

    flagged = []
    for ev in events:
        meta = ev.metadata_json if isinstance(ev.metadata_json, dict) else {}
        reporters = meta.get("duplicateReporters")
        if not isinstance(reporters, list) or not reporters:
            continue
        owner = users_by_id.get(ev.user_id)
        owner_is_admin = _is_admin_user(owner)
        other_user_ids = {
            r.get("userId") for r in reporters
            if isinstance(r, dict) and r.get("userId") and r.get("userId") != ev.user_id
        }
        non_admin_others = [uid for uid in other_user_ids if not _is_admin_user(users_by_id.get(uid))]
        if owner_is_admin and non_admin_others:
            flagged.append((ev, owner, non_admin_others))

    print(f"Scanned {len(events)} Kling usage events"
          + (f" from {start} to {end}" if (start or end) else " (all time)") + ".")
    print(f"Rows with a duplicateReporters trail: "
          f"{sum(1 for e in events if isinstance((e.metadata_json or {}).get('duplicateReporters'), list) and (e.metadata_json or {}).get('duplicateReporters'))}")
    print(f"Rows owned by an admin/shared account but also reported by a real (non-admin) employee: {len(flagged)}")
    print()

    if not flagged:
        print("No misattributed rows found in this window.")
        return

    credits_by_real_user: dict[int, float] = defaultdict(float)
    videos_by_real_user: dict[int, int] = defaultdict(int)

    for ev, owner, non_admin_others in flagged:
        real_uid = non_admin_others[0]
        real_user = users_by_id.get(real_uid)
        credits_by_real_user[real_uid] += ev.credits_burned or 0.0
        videos_by_real_user[real_uid] += 1
        print(
            f"event #{ev.id}  date={ev.event_date}  credential_id={ev.credential_id}  "
            f"credits={ev.credits_burned}\n"
            f"    currently owned by: {_user_label(owner, ev.user_id)}\n"
            f"    actually reported by: {_user_label(real_user, real_uid)}"
            + (f"  (+{len(non_admin_others) - 1} more)" if len(non_admin_others) > 1 else "")
        )

    print()
    print("Would-be real owner totals if ownership were corrected:")
    for uid, videos in sorted(videos_by_real_user.items(), key=lambda x: -x[1]):
        user = users_by_id.get(uid)
        print(f"  {_user_label(user, uid)}: +{videos} video(s), +{round(credits_by_real_user[uid], 2)} credit(s)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose Kling usage-event ownership misattribution (read-only).")
    parser.add_argument("--start", help="Window start date (YYYY-MM-DD).")
    parser.add_argument("--end", help="Window end date (YYYY-MM-DD).")
    args = parser.parse_args()

    session = OperationalSessionLocal()
    try:
        run(session, _parse_date(args.start), _parse_date(args.end))
        return 0
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
