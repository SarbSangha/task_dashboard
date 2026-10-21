"""Flow credits: rate table x account plan, stamped onto each generation.

Run from backend/:  python tests/flow_pricing_smoke.py

Checks, on an in-memory SQLite database:
  * the sheet's rates are seeded on first use;
  * a live capture carrying metadata.rmwSettings is priced as it is
    normalized - by model, resolution, duration and the account's plan -
    and mirrored onto its GenerationRecord;
  * Flow's own label "Omni 1.1 Flash" prices as the help page's "Gemini
    Omni Flash"; 360p and 720p price differently;
  * Free is charged the Plus & Pro column, Ultra its own;
  * a user credential linked to a shared login uses the login's plan;
  * a plan change from a date re-prices only generations from that date;
  * unknown stays NULL, never 0: no settings, no plan, no rate, and a
    model not offered on the plan (Lite Lower Priority on Pro);
  * a later snapshot without settings keeps the recorded settings;
  * a new rate from a date re-prices; deleting it restores the old one;
  * the admin API: get / set rate / set plan / delete, admin only.
"""

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from models_new import (  # noqa: E402
    Base, GenerationRecord, ITPortalTool, ITPortalToolCredential, User, UserFeatureAccess, UserRole,
)
from providers.flow import pricing as P  # noqa: E402
from providers.flow.models import FlowAccountPlan, FlowCaptureEvent, FlowCreditRate, FlowGeneration  # noqa: E402
from providers.flow.normalization import normalize_capture_event  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in (
    User, UserRole, UserFeatureAccess, ITPortalTool, ITPortalToolCredential, GenerationRecord,
    FlowCaptureEvent, FlowGeneration, FlowCreditRate, FlowAccountPlan)])


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def at(day: date, hour=12):
    """A UTC time on that IST date (noon IST)."""
    return datetime(day.year, day.month, day.day, hour) - timedelta(minutes=330)


OCT21, OCT25, NOV1 = date(2026, 10, 21), date(2026, 10, 25), date(2026, 11, 1)
SHARED, USER_LINK, SOLO = 357, 5, 74

db = SessionLocal()
db.add(User(id=1, email="u@x.com", name="U", hashed_password="x", is_active=True, position="employee"))
db.add(ITPortalTool(id=5, name="Flow", slug="flow", website_url="https://flow.google.com"))
db.add(ITPortalToolCredential(id=SHARED, tool_id=5, scope="company", is_active=True))
db.add(ITPortalToolCredential(id=USER_LINK, tool_id=5, scope="user", user_id=1, linked_credential_id=SHARED,
                              is_active=True))
db.add(ITPortalToolCredential(id=SOLO, tool_id=5, scope="user", user_id=1, is_active=True))
db.commit()

seq = {"n": 0}


def capture(day: date, credential_id: int, settings=None, creation_id=None, updated=None):
    """Normalize one live generation_workflow_row event; returns the row."""
    seq["n"] += 1
    cid = creation_id or f"gen{seq['n']}"
    when = at(day).isoformat() + "Z"
    metadata = {"displayName": "a boy running", "createTime": when, "updateTime": updated or when,
                "primaryMediaId": cid, "batchId": "b1", "rmwCaptureSource": "asset-observation"}
    if settings:
        metadata["rmwSettings"] = settings
    event = FlowCaptureEvent(tool_id=5, credential_id=credential_id, user_id=1, created_at=at(day),
                             event_type="generation_workflow_row", client_event_id=f"e{seq['n']}",
                             provider_creation_id=cid, ownership_confidence="ticket", event_date=day,
                             payload_json={"name": cid, "projectId": "p1", "metadata": metadata})
    db.add(event)
    db.flush()
    g = normalize_capture_event(db, event)
    db.commit()
    return g


def priced(g):
    db.expire_all()
    g = db.get(FlowGeneration, g.id)
    rec = db.get(GenerationRecord, g.generation_record_id)
    return g.account_plan, g.credits_used, rec.credits_burned


OMNI_360_10 = {"type": "video", "model": "Omni 1.1 Flash", "resolution": "360p", "durationSeconds": 10,
               "aspectRatio": "16:9", "outputs": 1, "quotedCredits": 7}
OMNI_720_8 = dict(OMNI_360_10, resolution="720p", durationSeconds=8)
FAST_8 = {"type": "video", "model": "Veo 3.1 - Fast", "resolution": "720p", "durationSeconds": 8, "outputs": 2}
LITE_LP = {"type": "video", "model": "Veo 3.1 - Lite (Lower Priority)", "resolution": "720p", "durationSeconds": 4}

# --- seeding ---
rates = P.all_rates(db)
db.commit()
check(len(rates) == len(P.DEFAULT_RATES) == 21, "the sheet's 21 rates are seeded on first use")
P.ensure_default_rates(db)
check(db.query(FlowCreditRate).count() == 21, "seeding twice adds nothing")

# --- no plan yet: settings recorded, cost unknown ---
g_noplan = capture(OCT21, SHARED, OMNI_360_10)
check(g_noplan.model_name == "Omni 1.1 Flash" and g_noplan.resolution == "360p" and g_noplan.duration_seconds == 10
      and g_noplan.aspect_ratio == "16:9" and g_noplan.output_count == 1 and g_noplan.media_type == "video",
      "settings from metadata.rmwSettings land on their own columns")
check(priced(g_noplan) == (None, None, None), "no plan set for the account: cost unknown (NULL, not 0)")

# --- plans ---
P.set_plan(db, SHARED, "pro", OCT21)
P.set_plan(db, SOLO, "ultra", OCT21)
db.commit()
check(priced(g_noplan) == ("pro", 7, 7), "setting Pro from 21 Oct re-prices it: Omni 360p 10s = 7")

g_720 = capture(OCT21, SHARED, OMNI_720_8)
check(priced(g_720) == ("pro", 12, 12), "Omni 720p 8s = 12 (resolution changes the price)")
g_fast_pro = capture(OCT21, SHARED, FAST_8)
check(priced(g_fast_pro) == ("pro", 20, 20), "Veo 3.1 Fast on Pro = 20 per output (x2 is two rows)")
g_fast_ultra = capture(OCT21, SOLO, FAST_8)
check(priced(g_fast_ultra) == ("ultra", 10, 10), "the same on Ultra = 10")
g_linked = capture(OCT21, USER_LINK, FAST_8)
check(priced(g_linked) == ("pro", 20, 20), "a user credential linked to the shared login uses its Pro plan")
g_lp_pro = capture(OCT21, SHARED, LITE_LP)
check(priced(g_lp_pro) == ("pro", None, None), "Lite Lower Priority is not offered on Pro: no price")
g_lp_ultra = capture(OCT21, SOLO, LITE_LP)
check(priced(g_lp_ultra) == ("ultra", 0, 0), "Lite Lower Priority on Ultra = 0 (free, not unknown)")
g_unknown = capture(OCT21, SHARED, dict(FAST_8, model="Veo 9 Turbo"))
check(priced(g_unknown) == ("pro", None, None), "a model with no rate: no price")
g_nosettings = capture(OCT21, SHARED)
check(priced(g_nosettings) == ("pro", None, None) and g_nosettings.model_name is None,
      "no settings captured (rows from before this change): no price")

P.set_plan(db, SHARED, "free", OCT25)
db.commit()
g_free = capture(OCT25, SHARED, FAST_8)
check(priced(g_free) == ("free", 20, 20), "Free is charged the Plus & Pro column")
check(priced(g_fast_pro) == ("pro", 20, 20), "the plan change from 25 Oct leaves 21 Oct's rows on Pro")
P.set_plan(db, SHARED, "ultra", OCT25, "upgraded")
db.commit()
check(priced(g_free) == ("ultra", 10, 10) and db.query(FlowAccountPlan).filter_by(credential_id=SHARED).count() == 2,
      "a same-day plan entry corrects it (no new period) and re-prices")

# --- a later snapshot without settings keeps them ---
again = capture(OCT21, SHARED, None, creation_id=g_720.provider_creation_id,
                updated=(at(OCT21) + timedelta(minutes=1)).isoformat() + "Z")
check(again.id == g_720.id and again.model_name == "Omni 1.1 Flash" and priced(again) == ("pro", 12, 12),
      "a later snapshot of the same row without settings keeps model and price")

# --- rate change from a date ---
row, stamped = P.set_rate(db, model_name="Veo 3.1 - Fast", resolution="720p", duration_seconds=8,
                          credits_plus_pro=25, credits_ultra=12, effective_from=OCT25, notes="Google raised it")
db.commit()
check(priced(g_fast_pro) == ("pro", 20, 20) and priced(g_free) == ("ultra", 12, 12),
      "a new Fast rate from 25 Oct re-prices 25 Oct's rows only")
old = next(r for r in P.all_rates(db) if r.model_key == P.model_key("Veo 3.1 - Fast")
           and r.duration_seconds == 8 and r.effective_from == P.DEFAULT_RATES_FROM)
check(old.effective_to == OCT25 - timedelta(days=1), "the old Fast rate now ends 24 Oct")
P.delete_rate(db, row.id)
db.commit()
check(priced(g_free) == ("ultra", 10, 10) and old.effective_to is None,
      "deleting the new rate: the old one covers those dates again")

summary = P.summary(db, [{"id": SHARED, "label": "shared"}, {"id": SOLO, "label": "solo"}])
shared = summary["accounts"][0]
expected_now = "ultra" if P.today_ist() >= OCT25 else "pro"
check(shared["currentPlan"] == expected_now and shared["generations"] == 8
      and shared["linkedCredentialIds"] == [USER_LINK] and [h["plan"] for h in shared["history"]] == ["ultra", "pro"],
      "summary: shared login's plan today, counts its linked user's rows, history newest first")
reasons = summary["generations"]
check(reasons["withoutSettings"] == 1 and any(w["model"] == "Veo 9 Turbo" for w in reasons["withoutRate"]),
      "summary names why rows are unpriced (no settings / which model has no rate)")

# --- admin API ---
from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
from database_config import get_operational_db  # noqa: E402
from utils.permissions import get_current_user  # noqa: E402

who = {"admin": True}


def _db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _user():
    return User(id=99, email="a@x.com", name="Admin" if who["admin"] else "Bob", is_admin=who["admin"],
                is_active=True, position="admin" if who["admin"] else "employee")


main.app.dependency_overrides[get_operational_db] = _db
main.app.dependency_overrides[get_current_user] = _user
client = TestClient(main.app)
r = client.get("/api/reports/credit-rates/flow")
body = r.json()
check(r.status_code == 200 and len(body["rates"]) == 21 and {a["id"] for a in body["accounts"]} == {SHARED, SOLO},
      "GET lists the rates and the Flow logins (not the linked user credential)")
r = client.post("/api/reports/credit-rates/flow/rates",
                json={"model": "Veo 9 Turbo", "resolution": "720p", "durationSeconds": 8,
                      "creditsPlusPro": 30, "creditsUltra": 15, "effectiveFrom": "2026-10-01"})
check(r.status_code == 200 and r.json()["generationsUpdated"] >= 1, "POST a rate for the unknown model")
check(priced(g_unknown) == ("pro", 30, 30), "the unknown model's row is now priced")
rate_id = r.json()["rateId"]
check(client.post("/api/reports/credit-rates/flow/rates",
                  json={"model": "X", "creditsPlusPro": -1, "effectiveFrom": "2026-10-01"}).status_code == 400,
      "negative credits are refused")
r = client.post("/api/reports/credit-rates/flow/plans",
                json={"credentialId": SOLO, "plan": "pro", "effectiveFrom": "2026-11-01"})
check(r.status_code == 200, "POST a plan change")
plan_id = r.json()["planId"]
check(client.post("/api/reports/credit-rates/flow/plans",
                  json={"credentialId": SOLO, "plan": "gold", "effectiveFrom": "2026-11-01"}).status_code == 400,
      "an unknown plan is refused")
check(client.post("/api/reports/credit-rates/flow/plans",
                  json={"credentialId": USER_LINK, "plan": "pro", "effectiveFrom": "2026-11-01"}).status_code == 404,
      "a plan cannot be set on a linked user credential (set it on the login)")
check(client.delete(f"/api/reports/credit-rates/flow/plans/{plan_id}").status_code == 200, "DELETE the plan")
check(client.delete(f"/api/reports/credit-rates/flow/rates/{rate_id}").status_code == 200
      and priced(g_unknown) == ("pro", None, None), "DELETE the rate: that row is unpriced again")
who["admin"] = False
check(client.get("/api/reports/credit-rates/flow").status_code == 403, "non-admins are refused")
print("\nALL FLOW PRICING CHECKS PASSED")
