"""Recent clients in the pre-generation Client picker, per logged-in user.

Run from backend/:  python tests/recent_clients_smoke.py

One Chrome profile is often shared by several people, so the picker's Recent
group comes from the server (utils/client_gate.get_recent_client_ids): each
user's own latest picks across every tool's capture-event table.
"""

import importlib
import os
import pkgutil
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

import providers  # noqa: E402
from models_new import GenerationClient, ITPortalTool, ITPortalToolUsageEvent, User  # noqa: E402

for module in pkgutil.iter_modules(providers.__path__):
    try:
        importlib.import_module(f"providers.{module.name}.models")
    except ModuleNotFoundError:
        pass
from providers.freepik.models import FreepikCaptureEvent  # noqa: E402
from utils.client_gate import _client_pick_tables, get_recent_client_ids  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
TABLES = [User.__table__, GenerationClient.__table__, ITPortalTool.__table__,
          ITPortalToolUsageEvent.__table__, FreepikCaptureEvent.__table__]
for table in TABLES + _client_pick_tables():
    table.create(bind=engine, checkfirst=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


names = {table.name for table in _client_pick_tables()}
check({"it_portal_tool_usage_events", "freepik_capture_events", "flow_capture_events", "heygen_capture_events"} <= names,
      f"picks are read from every tool's capture table ({len(names)} found)")

now = datetime.utcnow()
with SessionLocal() as db:
    nikhil = User(email="nikhil@example.com", name="Nikhil", hashed_password="x")
    divya = User(email="divya@example.com", name="Divya", hashed_password="x")
    tool = ITPortalTool(name="Kling", slug="kling-ai", category="AI", website_url="https://kling.ai")
    db.add_all([nikhil, divya, tool])
    db.flush()
    clients = {name: GenerationClient(name=name, is_active=True) for name in ["RMW", "RISLAND", "GHD", "Acme", "Old Co"]}
    db.add_all(clients.values())
    db.flush()

    def kling_pick(user, client, minutes_ago):
        db.add(ITPortalToolUsageEvent(
            tool_id=tool.id, user_id=user.id, event_type="generate_click", event_date=now.date(), status="settled",
            linked_client_id=client.id if client else None, created_at=now - timedelta(minutes=minutes_ago),
        ))

    kling_pick(nikhil, clients["RMW"], 60)
    kling_pick(nikhil, clients["RISLAND"], 30)
    kling_pick(nikhil, clients["RMW"], 5)        # RMW again - now the most recent
    kling_pick(nikhil, None, 1)                  # a click with no client chosen
    kling_pick(nikhil, clients["Old Co"], 60 * 24 * 120)  # outside the lookback
    kling_pick(divya, clients["Acme"], 2)        # same browser, different person
    db.add(FreepikCaptureEvent(
        provider="freepik", tool_id=tool.id, user_id=nikhil.id, linked_client_id=clients["GHD"].id,
        client_event_id="evt-1", event_type="generate_click", payload_json={}, event_date=now.date(),
        created_at=now - timedelta(minutes=10),
    ))
    db.commit()
    ids = {name: client.id for name, client in clients.items()}
    nikhil_id, divya_id = nikhil.id, divya.id

with SessionLocal() as db:
    nikhil_recent = get_recent_client_ids(db, nikhil_id)
    divya_recent = get_recent_client_ids(db, divya_id)
    check(nikhil_recent == [ids["RMW"], ids["GHD"], ids["RISLAND"]],
          "Nikhil: newest first across Kling and Freepik, each client once")
    check(ids["Old Co"] not in nikhil_recent, "picks older than the lookback are left out")
    check(divya_recent == [ids["Acme"]], "Divya sees only her own pick, not Nikhil's")
    check(get_recent_client_ids(db, None) == [], "no user, no recent clients")

print("\nALL RECENT CLIENT CHECKS PASSED")
