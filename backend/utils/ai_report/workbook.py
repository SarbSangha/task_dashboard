"""
Workbook orchestrator: build the dataset, then render the seven sheets in order.

This is the module the API/CLI imports. It owns sheet order, tab colours and the
final byte serialization -- nothing else. Each sheet's *content* lives in its own
module under ``sheets/``.
"""

from __future__ import annotations

import io
from datetime import date
from typing import Optional

from openpyxl import Workbook
from sqlalchemy.orm import Session

from . import components as _components
from . import theme as T
from .dataset import ReportDataset, build_dataset
from .sheets import (
    chatgpt_log,
    dashboard,
    employee_summary,
    kling_log,
    overview,
    read_me,
    tool_master,
)

XLSX_MIMETYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# (sheet title, renderer module, tab colour). Order == tab order.
_SHEETS = [
    ("Read Me", read_me, T.NAVY),
    ("Dashboard", dashboard, T.NAVY),
    ("Overview (Summary + Raw Data)", overview, T.GREEN),
    ("Tool Master", tool_master, T.NAVY),
    ("Employee Summary", employee_summary, T.GREEN),
    ("ChatGPT Usage Log", chatgpt_log, T.NAVY_TABLE),
    ("Kling Usage Log", kling_log, T.NAVY_TABLE),
]


def render_workbook(ds: ReportDataset) -> Workbook:
    """Render a fully-populated workbook from an already-built dataset."""
    # Table names must be unique across the whole workbook; reset the guard so
    # repeated builds in one process (e.g. a scheduler) stay clean.
    _components._used_table_names.clear()

    wb = Workbook()
    wb.remove(wb.active)  # drop the default sheet; we create our own

    for title, module, tab in _SHEETS:
        ws = wb.create_sheet(title=title[:31])  # Excel caps sheet names at 31 chars
        ws.sheet_properties.tabColor = tab
        module.render(ws, ds)

    wb.properties.title = "AI Tool Usage Report"
    wb.properties.creator = "AI Dashboard — Automated Reporting"
    wb.properties.subject = f"AI adoption & usage · {ds.period.label}"
    return wb


def build_ai_workbook(
    db: Session,
    *,
    start: Optional[date] = None,
    end: Optional[date] = None,
    ref_date: Optional[date] = None,
) -> tuple[bytes, str, str]:
    """
    Public entry point. Returns ``(xlsx_bytes, mimetype, filename)``.

    A single call reads the DB, assembles the typed snapshot and serializes the
    workbook to bytes ready for a streaming HTTP response. See
    :func:`dataset.build_dataset` for how ``start`` / ``end`` / ``ref_date``
    resolve the reporting window.
    """
    ds = build_dataset(db, start=start, end=end, ref_date=ref_date)
    wb = render_workbook(ds)
    buf = io.BytesIO()
    wb.save(buf)
    filename = f"AI-Usage-Report_{ds.period.end:%Y-%m-%d}.xlsx"
    return buf.getvalue(), XLSX_MIMETYPE, filename
