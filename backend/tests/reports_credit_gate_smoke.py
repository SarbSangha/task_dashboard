"""Regression guard for reports_router's cost calculation (_credit_rate_context):

* an account whose Credit System is disabled (Admin Queue -> Tool Renew ->
  Configure) costs 0, even with a leftover ToolCreditRate row of its own;
* a generation is costed only at its own account's rate: an account with no
  rate, or a record with no linkable account, is "Not set" (None) -- never
  another account's rate or the global default row;
* correcting an account's rate re-prices its earlier generations too.
"""
import os
import sys
from datetime import datetime, timedelta
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
from routers.reports_router import _cost, _credit_rate_context  # noqa: E402

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


def main() -> int:
    today = datetime.utcnow().date()
    with SessionLocal() as db:
        user = User(email="admin@example.com", name="admin", hashed_password="x", is_active=True, is_deleted=False)
        db.add(user)
        db.commit()
        db.refresh(user)

        tool = ITPortalTool(name="Canva", slug="canva", website_url="https://example.com")
        db.add(tool)
        db.commit()
        db.refresh(tool)

        # A global default rate row exists (as it does in the real app) --
        # no generation may ever be costed at it.
        db.add(ToolCreditRate(
            credential_id=None, provider=None, tool_id=None,
            package_credits=1000, package_rupees=1000, rate_per_credit=1.0,
            effective_from=today - timedelta(days=365),
        ))

        # Disabled account that used to be credit-tracked: still has its own
        # historical rate row, but Credit System is now off.
        disabled_credential = ITPortalToolCredential(tool_id=tool.id, scope="company", credit_enabled=False)
        db.add(disabled_credential)
        db.commit()
        db.refresh(disabled_credential)
        db.add(ToolCreditRate(
            credential_id=disabled_credential.id, tool_id=tool.id,
            package_credits=500, package_rupees=1000, rate_per_credit=2.0,
            effective_from=today - timedelta(days=30),
        ))

        # Enabled account with no rate of its own -> "Not set".
        enabled_no_rate = ITPortalToolCredential(tool_id=tool.id, scope="company", credit_enabled=True)
        db.add(enabled_no_rate)
        # Credit System off by default, never had a rate -> "Not set" too, not ₹0.
        never_configured = ITPortalToolCredential(tool_id=tool.id, scope="company")
        db.add(never_configured)
        # Enabled account with a rate: first entered wrong (10,000 credits for
        # 4,000 = 0.40), corrected the next day (20,000 for 4,000 = 0.20).
        rated = ITPortalToolCredential(tool_id=tool.id, scope="company", credit_enabled=True)
        db.add(rated)
        db.commit()
        db.refresh(enabled_no_rate)
        db.refresh(never_configured)
        db.refresh(rated)
        db.add(ToolCreditRate(
            credential_id=rated.id, tool_id=tool.id,
            package_credits=10000, package_rupees=4000, rate_per_credit=0.4,
            effective_from=today - timedelta(days=1), effective_to=today - timedelta(days=1),
        ))
        db.add(ToolCreditRate(
            credential_id=rated.id, tool_id=tool.id,
            package_credits=20000, package_rupees=4000, rate_per_credit=0.2,
            effective_from=today,
        ))

        db.commit()

        def _record_for(credential_id, credits_burned, day=today):
            event = ITPortalToolUsageEvent(
                tool_id=tool.id, credential_id=credential_id, user_id=user.id,
                event_type="generate_click", event_date=day, credits_burned=credits_burned,
            )
            db.add(event)
            db.flush()
            record = GenerationRecord(
                provider="freepik", provider_generation_id=f"gen-{event.id}",
                credits_burned=credits_burned, owner_user_id=user.id,
                source_usage_event_id=event.id,
            )
            db.add(record)
            db.commit()
            return record

        disabled_record = _record_for(disabled_credential.id, 100)
        enabled_record = _record_for(enabled_no_rate.id, 100)
        never_configured_record = _record_for(never_configured.id, 100)
        yesterday_record = _record_for(rated.id, 1000, day=today - timedelta(days=1))
        today_record = _record_for(rated.id, 1000)
        unlinkable_record = GenerationRecord(
            provider="freepik", provider_generation_id="gen-unlinked",
            credits_burned=100, owner_user_id=user.id,
        )
        db.add(unlinkable_record)
        db.commit()

        rate_expr, currency = _credit_rate_context(db)
        _assert(currency == "INR", f"expected INR, got {currency}")

        def cost_of(record):
            return _cost(db.query(GenerationRecord).filter(GenerationRecord.id == record.id), rate_expr)

        disabled_cost = cost_of(disabled_record)
        _assert(disabled_cost == 0, f"disabled account must cost 0 even with a leftover rate + global default, got {disabled_cost}")
        print("PASS disabled account with a stale own-rate costs 0, not its old rate")

        enabled_cost = cost_of(enabled_record)
        _assert(enabled_cost is None, f"enabled account with no own rate must be Not set, got {enabled_cost}")
        print("PASS enabled account with no own rate is Not set (no global default, no other account's rate)")

        never_configured_cost = cost_of(never_configured_record)
        _assert(never_configured_cost is None,
                f"an account never given a rate (Credit System off by default) must be Not set, got {never_configured_cost}")
        print("PASS account with Credit System off by default and no rate is Not set, not 0")

        unlinkable_cost = cost_of(unlinkable_record)
        _assert(unlinkable_cost is None, f"a record with no linkable account must be Not set, got {unlinkable_cost}")
        print("PASS record with no linkable account is Not set")

        for record in (yesterday_record, today_record):
            cost = cost_of(record)
            _assert(abs(cost - 200.0) < 1e-6, f"1,000 credits at the corrected 0.20 must cost 200, got {cost}")
        print("PASS corrected rate re-prices the account's earlier generation too (200, not 400)")

        both = _cost(db.query(GenerationRecord).filter(GenerationRecord.id.in_([enabled_record.id, today_record.id])),
                     rate_expr)
        _assert(abs(both - 200.0) < 1e-6, f"a group's cost counts only its priced generations, got {both}")
        print("PASS a mixed group costs only the generations whose account has a rate")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
