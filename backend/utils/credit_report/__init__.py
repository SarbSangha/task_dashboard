"""
Credit Consumption Report: a multi-sheet Excel export of who used which
tool, for which client, and how many credits it cost.

    from utils.credit_report import ReportFilters, generate_report

    filters = ReportFilters.build(start="2026-10-01", end="2026-10-07")
    model = generate_report(db, filters, "/tmp/report.xlsx", dashboard_url="https://dash.example.com")

Two versions (generate_report's ``version``):
    "full"        Summary, Team & Clients, Glossary, a Details divider, then
                  every detail sheet down to the Generation Log
    "management"  Summary, Team & Clients and Glossary only - no prompts,
                  outputs or log; small enough to email (and to_pdf() it)

Layers:
    facts.py      - UNION ALL of every tool's generation table, charge status,
                    rupee cost (costing.py), Kling double recording (dedupe.py),
                    clean names (display.py), GROUP BY totals, the streamed log
    model.py      - department / user / tool / client / month summaries, ranks, ties
    management.py - the rupee view for managers, this period vs the one before
    insights.py   - the Summary's sentences, each only when its condition holds
    workbook.py   - openpyxl write-only rendering with cross-sheet links
    workbook_summary.py - Summary, Team & Clients, Glossary, Details
"""

import os
import shutil
import subprocess
import tempfile
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
    load_upload_count,
    prepare,
    resolve_excluded_accounts,
    resolve_output_url,
    stream_log,
)
from .blocks import build_blocks  # noqa: F401
from .management import ManagementView, build_management, last_full_month, previous_period  # noqa: F401
from .model import ReportModel, build_model  # noqa: F401
from .workbook import (FIRST_DATA_ROW, XLSX_MIMETYPE, duplicate_ids, duplicate_summary, report_filename,  # noqa: F401
                       write_workbook)
from .workbook_summary import write_management_workbook  # noqa: F401

PUBLIC_DASHBOARD_URL_ENV = "PUBLIC_DASHBOARD_URL"
FULL = "full"
MANAGEMENT = "management"
VERSIONS = (FULL, MANAGEMENT)
PDF_MIMETYPE = "application/pdf"
SOFFICE_CANDIDATES = (
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/lib/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)


SOFFICE_ENV = "CREDIT_REPORT_SOFFICE"        # full path to soffice(.exe), for a non-standard install


def soffice_path() -> Optional[str]:
    configured = (os.getenv(SOFFICE_ENV) or "").strip()
    if configured and os.path.exists(configured):
        return configured
    for path in SOFFICE_CANDIDATES:
        if os.path.exists(path):
            return path
    return shutil.which("soffice") or shutil.which("libreoffice")


class PdfUnavailable(RuntimeError):
    """LibreOffice is not installed, so the PDF cannot be made."""


def to_pdf(xlsx_path: str, pdf_path: str, timeout: int = 180) -> str:
    """Print a workbook to PDF with LibreOffice (headless), using each
    sheet's page setup (the Summary prints on one A4 landscape page)."""
    soffice = soffice_path()
    if not soffice:
        raise PdfUnavailable("LibreOffice is not installed on this server")
    out_dir = tempfile.mkdtemp(prefix="credit-report-pdf-")
    profile = tempfile.mkdtemp(prefix="credit-report-lo-")
    try:
        subprocess.run([soffice, f"-env:UserInstallation=file:///{profile.replace(os.sep, '/')}", "--headless",
                        "--convert-to", "pdf", "--outdir", out_dir, xlsx_path],
                       check=True, timeout=timeout, capture_output=True)
        produced = os.path.join(out_dir, os.path.splitext(os.path.basename(xlsx_path))[0] + ".pdf")
        shutil.move(produced, pdf_path)
        return pdf_path
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


def public_dashboard_url() -> Optional[str]:
    """The address colleagues open the dashboard on - the base of every
    Generation Log "Open output" link. PUBLIC_DASHBOARD_URL wins; otherwise
    FRONTEND_URL (the same value password-reset emails link to)."""
    for name in (PUBLIC_DASHBOARD_URL_ENV, "FRONTEND_URL"):
        value = (os.getenv(name) or "").strip().rstrip("/")
        if value.startswith(("http://", "https://")):
            return value
    return None


def generate_report(db: Session, filters: ReportFilters, path: str, *, dashboard_url: str = "",
                    version: str = FULL, management: bool = True) -> ReportModel:
    """Run the aggregate queries, then stream the log straight into the file.

    version "management" writes only the management sheets. ``management``
    False leaves them out of the full version (the detail workbook alone)."""
    prepare(db, filters)
    groups = load_groups(db, filters)
    model = build_model(groups, load_excluded_summary(db, filters))
    # Possible double charges are found in time order first: the log's own
    # order (user, tool, day, client, time) can put the two rows of a pair apart.
    duplicates, dup_rows, dup_rupees = duplicate_summary(stream_log(db, filters, model.log_user_order))
    view = None
    if management or version == MANAGEMENT:
        view = build_management(db, filters, groups, duplicates=dup_rows, duplicate_rupees=dup_rupees)
    model.management = view
    if version == MANAGEMENT:
        write_management_workbook(path, view)
        return model
    # Day-level groups lay out the By User / By Tool blocks and the log's
    # order (user -> tool -> newest first) before the log is streamed.
    blocks = build_blocks(load_day_groups(db, filters), model.log_user_order, FIRST_DATA_ROW,
                          client_order=[c.name for c in model.clients])
    log = stream_log(db, filters, model.log_user_order, tool_order=blocks.log.tool_order,
                     client_order=blocks.log.client_order)
    model.log_stats = write_workbook(path, model, filters, log, dashboard_url=dashboard_url, blocks=blocks,
                                     duplicates=duplicates, management=view, uploads=load_upload_count(db, filters))
    return model
