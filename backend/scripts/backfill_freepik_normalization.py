"""
Replay of every historical FreepikCaptureEvent through
normalization.normalize_capture_event().

Needed because three normalization fixes are forward-only - they run at
normalize time, so rows already in the database still carry the old
behaviour until their raw events are replayed:

  * GenerationRecord.capture_status was never set, so every existing Freepik
    row sits at the "active" model default and reads as a success. Until this
    runs, Freepik success-rate KPIs keep showing 100% for historical data.
  * A late/thin snapshot could null out credits, output URLs and status on an
    already-populated row.
  * Offset-aware provider timestamps were stripped rather than converted.

Safe to re-run: every upsert in normalization.py is idempotent, and the
replay reaches the same ownership verdict the live pass did (freshness is
measured against the capture event's own created_at, never against now).
Safe to interrupt: work commits per event as it goes.

Not a "recovery" tool - there is no reconciliation against Freepik itself and
no FreepikRecoveryAudit row. This only re-reads payloads this system already
captured losslessly.

Usage (from backend/):
    python scripts/backfill_freepik_normalization.py --dry-run   # count only, no writes
    python scripts/backfill_freepik_normalization.py             # apply
    python scripts/backfill_freepik_normalization.py --batch-size 200
"""
import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database_config import OperationalSessionLocal  # noqa: E402
from providers.freepik.constants import PROVIDER  # noqa: E402
from providers.freepik.models import FreepikCaptureEvent  # noqa: E402
from providers.freepik.normalization import backfill_all  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="Count events that would be replayed without writing anything.")
    parser.add_argument("--batch-size", type=int, default=500, help="Events fetched per page (default 500).")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    db = OperationalSessionLocal()
    try:
        if args.dry_run:
            total = db.query(FreepikCaptureEvent).filter(FreepikCaptureEvent.provider == PROVIDER).count()
            print(f"[dry-run] {total} freepik_capture_events rows would be replayed. Re-run without --dry-run to apply.")
            return 0

        stats = backfill_all(db, batch_size=args.batch_size)
        print(
            f"Backfill complete: processed={stats['processed']} normalized={stats['normalized']} "
            f"skipped={stats['skipped']} errors={stats['errors']}"
        )
        if stats["skipped"]:
            print(f"  {stats['skipped']} event(s) had no identity field in their payload - expected, nothing to normalize.")
        if stats["errors"]:
            print(f"  {stats['errors']} event(s) failed - see the freepik_normalization logger output above.")
            return 1
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
