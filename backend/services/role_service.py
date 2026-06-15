from typing import Iterable, Optional

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
