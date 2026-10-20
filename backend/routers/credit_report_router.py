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
import httpx
from fastapi.responses import FileResponse, StreamingResponse
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
from utils.credit_report.live_sheet import build_live_sheet, seed_demo_ai_usage
from utils.credit_report.output_media import (
    TOOL_KIND,
    OutputFetchError,
    chat_transcript,
    iter_and_close,
    open_output_stream,
    output_filename,
    output_kind,
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


@router.get("/live-sheet")
def credit_report_live_sheet(
    start: Optional[str] = Query(None, description="YYYY-MM-DD"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD"),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None, description="0 = Unknown user"),
    tool: Optional[str] = Query(None),
    client: Optional[str] = Query(None),
    outputType: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    excludeTestAccounts: bool = Query(False),
    limit: int = Query(800, ge=50, le=3000),
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_credit_report_access),
):
    """Live JSON representation of the multi-sheet Excel workbook (KPIs,
    averages, spend in ₹, and all sheets) for in-app viewing and 1-2 click
    filtering inside RMW Eye."""
    start_iso = _parse_iso_date(start, "start")
    end_iso = _parse_iso_date(end, "end")
    if start_iso and end_iso and start_iso > end_iso:
        raise HTTPException(status_code=400, detail="start must be on or before end")
    return build_live_sheet(
        db,
        start=start_iso,
        end=end_iso,
        department=department,
        user_id=user,
        tool=tool,
        client=client,
        output_type=outputType,
        search=search,
        exclude_test_accounts=excludeTestAccounts,
        log_limit=limit,
    )


@router.post("/seed-demo")
def seed_credit_report_demo(
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_credit_report_access),
):
    """Populate realistic RMW AI tool usage, users, tools, and ₹ costs when
    running on a fresh local database."""
    # The production database can also sit on localhost, so the host check
    # alone is not enough: seeding must be switched on explicitly.
    if os.getenv("ENABLE_DEMO_SEED", "").strip().lower() not in {"1", "true", "yes"}:
        raise HTTPException(status_code=403, detail="Sample data loading is disabled on this server.")
    url = db.get_bind().url
    if (url.host or "").lower() not in {"localhost", "127.0.0.1", "::1"} or not (url.database or "").startswith("task_dashboard"):
        raise HTTPException(status_code=403, detail="Sample data can only be loaded into a local database.")
    result = seed_demo_ai_usage(db)
    return {"success": True, **result}


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
    return {
        "success": True,
        "url": url,
        "kind": output_kind(url, tool),
        # What the tool makes, so a Suno song stored only as its cover art
        # can say so instead of passing the picture off as the song.
        "expected": TOOL_KIND.get(tool),
        "filename": output_filename(url, tool, record_id),
    }


@router.get("/output/{tool}/{record_id}/chat")
def generation_chat_transcript(
    tool: str,
    record_id: int,
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_credit_report_access),
):
    """A Claude / ChatGPT log row's whole conversation, to read in the
    dashboard (the shared company account's chat page needs its login)."""
    data = chat_transcript(db, tool, record_id)
    if not data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"success": True, **data}


@router.get("/output/{tool}/{record_id}/download")
def generation_output_download(
    tool: str,
    record_id: int,
    db: Session = Depends(get_operational_db),
    _: User = Depends(require_user),
):
    """Stream a generation's output back as an attachment, so the dashboard
    can save provider / R2 files the browser would otherwise only open."""
    if tool not in TOOL_NAMES or output_kind("", tool) == "chat":
        raise HTTPException(status_code=404, detail="This generation has no downloadable output")
    url = resolve_output_url(db, tool, record_id)
    # The fetch and the whole streamed download happen after this, and the
    # request's session would otherwise stay checked out until the stream ends.
    db.close()
    if not url:
        raise HTTPException(status_code=404, detail="This generation has no stored output")
    try:
        resp, client = open_output_stream(url)
    except OutputFetchError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach the output source")
    content_type = resp.headers.get("content-type") or "application/octet-stream"
    headers = {"Content-Disposition": f'attachment; filename="{output_filename(url, tool, record_id, content_type)}"'}
    if resp.headers.get("content-length"):
        headers["Content-Length"] = resp.headers["content-length"]
    return StreamingResponse(iter_and_close(resp, client), media_type=content_type, headers=headers)
