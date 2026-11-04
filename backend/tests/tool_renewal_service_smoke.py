"""Smoke tests for utils/tool_renewal_service.py (Admin Queue -> Tool Renew:
per-account credit system + renewal type configuration).

Covers: credit system on/off, every plan (subscriptions of 1/3/6/12 months,
credit pack, custom dates, free, not purchased), monthly with and without
credits, credits reaching exactly zero or running low, renewals due soon,
auto-renew rolling a stale date forward (including multiple periods stale),
remaining-credits math against real GenerationRecord/usage-event
consumption, monthly credit resets, and renewal_type / credit_reset
validation.
"""
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import (  # noqa: E402
    Base,
    GenerationRecord,
    ITPortalTool,
    ITPortalToolCredential,
    ITPortalToolUsageEvent,
    ToolCreditRate,
    User,
)
from utils.tool_renewal_service import (  # noqa: E402
    STATUS_CREDITS_EXHAUSTED,
    STATUS_CREDITS_LOW,
    STATUS_DUE_SOON,
    STATUS_FREE,
    STATUS_NEEDS_SETUP,
    STATUS_NOT_APPLICABLE,
    STATUS_NOT_PURCHASED,
    STATUS_OK,
    STATUS_RENEWAL_REQUIRED,
    STATUS_RENEWS_SOON,
    calculate_next_renewal_date,
    calculate_renewal_status,
    credit_period,
    credit_usage,
    get_current_rate,
    is_valid_credit_reset,
    is_valid_renewal_type,
    normalize_renewal_type,
    process_auto_renewal,
    resolve_remaining_credits,
)

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        ITPortalToolCredential.__table__,
        ITPortalToolUsageEvent.__table__,
        ToolCreditRate.__table__,
        GenerationRecord.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _make_user(db, email: str) -> int:
    user = User(email=email, name=email.split("@", 1)[0], hashed_password="x", is_active=True, is_deleted=False)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user.id


def _make_tool(db, slug: str) -> int:
    tool = ITPortalTool(name=slug.title(), slug=slug, website_url="https://example.com")
    db.add(tool)
    db.commit()
    db.refresh(tool)
    return tool.id


def _make_credential(db, tool_id: int, **overrides) -> ITPortalToolCredential:
    credential = ITPortalToolCredential(
        tool_id=tool_id,
        scope="company",
        credit_enabled=overrides.pop("credit_enabled", False),
        renewal_type=overrides.pop("renewal_type", "MANUAL"),
        auto_renew=overrides.pop("auto_renew", False),
        credit_reset=overrides.pop("credit_reset", "CYCLE"),
        purchase_date=overrides.pop("purchase_date", None),
        renewal_date=overrides.pop("renewal_date", None),
        tool_cost=overrides.pop("tool_cost", None),
    )
    db.add(credential)
    db.commit()
    db.refresh(credential)
    return credential


def _make_rate(db, credential_id: int, tool_id: int, package_credits: float, package_rupees: float, effective_from: date):
    rate = ToolCreditRate(
        credential_id=credential_id,
        tool_id=tool_id,
        package_credits=package_credits,
        package_rupees=package_rupees,
        rate_per_credit=round(package_rupees / package_credits, 4),
        effective_from=effective_from,
    )
    db.add(rate)
    db.commit()
    db.refresh(rate)
    return rate


def _burn_credits(db, tool_id: int, credential_id: int, user_id: int, credits: float, when: datetime):
    event = ITPortalToolUsageEvent(
        tool_id=tool_id,
        credential_id=credential_id,
        user_id=user_id,
        event_type="generate_click",
        event_date=when.date(),
        credits_burned=credits,
        created_at=when,
    )
    db.add(event)
    db.flush()
    record = GenerationRecord(
        provider="freepik",
        provider_generation_id=f"gen-{event.id}",
        credits_burned=credits,
        owner_user_id=user_id,
        source_usage_event_id=event.id,
        created_at=when,
    )
    db.add(record)
    db.commit()


def main() -> int:
    today = datetime.utcnow().date()

    # 1. renewal_type validation
    _assert(is_valid_renewal_type("MONTHLY"), "MONTHLY should be valid")
    _assert(is_valid_renewal_type("manual"), "lowercase manual should be valid (case-insensitive)")
    _assert(not is_valid_renewal_type("WEEKLY"), "WEEKLY is not a supported renewal type")
    _assert(normalize_renewal_type(None) == "MANUAL", "missing renewal_type normalizes to MANUAL")
    _assert(normalize_renewal_type("bogus") == "MANUAL", "invalid renewal_type normalizes to MANUAL")
    for plan in ("QUARTERLY", "HALF_YEARLY", "FREE", "NOT_PURCHASED", "credit_consumption"):
        _assert(is_valid_renewal_type(plan), f"{plan} should be valid")
    _assert(is_valid_credit_reset("monthly") and is_valid_credit_reset("CYCLE"), "CYCLE / MONTHLY credit resets are valid")
    _assert(not is_valid_credit_reset("WEEKLY"), "WEEKLY is not a supported credit reset")
    print("PASS renewal_type validation")

    # 2. calculate_next_renewal_date: plain month roll + end-of-month clamp
    _assert(calculate_next_renewal_date(date(2026, 1, 15)) == date(2026, 2, 15), "simple month roll")
    _assert(calculate_next_renewal_date(date(2026, 1, 31)) == date(2026, 2, 28), "Jan 31 -> Feb 28 (2026 not a leap year)")
    _assert(calculate_next_renewal_date(date(2026, 12, 15)) == date(2027, 1, 15), "December rolls into next year")
    _assert(calculate_next_renewal_date(date(2026, 2, 24), 12) == date(2027, 2, 24), "yearly roll")
    _assert(calculate_next_renewal_date(date(2028, 2, 29), 12) == date(2029, 2, 28), "Feb 29 yearly -> Feb 28")
    print("PASS calculate_next_renewal_date")

    with SessionLocal() as db:
        user_id = _make_user(db, "admin@example.com")
        tool_id = _make_tool(db, "freepik")

        # 3. Credit system disabled: never reports a balance, never fabricates
        #    a renewal requirement; a credit pack without credits needs setup.
        disabled = _make_credential(db, tool_id, credit_enabled=False, renewal_type="CREDIT_CONSUMPTION")
        _assert(resolve_remaining_credits(db, disabled) is None, "disabled account has no remaining credits")
        status = calculate_renewal_status(disabled, None)
        _assert(status["status"] == STATUS_NEEDS_SETUP, "credit pack with the credit system off needs setup")
        _assert(status["requiresRenewal"] is False, "needs setup is not a renewal")
        print("PASS credit system disabled")

        # 4. Credit system enabled + CREDIT_CONSUMPTION: remaining credits
        #    computed from real usage/generation data, not fabricated.
        enabled = _make_credential(
            db, tool_id, credit_enabled=True, renewal_type="CREDIT_CONSUMPTION",
            purchase_date=today - timedelta(days=10),
        )
        _make_rate(db, enabled.id, tool_id, package_credits=1000, package_rupees=5000, effective_from=today - timedelta(days=10))
        remaining = resolve_remaining_credits(db, enabled)
        _assert(remaining == 1000, "no consumption yet -> full balance")
        _burn_credits(db, tool_id, enabled.id, user_id, 400, datetime.utcnow() - timedelta(days=5))
        remaining = resolve_remaining_credits(db, enabled)
        _assert(remaining == 600, f"expected 600 remaining after burning 400 of 1000, got {remaining}")
        status = calculate_renewal_status(enabled, remaining)
        _assert(status["status"] == STATUS_OK, "600 remaining is still OK")
        print("PASS credit consumption math")

        # 5. Credits reaching exactly zero -> a credit pack needs renewing.
        _burn_credits(db, tool_id, enabled.id, user_id, 600, datetime.utcnow() - timedelta(days=1))
        remaining = resolve_remaining_credits(db, enabled)
        _assert(remaining == 0, f"expected 0 remaining, got {remaining}")
        status = calculate_renewal_status(enabled, remaining)
        _assert(status["status"] == STATUS_CREDITS_EXHAUSTED, "0 remaining credits on a pack is credits_exhausted")
        _assert(status["requiresRenewal"] is True, "an exhausted credit pack requires renewal")
        # Overburn (more consumed than the package) never goes negative.
        _burn_credits(db, tool_id, enabled.id, user_id, 50, datetime.utcnow())
        _assert(resolve_remaining_credits(db, enabled) == 0, "remaining credits floors at 0, never negative")
        print("PASS credits exhausted at zero")

        # 6. MONTHLY, no credits: future date -> OK, past date -> requires renewal.
        monthly_no_credits = _make_credential(
            db, tool_id, credit_enabled=False, renewal_type="MONTHLY",
            renewal_date=today + timedelta(days=10),
        )
        status = calculate_renewal_status(monthly_no_credits, None)
        _assert(status["status"] == STATUS_OK, "future monthly renewal date is OK")
        monthly_no_credits.renewal_date = today - timedelta(days=3)
        status = calculate_renewal_status(monthly_no_credits, None)
        _assert(status["status"] == STATUS_RENEWAL_REQUIRED, "past monthly renewal date requires renewal")
        print("PASS monthly without credits")

        # 7. MONTHLY + credits together (not mutually exclusive).
        monthly_with_credits = _make_credential(
            db, tool_id, credit_enabled=True, renewal_type="MONTHLY",
            renewal_date=today + timedelta(days=10),
        )
        _make_rate(db, monthly_with_credits.id, tool_id, package_credits=500, package_rupees=2500, effective_from=today)
        _assert(resolve_remaining_credits(db, monthly_with_credits) == 500, "monthly+credits still tracks a balance")
        _assert(calculate_renewal_status(monthly_with_credits, 500, total_credits=500)["status"] == STATUS_OK, "monthly+credits with a full balance is OK")
        _assert(calculate_renewal_status(monthly_with_credits, 40, total_credits=500)["status"] == STATUS_CREDITS_LOW, "8% left is credits_low")
        exhausted_sub = calculate_renewal_status(monthly_with_credits, 0, total_credits=500)
        _assert(exhausted_sub["status"] == STATUS_CREDITS_EXHAUSTED and exhausted_sub["requiresRenewal"] is False,
                "a subscription out of credits is flagged but its plan does not need renewing")
        print("PASS monthly with credits combo")

        # 8. MANUAL (custom dates): a passed renewal date is overdue, no date
        #    at all is just "no renewal date".
        manual = _make_credential(db, tool_id, renewal_type="MANUAL", renewal_date=today - timedelta(days=400))
        status = calculate_renewal_status(manual, None)
        _assert(status["status"] == STATUS_RENEWAL_REQUIRED, "custom dates past their renewal date are overdue")
        _assert(status["daysLeft"] == -400, f"daysLeft counts the overdue days, got {status['daysLeft']}")
        undated = _make_credential(db, tool_id, renewal_type="MANUAL")
        _assert(calculate_renewal_status(undated, None)["status"] == STATUS_NOT_APPLICABLE, "custom dates without a date")
        print("PASS custom dates")

        # 9. Auto-renew lazy roll-forward: stale date, then multi-month stale.
        auto = _make_credential(
            db, tool_id, renewal_type="MONTHLY", auto_renew=True,
            renewal_date=today - timedelta(days=5),
        )
        changed = process_auto_renewal(db, auto)
        _assert(changed is True, "a past renewal date should roll forward")
        _assert(auto.renewal_date > today, f"rolled-forward date should be in the future, got {auto.renewal_date}")
        _assert(calculate_renewal_status(auto, None)["status"] == STATUS_OK, "freshly auto-renewed account is OK")
        changed_again = process_auto_renewal(db, auto)
        _assert(changed_again is False, "process_auto_renewal is idempotent once the date is current")

        very_stale = _make_credential(
            db, tool_id, renewal_type="MONTHLY", auto_renew=True,
            renewal_date=today - timedelta(days=95),  # roughly 3 months stale
        )
        process_auto_renewal(db, very_stale)
        _assert(very_stale.renewal_date > today, "multi-month-stale date rolls all the way to the future in one call")

        # auto_renew off -> never touched even if stale.
        no_auto = _make_credential(
            db, tool_id, renewal_type="MONTHLY", auto_renew=False,
            renewal_date=today - timedelta(days=30),
        )
        original = no_auto.renewal_date
        _assert(process_auto_renewal(db, no_auto) is False, "auto_renew=False must never roll the date forward")
        _assert(no_auto.renewal_date == original, "date is untouched without auto_renew")
        # Renewed date becomes the purchase date (monthly).
        rolled = _make_credential(
            db, tool_id, renewal_type="MONTHLY", auto_renew=True,
            purchase_date=date(2026, 8, 13), renewal_date=date(2026, 9, 13),
        )
        process_auto_renewal(db, rolled, today=date(2026, 10, 4))
        _assert(rolled.purchase_date == date(2026, 9, 13), f"purchase date should be last renewal, got {rolled.purchase_date}")
        _assert(rolled.renewal_date == date(2026, 10, 13), f"renewal should be next month, got {rolled.renewal_date}")
        # On the renewal day itself it renews.
        process_auto_renewal(db, rolled, today=date(2026, 10, 13))
        _assert(rolled.purchase_date == date(2026, 10, 13) and rolled.renewal_date == date(2026, 11, 13), "renews on the renewal day")

        # YEARLY + auto renew.
        yearly = _make_credential(
            db, tool_id, renewal_type="YEARLY", auto_renew=True,
            purchase_date=date(2025, 2, 24), renewal_date=date(2026, 2, 24),
        )
        _assert(process_auto_renewal(db, yearly, today=date(2026, 10, 4)) is True, "stale yearly rolls")
        _assert(yearly.purchase_date == date(2026, 2, 24) and yearly.renewal_date == date(2027, 2, 24), "yearly roll sets purchase/renewal")
        _assert(calculate_renewal_status(yearly, None, today=date(2026, 10, 4))["status"] == STATUS_OK, "yearly future date is OK")
        _assert(is_valid_renewal_type("YEARLY"), "YEARLY should be valid")
        print("PASS auto-renew lazy roll-forward")

        # 10. get_current_rate resolves the newest effective row and ignores
        #     an expired one.
        cred = _make_credential(db, tool_id, credit_enabled=True)
        _make_rate(db, cred.id, tool_id, package_credits=100, package_rupees=100, effective_from=today - timedelta(days=60))
        newest = _make_rate(db, cred.id, tool_id, package_credits=200, package_rupees=400, effective_from=today - timedelta(days=1))
        current = get_current_rate(db, cred.id)
        _assert(current is not None and current.id == newest.id, "get_current_rate returns the newest effective row")
        print("PASS get_current_rate resolution")

        # 11. Due soon vs renews soon, and subscriptions with no date.
        manual_soon = _make_credential(db, tool_id, renewal_type="YEARLY", renewal_date=today + timedelta(days=3))
        status = calculate_renewal_status(manual_soon, None)
        _assert(status["status"] == STATUS_DUE_SOON and status["daysLeft"] == 3, "manual yearly in 3 days is due_soon")
        auto_soon = _make_credential(db, tool_id, renewal_type="QUARTERLY", auto_renew=True, renewal_date=today)
        _assert(calculate_renewal_status(auto_soon, None)["status"] == STATUS_RENEWS_SOON, "auto-renew today is renews_soon")
        no_date = _make_credential(db, tool_id, renewal_type="HALF_YEARLY")
        _assert(calculate_renewal_status(no_date, None)["status"] == STATUS_NEEDS_SETUP, "subscription without a date needs setup")
        print("PASS due soon / renews soon")

        # 12. Free and not purchased.
        free = _make_credential(db, tool_id, renewal_type="FREE")
        _assert(calculate_renewal_status(free, None)["status"] == STATUS_FREE, "free plan without credits is free")
        _assert(calculate_renewal_status(free, 0, total_credits=100)["status"] == STATUS_FREE,
                "credits are ignored while the credit system is off")
        free.credit_enabled = True
        _assert(calculate_renewal_status(free, 0, total_credits=100)["status"] == STATUS_CREDITS_EXHAUSTED, "free credits used up")
        not_bought = _make_credential(db, tool_id, renewal_type="NOT_PURCHASED", credit_enabled=True,
                                      renewal_date=today - timedelta(days=30))
        _make_rate(db, not_bought.id, tool_id, package_credits=100, package_rupees=0, effective_from=today)
        _assert(credit_usage(db, not_bought) is None, "a not-purchased account has no credit balance")
        _assert(calculate_renewal_status(not_bought, None)["status"] == STATUS_NOT_PURCHASED, "not purchased beats an old date")
        print("PASS free / not purchased")

        # 13. Quarterly and half-yearly auto-renew.
        quarterly = _make_credential(db, tool_id, renewal_type="QUARTERLY", auto_renew=True,
                                     purchase_date=date(2025, 10, 15), renewal_date=date(2026, 1, 15))
        process_auto_renewal(db, quarterly, today=date(2026, 5, 1))
        _assert(quarterly.purchase_date == date(2026, 4, 15) and quarterly.renewal_date == date(2026, 7, 15),
                f"quarterly rolls 3 months at a time, got {quarterly.purchase_date} -> {quarterly.renewal_date}")
        half = _make_credential(db, tool_id, renewal_type="HALF_YEARLY", auto_renew=True,
                                purchase_date=date(2025, 8, 31), renewal_date=date(2026, 2, 28))
        process_auto_renewal(db, half, today=date(2026, 3, 1))
        _assert(half.purchase_date == date(2026, 2, 28) and half.renewal_date == date(2026, 8, 28),
                f"half-yearly rolls 6 months, got {half.purchase_date} -> {half.renewal_date}")
        print("PASS quarterly / half-yearly auto-renew")

        # 14. Credit periods: monthly reset on a yearly plan, without drifting
        #     from the 31st; a credit pack never resets.
        yearly_monthly = _make_credential(db, tool_id, renewal_type="YEARLY", credit_enabled=True, credit_reset="MONTHLY",
                                          purchase_date=date(2026, 1, 31), renewal_date=date(2027, 1, 31))
        _assert(credit_period(yearly_monthly, today=date(2026, 3, 5)) == (date(2026, 2, 28), date(2026, 3, 31)),
                f"monthly reset period, got {credit_period(yearly_monthly, today=date(2026, 3, 5))}")
        _assert(credit_period(yearly_monthly, today=date(2026, 3, 31)) == (date(2026, 3, 31), date(2026, 4, 30)),
                "resets on the anniversary day itself")
        yearly_monthly.credit_reset = "CYCLE"
        _assert(credit_period(yearly_monthly, today=date(2026, 3, 5)) == (date(2026, 1, 31), date(2027, 1, 31)),
                "cycle reset spans the whole plan period")
        pack = _make_credential(db, tool_id, renewal_type="CREDIT_CONSUMPTION", credit_reset="MONTHLY",
                                purchase_date=date(2026, 1, 1))
        _assert(credit_period(pack, today=date(2026, 6, 1)) == (date(2026, 1, 1), None), "a credit pack never resets")
        print("PASS credit periods")

        # 15. Usage only counts this credit period, and editing Total Credits
        #     mid-period (a new rate row from today) keeps what was used.
        monthly_reset = _make_credential(db, tool_id, renewal_type="YEARLY", credit_enabled=True, credit_reset="MONTHLY",
                                         purchase_date=today - timedelta(days=400), renewal_date=today + timedelta(days=200))
        period_start, _resets = credit_period(monthly_reset)
        _make_rate(db, monthly_reset.id, tool_id, package_credits=1000, package_rupees=1000, effective_from=today - timedelta(days=400))
        _burn_credits(db, tool_id, monthly_reset.id, user_id, 700,
                      datetime.combine(period_start, datetime.min.time()) - timedelta(days=1))
        _burn_credits(db, tool_id, monthly_reset.id, user_id, 300, datetime.combine(period_start, datetime.min.time()))
        usage = credit_usage(db, monthly_reset)
        _assert(usage["used"] == 300 and usage["remaining"] == 700,
                f"only this month's 300 counts, got used={usage['used']} remaining={usage['remaining']}")
        _make_rate(db, monthly_reset.id, tool_id, package_credits=1200, package_rupees=1200, effective_from=today)
        usage = credit_usage(db, monthly_reset)
        _assert(usage["total"] == 1200 and usage["used"] == 300 and usage["remaining"] == 900,
                f"raising credits mid-period keeps usage, got {usage}")
        print("PASS credit usage per period")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
