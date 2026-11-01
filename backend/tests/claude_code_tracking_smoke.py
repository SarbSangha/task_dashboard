"""Claude Code's own OpenTelemetry events become per-person prompt rows.

Run from backend/:  python tests/claude_code_tracking_smoke.py

Covers the full path through the real routers: an admin connects a computer
with a Cursor setup code, the Cursor extension asks for that computer's Claude
Code token, Claude Code posts OTLP/HTTP JSON batches with it, and the admin
view groups requests under their prompt with Claude Code's own cost. Then every
way the token must stop working: Disconnect, reconnecting the computer for
someone else, the extension's own disconnect, a deactivated person.
"""

import gzip
import json
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
from providers.claude_code import router as CC  # noqa: E402
from providers.claude_code.models import ClaudeCodePrompt, ClaudeCodeRequest, ClaudeCodeToken  # noqa: E402
from providers.claude_code.otlp import parse_logs  # noqa: E402
from providers.claude_code.queries import surface_of  # noqa: E402
from providers.cursor import router as R  # noqa: E402
from providers.cursor.models import CursorDevice, CursorSetupCode  # noqa: E402
from utils.permissions import get_current_user, require_admin  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in (
    User, ITPortalTool, CursorSetupCode, CursorDevice, ClaudeCodeToken, ClaudeCodePrompt, ClaudeCodeRequest)])


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


with SessionLocal() as db:
    admin = User(email="admin@example.com", name="Sarabjeet", hashed_password="x", department="GEN AI",
                 is_active=True, is_deleted=False, employee_id="E-1")
    rahul = User(email="rahul@example.com", name="Rahul", hashed_password="x", department="GEN AI",
                 is_active=True, is_deleted=False, employee_id="E-2")
    priya = User(email="priya@example.com", name="Priya", hashed_password="x", department="GEN AI",
                 is_active=True, is_deleted=False, employee_id="E-3")
    db.add_all([admin, rahul, priya])
    db.commit()
    USERS = {u.name: u.id for u in (admin, rahul, priya)}


def _db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _admin():
    with SessionLocal() as db:
        return db.get(User, USERS["Sarabjeet"])


app = FastAPI()
app.include_router(R.router)
app.include_router(CC.router)
app.dependency_overrides[get_operational_db] = _db
app.dependency_overrides[get_current_user] = _admin
app.dependency_overrides[require_admin] = _admin
client = TestClient(app)


def connect_computer(person, device_id):
    code = client.post("/api/providers/cursor/setup-codes", json={"user_id": USERS[person]}).json()["code"]
    res = client.post("/api/providers/cursor/connect", json={
        "code": code, "extension_version": "1.5.0", "device": {"id": device_id, "name": "PC-" + person, "os": "win32"}})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def claude_connect(cursor_token, device_id):
    return client.post("/api/providers/claude-code/connect",
                       headers={"Authorization": f"Bearer {cursor_token}"},
                       json={"extension_version": "1.5.0", "device": {"id": device_id}})


def kv(key, value):
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": value}}


T0 = datetime(2026, 10, 30, 4, 0, tzinfo=timezone.utc)


def at(seconds):
    return T0.timestamp() + seconds


def nanos(seconds):
    return str(int(at(seconds) * 1e9))


def prompt_event(prompt_id, seconds, text, session="sess-1", terminal="vscode", **extra):
    attrs = [kv("event.name", "user_prompt"), kv("session.id", session), kv("terminal.type", terminal),
             kv("user.email", "team@contenaissance.com"), kv("prompt_length", len(text)), kv("prompt", text)]
    if prompt_id:
        attrs.append(kv("prompt.id", prompt_id))
    attrs += [kv(k, v) for k, v in extra.items()]
    return {"timeUnixNano": nanos(seconds), "body": {"stringValue": "claude_code.user_prompt"}, "attributes": attrs}


def request_event(prompt_id, seconds, model, cost, inp, out, cache_read=0, cache_write=0, request_id=None,
                  session="sess-1", terminal="vscode"):
    attrs = [kv("event.name", "api_request"), kv("session.id", session), kv("terminal.type", terminal),
             kv("model", model), kv("cost_usd", cost), kv("input_tokens", inp), kv("output_tokens", out),
             kv("cache_read_tokens", cache_read), kv("cache_creation_tokens", cache_write), kv("duration_ms", 1800)]
    if prompt_id:
        attrs.append(kv("prompt.id", prompt_id))
    if request_id:
        attrs.append(kv("request_id", request_id))
    return {"timeUnixNano": nanos(seconds), "body": {"stringValue": "claude_code.api_request"}, "attributes": attrs}


def otlp(*records):
    return {"resourceLogs": [{
        "resource": {"attributes": [kv("service.name", "claude-code"), kv("service.version", "2.1.290")]},
        "scopeLogs": [{"scope": {"name": "com.anthropic.claude_code.events"}, "logRecords": list(records)}],
    }]}


def send(token, body, **headers):
    return client.post("/api/providers/claude-code/otlp/v1/logs",
                       headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", **headers},
                       content=json.dumps(body).encode())


def view(**params):
    q = {"from_ms": int(at(-3600) * 1000), "to_ms": int(at(3600) * 1000), **params}
    res = client.get("/api/providers/claude-code/view", params=q)
    assert res.status_code == 200, res.text
    return res.json()["data"]


# ---- parser, on its own ----
parsed = parse_logs(otlp(
    prompt_event("p-x", 0, "<REDACTED>"),
    prompt_event("p-y", 1, "<REDACTED>", prompt_text="newer field wins"),
    {"timeUnixNano": nanos(2), "body": {"stringValue": "claude_code.tool_result"}, "attributes": [kv("event.name", "tool_result")]},
))
check(parsed.prompts[0].text == "" and parsed.prompts[1].text == "newer field wins",
      "redacted prompts are stored without text; prompt_text (Claude Code 2.1.287+) is read too")
check(parsed.ignored == 1, "events other than user_prompt/api_request are ignored")
# What Claude Code 2.1.312 really sends from the VS Code chat panel with
# OTEL_METRICS_INCLUDE_ENTRYPOINT=true: terminal.type "non-interactive",
# app.entrypoint "claude-vscode". A `claude` run in a terminal says "cli".
where = parse_logs(otlp(
    prompt_event("p-v", 0, "x", terminal="non-interactive", **{"app.entrypoint": "claude-vscode"}),
    prompt_event("p-w", 0, "x", terminal="WindowsTerminal", **{"app.entrypoint": "cli"}),
    prompt_event("p-c", 0, "x", terminal="non-interactive", **{"app.entrypoint": "cli"}),
    prompt_event("p-s", 0, "x", terminal="non-interactive", **{"app.entrypoint": "sdk-ts"}),
    prompt_event("p-o", 0, "x", terminal="non-interactive"),
    prompt_event("p-t", 0, "x", terminal="windows-terminal", **{"app.entrypoint": "cli"}),
    # Classic CMD on Windows 10: Claude Code detects no terminal, so only the entrypoint says "cli".
    {**prompt_event("p-cmd", 0, "x", **{"app.entrypoint": "cli"}),
     "attributes": [kv_ for kv_ in prompt_event("p-cmd", 0, "x", **{"app.entrypoint": "cli"})["attributes"] if kv_["key"] != "terminal.type"]},
))
labels = [surface_of(p.terminal_type) for p in where.prompts]
check(labels == ["Claude Code · VS Code", "Claude Code · Terminal", "Claude Code · Non-interactive",
                 "Claude Code · SDK", "Claude Code · Non-interactive", "Claude Code · Terminal", "Claude Code · Terminal"],
      "the VS Code chat panel shows as VS Code (app.entrypoint), a terminal run keeps its terminal")
check(where.prompts[-1].terminal_type == "cli", "a classic CMD window (no terminal.type, entrypoint cli) counts as Terminal")
check(surface_of("vscode") == "Claude Code · VS Code" and surface_of("WindowsTerminal") == "Claude Code · Terminal"
      and surface_of("cursor") == "Claude Code · Cursor" and surface_of(None) == "Claude Code",
      "terminal.type becomes a VS Code / Terminal / Cursor label")

# ---- connecting ----
rahul_cursor = connect_computer("Rahul", "machine-rahul")
res = claude_connect(rahul_cursor, "machine-rahul")
check(res.status_code == 200 and res.json()["token"].startswith("cct_")
      and res.json()["otlpPath"] == "/api/providers/claude-code/otlp" and res.json()["user"]["name"] == "Rahul",
      "a connected computer gets a Claude Code token for its own person")
rahul_cc = res.json()["token"]
check(claude_connect(rahul_cursor, "machine-other").status_code == 401,
      "the Cursor token only gets a Claude Code token from its own computer")
check(claude_connect("cut_bogus", "machine-rahul").status_code == 401, "an unknown Cursor token gets nothing")
check(send(rahul_cursor, otlp()).status_code == 401, "the Cursor tracker token itself is not accepted by the OTLP receiver")
with SessionLocal() as db:
    check(db.query(ClaudeCodeToken).filter_by(token_hash=CC._sha256(rahul_cc)).count() == 1
          and db.query(ClaudeCodeToken).filter(ClaudeCodeToken.token_hash == rahul_cc).count() == 0,
          "only the token's sha256 is stored")

# ---- receiving ----
batch1 = otlp(
    prompt_event("p-1", 0, "Add retry logic to the payment webhook handler"),
    request_event("p-1", 2, "claude-sonnet-5-5", 0.0412, 9, 1440, 72000, 15000, request_id="req_A"),
    request_event("p-1", 9, "claude-haiku-5-5", 0.0021, 300, 40, request_id="req_B"),
)
check(send(rahul_cc, batch1).status_code == 200, "Claude Code's OTLP JSON batch is accepted")
check(send(rahul_cc, batch1).status_code == 200, "the same batch again (exporter retry) is accepted")
# A request for p-1 arriving in a later batch, gzip-compressed.
late = otlp(request_event("p-1", 20, "claude-sonnet-5-5", 0.0100, 5, 200, 80000, request_id="req_C"))
check(send(rahul_cc, {}, **{}).status_code == 200, "an empty export is fine")
res = client.post("/api/providers/claude-code/otlp/v1/logs",
                  headers={"Authorization": f"Bearer {rahul_cc}", "Content-Type": "application/json", "Content-Encoding": "gzip"},
                  content=gzip.compress(json.dumps(late).encode()))
check(res.status_code == 200, "gzip-compressed batches are accepted")
res = client.post("/api/providers/claude-code/otlp/v1/logs",
                  headers={"Authorization": f"Bearer {rahul_cc}", "Content-Type": "application/x-protobuf"}, content=b"\x0a\x00")
check(res.status_code == 415, "protobuf gets 415 telling the computer to use http/json")
check(client.post("/api/providers/claude-code/otlp/v1/metrics", headers={"Authorization": f"Bearer {rahul_cc}"}).status_code == 200,
      "metrics exports are accepted and dropped")

with SessionLocal() as db:
    check(db.query(ClaudeCodePrompt).count() == 1 and db.query(ClaudeCodeRequest).count() == 3,
          "the retry stored nothing twice: 1 prompt, 3 requests")

data = view()
row = data["prompts"][0]
check(len(data["prompts"]) == 1 and row["requests"] == 3 and row["promptText"].startswith("Add retry logic"),
      "all three requests - including the late one - sit under their prompt")
check(abs(row["costUsd"] - 0.0533) < 1e-9 and row["costComplete"], "the prompt's cost is the sum of Claude Code's own cost_usd")
check(row["tokens"] == {"input": 314, "output": 1680, "cacheRead": 152000, "cacheWrite": 15000}, "tokens are summed per kind")
check(row["models"] == ["claude-sonnet-5-5", "claude-haiku-5-5"] and row["surface"] == "Claude Code · VS Code"
      and row["ownerName"] == "Rahul" and row["claudeAccountEmail"] == "team@contenaissance.com",
      "models, surface, person and Claude login are shown")

# Older Claude Code without prompt.id: requests go to the latest prompt in the same session.
send(rahul_cc, otlp(
    prompt_event(None, 100, "Why does this test fail only on CI?", session="sess-2", terminal="WindowsTerminal"),
    request_event(None, 103, "claude-opus-5-5", 0.30, 100, 900, session="sess-2", terminal="WindowsTerminal"),
    prompt_event(None, 200, "/compact", session="sess-2", terminal="WindowsTerminal", command_name="compact"),
    request_event(None, 201, "claude-haiku-5-5", 0.01, 50, 50, session="sess-2", terminal="WindowsTerminal"),
))
by_text = {p["promptText"]: p for p in view()["prompts"]}
ci = by_text["Why does this test fail only on CI?"]
check(ci["requests"] == 1 and abs(ci["costUsd"] - 0.30) < 1e-9 and ci["surface"] == "Claude Code · Terminal",
      "without prompt.id a request goes to the latest earlier prompt in its session")
check(by_text["/compact"]["commandName"] == "compact" and by_text["/compact"]["requests"] == 1,
      "a slash command is its own prompt row")

# A request whose prompt was never received still counts toward the person's total.
send(rahul_cc, otlp(request_event("p-missing", 300, "claude-sonnet-5-5", 0.05, 10, 10, request_id="req_orphan")))
data = view()
orphan = [p for p in data["prompts"] if not p["hasPrompt"]]
check(len(orphan) == 1 and abs(orphan[0]["costUsd"] - 0.05) < 1e-9, "a request without its prompt becomes its own row")
check(abs(data["totals"]["costUsd"] - (0.0533 + 0.30 + 0.01 + 0.05)) < 1e-9 and data["totals"]["prompts"] == 3,
      "the period total equals every request's cost; only typed prompts count as prompts")

# What Claude Code 2.1.312 really sent for `claude -p`: a background call with
# no prompt.id 0.4s before the prompt, then the prompt's own call. A background
# call after a prompt.id prompt must not be pulled into that prompt either.
send(rahul_cc, otlp(
    request_event(None, 499.6, "claude-haiku-5-5", 0.0001244, 1174, 14, request_id="req_bg1", session="sess-3", terminal="non-interactive"),
    prompt_event("p-3", 500, "Reply with just the word: pong", session="sess-3", terminal="non-interactive"),
    request_event("p-3", 501, "claude-haiku-5-5", 0.00255977, 2, 4, 19937, 11791, request_id="req_p3", session="sess-3", terminal="non-interactive"),
    request_event(None, 510, "claude-haiku-5-5", 0.0002, 300, 10, request_id="req_bg2", session="sess-3", terminal="non-interactive"),
))
rows = [p for p in view()["prompts"] if p["sessionId"] == "sess-3"]
pong = next(p for p in rows if p["hasPrompt"])
background = [p for p in rows if not p["hasPrompt"]]
check(pong["requests"] == 1 and abs(pong["costUsd"] - 0.00255977) < 1e-9 and pong["surface"] == "Claude Code · Non-interactive",
      f"a prompt.id prompt keeps only its own requests (claude -p is labelled Non-interactive)")
check(len(background) == 1 and background[0]["requests"] == 2 and abs(background[0]["costUsd"] - 0.0003244) < 1e-9,
      "Claude Code's background calls without prompt.id form one row per session")

# Two people.
priya_cursor = connect_computer("Priya", "machine-priya")
priya_cc = claude_connect(priya_cursor, "machine-priya").json()["token"]
send(priya_cc, otlp(prompt_event("p-1", 400, "Same prompt.id as Rahul's, different person"),
                    request_event("p-1", 401, "claude-sonnet-5-5", 0.2, 10, 10, request_id="req_A")))
data = view()
people = {p["name"]: p for p in data["people"]}
check(set(people) == {"Rahul", "Priya"} and abs(people["Priya"]["costUsd"] - 0.2) < 1e-9,
      "each computer's events are its own person's, even when ids collide across people")
only_priya = view(owner_user_id=USERS["Priya"])
check(len(only_priya["prompts"]) == 1 and abs(only_priya["totals"]["costUsd"] - 0.2) < 1e-9,
      "the view filters prompts and totals by person")
check({p["name"] for p in only_priya["people"]} == {"Rahul", "Priya"}, "...while By person still lists everyone")

data = view()
check(abs(sum(d["costUsd"] for d in data["daily"]) - data["totals"]["costUsd"]) < 1e-9
      and abs(sum(m["costUsd"] for m in data["byModel"]) - data["totals"]["costUsd"]) < 1e-9,
      "daily cost and cost by model both add up to the period total")
haiku = next(m for m in data["byModel"] if m["model"] == "claude-haiku-5-5")
check(haiku["requests"] == 5, "cost by model counts model calls, so a prompt using two models feeds both")
check(abs(data["totals"]["backgroundCostUsd"] - (0.05 + 0.0003244)) < 1e-9
      and abs(data["totals"]["promptCostUsd"] + data["totals"]["backgroundCostUsd"] - data["totals"]["costUsd"]) < 1e-9,
      "background (no typed prompt) cost is reported separately and the two add up")
check(view(q="WEBHOOK")["pagination"]["total"] == 1 and view(q="priya")["pagination"]["total"] == 1
      and view(q="WEBHOOK")["totals"]["costUsd"] == data["totals"]["costUsd"],
      "search narrows only the prompt list (text, person, model...), not the totals")
by_cost = view(sort="cost")["prompts"]
check([p["costUsd"] for p in by_cost] == sorted((p["costUsd"] for p in by_cost), reverse=True)
      and view(sort="cost", direction="asc")["prompts"][0]["costUsd"] == min(p["costUsd"] for p in by_cost),
      "the prompt list sorts by cost both ways")
check(view(limit=2, offset=2)["prompts"][0]["id"] == view()["prompts"][2]["id"], "the prompt list pages")
check(client.get("/api/providers/claude-code/view", params={"from_ms": 1, "to_ms": 2, "sort": "bogus"}).status_code == 422,
      "an unknown sort key is refused")
# T0 is 04:00 UTC: 09:30 the same day in India (offset -330), 23:00 the day before at UTC-5 (offset 300).
check({d["date"] for d in view(tz_offset_min=-330)["daily"]} == {"2026-10-30"}
      and "2026-10-29" in {d["date"] for d in view(tz_offset_min=300)["daily"]},
      "daily buckets fall on the viewer's local days")
check(data["lastIngestAt"] is not None, "the view says when data last arrived")

conns = client.get("/api/providers/claude-code/connections").json()["data"]
check(len(conns) == 2 and all(c["active"] for c in conns) and {c["claudeVersion"] for c in conns} == {"2.1.290"},
      "admin sees each computer reporting Claude Code, with its Claude Code version")

# ---- every way the token stops working ----
new_rahul_cc = claude_connect(rahul_cursor, "machine-rahul").json()["token"]
check(send(rahul_cc, otlp()).status_code == 401 and send(new_rahul_cc, otlp()).status_code == 200,
      "connecting Claude Code again replaces the computer's previous token")

check(client.post("/api/providers/claude-code/disconnect", headers={"Authorization": f"Bearer {rahul_cursor}"},
                  json={"device": {"id": "machine-rahul"}}).json()["revoked"] == 1
      and send(new_rahul_cc, otlp()).status_code == 401,
      "the extension's Stop tracking Claude Code turns the token off")

rahul_cc = claude_connect(rahul_cursor, "machine-rahul").json()["token"]
with SessionLocal() as db:
    device_row = db.query(CursorDevice).filter_by(device_id="machine-rahul", revoked_at=None).one().id
client.post(f"/api/providers/cursor/devices/{device_row}/disconnect")
check(send(rahul_cc, otlp()).status_code == 401, "an admin's Disconnect of the computer also stops its Claude Code")

priya_cc_before = priya_cc
connect_computer("Rahul", "machine-priya")  # the admin hands Priya's computer to Rahul
check(send(priya_cc_before, otlp()).status_code == 401,
      "reconnecting a computer for someone else stops the old person's Claude Code token")

priya_cursor = connect_computer("Priya", "machine-priya-2")
priya_cc = claude_connect(priya_cursor, "machine-priya-2").json()["token"]
with SessionLocal() as db:
    db.get(User, USERS["Priya"]).is_active = False
    db.commit()
check(send(priya_cc, otlp()).status_code == 401, "a deactivated person's Claude Code token stops working")

print("\nall Claude Code tracking checks passed")
