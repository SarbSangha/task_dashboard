import argparse
import json
import logging

from database_config import OperationalSessionLocal
from utils.generation_backfill import run_generation_records_backfill


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill canonical generation_records from Kling usage events."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write generation_records to the database. Omit for dry-run analysis.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Number of Kling usage rows to scan per batch.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=0,
        help="Optional cap on scanned rows. Use 0 for no cap.",
    )
    parser.add_argument(
        "--start-after-id",
        type=int,
        default=0,
        help="Resume scanning after this usage-event id.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logger verbosity for the backfill run.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logger = logging.getLogger("generation_backfill")
    logger.info(
        "Starting generation backfill mode=%s batch_size=%s max_rows=%s start_after_id=%s",
        "apply" if args.apply else "dry-run",
        args.batch_size,
        args.max_rows or "unlimited",
        args.start_after_id,
    )

    session = OperationalSessionLocal()
    try:
        summary = run_generation_records_backfill(
            session,
            apply=args.apply,
            batch_size=max(1, args.batch_size),
            max_rows=args.max_rows or None,
            start_after_id=max(0, args.start_after_id),
            logger=logger,
        )
        print(json.dumps(summary.to_dict(), indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        session.rollback()
        logger.exception("Generation backfill failed: %s", exc)
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
