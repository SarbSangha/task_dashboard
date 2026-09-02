"""Regression guard for the exact bug this feature closes: reports_router's
cost calculation (_credit_rate_context) must never charge a rupee cost to an
account whose Credit System is disabled (Admin Queue -> Tool Renew ->
Configure), even when a global default rate exists and even when that
account still has a leftover ToolCreditRate row from before it was disabled.
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

        # A global default rate exists (as it would in the real app for
        # legacy/unlinkable records) -- this is the exact fallback a disabled
        # account must never be allowed to fall through to.
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

        # Enabled account with no rate of its own -> legitimately falls back
        # to the global default (unaffected by this feature).
        enabled_no_rate = ITPortalToolCredential(tool_id=tool.id, scope="company", credit_enabled=True)
        db.add(enabled_no_rate)
        db.commit()
        db.refresh(enabled_no_rate)

        db.commit()

        def _record_for(credential_id, credits_burned):
            event = ITPortalToolUsageEvent(
                tool_id=tool.id, credential_id=credential_id, user_id=user.id,
                event_type="generate_click", event_date=today, credits_burned=credits_burned,
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
        unlinkable_record = GenerationRecord(
            provider="freepik", provider_generation_id="gen-unlinked",
            credits_burned=100, owner_user_id=user.id,
        )
        db.add(unlinkable_record)
        db.commit()

        rate_expr, currency, default_rate = _credit_rate_context(db)
        _assert(default_rate == 1.0, f"expected global default rate 1.0, got {default_rate}")

        disabled_cost = _cost(db.query(GenerationRecord).filter(GenerationRecord.id == disabled_record.id), rate_expr)
        _assert(disabled_cost == 0, f"disabled account must cost 0 even with a leftover rate + global default, got {disabled_cost}")
        print("PASS disabled account with a stale own-rate costs 0, not its old rate")

        enabled_cost = _cost(db.query(GenerationRecord).filter(GenerationRecord.id == enabled_record.id), rate_expr)
        _assert(enabled_cost == 100 * 1.0, f"enabled account with no own rate should fall back to the global default, got {enabled_cost}")
        print("PASS enabled account with no own rate still uses the global default (unchanged behavior)")

        unlinkable_cost = _cost(db.query(GenerationRecord).filter(GenerationRecord.id == unlinkable_record.id), rate_expr)
        _assert(unlinkable_cost == 100 * 1.0, f"a record with no linkable credential at all should still use the global default, got {unlinkable_cost}")
        print("PASS record with no linkable account still uses the global default (unchanged behavior)")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
