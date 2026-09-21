"""
One-time backfill: fill in metadata_json.lastApproverName / lastApproverRole
for tasks that were HOD/SPOC-approved before that field started being written
(see approve_task in routers/tasks_router.py). Without it the Inbox card falls
back to the generic "HOD approved" / "SPOC approved" label instead of naming
the actual approver.

For each task with workflow_stage in ('hod_approved', 'spoc_approved') and no
lastApproverName yet, this looks up the most recent 'approved' row in
task_status_history for that task and uses its actor as the approver.

Run:
  python backfill_approver_names.py            # DRY RUN - reports, writes nothing
  python backfill_approver_names.py --apply     # writes the corrections
"""

import argparse
import sys

from database_config import OperationalSessionLocal
from models_new import Task, TaskStatusHistory, User


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write changes (default is dry run)")
    args = parser.parse_args()

    db = OperationalSessionLocal()
    try:
        tasks = (
            db.query(Task)
            .filter(Task.workflow_stage.in_(["hod_approved", "spoc_approved"]))
            .all()
        )

        updated = 0
        skipped_has_name = 0
        skipped_no_history = 0

        for task in tasks:
            meta = dict(task.metadata_json or {})
            if meta.get("lastApproverName"):
                skipped_has_name += 1
                continue

            history_row = (
                db.query(TaskStatusHistory)
                .filter(
                    TaskStatusHistory.task_id == task.id,
                    TaskStatusHistory.action == "approved",
                    TaskStatusHistory.status_to == "approved",
                )
                .order_by(TaskStatusHistory.timestamp.desc())
                .first()
            )
            if not history_row or not history_row.user_id:
                skipped_no_history += 1
                continue

            approver = db.query(User).filter(User.id == history_row.user_id).first()
            if not approver:
                skipped_no_history += 1
                continue

            role = "hod" if task.workflow_stage == "hod_approved" else "spoc"
            print(f"Task {task.id} ({task.title!r}): lastApproverName -> {approver.name!r} [{role}]")

            if args.apply:
                meta["lastApproverName"] = approver.name
                meta["lastApproverRole"] = role
                task.metadata_json = meta
            updated += 1

        print(
            f"\n{'Applied' if args.apply else 'Would update'}: {updated}, "
            f"already had name: {skipped_has_name}, no history found: {skipped_no_history}"
        )

        if args.apply:
            db.commit()
        else:
            db.rollback()
            print("\nDry run only - re-run with --apply to write changes.")
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
