"""
Credit Consumption Report API (Testing Report sidebar section).

Exporting is a per-user grant managed in Admin Queue -> Section Access
(feature key "credit_report"); admins always have it. Opening a Generation
Log output link only needs a signed-in account: the link lands on the
dashboard (/dashboard/open-output?ref=Tool:id), which calls /output here
and forwards the browser to the file. All endpoints are read-only.
"""

import logging
import os
import tempfile
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from database_config import OperationalSessionLocal, get_operational_db
from models_new import User
from utils.credit_report import (
    MANAGEMENT,
    PDF_MIMETYPE,
    TOOL_NAMES,
    UNASSIGNED_USER_ID,
    VERSIONS,
    XLSX_MIMETYPE,
    PdfUnavailable,
    ReportFilters,
    generate_report,
    last_full_month,
    load_options,
    public_dashboard_url,
    report_filename,
    resolve_output_url,
    to_pdf,
)

IST_OFFSET_MINUTES = 330
from utils.permissions import require_credit_report_access, require_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reports/credit", tags=["Credit Report"])


def _parse_iso_date(value: Optional[str], name: str) -> Optional[str]:
    if value in (None, ""):
        return None
    try:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{name} must be a date in YYYY-MM-DD format")


REPORT_DB_ENV = "CREDIT_REPORT_DATABASE_URL"   # a SELECT-only role (report_ro); unset = the app's connection
_report_engine = None


def _report_bind():
    """The export's own connection: the read-only report role when configured."""
    global _report_engine
    url = (os.getenv(REPORT_DB_ENV) or "").strip()
    if not url:
        return OperationalSessionLocal.kw["bind"]
    if _report_engine is None:
        from database_config import _create_engine
        _report_engine = _create_engine(url)
    return _report_engine


def _snapshot_session() -> Session:
    """A read-only session whose every query sees one consistent snapshot,
    so the summary sheets and the streamed Generation Log can never disagree
    when new generations land mid-export.

    database_config's connect hook runs SET statements on each new
    connection and leaves that implicit transaction open, so neither an
    isolation-level execution option (psycopg refuses to toggle autocommit
    mid-transaction) nor a session-level SET (lost behind Supabase's
    transaction pooler) works. Instead: end the hook's transaction, then make
    SET TRANSACTION the first statement of the export's own transaction.
    """
    bind = _report_bind()
    if bind.dialect.name != "postgresql":
        return Session(bind=bind, autoflush=False)
    conn = bind.connect()
    try:
        conn.connection.dbapi_connection.commit()
        conn.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    except Exception:
        conn.close()
        raise
    db = Session(bind=conn, autoflush=False)
    db.info["snapshot_connection"] = conn
    return db


def _close_snapshot(db: Session) -> None:
    conn = db.info.pop("snapshot_connection", None)
    db.close()
    if conn is not None:
        conn.close()


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        logger.warning("credit report: could not remove temp file %s", path)


@router.get("/options")
def credit_report_options(
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_credit_report_access),
):
    return {"success": True, "dashboardUrl": public_dashboard_url(), **load_options(db)}


@router.get("/export.xlsx")
def export_credit_report(
    start: Optional[str] = Query(None, description="YYYY-MM-DD; with no dates, the last full month"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD; with no dates, the last full month"),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None, description="0 = Unknown user (generations with no owner)"),
    tool: Optional[str] = Query(None),
    client: Optional[str] = Query(None),
    # On by default: the Summary is a management view, so test & admin
    # accounts stay out unless asked for (excludeTestAccounts=false).
    excludeTestAccounts: bool = Query(True, description="Leave out admin and test accounts (config + "
                                                        "CREDIT_REPORT_EXCLUDED_ACCOUNTS)"),
    version: str = Query("full", description="full = every sheet; management = Summary, Team & Clients, Glossary"),
    format: str = Query("xlsx", description="xlsx, or pdf (management version only)"),
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_credit_report_access),
):
    start_iso = _parse_iso_date(start, "start")
    end_iso = _parse_iso_date(end, "end")
    if start_iso and end_iso and start_iso > end_iso:
        raise HTTPException(status_code=400, detail="start must be on or before end")
    if tool and tool.strip() and tool.strip() not in TOOL_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown tool: {tool}")
    if version not in VERSIONS:
        raise HTTPException(status_code=400, detail=f"version must be one of {', '.join(VERSIONS)}")
    if format not in ("xlsx", "pdf"):
        raise HTTPException(status_code=400, detail="format must be xlsx or pdf")
    if format == "pdf" and version != MANAGEMENT:
        raise HTTPException(status_code=400, detail="PDF is available for the management version")
    if not start_iso and not end_iso:
        today = (datetime.utcnow() + timedelta(minutes=IST_OFFSET_MINUTES)).date()
        first, last = last_full_month(today)
        start_iso, end_iso = first.isoformat(), last.isoformat()

    filters = ReportFilters.build(start=start_iso, end=end_iso, department=department, user_id=user,
                                  tool=tool, client=client, exclude_test_accounts=excludeTestAccounts)
    if filters.user_id not in (None, UNASSIGNED_USER_ID):
        target = db.query(User.name).filter(User.id == filters.user_id).scalar()
        filters.user_label = filters.display.person_name(filters.user_id, target) if target else f"User #{filters.user_id}"
    # Release the auth session's connection before the long export; the
    # export opens its own snapshot connection.
    db.close()

    fd, path = tempfile.mkstemp(prefix="credit-report-", suffix=".xlsx")
    os.close(fd)
    report_db = _snapshot_session()
    try:
        generate_report(report_db, filters, path, dashboard_url=public_dashboard_url() or "", version=version)
    except Exception:
        _remove(path)
        raise
    finally:
        _close_snapshot(report_db)

    if format == "pdf":
        pdf_path = path[:-5] + ".pdf"
        try:
            to_pdf(path, pdf_path)
        except PdfUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        finally:
            _remove(path)
        return FileResponse(pdf_path, media_type=PDF_MIMETYPE, filename=report_filename(filters, version, "pdf"),
                            background=BackgroundTask(_remove, pdf_path))
    return FileResponse(
        path,
        media_type=XLSX_MIMETYPE,
        filename=report_filename(filters, version),
        background=BackgroundTask(_remove, path),
    )


@router.get("/output/{tool}/{record_id}")
def generation_output_url(
    tool: str,
    record_id: int,
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_user),
):
    """Resolve a Generation Log "Open output" link to a URL the browser can
    open right now (mirrored files get a freshly signed link)."""
    if tool not in TOOL_NAMES:
        raise HTTPException(status_code=404, detail="Unknown tool")
    url = resolve_output_url(db, tool, record_id)
    if not url:
        raise HTTPException(status_code=404, detail="This generation has no stored output")
    return {"success": True, "url": url}
