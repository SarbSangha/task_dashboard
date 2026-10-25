"""Smoke test for granting admin access and the protected super admin.

Covers: the startup seed, an admin promoting/demoting another user, and that
nobody can remove, deactivate, delete or reset the password of the super
admin. Also checks self-signup cannot request privileged roles.

Run: backend/venv/Scripts/python.exe tests/super_admin_smoke.py
"""

import os
import sys
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, User, UserApprovalRequest, UserFeatureAccess, UserRole  # noqa: E402
import routers.admin_router as admin_router  # noqa: E402
from services.role_service import ensure_super_admin, is_super_admin, strip_privileged_roles  # noqa: E402
from utils.permissions import has_any_role  # noqa: E402


engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[User.__table__, UserRole.__table__, UserFeatureAccess.__table__, UserApprovalRequest.__table__],
)

# Realtime pushes and session revocation need the real infra - not under test.
admin_router.push_admin_realtime_event = lambda *args, **kwargs: None
admin_router.revoke_user_sessions = lambda *args, **kwargs: None


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _create_user(db, email: str, *, is_admin: bool = False, roles=None) -> User:
    user = User(
        email=email,
        name=email.split("@", 1)[0],
        hashed_password="hashed-password",
        is_active=True,
        is_deleted=False,
        is_admin=is_admin,
        position="employee",
        roles_json=roles or [],
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _expect_http(status: int, fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except HTTPException as exc:
        _assert(exc.status_code == status, f"expected {status}, got {exc.status_code}: {exc.detail}")
        return
    raise AssertionError(f"expected HTTP {status} from {fn.__name__}")


def _access(db, target: User, actor: User, enabled: bool) -> dict:
    return admin_router.set_user_admin_access(
        target.id, admin_router.AdminAccessPayload(enabled=enabled), current_user=actor, db=db
    )


def main() -> None:
    with SessionLocal() as db:
        root = _create_user(db, "root@example.com", is_admin=True, roles=["admin", "root"])
        alice = _create_user(db, "alice@example.com")
        bob = _create_user(db, "bob@example.com")

        # Seed without an email picks the oldest admin, then stays put.
        seeded = ensure_super_admin(db)
        db.commit()
        _assert(seeded is not None and seeded.id == root.id, "oldest admin should be seeded as super admin")
        _assert(ensure_super_admin(db) is None, "seed should be a no-op once a super admin exists")
        db.refresh(root)
        _assert(is_super_admin(root), "root should be super admin")

        # Super admin promotes alice; alice is now a full admin.
        res = _access(db, alice, root, True)
        _assert(res["user"]["isAdmin"] and not res["user"]["isSuperAdmin"], "alice should be a plain admin")
        db.refresh(alice)
        _assert(has_any_role(alice, {"admin"}), "alice should pass admin checks")

        # Alice (admin) can promote bob, but cannot touch the super admin.
        _access(db, bob, alice, True)
        _expect_http(403, _access, db, root, alice, False)
        _expect_http(403, admin_router.deactivate_user, root.id, None, current_user=alice, db=db)
        _expect_http(403, admin_router.delete_user_account, root.id, None, current_user=alice, db=db)
        _expect_http(
            403,
            admin_router.admin_change_user_password,
            root.id,
            admin_router.AdminPasswordChangePayload(new_password="NewPassword@1"),
            current_user=alice,
            db=db,
        )
        # Even the super admin cannot demote themselves.
        _expect_http(403, _access, db, root, root, False)
        # An admin cannot demote themselves either.
        _expect_http(400, _access, db, alice, alice, False)

        # Alice demotes bob: every trace of admin is gone.
        res = _access(db, bob, alice, False)
        db.refresh(bob)
        _assert(not res["user"]["isAdmin"], "bob should no longer be admin")
        _assert(not has_any_role(bob, {"admin"}), "bob must fail admin checks after revoke")
        _assert(
            db.query(UserRole).filter(UserRole.user_id == bob.id, UserRole.role == "admin").count() == 0,
            "bob's admin role row should be deleted",
        )

        # Super admin can still demote alice.
        _access(db, alice, root, False)
        db.refresh(alice)
        _assert(not has_any_role(alice, {"admin"}), "alice should be demoted")

        db.refresh(root)
        _assert(is_super_admin(root) and has_any_role(root, {"admin"}), "super admin should be untouched")

        # Configured email wins and is (re)granted on startup.
        ensure_super_admin(db, " BOB@example.com ")
        db.commit()
        db.refresh(bob)
        _assert(is_super_admin(bob) and bob.is_admin, "configured email should become super admin")

    _assert(
        strip_privileged_roles(["Admin", "super_admin", "root", "hod"]) == ["hod"],
        "signup must not be able to request privileged roles",
    )
    print("super_admin_smoke: OK")


if __name__ == "__main__":
    main()
