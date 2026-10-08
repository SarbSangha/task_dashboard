"""Read side of the Sheets section: visibility, overview, requests, detail, CSV."""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import mean
from typing import Iterator, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import (
    ContentRequest,
    RequestEvent,
    SheetUserGoogleEmail,
    TrackedSheet,
    TrackedSheetMember,
    User,
)
from utils.permissions import has_any_role

from . import mapping as M
from .public_export import open_url
from .tracker import stage_of

IST = timedelta(minutes=330)
NEW_STATUS = "New"          # display label for a blank status
INPUT_EVENTS = ("NEW_REQUEST", "INPUT_EDIT")


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.replace(microsecond=0).isoformat() + "Z" if value else None


def is_sheet_admin(user: User) -> bool:
    return has_any_role(user, {"admin"})


def visible_sheet_ids(db: Session, user: User) -> Optional[set]:
    """None = every sheet (admins); otherwise the sheets the user is assigned to."""
    if is_sheet_admin(user):
        return None
    return {sid for (sid,) in db.query(TrackedSheetMember.sheet_id).filter(TrackedSheetMember.user_id == user.id)}


def can_view(db: Session, user: User, sheet_id: int) -> bool:
    ids = visible_sheet_ids(db, user)
    return ids is None or sheet_id in ids


#: Per-sheet permission keys, as the API and frontend name them, mapped to
#: the TrackedSheetMember column holding each.
SHEET_PERMISSIONS = {
    "open": "can_open",
    "openInGoogle": "can_open_google",
    "settings": "can_edit_settings",
}
ALL_SHEET_PERMISSIONS = {key: True for key in SHEET_PERMISSIONS}
NO_SHEET_PERMISSIONS = {key: False for key in SHEET_PERMISSIONS}


def member_permissions(member: Optional[TrackedSheetMember]) -> dict:
    if member is None:
        return dict(NO_SHEET_PERMISSIONS)
    return {key: bool(getattr(member, col)) for key, col in SHEET_PERMISSIONS.items()}


def sheet_permissions_for(db: Session, user: User) -> Optional[dict]:
    """{sheet_id: permissions} for the sheets this user is a member of; None
    for admins, who may do everything on every sheet."""
    if is_sheet_admin(user):
        return None
    rows = db.query(TrackedSheetMember).filter(TrackedSheetMember.user_id == user.id)
    return {m.sheet_id: member_permissions(m) for m in rows}


def sheet_permissions(db: Session, user: User, sheet_id: int) -> dict:
    if is_sheet_admin(user):
        return dict(ALL_SHEET_PERMISSIONS)
    member = (db.query(TrackedSheetMember)
              .filter(TrackedSheetMember.sheet_id == sheet_id, TrackedSheetMember.user_id == user.id).first())
    return member_permissions(member)


def people_directory(db: Session) -> dict:
    """{google email (lower): {"userId", "name"}} from login emails plus overrides."""
    out = {}
    for uid, email, name in db.query(User.id, User.email, User.name).filter(User.is_deleted.is_(False)):
        if email:
            out[email.strip().lower()] = {"userId": uid, "name": name}
    names = {uid: name for uid, name in db.query(User.id, User.name)}
    for uid, google in db.query(SheetUserGoogleEmail.user_id, SheetUserGoogleEmail.google_email):
        out[google.strip().lower()] = {"userId": uid, "name": names.get(uid)}
    return out


def _person(directory: dict, email: Optional[str]) -> dict:
    if not email:
        return {"email": None, "name": None, "userId": None}
    hit = directory.get(email.lower()) or {}
    return {"email": email, "name": hit.get("name"), "userId": hit.get("userId")}


def serialize_sheet(sheet: TrackedSheet, *, members: Optional[list] = None, request_count: Optional[int] = None,
                    permissions: Optional[dict] = None) -> dict:
    """`permissions` is the viewer's per-sheet permissions (None = all, for
    admins). Without openInGoogle the links are left out, so hiding the
    button is not the only thing standing between them and the sheet."""
    perms = permissions if permissions is not None else ALL_SHEET_PERMISSIONS
    show_links = perms.get("openInGoogle", False)
    return {
        "id": sheet.id,
        "name": sheet.name,
        "sheetType": sheet.sheet_type or "content_workflow",
        "spreadsheetId": sheet.spreadsheet_id,
        "sourceUrl": sheet.source_url if show_links else None,
        "sourceSpreadsheetId": sheet.source_spreadsheet_id,
        "url": sheet.url if show_links else None,
        "openUrl": open_url(sheet.spreadsheet_id) if show_links else None,
        "tabs": sheet.tabs_json or [],
        "mapping": sheet.mapping_json or {},
        "statuses": M.validate_statuses(sheet.statuses_json),
        "config": (M.validate_config(sheet.config_json)
                   if (sheet.sheet_type or "content_workflow") == "content_workflow" else (sheet.config_json or {})),
        "isActive": bool(sheet.is_active),
        "lastPolledAt": _iso(sheet.last_polled_at),
        "lastPollStatus": sheet.last_poll_status,
        "lastPollError": sheet.last_poll_error,
        "members": members,
        "requestCount": request_count,
        "permissions": dict(perms),
    }


# --------------------------------------------------------------------------- #
# Stuck / errors
# --------------------------------------------------------------------------- #
def link_headers(sheet: TrackedSheet) -> dict:
    mapping = sheet.mapping_json or {}
    inputs = [h for h in mapping if M.side_of(mapping, h) == "input" and M.is_link_header(mapping, h)]
    structure_doc = next((h for h in inputs if "structure" in h.lower()), inputs[0] if inputs else None)
    return {
        "structureDoc": structure_doc,
        "finalDoc": M.first_header(mapping, "final_link"),
        "structure": M.first_header(mapping, "structure"),
        "topic": M.first_header(mapping, "topic"),
        "status": M.first_header(mapping, "status"),
    }


def stuck_reason(req: ContentRequest, sheet: TrackedSheet, now: datetime) -> Optional[str]:
    statuses = M.validate_statuses(sheet.statuses_json)
    config = M.validate_config(sheet.config_json)
    stage = stage_of(req.status or "", statuses)
    final_h = M.first_header(sheet.mapping_json or {}, "final_link")
    if stage == "delivered" and final_h and not (req.values_json or {}).get(final_h):
        return "Delivered with no Final Doc Link"
    if stage == "awaiting":
        since = req.awaiting_at or req.first_seen_at
        if since and now - since > timedelta(hours=config["stuckAwaitingHours"]):
            return f"Awaiting Approval for over {config['stuckAwaitingHours']} h"
    if stage == "in_progress":
        since = req.in_progress_at or req.first_seen_at
        if since and now - since > timedelta(hours=config["stuckInProgressHours"]):
            return f"In Progress for over {config['stuckInProgressHours']} h"
    return None


# --------------------------------------------------------------------------- #
# Requests
# --------------------------------------------------------------------------- #
@dataclass
class RequestFilters:
    tab: Optional[str] = None
    status: Optional[str] = None        # a status label, or NEW_STATUS for blank
    user: Optional[str] = None          # creator email, or "unknown"
    start: Optional[date] = None        # IST days, on the request time (or first seen)
    end: Optional[date] = None
    q: Optional[str] = None
    stuck_only: bool = False


def _filtered_requests(db: Session, sheet: TrackedSheet, f: RequestFilters):
    q = db.query(ContentRequest).filter(ContentRequest.sheet_id == sheet.id, ContentRequest.removed_at.is_(None))
    if f.tab:
        q = q.filter(ContentRequest.tab_name == f.tab)
    if f.status:
        q = q.filter(ContentRequest.status.is_(None)) if f.status == NEW_STATUS else q.filter(ContentRequest.status == f.status)
    if f.user:
        q = (q.filter(ContentRequest.created_by_email.is_(None)) if f.user.lower() == "unknown"
             else q.filter(func.lower(ContentRequest.created_by_email) == f.user.lower()))
    when = func.coalesce(ContentRequest.requested_at, ContentRequest.first_seen_at)
    if f.start:
        q = q.filter(when >= datetime(f.start.year, f.start.month, f.start.day) - IST)
    if f.end:
        end = f.end + timedelta(days=1)
        q = q.filter(when < datetime(end.year, end.month, end.day) - IST)
    if f.q:
        q = q.filter(ContentRequest.topic.ilike(f"%{f.q.strip()}%"))
    return q


def request_row(req: ContentRequest, sheet: TrackedSheet, directory: dict, now: datetime) -> dict:
    links = link_headers(sheet)
    vals = req.values_json or {}
    return {
        "id": req.id,
        "tab": req.tab_name,
        "rowNumber": req.row_number,
        "rowKey": req.row_key,
        "topic": req.topic,
        "status": req.status or NEW_STATUS,
        "createdBy": _person(directory, req.created_by_email),
        "requestedAt": _iso(req.requested_at),
        "firstSeenAt": _iso(req.first_seen_at),
        "lastChangedAt": _iso(req.last_changed_at),
        "structureDocLink": vals.get(links["structureDoc"]) if links["structureDoc"] else None,
        "finalDocLink": vals.get(links["finalDoc"]) if links["finalDoc"] else None,
        "error": req.error,
        "stuck": stuck_reason(req, sheet, now),
        "isImported": bool(req.is_imported),
    }


def list_requests(db: Session, sheet: TrackedSheet, f: RequestFilters, page: int, page_size: int,
                  now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    directory = people_directory(db)
    q = _filtered_requests(db, sheet, f).order_by(ContentRequest.last_changed_at.desc(), ContentRequest.id.desc())
    if f.stuck_only:
        rows = [request_row(r, sheet, directory, now) for r in q.all()]
        rows = [r for r in rows if r["stuck"] or r["error"]]
        total = len(rows)
        rows = rows[(page - 1) * page_size: page * page_size]
    else:
        total = q.count()
        rows = [request_row(r, sheet, directory, now) for r in q.offset((page - 1) * page_size).limit(page_size)]
    return {"items": rows, "total": total, "page": page, "pageSize": page_size}


def _hours(deltas: list) -> Optional[float]:
    return round(mean(deltas) / 3600, 1) if deltas else None


def overview(db: Session, sheet: TrackedSheet, tab: Optional[str] = None, now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    directory = people_directory(db)
    reqs = _filtered_requests(db, sheet, RequestFilters(tab=tab)).all()
    statuses = M.validate_statuses(sheet.statuses_json)
    by_status: dict = defaultdict(int)
    for r in reqs:
        by_status[r.status or NEW_STATUS] += 1
    ordered = [NEW_STATUS] + [statuses[k] for k in ("awaiting", "approved", "in_progress", "delivered")]
    status_counts = [{"status": s, "count": by_status.get(s, 0)} for s in ordered]
    status_counts += [{"status": s, "count": n} for s, n in sorted(by_status.items()) if s not in ordered]

    to_awaiting = [(r.awaiting_at - r.requested_at).total_seconds() for r in reqs
                   if r.awaiting_at and r.requested_at and r.awaiting_at >= r.requested_at]
    to_delivered = [(r.delivered_at - r.approved_at).total_seconds() for r in reqs
                    if r.delivered_at and r.approved_at and r.delivered_at >= r.approved_at]
    stuck = []
    for r in reqs:
        reason = stuck_reason(r, sheet, now)
        if reason:
            stuck.append({"id": r.id, "tab": r.tab_name, "topic": r.topic, "status": r.status, "reason": reason})
    errors = sum(1 for r in reqs if r.error or (stuck_reason(r, sheet, now) or "").startswith("Delivered with no"))

    ev_q = db.query(RequestEvent).filter(RequestEvent.sheet_id == sheet.id)
    if tab:
        ev_q = ev_q.filter(RequestEvent.tab_name == tab)
    people: dict = defaultdict(lambda: {"created": 0, "approvals": 0, "structureEdits": 0, "inputEdits": 0, "last": None})
    claude = {"structures": 0, "drafts": 0, "delivered": 0, "errors": 0, "last": None}
    for e in ev_q.yield_per(2000):
        if e.actor_type == "user":
            p = people[(e.actor_email or "").lower() or None]
            p["created"] += e.event_type == "NEW_REQUEST"
            p["approvals"] += e.event_type == "APPROVED"
            p["structureEdits"] += e.event_type == "STRUCTURE_EDITED_BY_USER"
            p["inputEdits"] += e.event_type == "INPUT_EDIT"
            p["last"] = max(filter(None, [p["last"], e.occurred_at]))
        elif e.actor_type == "claude":
            claude["structures"] += e.event_type == "STRUCTURE_GENERATED"
            claude["drafts"] += e.event_type == "DRAFT_STARTED"
            claude["delivered"] += e.event_type == "DELIVERED"
            claude["errors"] += e.event_type == "ERROR"
            claude["last"] = max(filter(None, [claude["last"], e.occurred_at]))
    per_user = sorted(
        ({**_person(directory, email), **{k: v for k, v in s.items() if k != "last"}, "lastActivity": _iso(s["last"])}
         for email, s in people.items()),
        key=lambda r: (-(r["created"] + r["approvals"] + r["structureEdits"] + r["inputEdits"]), r["email"] or "~"),
    )
    tabs = sorted({r.tab_name for r in _filtered_requests(db, sheet, RequestFilters()).all()}
                  | {t["name"] for t in (sheet.tabs_json or []) if t.get("tracked")})
    return {
        "sheet": serialize_sheet(sheet),
        "tab": tab,
        "tabs": tabs,
        "totalRequests": len(reqs),
        "statusCounts": status_counts,
        "deliveredThisWeek": sum(1 for r in reqs if r.delivered_at and r.delivered_at >= now - timedelta(days=7)),
        "avgHoursToAwaiting": _hours(to_awaiting),
        "avgHoursApprovalToDelivered": _hours(to_delivered),
        "errors": errors,
        "stuck": stuck[:100],
        "perUser": per_user,
        "claude": {**{k: v for k, v in claude.items() if k != "last"}, "lastActivity": _iso(claude["last"])},
        "importedRequests": sum(1 for r in reqs if r.is_imported),
    }


# --------------------------------------------------------------------------- #
# Detail
# --------------------------------------------------------------------------- #
def serialize_event(e: RequestEvent, directory: dict) -> dict:
    return {
        "id": e.id,
        "eventType": e.event_type,
        "actorType": e.actor_type,
        "actor": _person(directory, e.actor_email),
        "column": e.column_name,
        "oldValue": e.old_value,
        "newValue": e.new_value,
        "metadata": e.metadata_json or {},
        "occurredAt": _iso(e.occurred_at),
        "source": e.source,
    }


def request_detail(db: Session, sheet: TrackedSheet, req: ContentRequest, now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    directory = people_directory(db)
    mapping = sheet.mapping_json or {}
    events = (db.query(RequestEvent).filter(RequestEvent.request_id == req.id)
              .order_by(RequestEvent.occurred_at.asc(), RequestEvent.id.asc()).all())
    serial = [serialize_event(e, directory) for e in events]
    links = link_headers(sheet)
    vals = req.values_json or {}
    generated = [e for e in events if e.event_type == "STRUCTURE_GENERATED" and e.new_value]
    claude_version = generated[-1].new_value if generated else None
    if claude_version is None and req.is_imported:
        claude_version = vals.get(links["structure"]) if links["structure"] else None
    stages = [
        ("Requested", req.requested_at), ("Awaiting Approval", req.awaiting_at), ("Approved", req.approved_at),
        ("In Progress", req.in_progress_at), ("Delivered", req.delivered_at),
    ]
    durations, previous = [], None
    for label, when in stages:
        durations.append({"stage": label, "at": _iso(when),
                          "hoursSincePrevious": round((when - previous[1]).total_seconds() / 3600, 1)
                          if when and previous and previous[1] and when >= previous[1] else None})
        if when:
            previous = (label, when)
    return {
        "request": request_row(req, sheet, directory, now),
        "values": [{"header": h, "value": vals.get(h, ""), "side": M.side_of(mapping, h), "role": M.role_of(mapping, h),
                    "isLink": M.is_link_header(mapping, h)} for h in mapping],
        # Two-sided timeline: what people entered vs everything that came back
        # (Claude's outputs, approvals, structure edits, errors).
        "inputEvents": [e for e in serial if e["eventType"] in INPUT_EVENTS],
        "responseEvents": [e for e in serial if e["eventType"] not in INPUT_EVENTS],
        "events": serial,
        "claudeStructure": claude_version,
        "currentStructure": vals.get(links["structure"]) if links["structure"] else None,
        "stages": durations,
    }


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def _csv_safe(value) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _csv_stream(header: list, rows) -> Iterator[str]:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    yield "﻿" + buf.getvalue()
    for row in rows:
        buf.seek(0)
        buf.truncate(0)
        w.writerow([_csv_safe(v) for v in row])
        yield buf.getvalue()


def requests_csv(db: Session, sheet: TrackedSheet, f: RequestFilters) -> Iterator[str]:
    now = datetime.utcnow()
    directory = people_directory(db)
    headers = list((sheet.mapping_json or {}).keys())
    reqs = _filtered_requests(db, sheet, f).order_by(ContentRequest.last_changed_at.desc()).all()
    rows = []
    for r in reqs:
        row = request_row(r, sheet, directory, now)
        if f.stuck_only and not (row["stuck"] or row["error"]):
            continue
        rows.append([r.id, r.tab_name, r.row_number, row["status"], row["createdBy"]["email"] or "Unknown user",
                     _iso(r.requested_at), _iso(r.awaiting_at), _iso(r.approved_at), _iso(r.in_progress_at),
                     _iso(r.delivered_at), _iso(r.last_changed_at), row["stuck"] or "", r.error or "",
                     "yes" if r.is_imported else "no"] + [(r.values_json or {}).get(h, "") for h in headers])
    return _csv_stream(["Request ID", "Tab", "Row", "Status", "Created by", "Requested (UTC)", "Awaiting Approval (UTC)",
                        "Approved (UTC)", "In Progress (UTC)", "Delivered (UTC)", "Last updated (UTC)", "Stuck",
                        "Error", "Imported"] + headers, rows)


def events_csv(db: Session, sheet: TrackedSheet, f: RequestFilters) -> Iterator[str]:
    ids = [r.id for r in _filtered_requests(db, sheet, f).with_entities(ContentRequest.id)]
    topics = dict(db.query(ContentRequest.id, ContentRequest.topic).filter(ContentRequest.sheet_id == sheet.id))
    events = (db.query(RequestEvent).filter(RequestEvent.request_id.in_(ids))
              .order_by(RequestEvent.occurred_at.asc(), RequestEvent.id.asc()).all()) if ids else []
    rows = [[e.id, e.request_id, e.tab_name, topics.get(e.request_id), _iso(e.occurred_at), e.actor_type,
             e.actor_email or ("Unknown user" if e.actor_type == "user" else ""), e.event_type, e.column_name,
             e.old_value, e.new_value, "yes" if (e.metadata_json or {}).get("approximateTime") else "no", e.source]
            for e in events]
    return _csv_stream(["Event ID", "Request ID", "Tab", "Topic", "Time (UTC)", "Actor type", "Actor email", "Event",
                        "Column", "Old value", "New value", "Time approximate", "Source"], rows)
