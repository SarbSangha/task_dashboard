# utils/generation_gate.py
"""
Resolves which ITPortalTool's launch ticket authenticates a pre-generation
Task/Client picker request.

A launch ticket is minted for one specific tool, so validating it against the
wrong ITPortalTool row fails outright - which surfaces in the picker as the
generic "Launch this tool from the dashboard..." 403. That is exactly the bug
this indirection exists to prevent: the endpoint used to resolve Freepik
regardless of caller, so Kling's picker 403'd even with a valid, active Kling
launch.

Lived as a verbatim copy in both routers/tasks_router.py and
routers/clients_router.py, each carrying a comment asking the reader to keep
the other in sync. Two copies of a security-adjacent resolver is one too many.
"""
from typing import Optional

from sqlalchemy.orm import Session

from models_new import ITPortalTool
from providers.envato.constants import TOOL_SLUGS as ENVATO_GATE_TOOL_SLUGS
from providers.freepik.constants import TOOL_SLUGS as FREEPIK_GATE_TOOL_SLUGS
from providers.heygen.constants import TOOL_SLUGS as HEYGEN_GATE_TOOL_SLUGS
from providers.higgsfield.constants import TOOL_SLUGS as HIGGSFIELD_GATE_TOOL_SLUGS
from utils.generation_backfill import KLING_TOOL_SLUGS as KLING_GATE_TOOL_SLUGS


def resolve_generation_gate_tool(db: Session, tool_slug: Optional[str]) -> Optional[ITPortalTool]:
    """Returns the active ITPortalTool whose ticket should authenticate this
    picker request. Defaults to Freepik - the original and, for a while, only
    caller - when tool_slug is omitted, so existing callers that don't send one
    keep working."""
    normalized = (tool_slug or "").strip().lower()
    if normalized in KLING_GATE_TOOL_SLUGS:
        slugs = KLING_GATE_TOOL_SLUGS
    elif normalized in HEYGEN_GATE_TOOL_SLUGS:
        slugs = HEYGEN_GATE_TOOL_SLUGS
    elif normalized in HIGGSFIELD_GATE_TOOL_SLUGS:
        slugs = HIGGSFIELD_GATE_TOOL_SLUGS
    elif normalized in ENVATO_GATE_TOOL_SLUGS:
        slugs = ENVATO_GATE_TOOL_SLUGS
    else:
        slugs = FREEPIK_GATE_TOOL_SLUGS
    return (
        db.query(ITPortalTool)
        .filter(ITPortalTool.slug.in_(tuple(slugs)))
        .filter(ITPortalTool.is_active == True)  # noqa: E712
        .first()
    )
