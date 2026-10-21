# providers/flow/pricing.py
"""Credits per Flow generation, from a rate table and the account's plan.

Flow reports no cost of its own, but its price is published per model:
Google Flow Help "Manage your credits", copied into
flow_credit_combinations.xlsx (Rates tab) and seeded below. One output
costs the rate for its (model, resolution, duration) under the account's
plan; aspect ratio and Frames vs Ingredients do not change it, and an xN
click is N rows, each charged once.

Where each input comes from:
* settings - content-flow.js snapshots Flow's composer when Generate is
  clicked into metadata.rmwSettings; settings_fields() copies them onto
  FlowGeneration's own columns.
* plan     - FlowAccountPlan, dated per account (Reports -> Credit Rates).
  Free is charged the Plus & Pro column, Ultra its own.
* rate     - FlowCreditRate, dated like Suno's fixed price
  (services/generation_pricing.py), so a Google price change only affects
  generations from its date on.

The result is written to FlowGeneration.credits_used and mirrored onto its
GenerationRecord.credits_burned, so the Credit Report and the cost reports
read it like a captured cost. Anything unknown (no settings - every row
captured before this existed -, a model with no rate, no plan set) stays
NULL, never 0: 0 means free.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import GenerationRecord, ITPortalToolCredential
from providers.flow.models import FlowAccountPlan, FlowCreditRate, FlowGeneration

IST = timedelta(minutes=330)

PLANS = ("free", "pro", "ultra")
PLAN_LABELS = {"free": "Free", "pro": "Plus & Pro", "ultra": "Ultra"}
_PLAN_COLUMN = {"free": "credits_plus_pro", "pro": "credits_plus_pro", "ultra": "credits_ultra"}

# The day the sheet's rates were checked against Google's help page.
DEFAULT_RATES_FROM = date(2026, 10, 21)
_ON_ALL_PLANS = "Google Flow Help: Manage your credits"
_OMNI = "Same on all plans (edits cost 40)"
# (model, resolution, duration_seconds, Plus & Pro, Ultra, note)
DEFAULT_RATES = (
    ("Veo 3.1 - Lite", "720p", 4, 10, 5, _ON_ALL_PLANS),
    ("Veo 3.1 - Lite", "720p", 6, 10, 5, _ON_ALL_PLANS),
    ("Veo 3.1 - Lite", "720p", 8, 10, 5, _ON_ALL_PLANS),
    ("Veo 3.1 - Fast", "720p", 4, 20, 10, _ON_ALL_PLANS),
    ("Veo 3.1 - Fast", "720p", 6, 20, 10, _ON_ALL_PLANS),
    ("Veo 3.1 - Fast", "720p", 8, 20, 10, _ON_ALL_PLANS),
    ("Veo 3.1 - Quality", "720p", 8, 100, 100, _ON_ALL_PLANS),
    ("Veo 3.1 - Lite (Lower Priority)", "720p", 4, None, 0, "Ultra only (not Ultra family members)"),
    ("Veo 3.1 - Lite (Lower Priority)", "720p", 6, None, 0, "Ultra only (not Ultra family members)"),
    ("Veo 3.1 - Lite (Lower Priority)", "720p", 8, None, 0, "Ultra only (not Ultra family members)"),
    ("Gemini Omni Flash", "720p", 4, 7, 7, _OMNI),
    ("Gemini Omni Flash", "720p", 6, 10, 10, _OMNI),
    ("Gemini Omni Flash", "720p", 8, 12, 12, _OMNI),
    ("Gemini Omni Flash", "720p", 10, 15, 15, _OMNI),
    ("Gemini Omni Flash", "360p", 4, 4, 4, _OMNI),
    ("Gemini Omni Flash", "360p", 6, 5, 5, _OMNI),
    ("Gemini Omni Flash", "360p", 8, 6, 6, _OMNI),
    ("Gemini Omni Flash", "360p", 10, 7, 7, _OMNI),
    ("Nano Banana 2 Lite", None, None, 0, 0, "Available at no charge"),
    ("Nano Banana 2.1", None, None, None, None, "Not published - enter what Flow shows"),
    ("Nano Banana Pro", None, None, None, None, "Not published - enter what Flow shows"),
)

# Flow's composer labels that differ from the help page's names, by key.
# Seen live 2026-10-21: the model menu shows "Omni 1.1 Flash".
MODEL_ALIASES = {
    "omni11flash": "geminiomniflash",
    "omniflash": "geminiomniflash",
    "geminiomni11flash": "geminiomniflash",
}


def model_key(label: Optional[str]) -> str:
    """Case/punctuation-blind key: "Veo 3.1 - Fast" and "veo 3.1 fast" match."""
    key = re.sub(r"[^a-z0-9]", "", (label or "").lower())
    return MODEL_ALIASES.get(key, key)


def generation_day(row) -> Optional[date]:
    """The IST date a generation belongs to (the Credit Report's Date)."""
    when = getattr(row, "provider_created_at", None) or getattr(row, "created_at", None)
    return (when.replace(tzinfo=None) + IST).date() if when else None


def _in_period(row, day: date) -> bool:
    return row.effective_from <= day and (row.effective_to is None or day <= row.effective_to)


# --------------------------------------------------------------------------- #
# Settings captured by the extension
# --------------------------------------------------------------------------- #
def _int(value) -> Optional[int]:
    try:
        number = int(str(value).strip().rstrip("sx"))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _text(value, limit: int) -> Optional[str]:
    text = str(value).strip() if value is not None else ""
    return text[:limit] or None


def settings_fields(metadata: Optional[dict]) -> dict:
    """FlowGeneration column values from metadata.rmwSettings ({} if absent)."""
    settings = (metadata or {}).get("rmwSettings")
    if not isinstance(settings, dict):
        return {}
    media_type = (_text(settings.get("type"), 20) or "").lower() or None
    resolution = (_text(settings.get("resolution"), 20) or "").lower() or None
    return {
        "media_type": media_type if media_type in ("video", "image") else None,
        "model_name": _text(settings.get("model"), 120),
        "resolution": resolution,
        "duration_seconds": _int(settings.get("durationSeconds")),
        "aspect_ratio": _text(settings.get("aspectRatio"), 20),
        "output_count": _int(settings.get("outputs")),
    }


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #
def ensure_default_rates(db: Session) -> None:
    """Seed the sheet's rates the first time the table is found empty.

    Done here rather than at startup because production runs with startup
    schema sync off; every path that prices or lists rates calls this."""
    if db.query(FlowCreditRate.id).first() is not None:
        return
    for model, resolution, seconds, plus_pro, ultra, note in DEFAULT_RATES:
        db.add(FlowCreditRate(model_name=model, model_key=model_key(model), resolution=resolution,
                              duration_seconds=seconds, credits_plus_pro=plus_pro, credits_ultra=ultra,
                              effective_from=DEFAULT_RATES_FROM, notes=note))
    db.flush()


def all_rates(db: Session) -> list:
    ensure_default_rates(db)
    return (db.query(FlowCreditRate)
            .order_by(FlowCreditRate.model_name, FlowCreditRate.resolution, FlowCreditRate.duration_seconds,
                      FlowCreditRate.effective_from).all())


def rate_for(rates: Iterable[FlowCreditRate], model: Optional[str], resolution: Optional[str],
             duration_seconds: Optional[int], day: Optional[date]) -> Optional[FlowCreditRate]:
    """The rate row in effect on `day`; a row's NULL resolution/duration
    matches anything, and the most specific match wins."""
    if not model or day is None:
        return None
    key = model_key(model)
    best, best_score = None, -1
    for rate in rates:
        if rate.model_key != key or not _in_period(rate, day):
            continue
        if rate.resolution is not None and rate.resolution != (resolution or "").lower():
            continue
        if rate.duration_seconds is not None and rate.duration_seconds != duration_seconds:
            continue
        score = (rate.resolution is not None) + (rate.duration_seconds is not None)
        if score > best_score:
            best, best_score = rate, score
    return best


class PlanBook:
    """Plans per account, read once per stamping pass. A user credential
    linked to a shared login (linked_credential_id) uses the login's plan
    unless it has its own."""

    def __init__(self, db: Session):
        self._plans: dict = {}
        for row in db.query(FlowAccountPlan).order_by(FlowAccountPlan.effective_from).all():
            self._plans.setdefault(row.credential_id, []).append(row)
        self._links = dict(db.query(ITPortalToolCredential.id, ITPortalToolCredential.linked_credential_id)
                           .filter(ITPortalToolCredential.linked_credential_id.isnot(None)).all())

    def plan_on(self, credential_id: Optional[int], day: Optional[date]) -> Optional[str]:
        if credential_id is None or day is None:
            return None
        for cid in (credential_id, self._links.get(credential_id)):
            for row in self._plans.get(cid, ()):
                if _in_period(row, day):
                    return row.plan
        return None


def price(generation: FlowGeneration, rates: list, plans: PlanBook) -> tuple:
    """(plan, credits) for one generation; either may be None (unknown)."""
    day = generation_day(generation)
    plan = plans.plan_on(generation.credential_id, day)
    if plan is None:
        return None, None
    rate = rate_for(rates, generation.model_name, generation.resolution, generation.duration_seconds, day)
    return plan, (getattr(rate, _PLAN_COLUMN[plan]) if rate is not None else None)


# --------------------------------------------------------------------------- #
# Stamping
# --------------------------------------------------------------------------- #
def stamp_generation(db: Session, generation: FlowGeneration) -> None:
    """Price one generation (called while it is normalized; the projection
    that follows copies credits_used onto its GenerationRecord)."""
    generation.account_plan, generation.credits_used = price(generation, all_rates(db), PlanBook(db))


def apply_prices(db: Session, start: Optional[date] = None, end: Optional[date] = None,
                 credential_ids: Optional[Iterable[int]] = None) -> int:
    """Re-stamp every generation whose IST date is in [start, end] (None =
    open), optionally only for some accounts. Returns how many rows were
    stamped. Does not commit."""
    when = func.coalesce(FlowGeneration.provider_created_at, FlowGeneration.created_at)
    q = db.query(FlowGeneration)
    if start:
        q = q.filter(when >= datetime(start.year, start.month, start.day) - IST)
    if end:
        q = q.filter(when < datetime(end.year, end.month, end.day) + timedelta(days=1) - IST)
    if credential_ids is not None:
        q = q.filter(FlowGeneration.credential_id.in_(list(credential_ids)))
    rows = q.all()
    rates, plans = all_rates(db), PlanBook(db)
    record_ids = [r.generation_record_id for r in rows if r.generation_record_id]
    records = {}
    for i in range(0, len(record_ids), 500):
        for rec in db.query(GenerationRecord).filter(GenerationRecord.id.in_(record_ids[i:i + 500])):
            records[rec.id] = rec
    for row in rows:
        row.account_plan, row.credits_used = price(row, rates, plans)
        rec = records.get(row.generation_record_id)
        if rec is not None and rec.provider == "flow":
            rec.credits_burned = row.credits_used
    db.flush()
    return len(rows)


# --------------------------------------------------------------------------- #
# Admin edits (dated: a change starts a new period and ends the previous one)
# --------------------------------------------------------------------------- #
def _insert_period(existing: list, effective_from: date, make_row):
    """Shared dated-period insert: the period before ends the day before,
    a later one bounds the new row. Returns the new row."""
    before = [p for p in existing if p.effective_from < effective_from]
    after = [p for p in existing if p.effective_from > effective_from]
    if before and (before[-1].effective_to is None or before[-1].effective_to >= effective_from):
        before[-1].effective_to = effective_from - timedelta(days=1)
    return make_row((after[0].effective_from - timedelta(days=1)) if after else None)


def _remove_period(existing: list, row) -> None:
    """The period before a removed one covers its dates again."""
    previous = [p for p in existing if p.effective_from < row.effective_from]
    if previous and previous[-1].effective_to == row.effective_from - timedelta(days=1):
        previous[-1].effective_to = row.effective_to


def _check_credits(value: Optional[int]) -> Optional[int]:
    if value is None:
        return None
    if int(value) < 0:
        raise ValueError("Credits must be 0 or more (leave blank for no price)")
    return int(value)


def set_rate(db: Session, *, model_name: str, resolution: Optional[str], duration_seconds: Optional[int],
             credits_plus_pro: Optional[int], credits_ultra: Optional[int], effective_from: date,
             notes: Optional[str] = None, user_id: Optional[int] = None) -> tuple:
    """Add a rate from `effective_from` (or correct the one starting that
    day). Returns (rate row, generations re-stamped). Does not commit."""
    model_name = (model_name or "").strip()
    if not model_key(model_name):
        raise ValueError("Model is required")
    resolution = (resolution or "").strip().lower() or None
    plus_pro, ultra = _check_credits(credits_plus_pro), _check_credits(credits_ultra)
    key = model_key(model_name)
    existing = [r for r in all_rates(db)
                if r.model_key == key and r.resolution == resolution and r.duration_seconds == duration_seconds]
    existing.sort(key=lambda r: r.effective_from)
    row = next((r for r in existing if r.effective_from == effective_from), None)
    if row is None:
        row = _insert_period(existing, effective_from, lambda effective_to: FlowCreditRate(
            model_name=model_name, model_key=key, resolution=resolution, duration_seconds=duration_seconds,
            effective_from=effective_from, effective_to=effective_to, created_by=user_id))
        db.add(row)
    row.model_name = model_name
    row.credits_plus_pro, row.credits_ultra, row.notes = plus_pro, ultra, notes
    db.flush()
    return row, apply_prices(db, effective_from, row.effective_to)


def delete_rate(db: Session, rate_id: int) -> int:
    row = db.get(FlowCreditRate, rate_id)
    if row is None:
        raise LookupError("Rate not found")
    siblings = sorted((r for r in all_rates(db) if r.model_key == row.model_key and r.resolution == row.resolution
                       and r.duration_seconds == row.duration_seconds), key=lambda r: r.effective_from)
    start, end = row.effective_from, row.effective_to
    _remove_period(siblings, row)
    db.delete(row)
    db.flush()
    return apply_prices(db, start, end)


def _accounts_sharing(db: Session, credential_id: int) -> list:
    """The account and every user credential linked to it."""
    linked = [cid for (cid,) in db.query(ITPortalToolCredential.id)
              .filter(ITPortalToolCredential.linked_credential_id == credential_id).all()]
    return [credential_id] + linked


def set_plan(db: Session, credential_id: int, plan: str, effective_from: date,
             notes: Optional[str] = None, user_id: Optional[int] = None) -> tuple:
    """Put an account on a plan from a date. Returns (row, re-stamped)."""
    if plan not in PLANS:
        raise ValueError(f"Plan must be one of: {', '.join(PLANS)}")
    existing = (db.query(FlowAccountPlan).filter(FlowAccountPlan.credential_id == credential_id)
                .order_by(FlowAccountPlan.effective_from).all())
    row = next((p for p in existing if p.effective_from == effective_from), None)
    if row is None:
        row = _insert_period(existing, effective_from, lambda effective_to: FlowAccountPlan(
            credential_id=credential_id, effective_from=effective_from, effective_to=effective_to,
            created_by=user_id))
        db.add(row)
    row.plan, row.notes = plan, notes
    db.flush()
    return row, apply_prices(db, effective_from, row.effective_to, _accounts_sharing(db, credential_id))


def delete_plan(db: Session, plan_id: int) -> int:
    row = db.get(FlowAccountPlan, plan_id)
    if row is None:
        raise LookupError("Plan not found")
    existing = (db.query(FlowAccountPlan).filter(FlowAccountPlan.credential_id == row.credential_id)
                .order_by(FlowAccountPlan.effective_from).all())
    credential_id, start, end = row.credential_id, row.effective_from, row.effective_to
    _remove_period(existing, row)
    db.delete(row)
    db.flush()
    return apply_prices(db, start, end, _accounts_sharing(db, credential_id))


# --------------------------------------------------------------------------- #
# Admin summary
# --------------------------------------------------------------------------- #
def today_ist() -> date:
    return (datetime.utcnow() + IST).date()


def _rate_dict(rate: FlowCreditRate, today: date) -> dict:
    return {
        "id": rate.id,
        "model": rate.model_name,
        "resolution": rate.resolution,
        "durationSeconds": rate.duration_seconds,
        "creditsPlusPro": rate.credits_plus_pro,
        "creditsUltra": rate.credits_ultra,
        "effectiveFrom": rate.effective_from.isoformat(),
        "effectiveTo": rate.effective_to.isoformat() if rate.effective_to else None,
        "current": _in_period(rate, today),
        "notes": rate.notes,
    }


def summary(db: Session, accounts: list) -> dict:
    """Rate table, the given Flow accounts ([{id, label}]) with their plan
    history, and why generations are still unpriced."""
    today = today_ist()
    rates = all_rates(db)
    plans = PlanBook(db)
    by_account = {}
    for row in db.query(FlowAccountPlan).order_by(FlowAccountPlan.effective_from.desc()).all():
        by_account.setdefault(row.credential_id, []).append(row)
    counts = dict(db.query(FlowGeneration.credential_id, func.count(FlowGeneration.id))
                  .group_by(FlowGeneration.credential_id).all())
    linked = {}
    for cid, parent in db.query(ITPortalToolCredential.id, ITPortalToolCredential.linked_credential_id) \
            .filter(ITPortalToolCredential.linked_credential_id.isnot(None)).all():
        linked.setdefault(parent, []).append(cid)

    account_rows = []
    for account in accounts:
        cid = account["id"]
        sharing = [cid] + linked.get(cid, [])
        account_rows.append({
            **account,
            "currentPlan": plans.plan_on(cid, today),
            "generations": int(sum(counts.get(c, 0) for c in sharing)),
            "linkedCredentialIds": linked.get(cid, []),
            "history": [{"id": p.id, "plan": p.plan, "effectiveFrom": p.effective_from.isoformat(),
                         "effectiveTo": p.effective_to.isoformat() if p.effective_to else None,
                         "notes": p.notes} for p in by_account.get(cid, [])],
        })

    total = db.query(func.count(FlowGeneration.id)).scalar() or 0
    priced = db.query(func.count(FlowGeneration.id)).filter(FlowGeneration.credits_used.isnot(None)).scalar() or 0
    no_settings = (db.query(func.count(FlowGeneration.id))
                   .filter(FlowGeneration.model_name.is_(None)).scalar() or 0)
    no_plan = (db.query(func.count(FlowGeneration.id))
               .filter(FlowGeneration.model_name.isnot(None), FlowGeneration.account_plan.is_(None)).scalar() or 0)
    # Settings and a plan, still no price: the model/resolution/duration has
    # no rate (a new model, or one Google never priced) - named so an admin
    # can add it.
    unpriced = (db.query(FlowGeneration.model_name, FlowGeneration.resolution, FlowGeneration.duration_seconds,
                         FlowGeneration.account_plan, func.count(FlowGeneration.id))
                .filter(FlowGeneration.model_name.isnot(None), FlowGeneration.account_plan.isnot(None),
                        FlowGeneration.credits_used.is_(None))
                .group_by(FlowGeneration.model_name, FlowGeneration.resolution, FlowGeneration.duration_seconds,
                          FlowGeneration.account_plan).all())
    return {
        "plans": [{"value": p, "label": PLAN_LABELS[p]} for p in PLANS],
        "rates": [_rate_dict(r, today) for r in rates],
        "accounts": account_rows,
        "generations": {
            "total": int(total),
            "priced": int(priced),
            "withoutSettings": int(no_settings),
            "withoutPlan": int(no_plan),
            "withoutRate": [{"model": m, "resolution": r, "durationSeconds": d, "plan": p, "count": int(n)}
                            for m, r, d, p, n in unpriced],
        },
    }
