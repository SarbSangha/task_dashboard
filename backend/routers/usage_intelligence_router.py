"""
Usage Intelligence APIs.

Management reporting: organisation / team snapshots (13-sheet Excel) plus a
single-tab individual briefing. All endpoints are admin-gated and read-only.
Prompt text is never returned.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from utils.permissions import require_admin
from utils.usage_intelligence import (
    build_snapshot,
    build_tool_login_report,
    build_tool_login_workbook,
    build_usage_workbook,
    directory as usage_directory,
)

router = APIRouter(prefix="/api/reports/usage", tags=["Usage Intelligence"])


def _snapshot(
    db: Session,
    preset: Optional[str],
    start: Optional[str],
    end: Optional[str],
    department: Optional[str],
    user: Optional[int],
    report_type: Optional[str],
):
    return build_snapshot(
        db,
        preset=preset,
        start=start,
        end=end,
        department=department,
        user_id=user,
        report_type=report_type,
    )


@router.get("/directory")
def usage_directory_endpoint(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return usage_directory(db)


@router.get("/overview")
def usage_overview(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None),
    reportType: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, department, user, reportType)
    # Strip per-user tool arrays from the org payload — they are large and
    # available on /users/{id}. Keep a compact user table for the dashboard.
    compact_users = []
    drop = {"tools", "generationLog", "clientTools"}
    for u in snap.get("users") or []:
        compact_users.append({k: v for k, v in u.items() if k not in drop})
    snap["users"] = compact_users
    snap.pop("timeline", None)
    snap.pop("generationLog", None)
    snap.pop("clientTools", None)
    return snap


@router.get("/preview")
def usage_preview(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None),
    reportType: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, department, user, reportType)
    return {
        "success": True,
        "period": snap["period"],
        "preview": snap["preview"],
        "kpis": snap["kpis"],
        "findings": snap["findings"],
        "actions": snap["actions"][:8],
        "methodology": snap["methodology"],
    }


@router.get("/users")
def usage_users(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    sort: Optional[str] = Query("credits"),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, department, None, "organisation")
    users = [{k: v for k, v in u.items() if k != "tools"} for u in snap.get("users") or []]
    key = (sort or "credits").strip()
    reverse = True
    if key.startswith("-"):
        reverse = False
        key = key[1:]
    if users and key in users[0]:
        users.sort(key=lambda u: (u.get(key) is None, u.get(key) or 0), reverse=reverse)
    return {"success": True, "period": snap["period"], "users": users}


@router.get("/users/{user_id}")
def usage_user_detail(
    user_id: int,
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, None, user_id, "individual")
    return snap


@router.get("/teams")
def usage_teams(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, None, None, "organisation")
    teams = []
    for team in snap.get("teams") or []:
        teams.append({k: v for k, v in team.items() if k != "members"})
    return {"success": True, "period": snap["period"], "teams": teams}


@router.get("/teams/{department}")
def usage_team_detail(
    department: str,
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, department, None, "team")
    return snap


@router.get("/tools")
def usage_tools(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, department, user, None)
    return {"success": True, "period": snap["period"], "tools": snap.get("tools") or []}


@router.get("/workbook.xlsx")
def usage_workbook(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None),
    reportType: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = _snapshot(db, preset, start, end, department, user, reportType)
    db.close()
    data, mimetype, filename = build_usage_workbook(snap)
    return Response(
        content=data,
        media_type=mimetype,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/tool-logins")
def tool_logins(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return build_tool_login_report(db, preset=preset, start=start, end=end, department=department, user_id=user)


@router.get("/tool-logins.xlsx")
def tool_logins_workbook(
    preset: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    user: Optional[int] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    snap = build_tool_login_report(db, preset=preset, start=start, end=end, department=department, user_id=user)
    db.close()
    data, mimetype, filename = build_tool_login_workbook(snap)
    return Response(
        content=data,
        media_type=mimetype,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
