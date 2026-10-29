"""Cursor prompts are tied to the usage rows in Cursor's own CSV export.

Run from backend/:  python tests/cursor_tracking_smoke.py

Covers the full path through the real router: an admin creates a setup code
for a person, the Cursor extension trades it for a computer-bound tracker token
and posts prompts with it, an admin uploads Cursor's usage
CSV, and the Cursor tab reads cards + the per-person token split. The first
scenario is the real 2026-10-29 data the matching rules were derived from
(including the two requests Cursor logged 10s and 14s before their prompt).
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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from database_config import get_operational_db  # noqa: E402
from models_new import Base, ITPortalTool, User  # noqa: E402
from providers.cursor import router as R  # noqa: E402
from providers.cursor.models import (  # noqa: E402
    CursorDevice, CursorPrompt, CursorSetupCode, CursorUsageEvent, CursorUsageUpload)
from utils.permissions import get_current_user, require_admin  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in (
    User, ITPortalTool, CursorPrompt, CursorUsageUpload, CursorUsageEvent, CursorSetupCode, CursorDevice)])


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


with SessionLocal() as db:
    sarabjeet = User(email="sarabjeet@example.com", name="Sarabjeet", hashed_password="x", department="GEN AI",
                     is_active=True, is_deleted=False, employee_id="E-1")
    friend = User(email="friend@example.com", name="Friend", hashed_password="x", department="GEN AI",
                  is_active=True, is_deleted=False, employee_id="E-2")
    leaver = User(email="leaver@example.com", name="Leaver", hashed_password="x", department="GEN AI",
                  is_active=True, is_deleted=False, employee_id="E-3")
    db.add_all([sarabjeet, friend, leaver, ITPortalTool(name="Cursor", slug="cursor", website_url="https://cursor.com/")])
    db.commit()
    USERS = {u.name: u.id for u in (sarabjeet, friend, leaver)}

acting = {"user": USERS["Sarabjeet"]}


def _db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _user():
    with SessionLocal() as db:
        return db.get(User, acting["user"])


app = FastAPI()
app.include_router(R.router)
app.dependency_overrides[get_operational_db] = _db
app.dependency_overrides[get_current_user] = _user
app.dependency_overrides[require_admin] = _user
api = TestClient(app)


def ms(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp() * 1000)


def setup_code(name):
    response = api.post("/api/providers/cursor/setup-codes", json={"user_id": USERS[name]})
    assert response.status_code == 200, response.text
    return response.json()["code"]


def connect(code, device="dev"):
    return api.post("/api/providers/cursor/connect", json={
        "code": code, "extension_version": "1.4.0", "device": {"id": device, "name": f"PC-{device}", "os": "win32"}})


# Each person's computer: the token only works together with its device id.
DEVICE_OF = {}


def token_for(name, device=None):
    device = device or f"dev-{name}"
    response = connect(setup_code(name), device)
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    DEVICE_OF[token] = device
    return token


def send(token, account, prompts, device=None):
    return api.post(
        "/api/providers/cursor/capture/prompts",
        headers={"Authorization": f"Bearer {token}"},
        json={"extension_version": "1.4.0",
              "device": {"id": device or DEVICE_OF.get(token, "dev"), "name": "PC", "os": "win32"},
              "account": {"email": account, "plan": "free"}, "prompts": prompts},
    )


def prompt(uid, start, end, steps, text, model="grok-4.6"):
    return {"id": uid, "ts": ms(start), "endTs": ms(end), "conversationId": uid.split(":")[0],
            "conversationName": "chat", "text": text, "mode": "agent", "models": [model], "responses": steps}


def upload(account, csv_text, name="usage.csv"):
    return api.post("/api/providers/cursor/usage/upload", params={"account_email": account, "file_name": name},
                    content=csv_text.encode("utf-8"), headers={"Content-Type": "text/csv"})


HEADER = ("Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),"
          "Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost")


def csv_row(when, model, inp, cache_read, out, cost):
    total = inp + cache_read + out
    return f'"{when}","","","free","{model}","No","0","{inp}","{cache_read}","{out}","{total}","{cost}"'


def summary(day, account):
    response = api.get("/api/providers/cursor/summary", params={"date_from": day, "date_to": day, "account_email": account})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def cards(day, account):
    response = api.get("/api/providers/cursor/prompts", params={"date_from": day, "date_to": day,
                                                                 "account_email": account, "limit": 50})
    assert response.status_code == 200, response.text
    return {c["promptText"]: c for c in response.json()["data"]}


# ---------------- 1. the real 2026-10-29 data ----------------
ME = "sarabjeet@contenaissance.com"
my_token = token_for("Sarabjeet")
response = send(my_token, ME, [
    prompt("c1:hi", "2026-10-29T05:25:38.187Z", "2026-10-29T05:25:40.869Z", 2, "hi"),
    prompt("c1:22", "2026-10-29T05:25:58.632Z", "2026-10-29T05:26:00.234Z", 2, "what is the 2+2"),
    prompt("c2:cuso", "2026-10-29T05:44:08.372Z", "2026-10-29T05:45:32.344Z", 25, "create cuso"),
    prompt("c3:a", "2026-10-29T06:23:17.367Z", "2026-10-29T06:23:24.891Z", 2, "0.1+0.3"),
    prompt("c3:b", "2026-10-29T06:24:21.106Z", "2026-10-29T06:24:23.508Z", 2, "0.11 vs 0.9"),
    prompt("c3:c", "2026-10-29T06:24:39.355Z", "2026-10-29T06:25:05.596Z", 7, "python"),
])
check(response.status_code == 200 and response.json()["created"] == 6, "extension posts prompts with a tracker token")
check(send(my_token, ME, [prompt("c1:hi", "2026-10-29T05:25:38.187Z", "2026-10-29T05:25:41Z", 3, "hi")]).json()["updated"] == 1,
      "re-sent prompts update in place instead of duplicating")

before = cards("2026-10-29", ME)
check(all(c["usageStatus"] == "pending" and c["tokens"] is None for c in before.values()),
      "before any CSV, prompts show as waiting rather than 0 tokens")

REAL_CSV = "\n".join([HEADER,
    csv_row("2026-10-29T06:24:25.409Z", "cursor-grok-4.6-medium", 2140, 48128, 914, "0.03"),
    csv_row("2026-10-29T06:24:21.811Z", "cursor-grok-4.6-medium", 559, 14848, 113, "0.01"),
    csv_row("2026-10-29T06:23:18.025Z", "cursor-grok-4.6-medium", 10093, 4864, 317, "0.02"),
    csv_row("2026-10-29T05:44:08.933Z", "cursor-grok-4.6-medium", 46637, 98304, 2557, "0.16"),
    csv_row("2026-10-29T05:25:48.452Z", "cursor-grok-4.6-medium", 10867, 4864, 25, "0.02"),
    csv_row("2026-10-29T05:25:38.718Z", "cursor-grok-4.6-medium", 10738, 4864, 73, "0.02"),
])
result = upload(ME, REAL_CSV).json()["data"]
check(result["rowCount"] == 6 and result["addedCount"] == 6 and result["matchedCount"] == 6,
      "the real export imports and every request is matched")
check(upload(ME, REAL_CSV).json()["data"]["addedCount"] == 0, "re-uploading the same export adds nothing")

after = cards("2026-10-29", ME)
check(all(c["requests"] == 1 for c in after.values()), "each real prompt gets exactly one request")
check(after["what is the 2+2"]["tokens"]["total"] == 15756, "a request logged 10s before its prompt goes to that prompt")
check(after["python"]["tokens"]["total"] == 51182, "a request logged 14s before its prompt goes to that prompt")
check(after["create cuso"]["costCents"] == 16 and after["create cuso"]["models"] == ["cursor-grok-4.6-medium"],
      "cost and Cursor's model name come from the CSV")
real = summary("2026-10-29", ME)
check(real["totalTokens"] == 260905 and real["unassigned"]["requests"] == 0, "totals equal the sum of the export")

# ---------------- 2. two people sharing one Cursor login ----------------
SHARED = "shared@team.com"
friend_token = token_for("Friend")
send(my_token, SHARED, [
    prompt("s:hi", "2026-10-30T05:25:38.187Z", "2026-10-30T05:25:40.869Z", 2, "S hi"),
    prompt("s:22", "2026-10-30T05:25:58.632Z", "2026-10-30T05:26:00.234Z", 2, "S 2+2"),
    prompt("s:cuso", "2026-10-30T05:44:08.372Z", "2026-10-30T05:45:32.344Z", 25, "S cuso"),
])
send(friend_token, SHARED, [
    prompt("f:1", "2026-10-30T05:25:59Z", "2026-10-30T05:26:10Z", 6, "F same model, same moment"),
    prompt("f:2", "2026-10-30T05:44:20Z", "2026-10-30T05:45:00Z", 4, "F other model", model="claude-4.5-sonnet"),
    prompt("f:3", "2026-10-30T06:00:50Z", "2026-10-30T06:01:30Z", 3, "F alone"),
])
M = 1_000_000
upload(SHARED, "\n".join([HEADER,
    csv_row("2026-10-30T05:25:39Z", "grok-4.6", int(0.10 * 2 * M), int(0.85 * 2 * M), int(0.05 * 2 * M), "Included"),
    csv_row("2026-10-30T05:26:00Z", "grok-4.6", int(0.10 * 3 * M), int(0.85 * 3 * M), int(0.05 * 3 * M), "Included"),
    csv_row("2026-10-30T05:44:30Z", "grok-4.6", int(0.10 * 37.25 * M), int(0.85 * 37.25 * M), int(0.05 * 37.25 * M), "1.20"),
    csv_row("2026-10-30T05:44:40Z", "claude-4.5-sonnet", 1 * M, int(8.5 * M), int(0.5 * M), "0.80"),
    csv_row("2026-10-30T06:01:00Z", "grok-4.6", int(0.10 * 7.75 * M), int(0.85 * 7.75 * M), int(0.05 * 7.75 * M), "Included"),
    csv_row("2026-10-30T07:30:00Z", "auto", int(0.1 * M), int(0.85 * M), int(0.05 * M), "Included"),
]))
split = summary("2026-10-30", SHARED)
by_name = {row["ownerName"]: row["tokens"] for row in split["people"]}
check(round(by_name["Sarabjeet"] / M, 2) == 40.00, "Sarabjeet gets 40M of the shared account's tokens")
check(round(by_name["Friend"] / M, 2) == 20.00, "Friend gets 20M")
check(round(split["unassigned"]["tokens"] / M, 2) == 1.00, "usage with no prompt running is Unassigned, not dropped")
check(round(split["totalTokens"] / M, 2) == 61.00, "people + Unassigned add up to the account total")
shared_cards = cards("2026-10-30", SHARED)
check(shared_cards["S 2+2"]["shared"] and shared_cards["F same model, same moment"]["shared"],
      "same moment + same model is split and marked shared")
check(not shared_cards["F other model"]["shared"], "same moment, different model goes to whoever used that model")

view = api.get("/api/providers/cursor/view", params={
    "from_ms": ms("2026-10-30T00:00:00Z"), "to_ms": ms("2026-10-31T00:00:00Z"), "account_email": SHARED}).json()["data"]
view_tokens = sum(p["tokens"]["total"] for p in view["prompts"] if p["tokens"]) + sum(u["tokens"]["total"] for u in view["unmatched"])
check(len(view["prompts"]) == 6 and len(view["unmatched"]) == 1 and round(view_tokens / M, 2) == 61.00,
      "the usage page view returns every prompt + Unassigned for the exact period")
check(view["latestUpload"]["cursorAccountEmail"] == SHARED and view["prompts"][0]["ownerName"],
      "the view carries the last CSV upload and each prompt's person")

# ---------------- 3. accounts, tokens and bad files ----------------
send(my_token, "a@team.com", [prompt("x:1", "2026-10-31T10:00:00Z", "2026-10-31T10:00:05Z", 2, "on account A")])
upload("b@team.com", "\n".join([HEADER, csv_row("2026-10-31T10:00:01Z", "grok-4.6", 100, 100, 100, "0.01")]))
check(summary("2026-10-31", "b@team.com")["unassigned"]["requests"] == 1,
      "a CSV never matches prompts from a different Cursor login")

check(send("not-a-token", ME, []).status_code == 401, "a bad tracker token is rejected")

# ---------------- 4. connecting computers ----------------
code = setup_code("Friend")
check(code.startswith("CUR-") and len(code) == 13, "an admin gets a CUR-XXXX-XXXX setup code")
first = connect(code.lower().replace("-", " "), "laptop-1")
check(first.status_code == 200 and first.json()["user"]["name"] == "Friend" and first.json()["sendFromMs"] is None,
      "the extension trades the code (typed loosely) for Friend's token, with full history")
check(connect(code, "laptop-2").status_code == 400, "a setup code only works once")
laptop_token = first.json()["token"]
check(send(laptop_token, ME, [], device="laptop-1").status_code == 200, "the token works from its own computer")
moved = send(laptop_token, ME, [], device="someone-elses-pc")
check(moved.status_code == 401 and "different computer" in moved.json()["detail"],
      "the same token copied to another computer is rejected")

stale_code = setup_code("Friend")
with SessionLocal() as db:
    expired = db.query(CursorSetupCode).order_by(CursorSetupCode.id.desc()).first()
    expired.expires_at = datetime(2000, 1, 1)
    db.commit()
check(connect(stale_code, "laptop-3").status_code == 400, "an expired setup code is refused")

# Re-connecting laptop-1 for Sarabjeet switches it over and kills Friend's token there.
switched = connect(setup_code("Sarabjeet"), "laptop-1")
check(switched.status_code == 200 and send(laptop_token, ME, [], device="laptop-1").status_code == 401,
      "connecting a computer again replaces its previous person")
check(switched.json()["sendFromMs"] and abs(switched.json()["sendFromMs"] - datetime.now(timezone.utc).timestamp() * 1000) < 60000,
      "after a switch, the extension sends only prompts from now on (Friend's history stays Friend's)")
same_again = connect(setup_code("Sarabjeet"), "laptop-1")
check(same_again.json()["sendFromMs"] is None, "reconnecting for the same person keeps re-sending their history")
switched_token = same_again.json()["token"]
devices = api.get("/api/providers/cursor/devices").json()["data"]
active = [d for d in devices if d["active"]]
check(any(d["userName"] == "Sarabjeet" and d["deviceName"] == "PC-laptop-1" for d in active)
      and not any(d["userName"] == "Friend" and d["deviceName"] == "PC-laptop-1" for d in active),
      "the device list shows who each computer reports as")
row = next(d for d in active if d["deviceName"] == "PC-laptop-1")
check(api.post(f"/api/providers/cursor/devices/{row['id']}/disconnect").json()["data"][0]["active"] is False
      and send(switched_token, ME, [], device="laptop-1").status_code == 401,
      "an admin's Disconnect stops that computer immediately")
check(api.post("/api/providers/cursor/setup-codes", json={"user_id": 99999}).status_code == 404,
      "no setup code for a person who doesn't exist")
check(any(p["name"] == "Friend" for p in api.get("/api/providers/cursor/people").json()["data"]),
      "the people picker lists dashboard users")
admin_only = {(m, r.path) for r in R.router.routes for m in r.methods
              if any(d.call is require_admin for d in r.dependant.dependencies)}
check({("GET", "/api/providers/cursor/people"), ("POST", "/api/providers/cursor/setup-codes"),
       ("GET", "/api/providers/cursor/devices"), ("POST", "/api/providers/cursor/devices/{device_row_id}/disconnect")}
      <= admin_only and ("POST", "/api/providers/cursor/connect") not in admin_only,
      "only admins can create codes or manage devices; the extension's /connect needs just the code")

leaver_token = token_for("Leaver")
with SessionLocal() as db:
    db.get(User, USERS["Leaver"]).is_deleted = True
    db.commit()
check(send(leaver_token, ME, []).status_code == 401, "a deleted user's token stops working")
check(api.post("/api/providers/cursor/setup-codes", json={"user_id": USERS["Leaver"]}).status_code == 404,
      "no setup code for a deleted user")
paused_token = token_for("Friend", device="friend-desk")
with SessionLocal() as db:
    db.get(User, USERS["Friend"]).is_active = False
    db.commit()
check(send(paused_token, ME, []).status_code == 401, "a deactivated user's computer is refused too")
with SessionLocal() as db:
    db.get(User, USERS["Friend"]).is_active = True
    db.commit()

bad = upload(ME, "foo,bar\n1,2")
check(bad.status_code == 400 and "Cursor usage export" in bad.json()["detail"], "a non-Cursor file gets a clear error")
check(upload(ME, HEADER + '\n"yesterday","","","free","m","No","0","1","1","1","3","0"').status_code == 400,
      "a file with no readable dates is refused")

print("\nAll Cursor tracking checks passed.")
