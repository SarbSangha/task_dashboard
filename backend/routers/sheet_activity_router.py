"""
Google Sheet edit history (Sheets -> Sheet Activity in the sidebar).

* POST /api/sheet-activity is called by apps-script/Code.gs, not by a
  browser. It is authenticated by the shared secret in the
  X-Sheet-Activity-Secret header (env SHEET_ACTIVITY_WEBHOOK_SECRET), and
  optionally limited to the spreadsheets in SHEET_ACTIVITY_SPREADSHEET_IDS.
* Every GET is gated by the "sheet_activity" Section Access grant (Admin
  Queue -> Section Access); admins always have it.
"""

import hmac
import json
import logging
import os
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

import database_config
from database_config import get_operational_db
from models_new import User
from services import sheet_activity_service as svc
from utils.permissions import require_sheet_activity_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sheet-activity", tags=["Sheet Activity"])

SECRET_ENV = "SHEET_ACTIVITY_WEBHOOK_SECRET"
SPREADSHEETS_ENV = "SHEET_ACTIVITY_SPREADSHEET_IDS"
MIN_SECRET_LENGTH = 24
MAX_BODY_BYTES = 2_000_000


def _allowed_spreadsheets() -> set:
    return {s.strip() for s in (os.getenv(SPREADSHEETS_ENV) or "").split(",") if s.strip()}


def _check_secret(provided: Optional[str]) -> None:
    expected = (os.getenv(SECRET_ENV) or "").strip()
    if len(expected) < MIN_SECRET_LENGTH:
        # Fail closed: an unset or weak secret must never mean "accept anything".
        logger.error("sheet activity webhook called but %s is unset or shorter than %s chars", SECRET_ENV, MIN_SECRET_LENGTH)
        raise HTTPException(status_code=503, detail="Sheet activity webhook is not configured")
    if not provided or not hmac.compare_digest(provided.strip().encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Invalid webhook secret")


def require_webhook_secret(x_sheet_activity_secret: Optional[str] = Header(None, alias="X-Sheet-Activity-Secret")) -> None:
    """Dependency form of the shared-secret check, so a bad secret is refused
    before the request body is even validated."""
    _check_secret(x_sheet_activity_secret)


def _validation_detail(exc: ValidationError) -> list:
    # Field locations and messages only - never echo the submitted values.
    return [{"loc": ".".join(str(p) for p in err.get("loc", ())), "msg": err.get("msg")} for err in exc.errors()][:20]


@router.post("")
async def receive_sheet_activity(
    request: Request,
    source: str = Query("webhook", description="webhook | resend | backfill"),
    x_sheet_activity_secret: Optional[str] = Header(None, alias="X-Sheet-Activity-Secret"),
    db: Session = Depends(get_operational_db),
):
    _check_secret(x_sheet_activity_secret)
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Payload too large")
    try:
        payload = json.loads(body or b"null")
        events = svc.parse_events(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=_validation_detail(exc))
    except ValueError as exc:  # bad JSON or wrong shape
        raise HTTPException(status_code=422, detail=f"Malformed payload: {exc}")

    allowed = _allowed_spreadsheets()
    if allowed:
        foreign = {ev.spreadsheetId for ev in events} - allowed
        if foreign:
            raise HTTPException(status_code=403, detail="Spreadsheet is not allowed")
    result = svc.ingest(db, events, source=source if source in svc.SOURCES else "webhook")
    return {"success": True, **result}


def _parse_day(value: Optional[str], name: str):
    if not value:
        return None
    try:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{name} must be a date in YYYY-MM-DD format")


def _scope(db: Session, viewer: User) -> Optional[frozenset]:
    """Admins see every spreadsheet; others only the ones assigned to them
    in the Sheets section."""
    from models_new import TrackedSheet
    from services.sheets.queries import visible_sheet_ids

    ids = visible_sheet_ids(db, viewer)
    if ids is None:
        return None
    rows = db.query(TrackedSheet.spreadsheet_id).filter(TrackedSheet.id.in_(ids or [-1])).all()
    return frozenset(sid for (sid,) in rows)


def _filters(user, sheet, changeType, start, end, q, scope=None) -> svc.ActivityFilters:
    f = svc.ActivityFilters(
        spreadsheet_ids=scope,
        user=(user or "").strip() or None,
        sheet=(sheet or "").strip() or None,
        change_type=(changeType or "").strip().upper() or None,
        start=_parse_day(start, "start"),
        end=_parse_day(end, "end"),
        q=(q or "").strip() or None,
    )
    if f.change_type and f.change_type not in svc.CHANGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown change type: {changeType}")
    if f.start and f.end and f.start > f.end:
        raise HTTPException(status_code=400, detail="start must be on or before end")
    return f


@router.get("")
def list_sheet_activity(
    user: Optional[str] = Query(None, description="Editor email, or 'unknown'"),
    sheet: Optional[str] = Query(None),
    changeType: Optional[str] = Query(None),
    start: Optional[str] = Query(None, description="YYYY-MM-DD (IST)"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD (IST)"),
    q: Optional[str] = Query(None, description="Search values, formulas, ranges, tabs, users"),
    page: int = Query(1, ge=1),
    pageSize: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    viewer: User = Depends(require_sheet_activity_access),
):
    f = _filters(user, sheet, changeType, start, end, q, _scope(db, viewer))
    return {"success": True, **svc.list_events(db, f, page, pageSize)}


@router.get("/summary")
def sheet_activity_summary(
    user: Optional[str] = Query(None),
    sheet: Optional[str] = Query(None),
    changeType: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    viewer: User = Depends(require_sheet_activity_access),
):
    return {"success": True, **svc.summary(db, _filters(user, sheet, changeType, start, end, q, _scope(db, viewer)))}


@router.get("/options")
def sheet_activity_options(
    db: Session = Depends(get_operational_db),
    viewer: User = Depends(require_sheet_activity_access),
):
    return {"success": True, **svc.options(db, svc.ActivityFilters(spreadsheet_ids=_scope(db, viewer)))}


@router.get("/export.csv")
def export_sheet_activity(
    user: Optional[str] = Query(None),
    sheet: Optional[str] = Query(None),
    changeType: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    viewer: User = Depends(require_sheet_activity_access),
):
    f = _filters(user, sheet, changeType, start, end, q, _scope(db, viewer))
    name = f"sheet-activity_{f.start or 'all'}_to_{f.end or 'now'}.csv"
    # The request's session is only for the access check: release it, and
    # stream from a session the generator owns, so the download never
    # outlives the connection it reads from.
    db.close()

    def stream():
        export_db = database_config.OperationalSessionLocal()
        try:
            yield from svc.csv_rows(export_db, f)
        finally:
            export_db.close()

    return StreamingResponse(
        stream(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
