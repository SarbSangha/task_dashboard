"""The per-request session lookup leaves the avatar out; it still loads on use.

Run from backend/:  python tests/session_avatar_smoke.py

Checks, on an in-memory SQLite database:
  * resolve_session_user returns the user without reading the avatar column;
  * reading user.avatar afterwards (as /me and /avatar do) loads it in full;
  * GET /api/auth/avatar and /api/auth/me still answer for that session.
"""

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, event, inspect  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from auth import create_session_fingerprint, create_session_token, resolve_session_user  # noqa: E402
from models_new import Base  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)

AVATAR = "data:image/png;base64," + "A" * 200_000


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


from models_new import User  # noqa: E402

db = SessionLocal()
db.add(User(id=7, email="pic@x.com", name="Pic", hashed_password="x", is_active=True, position="employee",
            avatar=AVATAR))
db.commit()
db.close()

UA = "smoke-test-agent"
token = create_session_token(7, create_session_fingerprint(UA))

statements = []


@event.listens_for(engine, "before_cursor_execute")
def _log(_conn, _cursor, statement, *_args):
    statements.append(statement)


db = SessionLocal()
user = resolve_session_user(token, db, session_fingerprint=create_session_fingerprint(UA))
check(user is not None and user.id == 7, "session resolves to the user")
check("avatar" in inspect(user).unloaded and not any("avatar" in s for s in statements),
      "the lookup does not read the avatar column")
check(user.avatar == AVATAR, "reading user.avatar loads it in full")
db.close()

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
from database_config import get_operational_db  # noqa: E402


def _db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


main.app.dependency_overrides[get_operational_db] = _db
client = TestClient(main.app)
headers = {"X-Session-Id": token, "User-Agent": UA}
r = client.get("/api/auth/avatar", headers=headers)
check(r.status_code == 200 and r.json()["avatar"] == AVATAR and r.json()["hasAvatar"] is True,
      "GET /api/auth/avatar returns the avatar")
r = client.get("/api/auth/me?fresh=1", headers=headers)
check(r.status_code == 200 and r.json()["user"]["id"] == 7, "GET /api/auth/me answers for the session")
print("\nALL SESSION AVATAR CHECKS PASSED")
