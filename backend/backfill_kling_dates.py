"""
One-time backfill: correct mis-dated Kling history-discovered rows.

Two tables drifted because a clip generated on (say) July 16 but *discovered*
by the extension on July 22 was stamped with the discovery day:

  A. it_portal_tool_usage_events.event_date   -> drives the Kling exports
                                                  + the daily usage aggregate
  B. generation_records.created_at            -> drives the Reports module
                                                  (credits, trends, capture panel)

The real generation time is already stored correctly in
ITPortalToolUsageEvent.created_at (UTC) for history-discovered rows — the ingest
path rewinds it to metadata.occurredAt. So both fixes derive from that column.

  event_date (a LOCAL/IST date) := IST-local date of created_at
  generation_records.created_at := earliest usage-event created_at for that clip

Run:
  python backfill_kling_dates.py            # DRY RUN — reports, writes nothing
  python backfill_kling_dates.py --apply    # writes the corrections

Only 'asset_history_discovered' usage rows are touched in phase A. Phase B only
ever pulls a record's created_at EARLIER (never forward), so it is safe to re-run.
"""

import argparse
import sys
from collections import defaultdict
from datetime import timedelta

from database_config import OperationalSessionLocal
from models_new import GenerationRecord, ITPortalTool, ITPortalToolUsageEvent

IST_OFFSET = timedelta(minutes=330)  # Asia/Kolkata, UTC+5:30
KLING_SLUGS = {"kling", "kling-ai", "klingai"}
HISTORY_SOURCE = "asset_history_discovered"
# Mirror the dashboard's sanity clamp so a couple of garbage credit values
# (e.g. a captured credits_before of 123456789) don't dominate the shift report.
MAX_SANE_CREDITS = 3000.0


def _sane_credits(value):
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return v if 0 <= v <= MAX_SANE_CREDITS else 0.0


def _ist_date(dt):
    return (dt + IST_OFFSET).date() if dt else None


def phase_a_usage_event_date(db, apply):
    """Fix forward-drifted event_date on Kling usage rows (ALL sources).

    A row is corrected only when its event_date is LATER than the IST-local date
    of its (already-correct) created_at — i.e. a later duplicate pushed it forward.
    Rows whose event_date is at/earlier than created(IST) are left untouched: the
    single-day earlier cases are just the UTC-vs-IST midnight wobble, not the bug.
    """
    kling_tool_ids = [
        tid for (tid,) in db.query(ITPortalTool.id).filter(ITPortalTool.slug.in_(KLING_SLUGS)).all()
    ]
    if not kling_tool_ids:
        print("  (no Kling tools found — skipping phase A)")
        return

    rows = (
        db.query(ITPortalToolUsageEvent)
        .filter(ITPortalToolUsageEvent.tool_id.in_(kling_tool_ids))
        .all()
    )

    changed = 0
    credits_moved = 0.0
    by_transition = defaultdict(lambda: {"rows": 0, "credits": 0.0})
    for ev in rows:
        if ev.created_at is None or ev.event_date is None:
            continue
        correct = _ist_date(ev.created_at)
        # Only pull FORWARD-drifted rows back (event_date after the real day).
        if correct is None or ev.event_date <= correct:
            continue
        cr = _sane_credits(ev.credits_burned)
        key = (str(ev.event_date), str(correct))
        by_transition[key]["rows"] += 1
        by_transition[key]["credits"] += cr
        changed += 1
        credits_moved += cr
        if apply:
            ev.event_date = correct

    print(f"  Phase A — usage_events.event_date (all sources, forward-drift only):")
    print(f"    scanned:            {len(rows)}")
    print(f"    rows to correct:    {changed}")
    print(f"    credits relocated:  {credits_moved:.1f} (sane 0..{int(MAX_SANE_CREDITS)})")
    if by_transition:
        print("    transitions (wrong_date -> correct_date):")
        for (old, new), agg in sorted(by_transition.items()):
            print(f"      {old} -> {new}: {agg['rows']} rows, {agg['credits']:.1f} credits")
    return changed


def phase_b_generation_created_at(db, apply):
    """Pull generation_records.created_at back to the earliest usage-event time."""
    kling_tool_ids = [
        tid for (tid,) in db.query(ITPortalTool.id).filter(ITPortalTool.slug.in_(KLING_SLUGS)).all()
    ]
    if not kling_tool_ids:
        print("  (no Kling tools found — skipping phase B)")
        return

    # Earliest created_at per clip identity, from the usage events themselves.
    task_min = {}
    gen_min = {}
    for created_at, task_id, gen_id in (
        db.query(
            ITPortalToolUsageEvent.created_at,
            ITPortalToolUsageEvent.generation_id,
            ITPortalToolUsageEvent.external_event_id,
        )
        .filter(ITPortalToolUsageEvent.tool_id.in_(kling_tool_ids))
        .all()
    ):
        if created_at is None:
            continue
        if task_id:
            cur = task_min.get(task_id)
            if cur is None or created_at < cur:
                task_min[task_id] = created_at
        if gen_id:
            cur = gen_min.get(gen_id)
            if cur is None or created_at < cur:
                gen_min[gen_id] = created_at

    records = (
        db.query(GenerationRecord)
        .filter(GenerationRecord.provider == "kling")
        .all()
    )

    changed = 0
    by_transition = defaultdict(lambda: {"rows": 0, "credits": 0.0})
    credits_moved = 0.0
    for rec in records:
        earliest = None
        for key, table in (
            (rec.provider_task_id, task_min),
            (rec.provider_generation_id, gen_min),
        ):
            if key and key in table:
                cand = table[key]
                if earliest is None or cand < earliest:
                    earliest = cand
        if earliest is None or rec.created_at is None:
            continue
        # Only ever pull earlier, and only when it actually moves the calendar day
        # (IST) — otherwise a sub-day tz wobble would churn rows for no reason.
        if earliest < rec.created_at and _ist_date(earliest) != _ist_date(rec.created_at):
            cr = _sane_credits(rec.credits_burned)
            key = (str(_ist_date(rec.created_at)), str(_ist_date(earliest)))
            by_transition[key]["rows"] += 1
            by_transition[key]["credits"] += cr
            changed += 1
            credits_moved += cr
            if apply:
                rec.created_at = earliest

    print(f"  Phase B — generation_records.created_at:")
    print(f"    scanned:            {len(records)}")
    print(f"    rows to correct:    {changed}")
    print(f"    credits relocated:  {credits_moved:.1f} (sane 0..{int(MAX_SANE_CREDITS)})")
    if by_transition:
        print("    transitions (wrong_day -> correct_day, IST):")
        for (old, new), agg in sorted(by_transition.items()):
            print(f"      {old} -> {new}: {agg['rows']} rows, {agg['credits']:.1f} credits")
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write changes (default is dry-run)")
    args = parser.parse_args()

    mode = "APPLY (writing)" if args.apply else "DRY RUN (no writes)"
    print(f"=== Kling date backfill — {mode} ===")

    db = OperationalSessionLocal()
    try:
        phase_a_usage_event_date(db, args.apply)
        print()
        phase_b_generation_created_at(db, args.apply)
        if args.apply:
            db.commit()
            print("\nCommitted.")
        else:
            db.rollback()
            print("\nDry run complete — no changes written. Re-run with --apply to commit.")
    except Exception as exc:  # pragma: no cover
        db.rollback()
        print(f"\nERROR: {exc}", file=sys.stderr)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
