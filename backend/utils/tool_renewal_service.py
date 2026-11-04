# utils/tool_renewal_service.py
"""
Centralized "Tool Renew" domain logic (Admin Queue -> Tool Renew).

Every account (ITPortalToolCredential) independently configures three things:

  - its plan (`renewal_type`):
      MONTHLY / QUARTERLY / HALF_YEARLY / YEARLY  a subscription billed every
                                                   1 / 3 / 6 / 12 months
      CREDIT_CONSUMPTION                           a credit pack: renews when
                                                   its credits run out
      MANUAL                                       custom dates, no fixed cycle
      FREE                                         a free plan (no cost)
      NOT_PURCHASED                                not bought right now
  - whether it uses a credit system (`credit_enabled`)
  - when its credit balance resets (`credit_reset`): CYCLE = at the start of
    each plan period (since the purchase date; never, for a credit pack or a
    free plan with one-time credits), MONTHLY = every month on the purchase
    date's day (e.g. a yearly plan that grants credits monthly)

Plan and credits are separate columns, not one merged enum, so any
combination is valid (e.g. a monthly plan that also tracks credits).

This module is the single place that interprets those columns, so the admin
API (routers/it_tools_router.py), the report/AI-workbook builder
(utils/usage_intelligence/service.py) and cost reporting
(routers/reports_router.py) all agree on:

  - what the account's current credit rate is (`get_current_rate`), and
    that a generation is costed only at its own account's rate
    (`account_credit_rates`)
  - how many credits it has used / has left this credit period
    (`credit_usage`, `resolve_remaining_credits`)
  - whether it needs attention right now (`calculate_renewal_status`)
  - keeping a stale subscription + auto-renew account rolled forward
    (`process_auto_renewal`): the renewal that just happened becomes the
    purchase date, and the renewal date moves on one billing period

Nothing here deletes historical ToolCreditRate/usage-event data; turning
credit_enabled off only stops these functions from reporting a balance/cost
for that account going forward.
"""
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import GenerationRecord, ITPortalToolCredential, ITPortalToolUsageEvent, ToolCreditRate

# Subscriptions and how many months one billing period spans.
PLAN_PERIOD_MONTHS = {"MONTHLY": 1, "QUARTERLY": 3, "HALF_YEARLY": 6, "YEARLY": 12}
CREDIT_PACK = "CREDIT_CONSUMPTION"
CUSTOM = "MANUAL"
FREE = "FREE"
NOT_PURCHASED = "NOT_PURCHASED"
RENEWAL_TYPES = (*PLAN_PERIOD_MONTHS, CREDIT_PACK, CUSTOM, FREE, NOT_PURCHASED)
DEFAULT_RENEWAL_TYPE = CUSTOM
# Plans that cost nothing: their tool_cost is held at 0 and they never renew.
NO_COST_TYPES = (FREE, NOT_PURCHASED)

PLAN_LABELS = {
    "MONTHLY": "Monthly",
    "QUARTERLY": "Quarterly",
    "HALF_YEARLY": "Half-yearly",
    "YEARLY": "Yearly",
    CREDIT_PACK: "Credit pack",
    CUSTOM: "Custom dates",
    FREE: "Free plan",
    NOT_PURCHASED: "Not purchased",
}

CREDIT_RESET_CYCLE = "CYCLE"
CREDIT_RESET_MONTHLY = "MONTHLY"
CREDIT_RESETS = (CREDIT_RESET_CYCLE, CREDIT_RESET_MONTHLY)

# How close a renewal date has to be to show as "due soon", and how small a
# share of the credits left counts as "low".
DUE_SOON_DAYS = 7
LOW_CREDIT_SHARE = 0.10

STATUS_OK = "ok"
STATUS_FREE = "free"
STATUS_NOT_PURCHASED = "not_purchased"
STATUS_RENEWS_SOON = "renews_soon"          # auto-renew, within DUE_SOON_DAYS
STATUS_DUE_SOON = "due_soon"                # manual renewal, within DUE_SOON_DAYS
STATUS_RENEWAL_REQUIRED = "renewal_required"  # renewal date passed, not auto-renewed
STATUS_CREDITS_LOW = "credits_low"
STATUS_CREDITS_EXHAUSTED = "credits_exhausted"
STATUS_NEEDS_SETUP = "needs_setup"          # e.g. a subscription with no renewal date
STATUS_NOT_APPLICABLE = "not_applicable"    # custom dates with no renewal date set

STATUS_LABELS = {
    STATUS_OK: "OK",
    STATUS_FREE: "Free",
    STATUS_NOT_PURCHASED: "Not purchased",
    STATUS_RENEWS_SOON: "Renews soon",
    STATUS_DUE_SOON: "Renewal due soon",
    STATUS_RENEWAL_REQUIRED: "Renewal overdue",
    STATUS_CREDITS_LOW: "Credits low",
    STATUS_CREDITS_EXHAUSTED: "Credits used up",
    STATUS_NEEDS_SETUP: "Needs setup",
    STATUS_NOT_APPLICABLE: "No renewal date",
}


def normalize_renewal_type(value: Optional[str]) -> str:
    normalized = (value or "").strip().upper()
    return normalized if normalized in RENEWAL_TYPES else DEFAULT_RENEWAL_TYPE


def is_valid_renewal_type(value: Optional[str]) -> bool:
    return (value or "").strip().upper() in RENEWAL_TYPES


def plan_label(value: Optional[str]) -> str:
    return PLAN_LABELS[normalize_renewal_type(value)]


def normalize_credit_reset(value: Optional[str]) -> str:
    normalized = (value or "").strip().upper()
    return normalized if normalized in CREDIT_RESETS else CREDIT_RESET_CYCLE


def is_valid_credit_reset(value: Optional[str]) -> bool:
    return (value or "").strip().upper() in CREDIT_RESETS


def get_current_rate(db: Session, credential_id: Optional[int]) -> Optional[ToolCreditRate]:
    """The effective ToolCreditRate for an account today, or the global
    default row when credential_id is None. Shared by credit_rates_router
    (admin CRUD) and reports_router (costing) so both agree on "current"."""
    today = datetime.utcnow().date()
    query = db.query(ToolCreditRate).filter(
        ToolCreditRate.effective_from <= today,
        (ToolCreditRate.effective_to.is_(None)) | (ToolCreditRate.effective_to >= today),
    )
    if credential_id is None:
        query = query.filter(
            ToolCreditRate.credential_id.is_(None),
            ToolCreditRate.provider.is_(None),
            ToolCreditRate.tool_id.is_(None),
        )
    else:
        query = query.filter(ToolCreditRate.credential_id == credential_id)
    return (
        query
        .order_by(ToolCreditRate.effective_from.desc(), ToolCreditRate.id.desc())
        .first()
    )


def account_credit_rates(db: Session) -> dict:
    """{credential_id: rupees per credit} for every account that has a rate.

    The one costing rule every report uses: a generation costs its credits x
    its own account's current rate (the one Tool Renew shows), whatever day
    it happened -- so correcting an account's rate re-prices all of that
    account's generations, and no other account's. An account missing from
    the dict has no rate: its cost is "Not set", never another account's
    rate, its tool's rate or a global default. An account that had a rate
    and then had Credit System turned off costs 0; one that never had a rate
    stays "Not set" (credit_enabled is off by default, so off alone does not
    mean the account costs nothing)."""
    today = datetime.utcnow().date()
    rows = (
        db.query(ToolCreditRate.credential_id, ToolCreditRate.rate_per_credit)
        .filter(
            ToolCreditRate.credential_id.isnot(None),
            ToolCreditRate.rate_per_credit.isnot(None),
            ToolCreditRate.effective_from <= today,
            (ToolCreditRate.effective_to.is_(None)) | (ToolCreditRate.effective_to >= today),
        )
        .order_by(ToolCreditRate.effective_from.desc(), ToolCreditRate.id.desc())
        .all()
    )
    rates: dict = {}
    for credential_id, rate in rows:
        rates.setdefault(int(credential_id), float(rate))  # newest row per account wins
    had_rate = db.query(ToolCreditRate.credential_id).filter(ToolCreditRate.credential_id.isnot(None))
    disabled = db.query(ITPortalToolCredential.id).filter(
        ITPortalToolCredential.credit_enabled.is_(False),
        ITPortalToolCredential.id.in_(had_rate),
    )
    for (credential_id,) in disabled.all():
        rates[int(credential_id)] = 0.0
    return rates


def _months_between(start: date, end: date) -> int:
    return (end.year - start.year) * 12 + (end.month - start.month)


def credit_period(credential: ITPortalToolCredential, today: Optional[date] = None) -> tuple:
    """(start, resets_on) of the account's current credit period; either can
    be None when unknown. A monthly reset counts from the latest monthly
    anniversary of the purchase date (the 1st of the month when there is
    none); otherwise credits count from the purchase date and reset at the
    renewal date (never, for a credit pack or a free plan)."""
    plan = normalize_renewal_type(credential.renewal_type)
    if plan == NOT_PURCHASED:
        return None, None
    reset = normalize_credit_reset(getattr(credential, "credit_reset", None))
    if plan in ("MONTHLY", CREDIT_PACK):
        reset = CREDIT_RESET_CYCLE  # a monthly plan already resets monthly; a pack never does
    today = today or datetime.utcnow().date()
    anchor = credential.purchase_date

    if reset == CREDIT_RESET_MONTHLY:
        if anchor is None:
            start = today.replace(day=1)
            return start, calculate_next_renewal_date(start, 1)
        if anchor > today:
            return anchor, calculate_next_renewal_date(anchor, 1)
        # Count from the anchor each time so a 31st doesn't drift to the 28th.
        k = _months_between(anchor, today)
        if calculate_next_renewal_date(anchor, k) > today:
            k -= 1
        return calculate_next_renewal_date(anchor, k), calculate_next_renewal_date(anchor, k + 1)

    resets_on = credential.renewal_date if plan in PLAN_PERIOD_MONTHS or plan == CUSTOM else None
    return anchor, resets_on


def _sum_credits_burned_since(db: Session, credential_id: int, since) -> float:
    query = (
        db.query(func.coalesce(func.sum(GenerationRecord.credits_burned), 0))
        .join(ITPortalToolUsageEvent, GenerationRecord.source_usage_event_id == ITPortalToolUsageEvent.id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            ITPortalToolUsageEvent.credential_id == credential_id,
        )
    )
    if since:
        query = query.filter(GenerationRecord.created_at >= datetime.combine(since, datetime.min.time()))
    return float(query.scalar() or 0)


def credit_usage(
    db: Session,
    credential: ITPortalToolCredential,
    rate: Optional[ToolCreditRate] = None,
    today: Optional[date] = None,
) -> Optional[dict]:
    """{total, used, remaining, periodStart, resetsOn} for this credit period,
    or None when credits don't apply (credit system off, not purchased, or no
    rate configured yet) -- callers must treat None as "not applicable",
    never as zero.

    Usage counts from the start of the credit period (see credit_period), so
    editing Total Credits mid-period (which starts a new rate row today) does
    not wipe what was already used. Only with no purchase date at all does it
    fall back to the rate's effective_from."""
    if not credential.credit_enabled or normalize_renewal_type(credential.renewal_type) == NOT_PURCHASED:
        return None
    if rate is None:
        rate = get_current_rate(db, credential.id)
    if rate is None or rate.package_credits is None:
        return None
    start, resets_on = credit_period(credential, today)
    if start is None:
        start = rate.effective_from
    total = float(rate.package_credits)
    used = _sum_credits_burned_since(db, credential.id, start)
    return {
        "total": total,
        "used": used,
        "remaining": max(total - used, 0.0),
        "periodStart": start,
        "resetsOn": resets_on,
    }


def resolve_remaining_credits(
    db: Session,
    credential: ITPortalToolCredential,
    rate: Optional[ToolCreditRate] = None,
) -> Optional[float]:
    """Credits left this credit period, or None when credits don't apply
    (see credit_usage)."""
    usage = credit_usage(db, credential, rate=rate)
    return usage["remaining"] if usage else None


def calculate_next_renewal_date(renewal_date: date, months: int = 1) -> date:
    """`months` calendar months forward (1 = monthly, 12 = yearly), clamping
    the day (e.g. Jan 31 -> Feb 28, Feb 29 2028 -> Feb 28 2029)."""
    total = renewal_date.month - 1 + months
    year = renewal_date.year + total // 12
    month = total % 12 + 1
    day = renewal_date.day
    while True:
        try:
            return renewal_date.replace(year=year, month=month, day=day)
        except ValueError:
            day -= 1  # walk back to the last valid day of that month


def calculate_renewal_status(
    credential: ITPortalToolCredential,
    remaining_credits: Optional[float],
    today: Optional[date] = None,
    total_credits: Optional[float] = None,
) -> dict:
    """{status, requiresRenewal, reason, daysLeft} -- the one place that
    decides whether an account needs attention, per its plan. The most
    urgent problem wins: an overdue renewal, then credits used up, then a
    renewal coming up within DUE_SOON_DAYS, then low credits (needs
    total_credits). daysLeft is days until the renewal date (negative once
    passed), None when the plan has no renewal date."""
    plan = normalize_renewal_type(credential.renewal_type)
    today = today or datetime.utcnow().date()

    def result(status: str, reason: Optional[str] = None, requires: bool = False, days_left: Optional[int] = None):
        return {"status": status, "requiresRenewal": requires, "reason": reason, "daysLeft": days_left}

    if plan == NOT_PURCHASED:
        return result(STATUS_NOT_PURCHASED)

    credits_known = bool(credential.credit_enabled) and remaining_credits is not None
    exhausted = credits_known and remaining_credits <= 0
    low = (credits_known and not exhausted and bool(total_credits)
           and remaining_credits / total_credits <= LOW_CREDIT_SHARE)

    if plan == CREDIT_PACK:
        if not credits_known:
            return result(STATUS_NEEDS_SETUP, "credits_not_configured")
        if exhausted:
            return result(STATUS_CREDITS_EXHAUSTED, "credits_exhausted", requires=True)
        return result(STATUS_CREDITS_LOW, "credits_low") if low else result(STATUS_OK)

    if plan == FREE:
        if exhausted:
            return result(STATUS_CREDITS_EXHAUSTED, "credits_exhausted")
        return result(STATUS_CREDITS_LOW, "credits_low") if low else result(STATUS_FREE)

    # Subscriptions and custom dates.
    days_left = (credential.renewal_date - today).days if credential.renewal_date else None
    if days_left is not None and days_left < 0:
        return result(STATUS_RENEWAL_REQUIRED, "renewal_date_passed", requires=True, days_left=days_left)
    if exhausted:
        # Resets at the next renewal / monthly reset: worth flagging, but
        # the plan itself doesn't need renewing.
        return result(STATUS_CREDITS_EXHAUSTED, "credits_exhausted", days_left=days_left)
    if days_left is not None and days_left <= DUE_SOON_DAYS:
        auto = plan in PLAN_PERIOD_MONTHS and credential.auto_renew
        return result(STATUS_RENEWS_SOON if auto else STATUS_DUE_SOON, "renewal_date_near", days_left=days_left)
    if low:
        return result(STATUS_CREDITS_LOW, "credits_low", days_left=days_left)
    if days_left is None:
        if plan in PLAN_PERIOD_MONTHS:
            return result(STATUS_NEEDS_SETUP, "no_renewal_date")
        return result(STATUS_NOT_APPLICABLE, "no_renewal_date")
    return result(STATUS_OK, days_left=days_left)


def process_auto_renewal(db: Session, credential: ITPortalToolCredential, today: Optional[date] = None) -> bool:
    """Lazy roll-forward for subscription + auto_renew accounts. Once the
    stored renewal date arrives the tool has been renewed (charged) on that
    date, so that date becomes the new purchase date and the renewal date
    moves on one billing period -- repeatedly, in case the page went
    unopened for several periods. Returns whether it changed anything; the
    caller is responsible for committing and audit-logging the change (see
    it_tools_router._add_audit, action="credential_auto_renewed")."""
    months = PLAN_PERIOD_MONTHS.get(normalize_renewal_type(credential.renewal_type))
    if not months:
        return False
    if not credential.auto_renew or not credential.renewal_date:
        return False

    today = today or datetime.utcnow().date()
    original = credential.renewal_date
    next_date = credential.renewal_date
    last_renewed = None
    guard = 0
    while next_date <= today and guard < 240:  # 240 periods safety cap
        last_renewed = next_date
        next_date = calculate_next_renewal_date(next_date, months)
        guard += 1
    if next_date == original:
        return False
    credential.renewal_date = next_date
    credential.purchase_date = last_renewed
    return True
