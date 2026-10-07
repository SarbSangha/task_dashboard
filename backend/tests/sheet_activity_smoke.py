"""Sheet Activity: webhook, filtered reads, summary, CSV, backfill, access.

Run from backend/:  python tests/sheet_activity_smoke.py
"""
import io
import csv
import os
import sys
from datetime import datetime, timedelta
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

import database_config  # noqa: E402
import routers.sheet_activity_router as R  # noqa: E402
from database_config import get_operational_db  # noqa: E402
from models_new import Base, SheetActivity, TrackedSheet, TrackedSheetMember, User, UserFeatureAccess, UserRole  # noqa: E402
from services import sheet_activity_service as svc  # noqa: E402
from utils.permissions import get_current_user  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[User.__table__, UserRole.__table__, UserFeatureAccess.__table__,
                                              SheetActivity.__table__, TrackedSheet.__table__,
                                              TrackedSheetMember.__table__])
database_config.OperationalSessionLocal = SessionLocal   # used by the CSV stream

SECRET = "s3cret-for-tests-only-0123456789"
SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
URL = "/api/sheet-activity"
IDS: dict = {}


def _assert(condition, message):
    if not condition:
        raise AssertionError(message)


def _setup():
    with SessionLocal() as db:
        for name, admin in (("Admin", True), ("Viewer", False), ("Granted", False)):
            u = User(email=f"{name.lower()}@example.com", name=name, hashed_password="x", is_active=True, is_admin=admin)
            db.add(u)
            db.flush()
            IDS[name] = u.id
        db.add(UserFeatureAccess(user_id=IDS["Granted"], feature="sheet_activity"))
        db.commit()

    app = FastAPI()
    app.include_router(R.router)
    who = {"id": IDS["Admin"]}

    def _db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def _user():
        with SessionLocal() as db:
            u = db.query(User).filter(User.id == who["id"]).one()
            u.feature_grants, u.role_assignments
            db.expunge(u)
            return u

    app.dependency_overrides[get_operational_db] = _db
    app.dependency_overrides[get_current_user] = _user
    return TestClient(app), who


def event(n, **kw):
    base = {
        "eventId": f"evt-{n:06d}-aaaa",
        "timestamp": "2026-10-05T06:00:00.000Z",
        "userEmail": "ravi@ritzmediaworld.com",
        "spreadsheetId": SHEET_ID,
        "sheetName": "Leads",
        "range": "B4",
        "row": 4,
        "column": 2,
        "numRows": 1,
        "numColumns": 1,
        "changeType": "EDIT",
        "oldValue": "Pending",
        "newValue": "Approved",
    }
    base.update(kw)
    return base


def post(client, body, secret=SECRET, source=None):
    headers = {"X-Sheet-Activity-Secret": secret} if secret is not None else {}
    params = {"source": source} if source else None
    return client.post(URL, json=body, headers=headers, params=params)


# --------------------------------------------------------------------------- #
def test_webhook_auth(client):
    os.environ.pop(R.SECRET_ENV, None)
    _assert(post(client, event(1)).status_code == 503, "no secret configured -> 503, never accept")
    os.environ[R.SECRET_ENV] = "short"
    _assert(post(client, event(1), secret="short").status_code == 503, "weak secret refused")
    os.environ[R.SECRET_ENV] = SECRET
    _assert(post(client, event(1), secret=None).status_code == 401, "missing secret -> 401")
    _assert(post(client, event(1), secret="wrong-" + SECRET).status_code == 401, "wrong secret -> 401")
    with SessionLocal() as db:
        _assert(db.query(SheetActivity).count() == 0, "nothing stored on auth failure")
    print("ok  webhook secret")


def test_webhook_malformed(client):
    headers = {"X-Sheet-Activity-Secret": SECRET, "Content-Type": "application/json"}
    _assert(client.post(URL, content=b"{not json", headers=headers).status_code == 422, "bad JSON -> 422")
    _assert(client.post(URL, content=b"[1,2]", headers=headers).status_code == 422, "array body -> 422")
    cases = {
        "missing eventId": {k: v for k, v in event(2).items() if k != "eventId"},
        "short eventId": event(2, eventId="x"),
        "bad changeType": event(2, changeType="DELETE_EVERYTHING"),
        "bad timestamp": event(2, timestamp="yesterday"),
        "missing spreadsheet": {k: v for k, v in event(2).items() if k != "spreadsheetId"},
        "negative row": event(2, row=-1),
        "huge value": event(2, newValue="x" * 200_000),
        "empty batch": {"events": []},
        "batch not list": {"events": "nope"},
        "batch too large": {"events": [event(i) for i in range(10, 10 + svc.MAX_BATCH + 1)]},
    }
    for name, body in cases.items():
        r = post(client, body)
        _assert(r.status_code == 422, f"{name}: {r.status_code} {r.text[:120]}")
    r = post(client, event(2, changeType="EDIT", newValue="SECRET-VALUE", row="NaN"))
    _assert(r.status_code == 422 and "SECRET-VALUE" not in r.text, "errors never echo submitted values")
    with SessionLocal() as db:
        _assert(db.query(SheetActivity).count() == 0, "nothing stored from malformed payloads")
    print("ok  webhook malformed payloads")


def test_webhook_store_and_idempotency(client):
    r = post(client, event(1))
    _assert(r.status_code == 200 and r.json()["stored"] == 1, f"valid event stored: {r.text}")
    r = post(client, event(1))
    _assert(r.json() == {"success": True, "stored": 0, "duplicates": 1}, "same eventId stored once")
    batch = {"events": [
        event(3, userEmail="  ASHA@ritzmediaworld.com ", sheetName="Budget", range="C2:D3", row=2, column=3,
              numRows=2, numColumns=2, oldValue=None, newValue=None, newValues=[["1", "2"], ["3", "=1+1"]],
              timestamp="2026-10-05T19:00:00Z"),                       # 6 Oct 00:30 IST
        event(4, userEmail="unknown", changeType="insert_row", oldValue=None, newValue=None, numRows=1, numColumns=26,
              timestamp="2026-10-04T18:29:00Z"),                       # 4 Oct 23:59 IST
        event(5, userEmail="", sheetName="Budget", oldValue="=SUM(A1:A3)", newValue="+cmd", formula="=SUM(A1:A4)",
              timestamp="2026-10-06T10:00:00+05:30"),
        event(5),                                                       # duplicate inside the batch
        event(1),                                                       # already stored
    ]}
    r = post(client, batch, source="resend")
    _assert(r.json()["stored"] == 3 and r.json()["duplicates"] == 2, f"batch: {r.text}")
    with SessionLocal() as db:
        rows = {r.event_id: r for r in db.query(SheetActivity).all()}
        _assert(len(rows) == 4, "four distinct events")
        multi = rows["evt-000003-aaaa"]
        _assert(multi.user_email == "asha@ritzmediaworld.com" and multi.is_multi_cell, "email normalised, multi-cell")
        _assert(multi.new_value == '[["1", "2"], ["3", "=1+1"]]' and multi.source == "resend", "grid stored as JSON")
        _assert(rows["evt-000004-aaaa"].user_email is None, "'unknown' stored as no email")
        _assert(rows["evt-000004-aaaa"].change_type == "INSERT_ROW", "change type normalised")
        _assert(not rows["evt-000004-aaaa"].is_multi_cell, "structural change is never 'multiple cells'")
        _assert(rows["evt-000005-aaaa"].timestamp == datetime(2026, 10, 6, 4, 30), "offset timestamp -> UTC")
    r = post(client, event(6, newValue="y" * 50_000))
    with SessionLocal() as db:
        long_row = db.query(SheetActivity).filter_by(event_id="evt-000006-aaaa").one()
        _assert(long_row.truncated and len(long_row.new_value) == svc.MAX_VALUE_CHARS, "long values truncated")
        db.delete(long_row)
        db.commit()

    os.environ[R.SPREADSHEETS_ENV] = f"{SHEET_ID}, other-sheet"
    try:
        _assert(post(client, event(7, spreadsheetId="someone-elses-sheet")).status_code == 403, "foreign sheet -> 403")
        _assert(post(client, event(7)).status_code == 200, "allowed sheet accepted")
    finally:
        os.environ.pop(R.SPREADSHEETS_ENV, None)
    print("ok  webhook store, normalise, idempotency, allowlist")


def test_read_filters(client):
    def get(**params):
        r = client.get(URL, params=params)
        _assert(r.status_code == 200, f"GET {params}: {r.status_code} {r.text[:150]}")
        return r.json()

    everything = get()
    _assert(everything["total"] == 5, f"total {everything['total']}")
    stamps = [i["timestamp"] for i in everything["items"]]
    _assert(stamps == sorted(stamps, reverse=True), "newest first")
    _assert({i["eventId"] for i in get(user="unknown")["items"]} == {"evt-000004-aaaa", "evt-000005-aaaa"}, "unknown user")
    _assert({i["eventId"] for i in get(user="ASHA@ritzmediaworld.com")["items"]} == {"evt-000003-aaaa"}, "user filter")
    _assert({i["eventId"] for i in get(sheet="Budget")["items"]} == {"evt-000003-aaaa", "evt-000005-aaaa"}, "tab filter")
    _assert({i["eventId"] for i in get(changeType="insert_row")["items"]} == {"evt-000004-aaaa"}, "change type filter")
    # IST days: 4 Oct 23:59 IST is on the 4th; 6 Oct 00:30 IST is on the 6th.
    _assert({i["eventId"] for i in get(start="2026-10-04", end="2026-10-04")["items"]} == {"evt-000004-aaaa"}, "IST day 4")
    _assert({i["eventId"] for i in get(start="2026-10-06")["items"]} == {"evt-000003-aaaa", "evt-000005-aaaa"},
            "IST day 6 onwards")
    _assert({i["eventId"] for i in get(q="sum(a1")["items"]} == {"evt-000005-aaaa"}, "search old/new/formula")
    _assert({i["eventId"] for i in get(q="Approved")["items"]} == {"evt-000001-aaaa", "evt-000007-aaaa"}, "search values")
    page2 = get(page=2, pageSize=2)
    _assert(len(page2["items"]) == 2 and page2["total"] == 5 and page2["page"] == 2, "pagination")
    for bad in ({"changeType": "NOPE"}, {"start": "05-10-2026"}, {"start": "2026-10-06", "end": "2026-10-01"},
                {"pageSize": 1000}):
        _assert(client.get(URL, params=bad).status_code in (400, 422), f"rejects {bad}")
    print("ok  read endpoint filters and pagination")


def test_summary_options_csv(client):
    s = client.get(f"{URL}/summary", params={"start": "2026-10-01", "end": "2026-10-07"}).json()
    _assert(s["totalEdits"] == 5, "summary total")
    per_user = {u["userEmail"]: u["edits"] for u in s["perUser"]}
    _assert(per_user == {"ravi@ritzmediaworld.com": 2, None: 2, "asha@ritzmediaworld.com": 1}, f"per user {per_user}")
    _assert(s["topTabs"][0] == {"sheetName": "Leads", "edits": 3}, f"top tabs {s['topTabs']}")
    _assert(s["lastEdit"]["userEmail"] is None and s["lastEdit"]["timestamp"] == "2026-10-06T04:30:00Z", "last edit")
    days = {(d["day"], d["userEmail"]): d["edits"] for d in s["daily"]}
    _assert(days[("2026-10-04", None)] == 1 and days[("2026-10-05", "ravi@ritzmediaworld.com")] == 2, f"daily {days}")
    _assert(days[("2026-10-06", "asha@ritzmediaworld.com")] == 1, "daily IST bucketing")
    now = datetime(2026, 10, 6, 6, 0)
    with SessionLocal() as db:
        cards = svc.summary(db, svc.ActivityFilters(), now=now)
    _assert(cards["activeUsersToday"] == 2 and cards["activeUsers7d"] == 3, f"active users {cards}")

    opts = client.get(f"{URL}/options").json()
    _assert(opts["users"][-1] == "unknown" and "Budget" in opts["sheets"] and "FORMAT" in opts["changeTypes"], "options")

    r = client.get(f"{URL}/export.csv", params={"sheet": "Budget"})
    _assert(r.status_code == 200 and "attachment" in r.headers["content-disposition"], "csv download")
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    _assert(rows[0] == svc.CSV_HEADERS and len(rows) == 3, f"csv rows {len(rows)}")
    flat = [c for row in rows[1:] for c in row]
    _assert("'=SUM(A1:A3)" in flat and "'+cmd" in flat and "Unknown user" in flat, "formula injection neutralised")
    print("ok  summary, options, CSV")


def test_backfill_import():
    rows = [
        {"eventId": "evt-000001-aaaa", "timestamp": "2026-10-05T06:00:00.000Z", "userEmail": "ravi@ritzmediaworld.com",
         "spreadsheetId": SHEET_ID, "sheetName": "Leads", "range": "B4", "row": "4", "column": "2", "numRows": "1",
         "numColumns": "1", "changeType": "EDIT", "oldValue": "Pending", "newValue": "Approved", "newValues": "",
         "formula": "", "truncated": "FALSE", "sent": "FALSE"},
        {"eventId": "evt-000099-bbbb", "timestamp": "2026-10-07T09:00:00.000Z", "userEmail": "unknown",
         "spreadsheetId": SHEET_ID, "sheetName": "Leads", "range": "A1:B1", "row": "1", "column": "1", "numRows": "1",
         "numColumns": "2", "changeType": "EDIT", "oldValue": "", "newValue": "", "newValues": '[["a","b"]]',
         "formula": "", "truncated": "FALSE", "sent": "FALSE"},
        {"eventId": "bad", "timestamp": "x"},
    ]
    with SessionLocal() as db:
        result = svc.import_audit_log_rows(db, rows)
        _assert(result == {"stored": 1, "duplicates": 1, "invalid": 1}, f"backfill {result}")
        imported = db.query(SheetActivity).filter_by(event_id="evt-000099-bbbb").one()
        _assert(imported.source == "backfill" and imported.is_multi_cell and imported.user_email is None, "imported row")
    print("ok  backfill import")


def test_access(client, who):
    who["id"] = IDS["Viewer"]
    for path in (URL, f"{URL}/summary", f"{URL}/options", f"{URL}/export.csv"):
        _assert(client.get(path).status_code == 403, f"ungranted user refused on {path}")
    _assert(post(client, event(50)).status_code == 200, "webhook needs only the secret, not a login")
    who["id"] = IDS["Granted"]
    r = client.get(URL)
    _assert(r.status_code == 200 and r.json()["total"] == 0, "grant opens the tab, but no assigned sheet = no rows")
    with SessionLocal() as db:
        sheet = TrackedSheet(name="S", spreadsheet_id=SHEET_ID, url="u", tabs_json=[], mapping_json={},
                             statuses_json={}, config_json={})
        db.add(sheet)
        db.flush()
        db.add(TrackedSheetMember(sheet_id=sheet.id, user_id=IDS["Granted"]))
        db.commit()
        expected = db.query(SheetActivity).filter_by(spreadsheet_id=SHEET_ID).count()
    _assert(expected > 0 and client.get(URL).json()["total"] == expected, "assigned spreadsheet's edits become visible")
    who["id"] = IDS["Admin"]
    _assert(client.get(URL).status_code == 200, "admins always have access")
    print("ok  access")


def main() -> int:
    client, who = _setup()
    test_webhook_auth(client)
    test_webhook_malformed(client)
    test_webhook_store_and_idempotency(client)
    test_read_filters(client)
    test_summary_options_csv(client)
    test_backfill_import()
    test_access(client, who)
    print("ALL SHEET ACTIVITY CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
