"""
Usage Intelligence reporting.

Management-facing usage reporting built on the same grain as the AI-usage
workbook, so the live dashboard and the Excel download never disagree. Two
report shapes come out of one snapshot: an organisation/team pack (13 sheets)
and a single-tab individual briefing for a team lead to walk through.

Public entry points::

    from utils.usage_intelligence import build_snapshot, build_usage_workbook

    snapshot = build_snapshot(db, preset="last_30_days")
    data, mimetype, filename = build_usage_workbook(snapshot)

``build_usage_workbook`` picks the layout from the snapshot itself: a snapshot
carrying ``individual`` (or ``reportType == "individual"``) renders the person
briefing, anything else renders the full pack.

Privacy: prompt and response text is never selected into a snapshot, and so
never reaches a workbook.
"""

from .service import METHODOLOGY, build_snapshot, build_tool_login_report, directory, resolve_period  # noqa: F401
from .workbook import XLSX_MIMETYPE, build_tool_login_workbook, build_usage_workbook  # noqa: F401

__all__ = [
    "METHODOLOGY",
    "build_snapshot",
    "build_tool_login_report",
    "directory",
    "resolve_period",
    "build_usage_workbook",
    "build_tool_login_workbook",
    "XLSX_MIMETYPE",
]
