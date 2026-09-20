"""Per-user access to sidebar sections that are hidden unless granted.

Two things make this different from utils/permissions.py role checks:

* it is **deny-by-default** - a user sees a gated section only if an admin
  created a `user_feature_access` row for them, so a brand new account and a
  revoked account look identical (no row);
* it is **per user, not per role** - the whole point is granting Buffer to
  one person in a department without granting it to the department.

Admins bypass the table completely, matching how the workplace policy
refuses to apply to administrators - it keeps an admin from hiding the
admin-facing sections from themselves.
"""

import logging
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from models_new import User, UserFeatureAccess
from utils.permissions import has_any_role


#: Canonical feature keys. The frontend mirrors these in
#: my-dashboard/src/hooks/usePermissions.js - keep the two lists in step.
FEATURE_RMW_DATA = "rmw_data"
FEATURE_BUFFER = "buffer"

GATED_FEATURES: tuple[str, ...] = (FEATURE_RMW_DATA, FEATURE_BUFFER)

logger = logging.getLogger(__name__)

#: Labels used in admin notifications/audit text.
FEATURE_LABELS = {
    FEATURE_RMW_DATA: "RMW Data",
    FEATURE_BUFFER: "Buffer",
}


def normalize_feature(feature: object) -> str:
    value = str(feature or "").strip().lower()
    return value if value in GATED_FEATURES else ""


def normalize_features(features: Optional[Iterable[object]]) -> list[str]:
    seen = {normalize_feature(f) for f in (features or [])}
    seen.discard("")
    return [f for f in GATED_FEATURES if f in seen]


def is_feature_exempt(user: Optional[User]) -> bool:
    """Admins are never gated by this table."""
    return bool(user) and has_any_role(user, {"admin"})


def granted_features(user: Optional[User]) -> list[str]:
    """Features this user may see, honouring the admin bypass.

    Reads the already-loaded `feature_grants` relationship so serializing a
    page of users does not fire a query per row.
    """
    if not user:
        return []
    if is_feature_exempt(user):
        return list(GATED_FEATURES)

    granted = set()
    for grant in getattr(user, "feature_grants", None) or []:
        feature = normalize_feature(getattr(grant, "feature", ""))
        if feature:
            granted.add(feature)
    return [f for f in GATED_FEATURES if f in granted]


def feature_access_map(user: Optional[User]) -> dict:
    """`{"rmw_data": bool, "buffer": bool}` - the shape the frontend reads."""
    granted = set(granted_features(user))
    return {feature: feature in granted for feature in GATED_FEATURES}


def has_feature_access(user: Optional[User], feature: str) -> bool:
    normalized = normalize_feature(feature)
    if not normalized:
        return False
    return normalized in set(granted_features(user))


def notify_feature_access_changed(user_ids: Iterable[int], feature: str, enabled: bool) -> None:
    """Tell the affected users their sidebar changed, so they need not reload.

    AuthContext.checkAuth() runs once on mount and is never re-run on a
    timer, so without this a revoked user keeps seeing the sidebar entry
    until they refresh the page - clicking it would open a panel whose API
    calls now 403. The data is safe either way (FeatureChecker reads the
    table live, with no caching), but the stale menu item is a visible bug.

    Best-effort by design: this is a UI nudge, not the enforcement, so a
    full queue or a disconnected socket is logged and swallowed rather than
    failing the admin's write, which has already been committed.
    """
    from routers.tasks_router import notification_dispatcher

    payload = {
        "eventType": "user_feature_access_changed",
        "title": "Section access updated",
        "message": (
            f"{FEATURE_LABELS.get(feature, feature)} was "
            f"{'granted to' if enabled else 'removed from'} your account."
        ),
        "metadata": {"feature": feature, "enabled": bool(enabled)},
    }
    for user_id in user_ids:
        try:
            notification_dispatcher.enqueue(int(user_id), payload)
        except Exception:  # pragma: no cover - depends on runtime infra
            logger.exception("Failed to notify user_id=%s of feature access change", user_id)


def set_feature_access(
    db: Session,
    user: User,
    feature: str,
    enabled: bool,
    granted_by: Optional[int] = None,
) -> bool:
    """Create or delete the grant row. Returns the resulting state.

    Does not commit - the caller owns the transaction so a bulk update stays
    a single commit.
    """
    normalized = normalize_feature(feature)
    if not normalized:
        raise ValueError(f"Unknown feature: {feature!r}")

    existing = (
        db.query(UserFeatureAccess)
        .filter(
            UserFeatureAccess.user_id == user.id,
            UserFeatureAccess.feature == normalized,
        )
        .first()
    )

    if enabled and not existing:
        db.add(
            UserFeatureAccess(
                user_id=user.id,
                feature=normalized,
                granted_by=granted_by,
            )
        )
    elif not enabled and existing:
        db.delete(existing)

    return bool(enabled)
