"""A deleted user's tool seats and single-seat locks are released.

Run from backend/:  python tests/deleted_user_tool_access_smoke.py

Checks, on an in-memory SQLite database:
  * release_tool_access closes the user's seats (audited) and frees a lock
    they hold, leaving other users alone;
  * release_deleted_users_tool_access sweeps users deleted earlier;
  * saving a login's assignments with a deleted user still in the list
    drops that user instead of refusing the whole save.
"""

import os
import sys
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from models_new import Base, ITPortalTool, ITPortalToolAudit, ITPortalToolCredential, User  # noqa: E402
from routers.it_tools_router import _apply_shared_credential_assignments  # noqa: E402
from services.tool_access_cleanup import release_deleted_users_tool_access, release_tool_access  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in (User, ITPortalTool, ITPortalToolCredential,
                                                                     ITPortalToolAudit)])


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


db = SessionLocal()
for uid, name in ((1, "Admin"), (2, "Ajmer"), (3, "Bela"), (4, "Old")):
    db.add(User(id=uid, email=f"u{uid}@x.com", name=name, hashed_password="x", is_active=True, position="employee"))
db.add(ITPortalTool(id=10, name="ChatGPT", slug="chatgpt", website_url="https://chatgpt.com", single_seat=True,
                    active_session_user_id=2, active_session_started_at=datetime.utcnow()))
db.add(ITPortalTool(id=11, name="Envato", slug="envato", website_url="https://envato.com"))
db.add(ITPortalToolCredential(id=100, tool_id=10, scope="company", is_active=True))
for seat_id, tool_id, uid in ((200, 10, 2), (201, 11, 2), (202, 10, 3), (203, 10, 4)):
    db.add(ITPortalToolCredential(id=seat_id, tool_id=tool_id, scope="user", user_id=uid,
                                  linked_credential_id=100 if tool_id == 10 else None, is_active=True))
db.commit()


def seat(seat_id):
    db.expire_all()
    return db.get(ITPortalToolCredential, seat_id).is_active


check(release_tool_access(db, 2, 1) == 2, "deleting Ajmer closes both of his seats")
db.commit()
tool = db.get(ITPortalTool, 10)
check(not seat(200) and not seat(201) and seat(202) and seat(203), "only Ajmer's seats closed")
check(tool.active_session_user_id is None and tool.active_session_started_at is None, "his ChatGPT lock is freed")
audits = db.query(ITPortalToolAudit).filter(ITPortalToolAudit.action == "credential_unassigned_user_deleted").all()
check(len(audits) == 2 and {a.target_user_id for a in audits} == {2} and {a.actor_id for a in audits} == {1},
      "each closed seat is audited, by the admin who deleted him")

# A user deleted before the cleanup existed: swept at startup.
old = db.get(User, 4)
old.is_deleted, old.deleted_by = True, 1
db.commit()
check(release_deleted_users_tool_access(db) == 1 and not seat(203) and seat(202), "startup sweep closes Old's seat")
db.commit()
check(release_deleted_users_tool_access(db) == 0, "sweep is a no-op once clean")

# Saving the login's assignments with a deleted user still on screen.
ajmer = db.get(User, 2)
ajmer.is_deleted = True
db.commit()
_apply_shared_credential_assignments(db, tool_id=10, credential=db.get(ITPortalToolCredential, 100),
                                     assigned_user_ids=[2, 3, 4], actor_id=1)
db.commit()
active = {c.user_id for c in db.query(ITPortalToolCredential).filter(
    ITPortalToolCredential.tool_id == 10, ITPortalToolCredential.scope == "user", ITPortalToolCredential.is_active == True)}
check(active == {3}, "save with deleted users in the list succeeds and keeps only Bela")
print("\nALL DELETED-USER TOOL ACCESS CHECKS PASSED")
