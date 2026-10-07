"""
Import Sheet Activity events from a CSV export of the spreadsheet's hidden
_AuditLog tab (File -> Download -> CSV while that tab is selected).

The _AuditLog tab is apps-script/Code.gs's backup: an event is appended there
whenever the POST to /api/sheet-activity fails. Two ways to load it:

  * From the spreadsheet: run resendAuditLog() in the Apps Script editor.
    It re-POSTs unsent rows in batches and marks them sent. Preferred.
  * Offline: this script, for when the backend was unreachable from Google
    or the rows were exported for another environment.

Safe to re-run: every event carries the eventId Code.gs minted, and an
eventId already stored is skipped, so rows the webhook did deliver are
never duplicated.

Usage (from backend/):
    python scripts/backfill_sheet_activity.py path/to/_AuditLog.csv --dry-run
    python scripts/backfill_sheet_activity.py path/to/_AuditLog.csv
"""
import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database_config import OperationalSessionLocal  # noqa: E402
from services.sheet_activity_service import SheetEventIn, import_audit_log_rows  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv_path", help="CSV export of the _AuditLog tab")
    parser.add_argument("--dry-run", action="store_true", help="validate and count only, no writes")
    args = parser.parse_args()

    with open(args.csv_path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    print(f"read {len(rows)} rows from {args.csv_path}")

    if args.dry_run:
        valid = 0
        for row in rows:
            try:
                item = {k: (v if v != "" else None) for k, v in row.items() if k}
                item.pop("newValues", None)
                item.pop("sent", None)
                for key in ("row", "column", "numRows", "numColumns"):
                    if item.get(key) is not None:
                        item[key] = int(float(item[key]))
                item["truncated"] = False
                SheetEventIn.model_validate(item)
                valid += 1
            except Exception:  # noqa: BLE001
                pass
        print(f"dry run: {valid} valid, {len(rows) - valid} invalid - nothing written")
        return 0

    db = OperationalSessionLocal()
    try:
        result = import_audit_log_rows(db, rows)
    finally:
        db.close()
    print(f"stored {result['stored']}, already present {result['duplicates']}, invalid {result['invalid']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
