from typing import Iterable, Optional

from fastapi import Cookie, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from auth import get_request_session_token, verify_session_token
from database_config import get_operational_db
from models_new import User


def resolve_roles(user: Optional[User]) -> set[str]:
    roles = set()
    if user and isinstance(user.roles_json, list):
        roles.update({str(role).strip().lower() for role in user.roles_json if str(role).strip()})

    position = (user.position or "").strip().lower() if user else ""
    if user and getattr(user, "is_admin", False):
        roles.add("admin")
    if "admin" in position:
        roles.add("admin")
    if "faculty" in position:
        roles.add("faculty")
    if "hod" in position or "head of department" in position:
        roles.add("hod")
    if "spoc" in position:
        roles.add("spoc")
    if "employee" in position or "user" in position:
        roles.add("employee")

    if "employee" in roles or "hod" in roles or "spoc" in roles:
        roles.add("user")
    if "faculty" in roles:
        roles.add("user")

    return roles


def has_any_role(user: Optional[User], allowed_roles: Iterable[str]) -> bool:
    normalized_allowed = {str(role).strip().lower() for role in allowed_roles if str(role).strip()}
    if not normalized_allowed:
        return True
    return bool(resolve_roles(user).intersection(normalized_allowed))


def get_current_user(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db),
):
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_id = verify_session_token(resolved_session_id, db)
    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=401, detail="Account has been deleted")

    return user


class RoleChecker:
    def __init__(self, allowed_roles: list[str]):
        self.allowed_roles = [str(role).strip().lower() for role in allowed_roles if str(role).strip()]

    def __call__(self, user: User = Depends(get_current_user)):
        if not has_any_role(user, self.allowed_roles):
            raise HTTPException(status_code=403, detail="Access denied")
        return user


require_admin = RoleChecker(["admin"])
require_faculty = RoleChecker(["admin", "faculty"])
require_user = RoleChecker(["admin", "faculty", "user"])
