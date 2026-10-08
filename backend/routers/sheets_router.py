"""
Sheets section API: registered Google Sheets of two types.

* content_workflow: each row is a content request (user input vs Claude's response).
* keyword_ranking: each row is a keyword; each date column pair is one SEO check run.
  The ranking job can also report its runs to POST /api/sheets/ranking-results
  (X-Sheet-Activity-Secret header), adding what the sheet can't show.

* Seeing the Sheets section at all is the "sheet_activity" Section Access
  grant (Admin Queue -> Section Access, labelled "Sheets"); admins always
  have it.
* Which sheets a non-admin sees is the per-sheet assignment
  (tracked_sheet_members). Admins see every sheet.
* What a member may do with a sheet is per sheet and per person
  (tracked_sheet_members.can_*, Admin Queue -> Sheet Access): "open" (the
  dashboard view and its CSVs), "openInGoogle" (the sheet's links) and
  "settings" (edit tabs/columns/config and Sync now). Admins have all three.
* Adding a sheet needs the "sheets_add" Section Access grant ("Add Sheets");
  the person who adds one becomes its member with every permission.
* Assigning people, setting their permissions and deleting sheets is admin-only.
"""

from datetime import datetime
from typing import Optional

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import database_config
from database_config import get_operational_db
from models_new import ContentRequest, Keyword, SheetUserGoogleEmail, TrackedSheet, TrackedSheetMember, User
from services import sheets as S
from services.sheets import mapping as M
from services.sheets import queries as Q
from services.sheets import ranking_queries as RQ
from services.sheets.ranking_sync import ingest_job_report
from routers.sheet_activity_router import require_webhook_secret
from services.feature_access_service import (
    FEATURE_SHEET_ACTIVITY, FEATURE_SHEETS_ADD, has_feature_access, notify_feature_access_changed, set_feature_access,
)
from utils.permissions import require_admin, require_sheet_activity_access

router = APIRouter(prefix="/api/sheets", tags=["Sheets"])


class InspectIn(BaseModel):
    url: str = Field(..., min_length=10, max_length=2000)


class TabIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    tracked: bool = False


class SheetIn(BaseModel):
    url: str = Field(..., min_length=10, max_length=2000)
    name: str = Field(..., min_length=1, max_length=255)
    sheetType: str = S.CONTENT_WORKFLOW
    sourceUrl: Optional[str] = Field(None, max_length=2000)
    tabs: list[TabIn]
    mapping: dict = {}
    statuses: dict = {}
    config: dict = {}
    memberIds: list[int] = []


class SheetPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    tabs: Optional[list[TabIn]] = None
    mapping: Optional[dict] = None
    statuses: Optional[dict] = None
    config: Optional[dict] = None
    isActive: Optional[bool] = None
    sourceUrl: Optional[str] = Field(None, max_length=2000)   # "" clears it


class MembersIn(BaseModel):
    userIds: list[int]


class MemberAccessIn(BaseModel):
    member: bool
    open: bool = True
    openInGoogle: bool = True
    settings: bool = False


class GoogleEmailIn(BaseModel):
    googleEmail: Optional[str] = Field(None, max_length=320)


def _clean_config(raw, sheet_type: str = S.CONTENT_WORKFLOW) -> dict:
    try:
        if sheet_type == S.KEYWORD_RANKING:
            # Blank = find the header row by its "Keyword" text, the
            # sub-header row by "Position", and data right below.
            out = {}
            for key in ("headerRow", "subHeaderRow", "firstDataRow"):
                value = (raw or {}).get(key)
                out[key] = max(1, min(int(value), 200)) if value not in (None, "") else None
            return out
        return M.validate_config(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="config: row numbers and hours must be whole numbers")


def _source(url: Optional[str]) -> tuple:
    if not url or not url.strip():
        return None, None
    try:
        return S.parse_spreadsheet_id(url), url.strip()
    except S.SheetAccessError as exc:
        raise HTTPException(status_code=400, detail=f"Source sheet: {exc}")


_PERMISSION_DENIED = {
    "open": "You do not have permission to open this sheet. Ask an administrator to grant it.",
    "settings": "You do not have permission to change this sheet's settings. Ask an administrator to grant it.",
}


def _get_visible_sheet(db: Session, user: User, sheet_id: int, need: Optional[str] = None) -> TrackedSheet:
    """The sheet, if the user may see it at all - and, with `need`, may also
    do that one thing with it ("open" / "settings")."""
    sheet = db.get(TrackedSheet, sheet_id)
    if sheet is None or not Q.can_view(db, user, sheet_id):
        raise HTTPException(status_code=404, detail="Sheet not found")
    if need and not Q.sheet_permissions(db, user, sheet_id).get(need):
        raise HTTPException(status_code=403, detail=_PERMISSION_DENIED[need])
    return sheet


def _can_add_sheets(user: User) -> bool:
    return Q.is_sheet_admin(user) or has_feature_access(user, FEATURE_SHEETS_ADD)


def require_sheet_adder(user: User = Depends(require_sheet_activity_access)) -> User:
    if not _can_add_sheets(user):
        raise HTTPException(status_code=403,
                            detail="You do not have access to Add Sheets. Ask an administrator to grant it.")
    return user


def _members(db: Session, sheet_id: int) -> list:
    rows = (db.query(User.id, User.name, User.email, TrackedSheetMember)
            .join(TrackedSheetMember, TrackedSheetMember.user_id == User.id)
            .filter(TrackedSheetMember.sheet_id == sheet_id).order_by(User.name).all())
    return [{"id": uid, "name": name, "email": email, "permissions": Q.member_permissions(m)}
            for uid, name, email, m in rows]


def _serialize_for(db: Session, user: User, sheet: TrackedSheet, **extra) -> dict:
    admin = Q.is_sheet_admin(user)
    return Q.serialize_sheet(sheet, members=_members(db, sheet.id) if admin else None,
                             permissions=None if admin else Q.sheet_permissions(db, user, sheet.id), **extra)


def _set_members(db: Session, sheet: TrackedSheet, user_ids: list, actor: User) -> None:
    wanted = set(user_ids)
    valid = {uid for (uid,) in db.query(User.id).filter(User.id.in_(wanted), User.is_deleted.is_(False))} if wanted else set()
    if wanted - valid:
        raise HTTPException(status_code=400, detail=f"Unknown user id(s): {sorted(wanted - valid)}")
    db.query(TrackedSheetMember).filter(TrackedSheetMember.sheet_id == sheet.id,
                                        TrackedSheetMember.user_id.notin_(valid) if valid else true()).delete(
        synchronize_session=False)
    have = {uid for (uid,) in db.query(TrackedSheetMember.user_id).filter(TrackedSheetMember.sheet_id == sheet.id)}
    for uid in valid - have:
        db.add(TrackedSheetMember(sheet_id=sheet.id, user_id=uid, added_by=actor.id))


def _validated(payload_tabs, mapping, statuses, sheet_type=S.CONTENT_WORKFLOW):
    tabs = [{"name": t.name, "tracked": bool(t.tracked)} for t in payload_tabs]
    if not any(t["tracked"] for t in tabs):
        raise HTTPException(status_code=400, detail="Track at least one tab")
    if sheet_type == S.KEYWORD_RANKING:
        return tabs, {}, {}      # columns are found by header text on every read
    try:
        clean_map = M.validate_mapping(mapping)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return tabs, clean_map, M.validate_statuses(statuses)


# --------------------------------------------------------------------------- #
# Registry (admin)
# --------------------------------------------------------------------------- #
@router.post("/inspect")
def inspect_sheet(payload: InspectIn, _: User = Depends(require_sheet_adder)):
    try:
        return {"success": True, **S.inspect_sheet(payload.url)}
    except S.SheetAccessError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("", status_code=201)
def create_sheet(payload: SheetIn, db: Session = Depends(get_operational_db), actor: User = Depends(require_sheet_adder)):
    try:
        spreadsheet_id = S.parse_spreadsheet_id(payload.url)
    except S.SheetAccessError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if payload.sheetType not in S.SHEET_TYPES:
        raise HTTPException(status_code=400, detail=f"sheetType must be one of {', '.join(S.SHEET_TYPES)}")
    tabs, mapping, statuses = _validated(payload.tabs, payload.mapping, payload.statuses, payload.sheetType)
    source_id, source_url = _source(payload.sourceUrl)
    sheet = TrackedSheet(name=payload.name.strip(), sheet_type=payload.sheetType, spreadsheet_id=spreadsheet_id,
                         url=payload.url.strip(), source_spreadsheet_id=source_id, source_url=source_url,
                         tabs_json=tabs, mapping_json=mapping, statuses_json=statuses,
                         config_json=_clean_config(payload.config, payload.sheetType), created_by=actor.id)
    db.add(sheet)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="This spreadsheet is already registered")
    if Q.is_sheet_admin(actor):
        _set_members(db, sheet, payload.memberIds, actor)
    else:
        # Who else sees it is an admin's call; the adder gets the sheet they
        # added with every permission.
        db.add(TrackedSheetMember(sheet_id=sheet.id, user_id=actor.id, added_by=actor.id,
                                  can_open=True, can_open_google=True, can_edit_settings=True))
    db.commit()
    # First poll right away: imports the rows already in the sheet (for a
    # ranking sheet that is the full history backfill).
    result = S.poll_sheet(db, sheet, force=True)
    db.refresh(sheet)
    return {"success": True, "sheet": _serialize_for(db, actor, sheet), "firstSync": result}


@router.patch("/{sheet_id}")
def update_sheet(sheet_id: int, payload: SheetPatch, db: Session = Depends(get_operational_db),
                 user: User = Depends(require_sheet_activity_access)):
    sheet = _get_visible_sheet(db, user, sheet_id, need="settings")
    if payload.name is not None:
        sheet.name = payload.name.strip()
    if payload.tabs is not None or payload.mapping is not None or payload.statuses is not None:
        tabs, mapping, statuses = _validated(
            payload.tabs if payload.tabs is not None else [TabIn(**t) for t in sheet.tabs_json or []],
            payload.mapping if payload.mapping is not None else sheet.mapping_json,
            payload.statuses if payload.statuses is not None else sheet.statuses_json,
            sheet.sheet_type,
        )
        sheet.tabs_json, sheet.mapping_json, sheet.statuses_json = tabs, mapping, statuses
    if payload.config is not None:
        sheet.config_json = _clean_config(payload.config, sheet.sheet_type)
    # The link is withheld from people without "openInGoogle", so they can
    # neither see nor replace it.
    if payload.sourceUrl is not None and Q.sheet_permissions(db, user, sheet_id).get("openInGoogle"):
        sheet.source_spreadsheet_id, sheet.source_url = _source(payload.sourceUrl)
    if payload.isActive is not None:
        sheet.is_active = payload.isActive
    db.commit()
    db.refresh(sheet)
    return {"success": True, "sheet": _serialize_for(db, user, sheet)}


@router.delete("/{sheet_id}")
def delete_sheet(sheet_id: int, db: Session = Depends(get_operational_db), _: User = Depends(require_admin)):
    sheet = db.get(TrackedSheet, sheet_id)
    if sheet is None:
        raise HTTPException(status_code=404, detail="Sheet not found")
    db.delete(sheet)
    db.commit()
    return {"success": True}


@router.put("/{sheet_id}/members")
def set_members(sheet_id: int, payload: MembersIn, db: Session = Depends(get_operational_db),
                admin: User = Depends(require_admin)):
    sheet = db.get(TrackedSheet, sheet_id)
    if sheet is None:
        raise HTTPException(status_code=404, detail="Sheet not found")
    _set_members(db, sheet, payload.userIds, admin)
    db.commit()
    return {"success": True, "members": _members(db, sheet_id)}


@router.post("/{sheet_id}/sync")
def sync_now(sheet_id: int, db: Session = Depends(get_operational_db),
             user: User = Depends(require_sheet_activity_access)):
    sheet = _get_visible_sheet(db, user, sheet_id, need="settings")
    result = S.poll_sheet(db, sheet)
    db.refresh(sheet)
    return {"success": True, "result": result, "sheet": _serialize_for(db, user, sheet)}


# --------------------------------------------------------------------------- #
# Sheet Access (Admin Queue): who sees each sheet and what they may do with it
# --------------------------------------------------------------------------- #
@router.get("/access")
def access_overview(db: Session = Depends(get_operational_db), _: User = Depends(require_admin)):
    """Every sheet with its members' permissions, keyed by user id."""
    grants = {}
    for m in db.query(TrackedSheetMember):
        grants.setdefault(m.sheet_id, {})[str(m.user_id)] = Q.member_permissions(m)
    return {"success": True, "sheets": [
        {"id": s.id, "name": s.name, "sheetType": s.sheet_type or S.CONTENT_WORKFLOW,
         "isActive": bool(s.is_active), "members": grants.get(s.id, {})}
        for s in db.query(TrackedSheet).order_by(TrackedSheet.name)]}


@router.put("/{sheet_id}/access/{user_id}")
def set_member_access(sheet_id: int, user_id: int, payload: MemberAccessIn,
                      db: Session = Depends(get_operational_db), admin: User = Depends(require_admin)):
    """Add/remove one person on one sheet and set their permissions."""
    if db.get(TrackedSheet, sheet_id) is None:
        raise HTTPException(status_code=404, detail="Sheet not found")
    target = db.get(User, user_id)
    if target is None or target.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    row = (db.query(TrackedSheetMember)
           .filter(TrackedSheetMember.sheet_id == sheet_id, TrackedSheetMember.user_id == user_id).first())
    if not payload.member:
        if row:
            db.delete(row)
            db.commit()
        return {"success": True, "member": False, "permissions": dict(Q.NO_SHEET_PERMISSIONS)}
    if row is None:
        row = TrackedSheetMember(sheet_id=sheet_id, user_id=user_id, added_by=admin.id)
        db.add(row)
    row.can_open, row.can_open_google, row.can_edit_settings = payload.open, payload.openInGoogle, payload.settings
    # A sheet is useless without the Sheets section to reach it from, so
    # giving someone a sheet also grants the section (never revokes it).
    section_granted = not has_feature_access(target, FEATURE_SHEET_ACTIVITY)
    if section_granted:
        set_feature_access(db, target, FEATURE_SHEET_ACTIVITY, True, granted_by=admin.id)
    db.commit()
    if section_granted:
        notify_feature_access_changed([target.id], FEATURE_SHEET_ACTIVITY, True)
    return {"success": True, "member": True, "permissions": Q.member_permissions(row),
            "sectionGranted": section_granted}


@router.get("/people")
def people(db: Session = Depends(get_operational_db), _: User = Depends(require_admin)):
    """Dashboard users with the Google email their sheet edits arrive under."""
    overrides = dict(db.query(SheetUserGoogleEmail.user_id, SheetUserGoogleEmail.google_email))
    rows = db.query(User.id, User.name, User.email, User.department).filter(User.is_deleted.is_(False)).order_by(User.name)
    return {"success": True, "people": [
        {"id": uid, "name": name, "email": email, "department": dept,
         "googleEmail": overrides.get(uid) or email, "googleEmailIsOverride": uid in overrides}
        for uid, name, email, dept in rows]}


@router.put("/people/{user_id}/google-email")
def set_google_email(user_id: int, payload: GoogleEmailIn, db: Session = Depends(get_operational_db),
                     admin: User = Depends(require_admin)):
    user = db.get(User, user_id)
    if user is None or user.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    value = (payload.googleEmail or "").strip().lower()
    row = db.query(SheetUserGoogleEmail).filter(SheetUserGoogleEmail.user_id == user_id).first()
    if not value or value == (user.email or "").strip().lower():
        if row:
            db.delete(row)
    elif "@" not in value:
        raise HTTPException(status_code=400, detail="Enter a full Google email address")
    elif row:
        row.google_email, row.updated_by = value, admin.id
    else:
        db.add(SheetUserGoogleEmail(user_id=user_id, google_email=value, updated_by=admin.id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="That Google email is already linked to another user")
    return {"success": True}


# --------------------------------------------------------------------------- #
# Read side (Section Access grant + per-sheet assignment)
# --------------------------------------------------------------------------- #
@router.get("")
def list_sheets(db: Session = Depends(get_operational_db), user: User = Depends(require_sheet_activity_access)):
    ids = Q.visible_sheet_ids(db, user)
    q = db.query(TrackedSheet).order_by(TrackedSheet.name)
    if ids is not None:
        q = q.filter(TrackedSheet.id.in_(ids or [-1]))
    counts = dict(db.query(ContentRequest.sheet_id, func.count(ContentRequest.id))
                  .filter(ContentRequest.removed_at.is_(None)).group_by(ContentRequest.sheet_id))
    admin = Q.is_sheet_admin(user)
    perms = Q.sheet_permissions_for(db, user)
    return {"success": True, "isAdmin": admin, "canAdd": _can_add_sheets(user), "sheets": [
        Q.serialize_sheet(s, members=_members(db, s.id) if admin else None, request_count=counts.get(s.id, 0),
                          permissions=None if perms is None else perms.get(s.id))
        for s in q.all()]}


@router.get("/{sheet_id}")
def get_sheet(sheet_id: int, db: Session = Depends(get_operational_db), user: User = Depends(require_sheet_activity_access)):
    sheet = _get_visible_sheet(db, user, sheet_id)
    return {"success": True, "sheet": _serialize_for(db, user, sheet)}


@router.get("/{sheet_id}/overview")
def sheet_overview(sheet_id: int, tab: Optional[str] = Query(None), db: Session = Depends(get_operational_db),
                   user: User = Depends(require_sheet_activity_access)):
    sheet = _get_visible_sheet(db, user, sheet_id, need="open")
    return {"success": True, **Q.overview(db, sheet, tab=(tab or "").strip() or None)}


def _parse_day(value: Optional[str], name: str):
    if not value:
        return None
    try:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{name} must be a date in YYYY-MM-DD format")


def _filters(tab, status, user, start, end, q, stuck) -> Q.RequestFilters:
    f = Q.RequestFilters(tab=(tab or "").strip() or None, status=(status or "").strip() or None,
                         user=(user or "").strip() or None, start=_parse_day(start, "start"),
                         end=_parse_day(end, "end"), q=(q or "").strip() or None, stuck_only=bool(stuck))
    if f.start and f.end and f.start > f.end:
        raise HTTPException(status_code=400, detail="start must be on or before end")
    return f


@router.get("/{sheet_id}/requests")
def sheet_requests(
    sheet_id: int,
    tab: Optional[str] = Query(None), status: Optional[str] = Query(None), user: Optional[str] = Query(None),
    start: Optional[str] = Query(None), end: Optional[str] = Query(None), q: Optional[str] = Query(None),
    stuck: bool = Query(False), page: int = Query(1, ge=1), pageSize: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db), viewer: User = Depends(require_sheet_activity_access),
):
    sheet = _get_visible_sheet(db, viewer, sheet_id, need="open")
    return {"success": True, **Q.list_requests(db, sheet, _filters(tab, status, user, start, end, q, stuck), page, pageSize)}


@router.get("/{sheet_id}/requests/{request_id}")
def sheet_request_detail(sheet_id: int, request_id: int, db: Session = Depends(get_operational_db),
                         viewer: User = Depends(require_sheet_activity_access)):
    sheet = _get_visible_sheet(db, viewer, sheet_id, need="open")
    req = db.get(ContentRequest, request_id)
    if req is None or req.sheet_id != sheet.id:
        raise HTTPException(status_code=404, detail="Request not found")
    return {"success": True, **Q.request_detail(db, sheet, req)}


def _csv_response(sheet_id: int, viewer: User, db: Session, kind: str, f: Q.RequestFilters):
    sheet = _get_visible_sheet(db, viewer, sheet_id, need="open")
    name = f"{kind}_{sheet.name.replace(' ', '-').lower()}_{datetime.utcnow():%Y-%m-%d}.csv"
    db.close()

    def stream():
        export_db = database_config.OperationalSessionLocal()
        try:
            fresh = export_db.get(TrackedSheet, sheet_id)
            yield from (Q.requests_csv if kind == "requests" else Q.events_csv)(export_db, fresh, f)
        finally:
            export_db.close()

    return StreamingResponse(stream(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/{sheet_id}/requests.csv")
def sheet_requests_csv(sheet_id: int, tab: Optional[str] = Query(None), status: Optional[str] = Query(None),
                       user: Optional[str] = Query(None), start: Optional[str] = Query(None),
                       end: Optional[str] = Query(None), q: Optional[str] = Query(None), stuck: bool = Query(False),
                       db: Session = Depends(get_operational_db), viewer: User = Depends(require_sheet_activity_access)):
    return _csv_response(sheet_id, viewer, db, "requests", _filters(tab, status, user, start, end, q, stuck))


@router.get("/{sheet_id}/events.csv")
def sheet_events_csv(sheet_id: int, tab: Optional[str] = Query(None), status: Optional[str] = Query(None),
                     user: Optional[str] = Query(None), start: Optional[str] = Query(None),
                     end: Optional[str] = Query(None), q: Optional[str] = Query(None), stuck: bool = Query(False),
                     db: Session = Depends(get_operational_db), viewer: User = Depends(require_sheet_activity_access)):
    return _csv_response(sheet_id, viewer, db, "events", _filters(tab, status, user, start, end, q, stuck))


# --------------------------------------------------------------------------- #
# keyword_ranking sheets
# --------------------------------------------------------------------------- #
def _ranking_sheet(db: Session, user: User, sheet_id: int) -> TrackedSheet:
    sheet = _get_visible_sheet(db, user, sheet_id, need="open")
    if sheet.sheet_type != S.KEYWORD_RANKING:
        raise HTTPException(status_code=400, detail="This is not a keyword ranking sheet")
    return sheet


def _kw_filters(tab, bucket, ai, added_by, movement, q) -> RQ.KeywordFilters:
    return RQ.KeywordFilters(tab=(tab or "").strip() or None, bucket=(bucket or "").strip() or None,
                             ai=(ai or "").strip() or None, added_by=(added_by or "").strip() or None,
                             movement=(movement or "").strip() or None, q=(q or "").strip() or None)


def _tab(tab: Optional[str]) -> Optional[str]:
    return (tab or "").strip() or None


@router.get("/{sheet_id}/ranking/overview")
def ranking_overview(sheet_id: int, tab: Optional[str] = Query(None), db: Session = Depends(get_operational_db),
                     user: User = Depends(require_sheet_activity_access)):
    sheet = _ranking_sheet(db, user, sheet_id)
    return {"success": True, "sheet": Q.serialize_sheet(sheet), **RQ.overview(db, sheet, _tab(tab))}


@router.get("/{sheet_id}/ranking/keywords")
def ranking_keywords(sheet_id: int, tab: Optional[str] = Query(None), bucket: Optional[str] = Query(None),
                     ai: Optional[str] = Query(None), addedBy: Optional[str] = Query(None),
                     movement: Optional[str] = Query(None), q: Optional[str] = Query(None),
                     page: int = Query(1, ge=1), pageSize: int = Query(100, ge=1, le=500),
                     db: Session = Depends(get_operational_db), user: User = Depends(require_sheet_activity_access)):
    sheet = _ranking_sheet(db, user, sheet_id)
    rows = RQ.keyword_rows(db, sheet, _kw_filters(tab, bucket, ai, addedBy, movement, q))
    return {"success": True, "total": len(rows), "page": page, "pageSize": pageSize,
            "items": rows[(page - 1) * pageSize: page * pageSize]}


@router.get("/{sheet_id}/ranking/keywords/{keyword_id}")
def ranking_keyword(sheet_id: int, keyword_id: int, db: Session = Depends(get_operational_db),
                    user: User = Depends(require_sheet_activity_access)):
    sheet = _ranking_sheet(db, user, sheet_id)
    kw = db.get(Keyword, keyword_id)
    if kw is None or kw.sheet_id != sheet.id:
        raise HTTPException(status_code=404, detail="Keyword not found")
    return {"success": True, **RQ.keyword_detail(db, sheet, kw)}


@router.get("/{sheet_id}/ranking/runs")
def ranking_runs(sheet_id: int, tab: Optional[str] = Query(None), db: Session = Depends(get_operational_db),
                 user: User = Depends(require_sheet_activity_access)):
    sheet = _ranking_sheet(db, user, sheet_id)
    return {"success": True, "runs": RQ.runs_log(db, sheet, _tab(tab))}


@router.get("/{sheet_id}/ranking/alerts")
def ranking_alerts(sheet_id: int, tab: Optional[str] = Query(None), db: Session = Depends(get_operational_db),
                   user: User = Depends(require_sheet_activity_access)):
    sheet = _ranking_sheet(db, user, sheet_id)
    return {"success": True, "alerts": RQ.alerts(db, sheet, _tab(tab))}


@router.get("/{sheet_id}/ranking/contributors")
def ranking_contributors(sheet_id: int, tab: Optional[str] = Query(None), db: Session = Depends(get_operational_db),
                         user: User = Depends(require_sheet_activity_access)):
    sheet = _ranking_sheet(db, user, sheet_id)
    return {"success": True, "people": RQ.contributors(db, sheet, _tab(tab))}


def _ranking_csv(sheet_id: int, user: User, db: Session, kind: str, f: RQ.KeywordFilters):
    sheet = _ranking_sheet(db, user, sheet_id)
    name = f"{kind}_{sheet.name.replace(' ', '-').lower()}_{datetime.utcnow():%Y-%m-%d}.csv"
    db.close()

    def stream():
        export_db = database_config.OperationalSessionLocal()
        try:
            fresh = export_db.get(TrackedSheet, sheet_id)
            yield from (RQ.keywords_csv if kind == "keywords" else RQ.history_csv)(export_db, fresh, f)
        finally:
            export_db.close()

    return StreamingResponse(stream(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/{sheet_id}/ranking/keywords.csv")
def ranking_keywords_csv(sheet_id: int, tab: Optional[str] = Query(None), bucket: Optional[str] = Query(None),
                         ai: Optional[str] = Query(None), addedBy: Optional[str] = Query(None),
                         movement: Optional[str] = Query(None), q: Optional[str] = Query(None),
                         db: Session = Depends(get_operational_db), user: User = Depends(require_sheet_activity_access)):
    return _ranking_csv(sheet_id, user, db, "keywords", _kw_filters(tab, bucket, ai, addedBy, movement, q))


@router.get("/{sheet_id}/ranking/history.csv")
def ranking_history_csv(sheet_id: int, tab: Optional[str] = Query(None), bucket: Optional[str] = Query(None),
                        ai: Optional[str] = Query(None), addedBy: Optional[str] = Query(None),
                        movement: Optional[str] = Query(None), q: Optional[str] = Query(None),
                        db: Session = Depends(get_operational_db), user: User = Depends(require_sheet_activity_access)):
    return _ranking_csv(sheet_id, user, db, "ranking-history", _kw_filters(tab, bucket, ai, addedBy, movement, q))


# --------------------------------------------------------------------------- #
# Ranking job report: called by the ranking Apps Script, not by a browser
# --------------------------------------------------------------------------- #
class RankingResultIn(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=500)
    targetUrl: Optional[str] = Field(None, max_length=2000)
    position: Optional[int] = Field(None, ge=1, le=1000)
    positionRaw: Optional[str] = Field(None, max_length=120)   # what was written to the sheet, e.g. "Not in Top 50"
    aiOverview: Optional[str] = Field(None, max_length=120)    # Yes / No / No AI Overview
    foundUrl: Optional[str] = Field(None, max_length=2000)     # the URL that actually ranked
    raw: Optional[object] = None                               # API response, trimmed server-side
    error: Optional[str] = Field(None, max_length=1000)


class RankingReportIn(BaseModel):
    spreadsheetId: str = Field(..., min_length=10, max_length=128)
    tab: str = Field(..., min_length=1, max_length=255)
    runDate: date
    runId: Optional[str] = Field(None, max_length=120)
    trigger: Optional[str] = Field(None, pattern="^(scheduled|manual|baseline)$")
    api: Optional[str] = Field(None, max_length=80)
    location: Optional[str] = Field(None, max_length=160)
    gl: Optional[str] = Field(None, max_length=20)
    cost: Optional[float] = Field(None, ge=0)
    durationSeconds: Optional[float] = Field(None, ge=0)
    startedAt: Optional[datetime] = None
    finishedAt: Optional[datetime] = None
    errors: Optional[list] = None
    results: list[RankingResultIn] = Field(default_factory=list, max_length=5000)


@router.post("/ranking-results", dependencies=[Depends(require_webhook_secret)])
def receive_ranking_results(report: RankingReportIn, db: Session = Depends(get_operational_db)):
    sheet = db.query(TrackedSheet).filter(TrackedSheet.spreadsheet_id == report.spreadsheetId).first()
    if sheet is None or sheet.sheet_type != S.KEYWORD_RANKING:
        raise HTTPException(status_code=404, detail="No keyword ranking sheet is registered with that spreadsheet ID")
    if report.tab not in RQ.tracked_tabs(sheet):
        raise HTTPException(status_code=400, detail=f"Tab '{report.tab}' is not tracked for this sheet")
    return {"success": True, **ingest_job_report(db, sheet, report)}
