"""Fixed credits per generation for tools that never report a cost (Suno).

Suno's capture carries no per-song cost (providers/suno/CAPTURE_CONTRACT.md),
but a song costs a known, fixed number of credits. An admin records that
price with a start date (Reports -> Credit Rates); this module stamps it onto
every generation of the tool, past and future:

* each generation gets the price in effect on its IST date - every charge
  status, so a song shows its cost wherever it is listed (totals still only
  count Charged rows);
* a price change starts a new dated row and closes the previous one, so
  older songs keep the price they were made at;
* adding or removing a price re-stamps only the dates it covers; new
  captures are stamped as they are normalized (stamp_generation).

The value is written to the tool's own credits column and mirrored onto its
cross-tool GenerationRecord.credits_burned, so the Credit Report, the cost
reports and the capture cards all read it like a captured cost.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from models_new import GenerationRecord, ToolGenerationPrice

IST = timedelta(minutes=330)


@dataclass(frozen=True)
class PricedTool:
    name: str
    unit: str                 # what one generation is ("song")
    model: type
    credits_column: str
    provider: str             # GenerationRecord.provider


def _tools() -> dict:
    from providers.suno.models import SunoGeneration
    return {"Suno": PricedTool("Suno", "song", SunoGeneration, "credits_used", "suno")}


def priced_tools() -> dict:
    return _tools()


def generation_day(row) -> Optional[date]:
    """The IST date a generation belongs to (the Credit Report's Date)."""
    when = getattr(row, "provider_created_at", None) or getattr(row, "created_at", None)
    return (when.replace(tzinfo=None) + IST).date() if when else None


def prices(db: Session, tool: str) -> list:
    return (db.query(ToolGenerationPrice).filter(ToolGenerationPrice.tool == tool)
            .order_by(ToolGenerationPrice.effective_from).all())


def price_on(price_rows: list, day: Optional[date]) -> Optional[int]:
    if day is None:
        return None
    for p in price_rows:
        if p.effective_from <= day and (p.effective_to is None or day <= p.effective_to):
            return int(p.credits_per_generation)
    return None


def stamp_generation(db: Session, tool: str, generation, record: Optional[GenerationRecord] = None) -> None:
    """Price one generation (called while it is normalized)."""
    spec = _tools().get(tool)
    if spec is None:
        return
    credits = price_on(prices(db, tool), generation_day(generation))
    setattr(generation, spec.credits_column, credits)
    if record is not None:
        record.credits_burned = credits


def apply_prices(db: Session, tool: str, start: Optional[date] = None, end: Optional[date] = None) -> int:
    """Re-stamp every generation of `tool` whose IST date is in [start, end]
    (None = open). Returns how many rows were stamped. Does not commit."""
    spec = _tools()[tool]
    model = spec.model
    when = func.coalesce(model.provider_created_at, model.created_at)
    q = db.query(model)
    if start:
        q = q.filter(when >= datetime(start.year, start.month, start.day) - IST)
    if end:
        q = q.filter(when < datetime(end.year, end.month, end.day) + timedelta(days=1) - IST)
    rows = q.all()
    price_rows = prices(db, tool)
    records = {}
    record_ids = [r.generation_record_id for r in rows if getattr(r, "generation_record_id", None)]
    for i in range(0, len(record_ids), 500):
        for rec in db.query(GenerationRecord).filter(GenerationRecord.id.in_(record_ids[i:i + 500])):
            records[rec.id] = rec
    for row in rows:
        credits = price_on(price_rows, generation_day(row))
        setattr(row, spec.credits_column, credits)
        rec = records.get(getattr(row, "generation_record_id", None))
        if rec is not None and rec.provider == spec.provider:
            rec.credits_burned = credits
    db.flush()
    return len(rows)


def set_price(db: Session, tool: str, credits: int, effective_from: date, notes: Optional[str] = None,
              user_id: Optional[int] = None) -> tuple:
    """Add a price from `effective_from`. The price in effect before it ends
    the day before; a later price (if any) bounds this one. Re-stamps the
    dates it covers. Returns (price row, rows stamped). Does not commit."""
    if tool not in _tools():
        raise ValueError(f"{tool} has no fixed price setting")
    if credits < 0:
        raise ValueError("Credits per generation must be 0 or more")
    existing = prices(db, tool)
    same_day = next((p for p in existing if p.effective_from == effective_from), None)
    if same_day is not None:
        # Same start date: a correction, not a new period.
        same_day.credits_per_generation = credits
        same_day.notes = notes
        row = same_day
    else:
        before = [p for p in existing if p.effective_from < effective_from]
        after = [p for p in existing if p.effective_from > effective_from]
        if before and (before[-1].effective_to is None or before[-1].effective_to >= effective_from):
            before[-1].effective_to = effective_from - timedelta(days=1)
        row = ToolGenerationPrice(tool=tool, credits_per_generation=credits, effective_from=effective_from,
                                  effective_to=(after[0].effective_from - timedelta(days=1)) if after else None,
                                  notes=notes, created_by=user_id)
        db.add(row)
    db.flush()
    return row, apply_prices(db, tool, effective_from, row.effective_to)


def delete_price(db: Session, price_id: int) -> tuple:
    """Remove a price; the price before it covers its dates again (or none).
    Returns (tool, rows stamped). Does not commit."""
    row = db.get(ToolGenerationPrice, price_id)
    if row is None:
        raise LookupError("Price not found")
    tool, start, end = row.tool, row.effective_from, row.effective_to
    previous = [p for p in prices(db, tool) if p.effective_from < start]
    if previous and previous[-1].effective_to == start - timedelta(days=1):
        previous[-1].effective_to = end
    db.delete(row)
    db.flush()
    return tool, apply_prices(db, tool, start, end)


def first_generation_day(db: Session, tool: str) -> Optional[date]:
    spec = _tools()[tool]
    first = db.query(func.min(func.coalesce(spec.model.provider_created_at, spec.model.created_at))).scalar()
    return (first + IST).date() if first else None


def summary(db: Session) -> list:
    """Each priced tool: unit, current price, history, and how many generations exist."""
    out = []
    today = (datetime.utcnow() + IST).date()
    for name, spec in _tools().items():
        rows = prices(db, name)
        total = db.query(func.count(spec.model.id)).scalar() or 0
        unpriced = (db.query(func.count(spec.model.id))
                    .filter(or_(getattr(spec.model, spec.credits_column).is_(None))).scalar() or 0)
        out.append({
            "tool": name,
            "unit": spec.unit,
            "currentCredits": price_on(rows, today),
            "firstGenerationDate": (first_generation_day(db, name) or today).isoformat(),
            "generations": int(total),
            "generationsWithoutPrice": int(unpriced),
            "history": [{"id": p.id, "credits": int(p.credits_per_generation),
                         "effectiveFrom": p.effective_from.isoformat(),
                         "effectiveTo": p.effective_to.isoformat() if p.effective_to else None,
                         "notes": p.notes} for p in reversed(rows)],
        })
    return out
