# utils/tool_renewal_service.py
"""
Centralized "Tool Renew" domain logic (Admin Queue -> Tool Renew).

Every account (ITPortalToolCredential) independently configures whether it
uses a credit system (`credit_enabled`) and how it renews (`renewal_type`:
MANUAL / MONTHLY / CREDIT_CONSUMPTION). Those two concerns are intentionally
separate columns, not one merged enum, so any combination is valid (e.g. a
monthly-billed tool that also tracks credits).

This module is the single place that interprets those columns, so the admin
API (routers/it_tools_router.py), the report/AI-workbook builder
(utils/usage_intelligence/service.py) and cost reporting
(routers/reports_router.py) all agree on:

  - what the account's current credit rate is (`get_current_rate`)
  - how many credits it has left (`resolve_remaining_credits`)
  - whether it needs renewing right now (`calculate_renewal_status`)
  - keeping a stale MONTHLY+auto-renew date rolled forward
    (`process_auto_renewal`)

Nothing here deletes historical ToolCreditRate/usage-event data; turning
credit_enabled off only stops these functions from reporting a balance/cost
for that account going forward.
"""
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import GenerationRecord, ITPortalToolCredential, ITPortalToolUsageEvent, ToolCreditRate

RENEWAL_TYPES = ("MANUAL", "MONTHLY", "CREDIT_CONSUMPTION")
DEFAULT_RENEWAL_TYPE = "MANUAL"

STATUS_OK = "ok"
STATUS_RENEWAL_REQUIRED = "renewal_required"
STATUS_NOT_APPLICABLE = "not_applicable"


def normalize_renewal_type(value: Optional[str]) -> str:
    normalized = (value or "").strip().upper()
    return normalized if normalized in RENEWAL_TYPES else DEFAULT_RENEWAL_TYPE


def is_valid_renewal_type(value: Optional[str]) -> bool:
    return (value or "").strip().upper() in RENEWAL_TYPES


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


def _consumption_start(credential: ITPortalToolCredential, rate: Optional[ToolCreditRate]):
    candidates = [d for d in (credential.purchase_date, getattr(rate, "effective_from", None)) if d]
    return max(candidates) if candidates else None


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


def resolve_remaining_credits(
    db: Session,
    credential: ITPortalToolCredential,
    rate: Optional[ToolCreditRate] = None,
) -> Optional[float]:
    """None when credits don't apply to this account (disabled or no rate
    configured yet) -- callers must treat None as "not applicable", never as
    zero. Otherwise total package credits minus what's been burned since the
    package started (purchase date, or the rate's effective_from if no
    purchase date is set)."""
    if not credential.credit_enabled:
        return None
    if rate is None:
        rate = get_current_rate(db, credential.id)
    if rate is None or rate.package_credits is None:
        return None
    consumed = _sum_credits_burned_since(db, credential.id, _consumption_start(credential, rate))
    return max(float(rate.package_credits) - consumed, 0.0)


def calculate_next_renewal_date(renewal_date: date) -> date:
    """One calendar month forward, clamping the day (e.g. Jan 31 -> Feb 28)."""
    month = renewal_date.month + 1
    year = renewal_date.year + (1 if month > 12 else 0)
    month = 1 if month > 12 else month
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
) -> dict:
    """{status, requiresRenewal, reason} -- the one place that decides
    whether an account needs attention, per its configured renewal_type."""
    renewal_type = normalize_renewal_type(credential.renewal_type)
    today = today or datetime.utcnow().date()

    if renewal_type == "MONTHLY":
        if not credential.renewal_date:
            return {"status": STATUS_NOT_APPLICABLE, "requiresRenewal": False, "reason": "no_renewal_date"}
        requires = credential.renewal_date < today
        return {
            "status": STATUS_RENEWAL_REQUIRED if requires else STATUS_OK,
            "requiresRenewal": requires,
            "reason": "renewal_date_passed" if requires else None,
        }

    if renewal_type == "CREDIT_CONSUMPTION":
        if not credential.credit_enabled or remaining_credits is None:
            return {"status": STATUS_NOT_APPLICABLE, "requiresRenewal": False, "reason": "credits_not_configured"}
        requires = remaining_credits <= 0
        return {
            "status": STATUS_RENEWAL_REQUIRED if requires else STATUS_OK,
            "requiresRenewal": requires,
            "reason": "credits_exhausted" if requires else None,
        }

    # MANUAL: admin-driven, never auto-flagged.
    return {"status": STATUS_NOT_APPLICABLE, "requiresRenewal": False, "reason": None}


def process_auto_renewal(db: Session, credential: ITPortalToolCredential, today: Optional[date] = None) -> bool:
    """Lazy roll-forward for MONTHLY + auto_renew accounts: if the stored
    renewal_date has passed, advance it (repeatedly, in case the tool went
    unopened for 2+ months) to the next date that is still in the future.
    Returns whether it changed anything; the caller is responsible for
    committing and audit-logging the change (see it_tools_router._add_audit,
    action="credential_auto_renewed")."""
    if normalize_renewal_type(credential.renewal_type) != "MONTHLY":
        return False
    if not credential.auto_renew or not credential.renewal_date:
        return False

    today = today or datetime.utcnow().date()
    original = credential.renewal_date
    next_date = credential.renewal_date
    guard = 0
    while next_date < today and guard < 240:  # 240 months = 20yr safety cap
        next_date = calculate_next_renewal_date(next_date)
        guard += 1
    if next_date == original:
        return False
    credential.renewal_date = next_date
    return True
