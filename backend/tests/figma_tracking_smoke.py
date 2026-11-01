"""Figma AI prompts become per-person rows with Figma's own credits.

Run from backend/:  python tests/figma_tracking_smoke.py

Covers the path through the real router: the extension's "prompt" and
"balance" events (shapes as content-figma-network.js sends them, uuids and
credits from the live check on 2026-10-30: 24 + 8 + 4), each attributed to the
person whose dashboard launch ticket opened the tab; a prompt reported first
without credits and later with them; duplicates; the admin view; and the
credit report sharing the Figma fee by those credits.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import utils.usage_intelligence  # noqa: E402,F401  (import order the app uses; avoids a known cycle)
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from database_config import get_operational_db  # noqa: E402
from models_new import (  # noqa: E402
    Base, GenerationClient, GenerationRecord, ITPortalTool, ITPortalToolCredential, ITPortalToolUsageEvent,
    ToolCreditRate, User, UserFeatureAccess, UserRole,
)
from providers.chatgpt.models import (ConversationCaptureEvent, ConversationPrompt, ConversationRecord,  # noqa: E402
                                     ConversationResponse)
from providers.elevenlabs.models import ElevenlabsGeneration  # noqa: E402
from providers.envato.models import EnvatoDownload  # noqa: E402
from providers.epidemicsound.models import EpidemicDownload  # noqa: E402
from providers.figma import router as F  # noqa: E402
from providers.figma.models import FigmaBalanceSnapshot, FigmaPrompt  # noqa: E402
from providers.flow.models import FlowGeneration  # noqa: E402
from providers.freepik.models import FreepikGeneration  # noqa: E402
from providers.grammarly_docs.models import GrammarlyDocSession  # noqa: E402
from providers.heygen.models import HeygenGeneration  # noqa: E402
from providers.higgsfield.models import HiggsfieldGeneration  # noqa: E402
from providers.splice.models import SpliceDownload  # noqa: E402
from providers.suno.models import SunoGeneration  # noqa: E402
from utils.credit_report.live_sheet import build_live_sheet  # noqa: E402
from utils.permissions import require_admin  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in (
    User, UserRole, UserFeatureAccess, GenerationClient, ITPortalTool, ITPortalToolCredential,
    ITPortalToolUsageEvent, ToolCreditRate, GenerationRecord, FreepikGeneration, EnvatoDownload,
    HeygenGeneration, HiggsfieldGeneration, ElevenlabsGeneration, FlowGeneration, SunoGeneration,
    EpidemicDownload, SpliceDownload, GrammarlyDocSession, ConversationRecord, ConversationPrompt,
    ConversationResponse, ConversationCaptureEvent, FigmaPrompt, FigmaBalanceSnapshot)])

FIGMA_FEE = 1600.0
U_TITLE, U_HI1, U_HI2, U_PENDING = (
    "f1a9a379-72f6-4e89-9d11-18f78c02e2c5", "ec13b342-075e-468e-a5b4-483ccd3220ed",
    "47dfe766-05ff-4051-949d-aa8fd5c5c7c1", "0b9c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3")
FILE_KEY = "X4SyRLJQxVua36mbo7whQ6"


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


def close(a, b, message, tol=0.01):
    check(a is not None and abs(float(a) - float(b)) <= tol, f"{message} ({a} vs {b})")


def ms(day, hour, minute=0):
    return int(datetime(2026, 10, day, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


with SessionLocal() as db:
    users = {}
    for name in ("Sarabjeet", "Asha", "Bob"):
        u = User(email=f"{name.lower()}@example.com", name=name, hashed_password="x", department="DESIGN",
                 is_active=True, is_deleted=False, employee_id=f"E-{name}")
        db.add(u)
        db.flush()
        users[name] = u.id
    tool = ITPortalTool(name="Figma", slug="figma", website_url="https://www.figma.com", is_active=True)
    db.add(tool)
    db.flush()
    cred = ITPortalToolCredential(tool_id=tool.id, scope="company", tool_cost=FIGMA_FEE, renewal_type="MONTHLY",
                                  is_active=True, auto_renew=False)
    db.add(cred)
    db.commit()
    CRED_ID = cred.id

TICKETS = {"ticket-asha": "Asha", "ticket-bob": "Bob"}


def fake_actor(*, request, db, tool, usage_ticket, extension_ticket):
    name = TICKETS.get(usage_ticket or extension_ticket or "")
    if not name:
        raise HTTPException(status_code=403, detail="Launch Figma from the dashboard")
    return db.get(User, users[name])


def fake_credential(db, *, tool_id, user_id, explicit_credential_id=None):
    return db.get(ITPortalToolCredential, CRED_ID)


F.resolve_figma_actor = fake_actor
F.resolve_figma_credential = fake_credential


def _db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _admin():
    with SessionLocal() as db:
        return db.get(User, users["Sarabjeet"])


app = FastAPI()
app.include_router(F.router)
app.dependency_overrides[get_operational_db] = _db
app.dependency_overrides[require_admin] = _admin
client = TestClient(app)


def prompt(uuid, ticket, text, credits, at_ms, outcome="completed", **extra):
    payload = {"userActionUuid": uuid, "requestUuid": "req-" + uuid[:8], "threadId": "thread-1",
               "fileKey": FILE_KEY, "fileName": "Untitled", "origin": "assistant-thread", "promptText": text,
               "promptedAtMs": at_ms, "finishedAtMs": at_ms + 60000, "outcome": outcome, "credits": credits,
               "creditCost": credits, "toolCalls": 7, "workMs": 57368, "figmaUserId": "1681993755224840416",
               "figmaEmail": "design@rmw.example", "planId": "8bd8c35d-01ea-46d4-82e2-123c61880e23",
               "planTier": "starter", "pageUrl": f"https://www.figma.com/design/{FILE_KEY}/Untitled"}
    payload.update(extra)
    return {"event_type": "prompt", "client_event_id": uuid, "payload": payload, "usage_ticket": ticket,
            "extension_version": "0.1.78", "tab_id": 7}


def send(*events):
    res = client.post("/api/providers/figma/capture/events", json={"events": list(events)})
    assert res.status_code == 200, res.text
    return {r["client_event_id"]: r for r in res.json()["results"]}


# --- capture ---------------------------------------------------------------
r = send(prompt(U_TITLE, "ticket-asha", "create a title bar with name RMW EYE", 24, ms(28, 9)),
         prompt(U_HI1, "ticket-bob", "hi", 8, ms(30, 9)),
         prompt(U_PENDING, "ticket-bob", "design a footer", None, ms(30, 10)))
check([r[u]["status"] for u in (U_TITLE, U_HI1, U_PENDING)] == ["created"] * 3, "three prompts created")

r = send(prompt(U_TITLE, "ticket-asha", "create a title bar with name RMW EYE", 24, ms(28, 9)))
check(r[U_TITLE]["status"] == "duplicate", "the same prompt reported again is a duplicate")

r = send(prompt(U_PENDING, "ticket-bob", "design a footer", 36, ms(30, 10)))
check(r[U_PENDING]["status"] == "updated", "a pending prompt gets its credits when they arrive")

r = send(prompt(U_HI2, "ticket-nobody", "hi", 4, ms(30, 11)))
check(r[U_HI2]["status"] == "rejected" and "dashboard" in r[U_HI2]["reason"],
      "a tab not launched from the dashboard is refused")

r = send({"event_type": "screenshot", "client_event_id": "x1", "payload": {}, "usage_ticket": "ticket-bob"})
check(r["x1"]["status"] == "rejected", "an unknown event type is refused")

r = send(prompt(U_HI2, "ticket-asha", "hi", None, ms(30, 11), outcome="error"))
check(r[U_HI2]["status"] == "created", "a failed prompt is still recorded")

with SessionLocal() as db:
    rows = {p.user_action_uuid: p for p in db.query(FigmaPrompt).all()}
    check(rows[U_TITLE].owner_user_id == users["Asha"] and rows[U_HI1].owner_user_id == users["Bob"],
          "each prompt belongs to the person whose launch ticket opened the tab")
    check(rows[U_PENDING].credits_used == 36 and rows[U_PENDING].status == "completed"
          and rows[U_PENDING].costed_at is not None, "updated prompt is completed with Figma's credits")
    check(rows[U_HI2].status == "failed" and rows[U_HI2].credits_used is None, "failed prompt has no credits")
    check(rows[U_TITLE].credential_id == CRED_ID, "prompt is on the company Figma account")
    check(rows[U_TITLE].file_url == f"https://www.figma.com/design/{FILE_KEY}", "file link built from the key")

balance = {"event_type": "balance", "client_event_id": "bal-1", "usage_ticket": "ticket-bob", "payload": {
    "figmaUserId": "1681993755224840416", "figmaEmail": "design@rmw.example",
    "planId": "8bd8c35d-01ea-46d4-82e2-123c61880e23", "planTier": "starter",
    "periodStart": "2026-10-01T00:00:00.000Z", "periodEnd": "2026-11-01T00:00:00.000Z",
    "monthlyTotal": 500, "monthlyConsumed": 134, "monthlyRemaining": 366,
    "dailyTotal": 150, "dailyConsumed": 12, "capturedAtMs": ms(30, 11)}}
check(send(balance)["bal-1"]["status"] == "created", "balance snapshot stored")
check(send({**balance, "client_event_id": "bal-2"})["bal-2"]["status"] == "duplicate",
      "an unchanged balance is not stored twice")

# --- a figure that grows after it was reported (live 2026-10-30: 8, then 10) ---
U_GROW = "c05d6532-1f55-48be-a152-16055412084a"
first = prompt(U_GROW, "ticket-asha", "use the title as RMW", 8, ms(29, 9))
first["client_event_id"] = f"{U_GROW}:c8"
check(send(first)[f"{U_GROW}:c8"]["status"] == "created", "prompt reported with the first figure read")
again = prompt(U_GROW, "ticket-asha", "use the title as RMW", 10, ms(29, 9))
again["client_event_id"] = f"{U_GROW}:c10"
check(send(again)[f"{U_GROW}:c10"]["status"] == "updated", "the re-read figure replaces it")
with SessionLocal() as db:
    check(db.query(FigmaPrompt).filter_by(user_action_uuid=U_GROW).one().credits_used == 10, "stored 10, not 8")
    db.query(FigmaPrompt).filter_by(user_action_uuid=U_GROW).delete()
    db.commit()

from providers.figma.capture import readable_prompt  # noqa: E402

raw = ('<tool_result tool_name="mcp__plugin_conversation_ask_user_question__ask_user_question" tool_call_id="c1">\n'
       '{"success":true,"message":"The on-screen heading labeled “Title”",'
       '"selectedOptions":["The on-screen heading labeled “Title”"],"responseUserId":"1"}\n</tool_result>')
check(readable_prompt(raw) == "Answered the agent's question: The on-screen heading labeled “Title”",
      "an answer to the agent's question reads as one")
check(readable_prompt("use the title as RMW") == "use the title as RMW", "a normal prompt is unchanged")

# --- admin view --------------------------------------------------------------
view = client.get("/api/providers/figma/view", params={"from_ms": ms(1, 0), "to_ms": ms(31, 23)}).json()["data"]
t = view["totals"]
check(t["prompts"] == 4 and t["costedPrompts"] == 3 and t["failedPrompts"] == 1, f"totals counted: {t}")
close(t["credits"], 24 + 8 + 36, "credits = Figma's numbers added up")
close(t["avgCredits"], (24 + 8 + 36) / 3, "average over costed prompts")
people = {p["name"]: p for p in view["people"]}
close(people["Bob"]["credits"], 44, "Bob: 8 + 36")
close(people["Asha"]["credits"], 24, "Asha: 24 (the failed prompt adds nothing)")
check(view["byFile"][0]["fileName"] == "Untitled" and view["byFile"][0]["people"] == 2, "per-file totals")
acct = view["accounts"][0]
check(acct["monthlyRemaining"] == 366, "account balance shown")
close(acct["notCapturedCredits"], 134 - 68, "credits Figma counted that no captured prompt explains")

bob = client.get("/api/providers/figma/view", params={"from_ms": ms(1, 0), "to_ms": ms(31, 23),
                                                      "owner_user_id": users["Bob"]}).json()["data"]
check(bob["totals"]["prompts"] == 2 and len(bob["people"]) == 2, "person filter narrows totals, not the people list")
found = client.get("/api/providers/figma/view", params={"from_ms": ms(1, 0), "to_ms": ms(31, 23),
                                                        "q": "footer"}).json()["data"]
check([p["userActionUuid"] for p in found["prompts"]] == [U_PENDING], "search finds prompt text")
top = client.get("/api/providers/figma/view", params={"from_ms": ms(1, 0), "to_ms": ms(31, 23),
                                                      "sort": "credits"}).json()["data"]
check(top["prompts"][0]["credits"] == 36, "sort by credits")

# --- credit report -------------------------------------------------------------
with SessionLocal() as db:
    data = build_live_sheet(db, start="2026-10-01", end="2026-10-31")
tools = {x["tool"]: x for x in data["sheets"]["tools"]}
check("Figma" in tools and tools["Figma"].get("tracked", True), "Figma is a tracked tool in the credit report")
check("Figma" in data["options"]["tools"], "Figma can be picked in the report's tool filter")
close(tools["Figma"]["totalSpendRupees"], FIGMA_FEE, "the whole Figma fee is spent on its prompts")
spend = {u["userName"]: u["spendRupees"] for u in data["sheets"]["users"]}
close(spend["Asha"], FIGMA_FEE * 24 / 68, "Asha's share of the fee follows her credits")
close(spend["Bob"], FIGMA_FEE * 44 / 68, "Bob's share of the fee follows his credits")

print("\nALL FIGMA TRACKING CHECKS PASSED")
