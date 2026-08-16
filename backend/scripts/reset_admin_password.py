"""
One-off admin password recovery: bypasses the API's own
POST /admin/users/{id}/password endpoint (which requires an already-logged-in
admin) by writing the new hash directly, for when the admin account itself is
what's locked out. Mirrors that endpoint's own logic (get_password_hash +
revoke_user_sessions) so the result is indistinguishable from a normal
admin-initiated change.

Usage (from backend/):
    python scripts/reset_admin_password.py "NewAdminPass@1234"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from auth import get_password_hash, revoke_user_sessions  # noqa: E402
from database_config import OperationalSessionLocal  # noqa: E402
from models_new import User  # noqa: E402
from services.role_service import user_role_names  # noqa: E402


def is_admin_user(user: User) -> bool:
    # Admin status can come from the legacy is_admin column OR a UserRole /
    # roles_json entry (see utils/permissions.py's resolve_roles) - check
    # both, same as the real authorization path does.
    return bool(getattr(user, "is_admin", False)) or "admin" in user_role_names(user)


def main():
    if len(sys.argv) != 2:
        print("Usage: python scripts/reset_admin_password.py <new_password>")
        sys.exit(1)

    new_password = sys.argv[1]
    if len(new_password) < 8:
        print("Password must be at least 8 characters.")
        sys.exit(1)

    db = OperationalSessionLocal()
    try:
        candidates = db.query(User).filter(User.is_deleted == False).all()  # noqa: E712
        admins = [u for u in candidates if is_admin_user(u)]
        if not admins:
            print("No active admin user found.")
            sys.exit(1)
        if len(admins) > 1:
            print("Multiple admin users found - re-run targeting one by email:")
            for u in admins:
                print(f"  id={u.id} email={u.email} name={u.name}")
            sys.exit(1)

        user = admins[0]
        user.hashed_password = get_password_hash(new_password)
        revoke_user_sessions(db, user.id)
        db.commit()
        print(f"Password updated for admin: id={user.id} email={user.email} name={user.name}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
