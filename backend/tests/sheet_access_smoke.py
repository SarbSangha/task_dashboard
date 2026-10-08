"""Smoke test for per-sheet permissions (Admin Queue -> Sheet Access) and the
"Add Sheets" grant in routers/sheets_router.py.

Run: python tests/sheet_access_smoke.py
"""

import os
import sys
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])

from models_new import (  # noqa: E402
    Base, ContentRequest, TrackedSheet, TrackedSheetMember, User, UserFeatureAccess, UserRole,
)
from routers import sheets_router as R  # noqa: E402
from services.feature_access_service import FEATURE_SHEETS_ADD, set_feature_access  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[
    User.__table__, UserRole.__table__, UserFeatureAccess.__table__,
    TrackedSheet.__table__, TrackedSheetMember.__table__, ContentRequest.__table__,
])

# Creating a sheet polls Google right away; not here.
R.S.poll_sheet = lambda db, sheet, force=False: {"created": 0}
R.S.parse_spreadsheet_id = lambda url: url.rsplit("/", 1)[-1]


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def expect_http(status, fn, msg):
    try:
        fn()
    except HTTPException as exc:
        check(exc.status_code == status, f"{msg} -> {status}")
        return
    raise AssertionError(f"{msg}: expected HTTP {status}, got success")


db = SessionLocal()
admin = User(email="admin@x.com", name="Admin", hashed_password="x", is_active=True, is_admin=True, position="admin")
alice = User(email="alice@x.com", name="Alice", hashed_password="x", is_active=True, position="employee")
bob = User(email="bob@x.com", name="Bob", hashed_password="x", is_active=True, position="employee")
db.add_all([admin, alice, bob])
db.commit()

tabs = [R.TabIn(name="Sheet1", tracked=True)]
ranking = dict(sheetType="keyword_ranking", tabs=tabs)

# --- Add Sheets grant ---------------------------------------------------
expect_http(403, lambda: R.require_sheet_adder(alice), "user without Add Sheets cannot add")
set_feature_access(db, alice, FEATURE_SHEETS_ADD, True)
db.commit()
check(R.require_sheet_adder(alice) is alice, "user with Add Sheets can add")

res = R.create_sheet(R.SheetIn(url="https://docs.google.com/spreadsheets/d/AAA", name="Alice sheet",
                               memberIds=[bob.id], **ranking), db, alice)
sid = res["sheet"]["id"]
check(res["sheet"]["permissions"] == {"open": True, "openInGoogle": True, "settings": True},
      "adder gets every permission on the sheet they added")
member_ids = {m.user_id for m in db.query(TrackedSheetMember).filter_by(sheet_id=sid)}
check(member_ids == {alice.id}, "non-admin adder cannot assign other people (memberIds ignored)")

# --- Admin sets Bob's access --------------------------------------------
listed = lambda u: {s["id"]: s for s in R.list_sheets(db, u)["sheets"]}  # noqa: E731
check(sid not in listed(bob), "Bob does not see the sheet before being given it")

from services.feature_access_service import has_feature_access  # noqa: E402
check(not has_feature_access(bob, "sheet_activity"), "Bob has no Sheets section yet")
res = R.set_member_access(sid, bob.id, R.MemberAccessIn(member=True, open=False, openInGoogle=False, settings=False), db, admin)
db.refresh(bob)
check(res["sectionGranted"] and has_feature_access(bob, "sheet_activity"), "giving Bob a sheet grants the Sheets section")
card = listed(bob)[sid]
check(card["permissions"] == {"open": False, "openInGoogle": False, "settings": False}, "Bob sees the card, no actions")
check(card["openUrl"] is None and card["url"] is None, "Google link withheld without openInGoogle")
expect_http(403, lambda: R.ranking_overview(sid, None, db, bob), "Bob cannot open without Open")
expect_http(403, lambda: R.sync_now(sid, db, bob), "Bob cannot Sync now without Settings")
expect_http(403, lambda: R.update_sheet(sid, R.SheetPatch(name="x"), db, bob), "Bob cannot change settings")

R.set_member_access(sid, bob.id, R.MemberAccessIn(member=True, open=True, openInGoogle=True, settings=False), db, admin)
card = listed(bob)[sid]
check(card["openUrl"] is not None, "Google link shown with openInGoogle")
_ = R._get_visible_sheet(db, bob, sid, need="open")
check(True, "Bob can open with Open")

R.set_member_access(sid, bob.id, R.MemberAccessIn(member=True, open=False, openInGoogle=False, settings=True), db, admin)
before = db.get(TrackedSheet, sid).source_url
R.update_sheet(sid, R.SheetPatch(name="Renamed", sourceUrl=""), db, bob)
check(db.get(TrackedSheet, sid).name == "Renamed", "Bob can change settings with Settings")
check(db.get(TrackedSheet, sid).source_url == before, "Settings-only member cannot clear the hidden source link")
expect_http(403, lambda: R.require_admin(bob), "deleting / assigning stays admin-only")

overview = R.access_overview(db, admin)["sheets"][0]["members"]
check(set(overview) == {str(alice.id), str(bob.id)}, "Admin Queue overview lists both members")

R.set_member_access(sid, bob.id, R.MemberAccessIn(member=False), db, admin)
check(sid not in listed(bob), "removing Bob hides the sheet")
expect_http(404, lambda: R._get_visible_sheet(db, bob, sid), "removed member gets 404")

check(listed(admin)[sid]["permissions"]["settings"] is True, "admin always has every permission")
print("\nAll sheet access checks passed.")
