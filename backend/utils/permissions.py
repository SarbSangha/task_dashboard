from typing import Iterable, Optional

from fastapi import Cookie, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from auth import create_session_fingerprint, get_request_session_token, resolve_session_user
from database_config import get_operational_db
from models_new import User
from services.role_service import user_role_names


def resolve_roles(user: Optional[User]) -> set[str]:
    roles = user_role_names(user)

    position = (user.position or "").strip().lower() if user else ""
    if user and getattr(user, "is_admin", False):
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

    # Any valid, authenticated user is at minimum a "user" - everything above
    # only ever ADDS a more specific role (admin/faculty/hod/spoc) on top of
    # that baseline; it was never meant to be the only way to earn it. A
    # position value that doesn't contain any of the recognized substrings
    # (e.g. "NORMAL", or any other free-text value HR might use) previously
    # fell through with zero roles at all, so require_user
    # (RoleChecker(["admin", "faculty", "user"])) - despite its own name
    # meaning "any logged-in user" - rejected them with a flat 403. Confirmed
    # in production: an employee with position="NORMAL" and no roles_json
    # entries got 403 on every require_user-gated endpoint (ChatGPT
    # capture's /events, /health, /media) while other endpoints using a
    # different auth dependency (get_current_user_from_session,
    # get_current_user_with_workplace_tools_access, or no role check at all)
    # worked fine for that exact same session - proving this was an
    # authorization gap, not a session/authentication problem.
    if user:
        roles.add("user")

    return roles


def has_any_role(user: Optional[User], allowed_roles: Iterable[str]) -> bool:
    normalized_allowed = {str(role).strip().lower() for role in allowed_roles if str(role).strip()}
    if not normalized_allowed:
        return True
    return bool(resolve_roles(user).intersection(normalized_allowed))


def get_current_user(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db),
):
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return resolve_session_user(
        resolved_session_id,
        db,
        session_fingerprint=create_session_fingerprint(request.headers.get("user-agent")),
    )


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
