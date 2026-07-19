"""
Report Distribution layer — library (history), exports, schedules, audit, capabilities.

Storage & audit are real. Server exports are guarded by engine availability. Email sends only
when SMTP is configured. Schedule firing is triggered by POST /schedules/run-due (call from cron).
"""

import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ReportAuditLog, ReportSchedule, SavedReport, User
from utils.permissions import require_admin, has_any_role
from utils.report_render import build_html
from utils.report_exports import export_report, available_formats, ExportUnavailable
from utils.report_email import email_status, send_report_email

router = APIRouter(prefix="/api/reports", tags=["Report Distribution"])


def _is_admin(user: User) -> bool:
    return bool(getattr(user, "is_admin", False)) or has_any_role(user, ["admin"])


def _audit(db, action, *, report_id=None, schedule_id=None, fmt=None, user_id=None, detail=None):
    db.add(ReportAuditLog(action=action, report_id=report_id, schedule_id=schedule_id,
                          format=fmt, user_id=user_id, detail=detail))


def _safe_name(name):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "report").strip())[:60] or "report"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class SaveReportIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    definition: dict
    htmlSnapshot: Optional[str] = None
    department: Optional[str] = None


class ScheduleIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    definition: dict
    cadence: str = "weekly"
    hourUtc: int = 8
    weekday: Optional[int] = None
    dayOfMonth: Optional[int] = None
    recipients: list[str] = []
    formats: list[str] = ["pdf"]
    active: bool = True


def _compute_next_run(cadence, hour, weekday, dom, base=None):
    base = base or datetime.utcnow()
    hour = hour if hour is not None else 8
    anchor = base.replace(minute=0, second=0, microsecond=0)
    if cadence == "daily":
        nxt = anchor.replace(hour=hour)
        return nxt if nxt > base else nxt + timedelta(days=1)
    if cadence == "weekly":
        wd = weekday if weekday is not None else 0
        nxt = anchor.replace(hour=hour) + timedelta(days=(wd - anchor.weekday()) % 7)
        return nxt if nxt > base else nxt + timedelta(days=7)
    if cadence == "monthly":
        d = min(max(dom or 1, 1), 28)
        nxt = base.replace(day=d, hour=hour, minute=0, second=0, microsecond=0)
        if nxt <= base:
            year, month = (base.year + 1, 1) if base.month == 12 else (base.year, base.month + 1)
            nxt = nxt.replace(year=year, month=month)
        return nxt
    return base + timedelta(days=1)


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------
@router.get("/distribution/capabilities")
def capabilities(current_user: User = Depends(require_admin)):
    return {"success": True, "formats": available_formats(), "email": email_status()}


# ---------------------------------------------------------------------------
# Library (saved reports / history)
# ---------------------------------------------------------------------------
@router.post("/library")
def save_report(body: SaveReportIn, db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    row = SavedReport(
        name=body.name, definition_json=body.definition, html_snapshot=body.htmlSnapshot,
        owner_user_id=current_user.id, department=body.department, version=1,
    )
    db.add(row)
    db.flush()
    _audit(db, "created", report_id=row.id, user_id=current_user.id, detail=body.name)
    db.commit()
    db.refresh(row)
    return {"success": True, "data": row.to_dict()}


@router.get("/library")
def list_reports(db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    q = db.query(SavedReport)
    if not _is_admin(current_user):
        q = q.filter(SavedReport.owner_user_id == current_user.id)
    rows = q.order_by(SavedReport.created_at.desc()).limit(200).all()
    # attach owner names
    owner_ids = {r.owner_user_id for r in rows if r.owner_user_id}
    names = {u.id: u.name for u in db.query(User.id, User.name).filter(User.id.in_(owner_ids)).all()} if owner_ids else {}
    data = []
    for r in rows:
        d = r.to_dict()
        d["ownerName"] = names.get(r.owner_user_id, "—")
        data.append(d)
    return {"success": True, "data": data}


class AdhocExportIn(BaseModel):
    definition: dict
    format: str = "pdf"
    htmlSnapshot: Optional[str] = None
    name: Optional[str] = None


@router.post("/library/export")
def adhoc_export(body: AdhocExportIn, db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    try:
        data, mime, ext = export_report(body.definition or {}, body.format, html_snapshot=body.htmlSnapshot)
    except ExportUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    _audit(db, "exported", fmt=ext, user_id=current_user.id, detail="ad-hoc")
    db.commit()
    filename = f"{_safe_name(body.name or ((body.definition or {}).get('branding') or {}).get('title'))}.{ext}"
    return Response(content=data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _get_owned_report(db, report_id, current_user):
    row = db.query(SavedReport).filter(SavedReport.id == report_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    if not _is_admin(current_user) and row.owner_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your report")
    return row


@router.get("/library/{report_id}")
def get_report(report_id: int, db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    row = _get_owned_report(db, report_id, current_user)
    return {"success": True, "data": row.to_dict(include_definition=True)}


@router.delete("/library/{report_id}")
def delete_report(report_id: int, db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    row = _get_owned_report(db, report_id, current_user)
    _audit(db, "deleted", report_id=row.id, user_id=current_user.id, detail=row.name)
    db.delete(row)
    db.commit()
    return {"success": True}


@router.get("/library/{report_id}/export")
def export_saved_report(report_id: int, format: str = Query("pdf"),
                        db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    row = _get_owned_report(db, report_id, current_user)
    definition = row.definition_json or {}
    try:
        data, mime, ext = export_report(definition, format, html_snapshot=row.html_snapshot)
    except ExportUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    _audit(db, "exported", report_id=row.id, fmt=ext, user_id=current_user.id)
    db.commit()
    filename = f"{_safe_name(row.name)}.{ext}"
    return Response(content=data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---------------------------------------------------------------------------
# Schedules
# ---------------------------------------------------------------------------
@router.post("/schedules")
def create_schedule(body: ScheduleIn, db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    nxt = _compute_next_run(body.cadence, body.hourUtc, body.weekday, body.dayOfMonth)
    row = ReportSchedule(
        name=body.name, definition_json=body.definition, cadence=body.cadence, hour_utc=body.hourUtc,
        weekday=body.weekday, day_of_month=body.dayOfMonth, recipients_json=body.recipients,
        formats_json=body.formats, active=body.active, owner_user_id=current_user.id, next_run_at=nxt,
    )
    db.add(row)
    db.flush()
    _audit(db, "scheduled", schedule_id=row.id, user_id=current_user.id, detail=f"{body.cadence} → {', '.join(body.recipients)}")
    db.commit()
    db.refresh(row)
    return {"success": True, "data": row.to_dict()}


@router.get("/schedules")
def list_schedules(db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    q = db.query(ReportSchedule)
    if not _is_admin(current_user):
        q = q.filter(ReportSchedule.owner_user_id == current_user.id)
    rows = q.order_by(ReportSchedule.created_at.desc()).limit(200).all()
    return {"success": True, "data": [r.to_dict() for r in rows], "email": email_status()}


@router.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: int, db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    row = db.query(ReportSchedule).filter(ReportSchedule.id == schedule_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if not _is_admin(current_user) and row.owner_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your schedule")
    db.delete(row)
    db.commit()
    return {"success": True}


@router.post("/schedules/run-due")
def run_due_schedules(db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    now = datetime.utcnow()
    due = (
        db.query(ReportSchedule)
        .filter(ReportSchedule.active.is_(True), ReportSchedule.next_run_at.isnot(None), ReportSchedule.next_run_at <= now)
        .limit(50).all()
    )
    results = []
    for sch in due:
        definition = sch.definition_json or {}
        html = build_html(definition)
        attachments = []
        export_errors = []
        for fmt in (sch.formats_json or ["pdf"]):
            try:
                data, mime, ext = export_report(definition, fmt, html_snapshot=html)
                attachments.append((f"{_safe_name(sch.name)}.{ext}", data, mime))
            except ExportUnavailable as exc:
                export_errors.append(f"{fmt}: {exc}")

        subject = f"{sch.name} — {now.strftime('%Y-%m-%d')}"
        sent, detail = send_report_email(sch.recipients_json or [], subject, html, attachments)
        status = "sent" if sent else "email_skipped"
        _audit(db, status, schedule_id=sch.id, detail="; ".join([detail] + export_errors) or detail)

        sch.last_run_at = now
        sch.last_status = status
        sch.next_run_at = _compute_next_run(sch.cadence, sch.hour_utc, sch.weekday, sch.day_of_month, base=now)
        results.append({"id": sch.id, "name": sch.name, "status": status, "detail": detail})
    db.commit()
    return {"success": True, "processed": len(due), "results": results, "email": email_status()}


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------
@router.get("/audit")
def list_audit(limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_operational_db), current_user: User = Depends(require_admin)):
    rows = db.query(ReportAuditLog).order_by(ReportAuditLog.created_at.desc()).limit(limit).all()
    user_ids = {r.user_id for r in rows if r.user_id}
    names = {u.id: u.name for u in db.query(User.id, User.name).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    data = [{**r.to_dict(), "userName": names.get(r.user_id, "system")} for r in rows]
    return {"success": True, "data": data}
