"""Fixed credits per generation (Suno): dated prices stamped onto songs.

Run from backend/:  python tests/generation_pricing_smoke.py

Checks, on an in-memory SQLite database:
  * a price from a date stamps every song of every status from that date on,
    and its GenerationRecord mirror;
  * a later price closes the earlier one; older songs keep their price;
  * a same-day entry corrects the price instead of adding a period;
  * deleting a price re-opens the previous one over its dates;
  * songs before the first price stay unpriced (NULL);
  * a newly captured song is priced as it is normalized, by its own date;
  * the admin API: list / set / delete, admin only.
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
    Base, GenerationRecord, ITPortalTool, ToolGenerationPrice, User, UserFeatureAccess, UserRole,
)
from providers.suno.models import SunoCaptureEvent, SunoGeneration  # noqa: E402
from providers.suno.normalization import normalize_capture_event  # noqa: E402
from services import generation_pricing as P  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in (
    User, UserRole, UserFeatureAccess, ITPortalTool, GenerationRecord, ToolGenerationPrice, SunoGeneration,
    SunoCaptureEvent)])


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def at(day: date, hour=12):
    """A UTC time on that IST date (noon IST)."""
    return datetime(day.year, day.month, day.day, hour) - timedelta(minutes=330)


AUG17, AUG31, SEP1, SEP15, OCT1 = date(2026, 8, 17), date(2026, 8, 31), date(2026, 9, 1), date(2026, 9, 15), date(2026, 10, 1)

db = SessionLocal()
songs = {}
for i, (day, status) in enumerate([(AUG17, "complete"), (AUG17, "submitted"), (AUG31, "complete"),
                                   (SEP1, "complete"), (SEP15, "queued"), (OCT1, "complete")]):
    rec = GenerationRecord(provider="suno", provider_generation_id=f"s{i}", created_at=at(day))
    db.add(rec)
    db.flush()
    g = SunoGeneration(provider="suno", provider_creation_id=f"s{i}", provider_created_at=at(day), status=status,
                       generation_record_id=rec.id)
    db.add(g)
    songs[(day, status)] = g
db.commit()


def credits():
    db.expire_all()
    out = {}
    for (day, status), g in songs.items():
        g = db.get(SunoGeneration, g.id)
        rec = db.get(GenerationRecord, g.generation_record_id)
        out[(day, status)] = (g.credits_used, rec.credits_burned)
    return out


check(all(v == (None, None) for v in credits().values()), "no price yet: every song unpriced")

_row, stamped = P.set_price(db, "Suno", 5, AUG17, "5 credits per song")
db.commit()
c = credits()
check(stamped == 6 and all(v == (5, 5) for v in c.values()),
      "5 from 17 Aug: every song, every status, priced 5 (and its GenerationRecord)")

_row, stamped = P.set_price(db, "Suno", 7, SEP1)
db.commit()
c = credits()
check(c[(AUG17, "complete")] == (5, 5) and c[(AUG31, "complete")] == (5, 5), "songs before 1 Sep keep 5")
check(c[(SEP1, "complete")] == (7, 7) and c[(OCT1, "complete")] == (7, 7) and c[(SEP15, "queued")] == (7, 7),
      "songs from 1 Sep get 7")
first, second = P.prices(db, "Suno")
check(first.effective_to == AUG31 and second.effective_to is None and stamped == 3,
      "the 5 price now ends 31 Aug; 7 is current; only the 3 songs from 1 Sep were re-stamped")

P.set_price(db, "Suno", 8, SEP1, "corrected")
db.commit()
check(len(P.prices(db, "Suno")) == 2 and credits()[(SEP1, "complete")] == (8, 8),
      "same start date corrects the price (no new period)")

P.set_price(db, "Suno", 6, SEP15)
db.commit()
c = credits()
check(c[(SEP1, "complete")] == (8, 8) and c[(SEP15, "queued")] == (6, 6) and c[(OCT1, "complete")] == (6, 6),
      "a price from 15 Sep splits the 1 Sep period")

sep15 = next(p for p in P.prices(db, "Suno") if p.effective_from == SEP15)
P.delete_price(db, sep15.id)
db.commit()
c = credits()
check(c[(SEP15, "queued")] == (8, 8) and c[(OCT1, "complete")] == (8, 8) and P.prices(db, "Suno")[-1].effective_to is None,
      "deleting the 15 Sep price: 1 Sep's price covers those songs again")

early = P.prices(db, "Suno")[0]
P.delete_price(db, early.id)
db.commit()
c = credits()
check(c[(AUG17, "complete")] == (None, None) and c[(SEP1, "complete")] == (8, 8),
      "deleting the first price: songs before 1 Sep are unpriced again")

# A newly captured song is priced as it is normalized.
P.set_price(db, "Suno", 5, AUG17)
db.commit()
db.add(User(id=1, email="u@x.com", name="U", hashed_password="x", is_active=True, position="employee"))
db.add(ITPortalTool(id=1, name="Suno", slug="suno", website_url="https://suno.com"))
db.commit()
event = SunoCaptureEvent(tool_id=1, user_id=1, event_type="generation_completed", client_event_id="e1",
                         provider_creation_id="new1", ownership_confidence="session", event_date=AUG31,
                         payload_json={"id": "new1", "created_at": at(AUG31).isoformat() + "Z", "status": "complete"})
db.add(event)
db.flush()
g = normalize_capture_event(db, event)
db.commit()
rec = db.get(GenerationRecord, g.generation_record_id)
check(g.credits_used == 5 and rec.credits_burned == 5, "a new capture (31 Aug) is priced 5 as it is normalized")

summary = P.summary(db)[0]
check(summary["tool"] == "Suno" and summary["unit"] == "song" and summary["currentCredits"] == 8
      and summary["generations"] == 7 and summary["firstGenerationDate"] == AUG17.isoformat()
      and [h["credits"] for h in summary["history"]] == [8, 5],
      f"summary for the admin screen: {summary['currentCredits']} now, history newest first")

# Admin API
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
r = client.get("/api/reports/credit-rates/generation-prices")
check(r.status_code == 200 and r.json()["tools"][0]["tool"] == "Suno", "GET lists Suno")
r = client.post("/api/reports/credit-rates/generation-prices",
                json={"tool": "Suno", "creditsPerGeneration": 10, "effectiveFrom": "2026-10-01"})
check(r.status_code == 200 and r.json()["generationsUpdated"] == 1, "POST a price from 1 Oct re-stamps 1 song")
pid = r.json()["priceId"]
check(client.post("/api/reports/credit-rates/generation-prices",
                  json={"tool": "Flow", "creditsPerGeneration": 1, "effectiveFrom": "2026-10-01"}).status_code == 400,
      "unknown tool is refused")
check(client.post("/api/reports/credit-rates/generation-prices",
                  json={"tool": "Suno", "creditsPerGeneration": -1, "effectiveFrom": "2026-10-01"}).status_code == 400,
      "negative credits are refused")
r = client.delete(f"/api/reports/credit-rates/generation-prices/{pid}")
check(r.status_code == 200 and r.json()["generationsUpdated"] == 1, "DELETE re-stamps that song")
who["admin"] = False
check(client.get("/api/reports/credit-rates/generation-prices").status_code == 403, "non-admins are refused")
print("\nALL GENERATION PRICING CHECKS PASSED")
