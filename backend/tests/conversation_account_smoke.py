"""Claude / ChatGPT prompts are costed on the login they were sent through.

Run from backend/:  python tests/conversation_account_smoke.py

A prompt's account is the login recorded on its capture event (a person's own
login counts as the company login it is linked to); only a prompt with none
recorded falls back to the tool's only paid account. Each account's plan fee
is shared by the prompts on that account alone.
"""

import os
import sys
from datetime import date, datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from models_new import (Base, GenerationClient, GenerationRecord, ITPortalTool, ITPortalToolCredential,  # noqa: E402
                        ITPortalToolUsageEvent, ToolCreditRate, User, UserFeatureAccess, UserRole)
from providers.chatgpt.models import ConversationCaptureEvent, ConversationPrompt, ConversationRecord  # noqa: E402
from providers.elevenlabs.models import ElevenlabsGeneration  # noqa: E402
from providers.envato.models import EnvatoGeneration  # noqa: E402
from providers.epidemicsound.models import EpidemicAdaptation  # noqa: E402
from providers.flow.models import FlowGeneration  # noqa: E402
from providers.freepik.models import FreepikGeneration  # noqa: E402
from providers.grammarly_docs.models import GrammarlyDocSession  # noqa: E402
from providers.heygen.models import HeygenGeneration  # noqa: E402
from providers.higgsfield.models import HiggsfieldGeneration  # noqa: E402
from providers.splice.models import SpliceDownload  # noqa: E402
from providers.suno.models import SunoGeneration  # noqa: E402
from utils.credit_report import ReportFilters  # noqa: E402
from utils.credit_report.costing import period_fee  # noqa: E402
from utils.credit_report.facts import prepare, recent_log  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
TABLES = [User, UserRole, UserFeatureAccess, GenerationClient, ITPortalTool, ITPortalToolCredential,
          ITPortalToolUsageEvent, ToolCreditRate, GenerationRecord, FreepikGeneration, EnvatoGeneration,
          HeygenGeneration, HiggsfieldGeneration, ElevenlabsGeneration, FlowGeneration, SunoGeneration,
          EpidemicAdaptation, SpliceDownload, GrammarlyDocSession, ConversationRecord, ConversationPrompt,
          ConversationCaptureEvent]
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in TABLES])

START, END = date(2026, 10, 1), date(2026, 10, 14)
FEE_PAID = 3100.0       # the paid Claude login; the other login has no fee set


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


with SessionLocal() as db:
    priya = User(email="priya@example.com", name="Priya", hashed_password="x", department="DIGITAL",
                 is_active=True, is_deleted=False, employee_id="E-1")
    db.add(priya)
    claude = ITPortalTool(name="Claude", slug="claude", website_url="https://claude.ai")
    db.add(claude)
    db.flush()
    paid = ITPortalToolCredential(tool_id=claude.id, scope="company", tool_cost=FEE_PAID, renewal_type="MONTHLY",
                                  is_active=True, auto_renew=False)
    unpaid = ITPortalToolCredential(tool_id=claude.id, scope="company", tool_cost=None, renewal_type="MANUAL",
                                    is_active=True, auto_renew=False)
    db.add_all([paid, unpaid])
    db.flush()
    own = ITPortalToolCredential(tool_id=claude.id, scope="user", user_id=priya.id, linked_credential_id=unpaid.id,
                                 is_active=True, auto_renew=False)
    db.add(own)
    db.flush()
    chat = ConversationRecord(provider="claude", provider_conversation_id="chat-1", owner_user_id=priya.id, title="chat")
    db.add(chat)
    db.flush()

    def prompt(n, credential_id):
        event_id = None
        if credential_id is not None:
            event = ConversationCaptureEvent(provider="claude", tool_id=claude.id, user_id=priya.id,
                                             credential_id=credential_id, event_type="prompt",
                                             client_event_id=f"e{n}", payload_json={}, event_date=date(2026, 10, 3))
            db.add(event)
            db.flush()
            event_id = event.id
        db.add(ConversationPrompt(conversation_id=chat.id, prompt_text=f"prompt {n}", source_capture_event_id=event_id,
                                  prompt_timestamp=datetime(2026, 10, 3, 10, n)))

    prompt(1, own.id)          # Priya's own login, linked to the unpaid company login
    prompt(2, own.id)
    prompt(3, unpaid.id)       # the unpaid company login itself
    prompt(4, paid.id)         # the paid login
    prompt(5, None)            # no login recorded: the tool's only paid account
    db.commit()
    ids = {"paid": paid.id, "unpaid": unpaid.id}

with SessionLocal() as db:
    filters = ReportFilters.build(start=START.isoformat(), end=END.isoformat())
    prepare(db, filters)
    rows = {r.prompt: r for r in recent_log(db, filters, 50)}
    check(len(rows) == 5, "every prompt reported")
    check(all(rows[f"prompt {n}"].account == ids["unpaid"] for n in (1, 2)),
          "a person's own login counts as the company login it is linked to")
    check(rows["prompt 3"].account == ids["unpaid"], "a company login recorded on the event is used as is")
    check(rows["prompt 4"].account == ids["paid"], "the paid login is used for the prompt sent through it")
    check(rows["prompt 5"].account == ids["paid"], "no login recorded: falls back to the tool's only paid account")
    check(all(abs(rows[f"prompt {n}"].rupees) < 0.005 for n in (1, 2, 3)),
          "prompts on a login with no fee set cost nothing")
    share = period_fee(FEE_PAID, START, END) / 2
    check(all(abs(rows[f"prompt {n}"].rupees - share) < 0.01 for n in (4, 5)),
          f"the paid login's fee is shared by its own two prompts only (₹{share:.2f} each)")

print("\nALL CONVERSATION ACCOUNT CHECKS PASSED")
