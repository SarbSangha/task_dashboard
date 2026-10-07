"""Sheets section: registered Google Sheets of two types.

    content_workflow  each row is a content request (input vs Claude's response)
    keyword_ranking   each row is a keyword; each date column pair is one SEO check run

Shared:
    public_export.py  read a link-shared spreadsheet (one .xlsx export per poll)
    queries.py        visibility, people, content-workflow read side
content_workflow:
    mapping.py, tracker.py
keyword_ranking:
    ranking.py (wide-layout parser + value normalisation), ranking_sync.py
    (importer + job reports), ranking_queries.py (read side, alerts, CSV)

poll_due_sheets() is run by main.py's background loop (SHEETS_POLL_INTERVAL_SECONDS).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from models_new import TrackedSheet

from . import mapping as M
from .public_export import SheetAccessError, fetch_workbook_bytes, open_url, parse_spreadsheet_id, parse_workbook
from .ranking import parse_ranking_workbook
from .ranking_sync import sync_ranking_sheet
from .tracker import claim_poll, sync_sheet

logger = logging.getLogger(__name__)

CONTENT_WORKFLOW = "content_workflow"
KEYWORD_RANKING = "keyword_ranking"
SHEET_TYPES = (CONTENT_WORKFLOW, KEYWORD_RANKING)


def read_sheet(spreadsheet_id: str, header_row: int = 1) -> dict:
    return parse_workbook(fetch_workbook_bytes(spreadsheet_id), header_row=header_row)


def inspect_sheet(url: str) -> dict:
    """Everything the "Add sheet" form needs, for either sheet type: tabs,
    the detected type, and for content sheets a suggested column mapping,
    for ranking sheets the detected layout of each tab."""
    spreadsheet_id = parse_spreadsheet_id(url)
    data = fetch_workbook_bytes(spreadsheet_id)
    ranking = parse_ranking_workbook(data)
    is_ranking = any(t.is_ranking for t in ranking.values())
    tabs = parse_workbook(data)
    tab_rows = []
    for tab in tabs.values():
        rtab = ranking.get(tab.name)
        if is_ranking:
            suggest = bool(rtab and rtab.is_ranking) and not tab.hidden
            layout = {
                "headerRow": rtab.header_row, "subHeaderRow": rtab.sub_header_row, "firstDataRow": rtab.first_data_row,
                "columns": rtab.columns, "runs": len(rtab.runs), "keywords": len(rtab.rows),
                "firstRun": rtab.runs[0].label if rtab.runs else None, "lastRun": rtab.runs[-1].label if rtab.runs else None,
                "problems": rtab.problems,
            } if rtab else None
        else:
            tab_map = M.auto_mapping(tab.headers)
            suggest = bool(M.headers_with_role(tab_map, "topic") and M.headers_with_role(tab_map, "status")) and not tab.hidden
            layout = None
        tab_rows.append({
            "name": tab.name,
            "headers": tab.headers,
            "rows": len(rtab.rows) if is_ranking and rtab else sum(1 for r in tab.rows if any(r.values.values())),
            "hidden": tab.hidden,
            "suggestTracked": suggest,
            "exampleRows": [r.row_number for r in tab.rows if r.is_example] if not is_ranking else [],
            "layout": layout,
        })
    tracked = [t["name"] for t in tab_rows if t["suggestTracked"]]
    headers = M.merged_headers(tabs, tracked or list(tabs)) if not is_ranking else []
    return {
        "spreadsheetId": spreadsheet_id,
        "openUrl": open_url(spreadsheet_id),
        "sheetType": KEYWORD_RANKING if is_ranking else CONTENT_WORKFLOW,
        "tabs": tab_rows,
        "headers": headers,
        "mapping": M.auto_mapping(headers) if not is_ranking else {},
        "statuses": dict(M.DEFAULT_STATUSES),
        "config": dict(M.DEFAULT_CONFIG) if not is_ranking else {"headerRow": None, "subHeaderRow": None, "firstDataRow": None},
    }


def poll_sheet(db: Session, sheet: TrackedSheet, now: Optional[datetime] = None, *, force: bool = False) -> dict:
    now = now or datetime.utcnow()
    if not force and not claim_poll(db, sheet.id, now):
        return {"skipped": "another worker is polling this sheet"}
    try:
        if sheet.sheet_type == KEYWORD_RANKING:
            data = fetch_workbook_bytes(sheet.spreadsheet_id)
            return sync_ranking_sheet(db, sheet, parse_ranking_workbook(data, sheet.config_json or {}), now)
        tabs = read_sheet(sheet.spreadsheet_id, header_row=M.validate_config(sheet.config_json)["headerRow"])
        return sync_sheet(db, sheet, tabs, now)
    except SheetAccessError as exc:
        db.rollback()
        sheet.last_poll_status, sheet.last_poll_error = "error", str(exc)
        db.commit()
        return {"error": str(exc)}
    finally:
        sheet.poll_lease_until = None
        db.commit()


def poll_due_sheets(session_factory) -> list:
    """One pass over every active sheet; each gets its own session so one
    broken sheet never blocks the others."""
    results = []
    with session_factory() as db:
        ids = [sid for (sid,) in db.query(TrackedSheet.id).filter(TrackedSheet.is_active.is_(True))]
    for sid in ids:
        with session_factory() as db:
            sheet = db.get(TrackedSheet, sid)
            if sheet is None or not sheet.is_active:
                continue
            try:
                results.append({"sheetId": sid, **poll_sheet(db, sheet)})
            except Exception as exc:  # noqa: BLE001 - logged, next sheet still runs
                logger.exception("sheet poll failed for %s", sid)
                db.rollback()
                results.append({"sheetId": sid, "error": str(exc)})
    return results


__all__ = ["SheetAccessError", "inspect_sheet", "poll_sheet", "poll_due_sheets", "parse_spreadsheet_id", "open_url",
           "SHEET_TYPES", "CONTENT_WORKFLOW", "KEYWORD_RANKING", "fetch_workbook_bytes", "read_sheet"]
