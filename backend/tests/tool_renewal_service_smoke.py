"""Smoke tests for utils/tool_renewal_service.py (Admin Queue -> Tool Renew:
per-account credit system + renewal type configuration).

Covers: credit system on/off, all three renewal types, monthly with and
without credits, credits reaching exactly zero, auto-renew rolling a stale
date forward (including multiple months stale), remaining-credits math
against real GenerationRecord/usage-event consumption, and renewal_type
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
    STATUS_NOT_APPLICABLE,
    STATUS_OK,
    STATUS_RENEWAL_REQUIRED,
    calculate_next_renewal_date,
    calculate_renewal_status,
    get_current_rate,
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
    _assert(not is_valid_renewal_type("YEARLY"), "YEARLY is not a supported renewal type")
    _assert(normalize_renewal_type(None) == "MANUAL", "missing renewal_type normalizes to MANUAL")
    _assert(normalize_renewal_type("bogus") == "MANUAL", "invalid renewal_type normalizes to MANUAL")
    print("PASS renewal_type validation")

    # 2. calculate_next_renewal_date: plain month roll + end-of-month clamp
    _assert(calculate_next_renewal_date(date(2026, 1, 15)) == date(2026, 2, 15), "simple month roll")
    _assert(calculate_next_renewal_date(date(2026, 1, 31)) == date(2026, 2, 28), "Jan 31 -> Feb 28 (2026 not a leap year)")
    _assert(calculate_next_renewal_date(date(2026, 12, 15)) == date(2027, 1, 15), "December rolls into next year")
    print("PASS calculate_next_renewal_date")

    with SessionLocal() as db:
        user_id = _make_user(db, "admin@example.com")
        tool_id = _make_tool(db, "freepik")

        # 3. Credit system disabled: never reports a balance, never fabricates
        #    a renewal requirement even under CREDIT_CONSUMPTION.
        disabled = _make_credential(db, tool_id, credit_enabled=False, renewal_type="CREDIT_CONSUMPTION")
        _assert(resolve_remaining_credits(db, disabled) is None, "disabled account has no remaining credits")
        status = calculate_renewal_status(disabled, None)
        _assert(status["status"] == STATUS_NOT_APPLICABLE, "disabled CREDIT_CONSUMPTION account is not_applicable")
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

        # 5. Credits reaching exactly zero -> renewal required.
        _burn_credits(db, tool_id, enabled.id, user_id, 600, datetime.utcnow() - timedelta(days=1))
        remaining = resolve_remaining_credits(db, enabled)
        _assert(remaining == 0, f"expected 0 remaining, got {remaining}")
        status = calculate_renewal_status(enabled, remaining)
        _assert(status["status"] == STATUS_RENEWAL_REQUIRED, "0 remaining credits requires renewal")
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
            renewal_date=today + timedelta(days=5),
        )
        _make_rate(db, monthly_with_credits.id, tool_id, package_credits=500, package_rupees=2500, effective_from=today)
        _assert(resolve_remaining_credits(db, monthly_with_credits) == 500, "monthly+credits still tracks a balance")
        _assert(calculate_renewal_status(monthly_with_credits, 500)["status"] == STATUS_OK, "monthly+credits status driven by the date, not the balance")
        print("PASS monthly with credits combo")

        # 8. MANUAL: never auto-flagged regardless of a stale date.
        manual = _make_credential(db, tool_id, renewal_type="MANUAL", renewal_date=today - timedelta(days=400))
        status = calculate_renewal_status(manual, None)
        _assert(status["status"] == STATUS_NOT_APPLICABLE, "MANUAL is never auto-flagged")
        _assert(status["requiresRenewal"] is False, "MANUAL never requires renewal automatically")
        print("PASS manual renewal never auto-flagged")

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
        print("PASS auto-renew lazy roll-forward")

        # 10. get_current_rate resolves the newest effective row and ignores
        #     an expired one.
        cred = _make_credential(db, tool_id, credit_enabled=True)
        _make_rate(db, cred.id, tool_id, package_credits=100, package_rupees=100, effective_from=today - timedelta(days=60))
        newest = _make_rate(db, cred.id, tool_id, package_credits=200, package_rupees=400, effective_from=today - timedelta(days=1))
        current = get_current_rate(db, cred.id)
        _assert(current is not None and current.id == newest.id, "get_current_rate returns the newest effective row")
        print("PASS get_current_rate resolution")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
