"""Smoke test for per-user section access (RMW Data / Buffer).

Covers the rules the Admin Queue -> Section Access tab depends on:
deny-by-default, grant, revoke, the admin bypass, and that the two
sections are independent of each other.

Run: backend/venv/Scripts/python.exe tests/feature_access_smoke.py
"""

import os
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, User, UserFeatureAccess, UserRole  # noqa: E402
from services.feature_access_service import (  # noqa: E402
    FEATURE_BUFFER,
    FEATURE_RMW_DATA,
    GATED_FEATURES,
    feature_access_map,
    granted_features,
    has_feature_access,
    normalize_feature,
    set_feature_access,
)


engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[User.__table__, UserRole.__table__, UserFeatureAccess.__table__],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _create_user(*, email: str, position: str = "employee", is_admin: bool = False) -> int:
    with SessionLocal() as db:
        user = User(
            email=email,
            name=email.split("@", 1)[0],
            hashed_password="hashed-password",
            is_active=True,
            is_deleted=False,
            is_admin=is_admin,
            position=position,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def _grant(user_id: int, feature: str, enabled: bool) -> None:
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == user_id).one()
        set_feature_access(db, user, feature, enabled, granted_by=None)
        db.commit()


def _reload(user_id: int) -> User:
    db = SessionLocal()
    return db.query(User).filter(User.id == user_id).one()


def test_denied_by_default() -> None:
    user_id = _create_user(email="default@example.com")
    user = _reload(user_id)
    _assert(granted_features(user) == [], "a new user should hold no grants")
    for feature in GATED_FEATURES:
        _assert(not has_feature_access(user, feature), f"{feature} should be denied by default")
    _assert(
        feature_access_map(user) == {FEATURE_RMW_DATA: False, FEATURE_BUFFER: False},
        "the serialized map should report both sections as hidden",
    )


def test_grant_then_revoke() -> None:
    user_id = _create_user(email="grantee@example.com")

    _grant(user_id, FEATURE_BUFFER, True)
    user = _reload(user_id)
    _assert(has_feature_access(user, FEATURE_BUFFER), "granted Buffer should be visible")
    _assert(
        not has_feature_access(user, FEATURE_RMW_DATA),
        "granting Buffer must not also grant RMW Data",
    )

    # Re-granting is idempotent: it must not create a second row that a
    # single revoke would then fail to clear.
    _grant(user_id, FEATURE_BUFFER, True)
    with SessionLocal() as db:
        rows = (
            db.query(UserFeatureAccess)
            .filter(UserFeatureAccess.user_id == user_id, UserFeatureAccess.feature == FEATURE_BUFFER)
            .count()
        )
    _assert(rows == 1, f"expected exactly one grant row, found {rows}")

    _grant(user_id, FEATURE_BUFFER, False)
    user = _reload(user_id)
    _assert(not has_feature_access(user, FEATURE_BUFFER), "revoked Buffer should be hidden again")

    # Revoking something never granted is a no-op, not an error.
    _grant(user_id, FEATURE_RMW_DATA, False)
    user = _reload(user_id)
    _assert(not has_feature_access(user, FEATURE_RMW_DATA), "RMW Data should still be hidden")


def test_both_sections_independent() -> None:
    user_id = _create_user(email="both@example.com")
    _grant(user_id, FEATURE_RMW_DATA, True)
    _grant(user_id, FEATURE_BUFFER, True)
    user = _reload(user_id)
    _assert(
        set(granted_features(user)) == set(GATED_FEATURES),
        "both sections should be granted",
    )

    _grant(user_id, FEATURE_RMW_DATA, False)
    user = _reload(user_id)
    _assert(not has_feature_access(user, FEATURE_RMW_DATA), "RMW Data revoked")
    _assert(has_feature_access(user, FEATURE_BUFFER), "Buffer must survive revoking RMW Data")


def test_admin_bypasses_grants() -> None:
    # The two ways utils.permissions.resolve_roles actually recognises an
    # admin: the is_admin column, and an explicit 'admin' role row.
    flag_admin_id = _create_user(email="admin-flag@example.com", is_admin=True)

    role_admin_id = _create_user(email="admin-role@example.com")
    with SessionLocal() as db:
        db.add(UserRole(user_id=role_admin_id, role="admin"))
        db.commit()

    for label, user_id in (("is_admin flag", flag_admin_id), ("admin role row", role_admin_id)):
        user = _reload(user_id)
        _assert(
            set(granted_features(user)) == set(GATED_FEATURES),
            f"{label}: should see every section with no grant rows",
        )
        _assert(
            feature_access_map(user) == {FEATURE_RMW_DATA: True, FEATURE_BUFFER: True},
            f"{label}: should serialize as fully granted",
        )


def test_position_admin_is_not_an_admin() -> None:
    """position="Admin" alone does NOT bypass the gate.

    Pins a real asymmetry rather than endorsing it: the frontend's
    normalizeRoles() treats a position containing "admin" as the admin
    role, while the backend's resolve_roles() only honours the is_admin
    column and explicit role rows. Access follows the backend, which is why
    usePermissions.can() reads the server's featureAccess for these
    sections instead of its own isAdmin - otherwise such a user would see
    the sidebar entry and then get a 403 from the API.
    """
    user_id = _create_user(email="position-admin@example.com", position="Admin")
    user = _reload(user_id)
    _assert(granted_features(user) == [], "a position-only 'admin' must still be gated")

    _grant(user_id, FEATURE_BUFFER, True)
    user = _reload(user_id)
    _assert(has_feature_access(user, FEATURE_BUFFER), "an explicit grant still works for them")


def test_unknown_feature_rejected() -> None:
    _assert(normalize_feature("nope") == "", "an unknown feature key should normalize away")
    _assert(normalize_feature("  BUFFER ") == FEATURE_BUFFER, "keys should be trimmed and lowercased")

    user_id = _create_user(email="unknown@example.com")
    user = _reload(user_id)
    _assert(not has_feature_access(user, "nope"), "an unknown feature is never accessible")

    raised = False
    with SessionLocal() as db:
        target = db.query(User).filter(User.id == user_id).one()
        try:
            set_feature_access(db, target, "nope", True)
        except ValueError:
            raised = True
    _assert(raised, "granting an unknown feature should raise ValueError")


def run() -> None:
    tests = [
        test_denied_by_default,
        test_grant_then_revoke,
        test_both_sections_independent,
        test_admin_bypasses_grants,
        test_position_admin_is_not_an_admin,
        test_unknown_feature_rejected,
    ]
    for test in tests:
        test()
        print(f"  ok  {test.__name__}")
    print(f"\nfeature access smoke: {len(tests)} passed")


if __name__ == "__main__":
    run()
