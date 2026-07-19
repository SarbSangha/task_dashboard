"""
One-off replay of every historical ConversationCaptureEvent through
normalization.normalize_capture_event(), for conversations captured before
Phase 3 normalization existed. Safe to re-run - every upsert in
normalization.py is idempotent on an existing unique/partial-unique index.

Not a "recovery" tool (no reconciliation against ChatGPT itself, no
ConversationRecoveryAudit row) - a straight replay of data this system
already captured losslessly into ConversationCaptureEvent.

Usage (from backend/):
    python scripts/backfill_chatgpt_normalization.py            # apply
    python scripts/backfill_chatgpt_normalization.py --dry-run  # count only, no writes
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database_config import OperationalSessionLocal  # noqa: E402
from providers.chatgpt.normalization import backfill_all  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Count events that would be processed without writing anything.")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()

    db = OperationalSessionLocal()
    try:
        if args.dry_run:
            from providers.chatgpt.models import ConversationCaptureEvent

            total = db.query(ConversationCaptureEvent).count()
            print(f"[dry-run] {total} total conversation_capture_events rows present. Re-run without --dry-run to normalize them.")
            return

        stats = backfill_all(db, batch_size=args.batch_size)
        print(
            f"Backfill complete: processed={stats['processed']} normalized={stats['normalized']} "
            f"skipped={stats['skipped']} errors={stats['errors']}"
        )
        if stats["errors"]:
            print("Some events failed to normalize - see chatgpt_normalization logger output above for details.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
