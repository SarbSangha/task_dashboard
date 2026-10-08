"""
Credit Consumption Report: a multi-sheet Excel export of who used which
tool, for which client, and how many credits it cost.

    from utils.credit_report import ReportFilters, generate_report

    filters = ReportFilters.build(start="2026-10-01", end="2026-10-07")
    model = generate_report(db, filters, "/tmp/report.xlsx", dashboard_url="https://dash.example.com")

Layers:
    facts.py     - UNION ALL of every tool's generation table, charge status,
                   GROUP BY totals, the streamed Generation Log query
    model.py     - department / user / tool / client / month summaries, ranks, ties
    workbook.py  - openpyxl write-only rendering with cross-sheet links
"""

import os
from typing import Optional

from sqlalchemy.orm import Session

from .facts import (  # noqa: F401
    CHARGED,
    CHARGE_STATUSES,
    FAILED,
    NO_CLIENT,
    PENDING,
    TOOL_NAMES,
    UNASSIGNED,
    UNASSIGNED_DEPARTMENT,
    UNASSIGNED_USER_ID,
    ReportFilters,
    charge_status,
    load_excluded_summary,
    load_day_groups,
    load_groups,
    load_options,
    resolve_excluded_accounts,
    resolve_output_url,
    stream_log,
)
from .blocks import build_blocks  # noqa: F401
from .model import ReportModel, build_model  # noqa: F401
from .workbook import FIRST_DATA_ROW, XLSX_MIMETYPE, duplicate_ids, report_filename, write_workbook  # noqa: F401

PUBLIC_DASHBOARD_URL_ENV = "PUBLIC_DASHBOARD_URL"


def public_dashboard_url() -> Optional[str]:
    """The address colleagues open the dashboard on - the base of every
    Generation Log "Open output" link. PUBLIC_DASHBOARD_URL wins; otherwise
    FRONTEND_URL (the same value password-reset emails link to)."""
    for name in (PUBLIC_DASHBOARD_URL_ENV, "FRONTEND_URL"):
        value = (os.getenv(name) or "").strip().rstrip("/")
        if value.startswith(("http://", "https://")):
            return value
    return None


def generate_report(db: Session, filters: ReportFilters, path: str, *, dashboard_url: str = "") -> ReportModel:
    """Run the aggregate queries, then stream the log straight into the file."""
    if filters.exclude_test_accounts and not filters.excluded_accounts:
        filters.excluded_accounts = resolve_excluded_accounts(db)
    model = build_model(load_groups(db, filters), load_excluded_summary(db, filters))
    # Day-level groups lay out the By User / By Tool blocks and the log's
    # order (user -> tool -> newest first) before the log is streamed.
    blocks = build_blocks(load_day_groups(db, filters), model.log_user_order, FIRST_DATA_ROW,
                          client_order=[c.name for c in model.clients])
    # Possible duplicates are found in time order first: the log's own order
    # (user, tool, day, client, time) can put the two rows of a pair apart.
    duplicates = duplicate_ids(stream_log(db, filters, model.log_user_order))
    log = stream_log(db, filters, model.log_user_order, tool_order=blocks.log.tool_order,
                     client_order=blocks.log.client_order)
    model.log_stats = write_workbook(path, model, filters, log, dashboard_url=dashboard_url, blocks=blocks,
                                     duplicates=duplicates)
    return model
