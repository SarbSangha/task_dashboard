from typing import Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User, UserRole


def normalize_roles(roles: Optional[Iterable[object]]) -> list[str]:
    normalized = {
        str(role).strip().lower()
        for role in (roles or [])
        if str(role).strip()
    }
    return sorted(normalized)


def user_role_names(user: Optional[User]) -> set[str]:
    roles: set[str] = set()
    if not user:
        return roles

    for assignment in getattr(user, "role_assignments", None) or []:
        role = str(getattr(assignment, "role", "")).strip().lower()
        if role:
            roles.add(role)

    if isinstance(user.roles_json, list):
        roles.update(normalize_roles(user.roles_json))

    return roles


def replace_user_roles(db: Session, user: User, roles: Optional[Iterable[object]]) -> None:
    normalized_roles = normalize_roles(roles)
    db.query(UserRole).filter(UserRole.user_id == user.id).delete(synchronize_session=False)
    for role in normalized_roles:
        db.add(UserRole(user_id=user.id, role=role))
    user.roles_json = normalized_roles


ADMIN_ROLE = "admin"
SUPER_ADMIN_ROLE = "super_admin"
# Roles that must never come from user input (e.g. the signup form) - only an
# admin action or the startup super-admin seed may hand these out.
PRIVILEGED_ROLES = frozenset({ADMIN_ROLE, SUPER_ADMIN_ROLE, "root"})


def strip_privileged_roles(roles: Optional[Iterable[object]]) -> list[str]:
    return [role for role in normalize_roles(roles) if role not in PRIVILEGED_ROLES]


def is_super_admin(user: Optional[User]) -> bool:
    return SUPER_ADMIN_ROLE in user_role_names(user)


def grant_role(db: Session, user: User, role: str) -> None:
    role = role.strip().lower()
    if not db.query(UserRole).filter(UserRole.user_id == user.id, UserRole.role == role).first():
        db.add(UserRole(user_id=user.id, role=role))
    current = normalize_roles(user.roles_json if isinstance(user.roles_json, list) else [])
    if role not in current:
        user.roles_json = normalize_roles([*current, role])
    db.expire(user, ["role_assignments"])


def revoke_role(db: Session, user: User, role: str) -> None:
    role = role.strip().lower()
    db.query(UserRole).filter(UserRole.user_id == user.id, UserRole.role == role).delete(synchronize_session=False)
    if isinstance(user.roles_json, list):
        user.roles_json = [r for r in normalize_roles(user.roles_json) if r != role]
    # Drop the stale relationship rows so user_role_names() reflects the
    # revoke within this same session.
    db.expire(user, ["role_assignments"])


def ensure_super_admin(db: Session, email: Optional[str] = None) -> Optional[User]:
    """Make sure the protected super-admin account holds its role.

    With an email configured, that account is (re)granted super_admin + admin
    on every startup. Without one, the role is seeded once onto the oldest
    existing admin and left alone after that. Nothing in the API can grant or
    revoke super_admin - change it in the database or via SUPER_ADMIN_EMAIL.
    """
    email = (email or "").strip().lower()
    if email:
        user = (
            db.query(User)
            .filter(func.lower(func.trim(User.email)) == email, User.is_deleted == False)  # noqa: E712
            .order_by(User.id.asc())
            .first()
        )
    else:
        if db.query(UserRole.id).filter(UserRole.role == SUPER_ADMIN_ROLE).first():
            return None
        user = (
            db.query(User)
            .outerjoin(UserRole, (UserRole.user_id == User.id) & (UserRole.role == ADMIN_ROLE))
            .filter(User.is_deleted == False, (User.is_admin == True) | (UserRole.id != None))  # noqa: E711,E712
            .order_by(User.id.asc())
            .first()
        )
    if not user:
        return None
    user.is_admin = True
    grant_role(db, user, ADMIN_ROLE)
    grant_role(db, user, SUPER_ADMIN_ROLE)
    return user
