"""Sheet 7 -- Kling Usage Log: one row per video generation."""

from __future__ import annotations

from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import ReportDataset

LAST_COL = 15


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)

    row = C.title_band(
        ws, "Kling Usage Log — Raw Data (auto-fetched)",
        "One row = one Kling generation · sortable & filterable via the header dropdowns",
        last_col=LAST_COL,
    )

    cols = [
        C.Col("Generation Date", 15, "center", fmt=T.FMT_DATE, get=lambda e: e.when),
        C.Col("Employee ID", 12, "center", key="employee_id"),
        C.Col("Employee Name", 18, "left", key="employee_name"),
        C.Col("Department", 16, "left", key="department"),
        C.Col("Prompt", 30, "left", key="prompt"),
        C.Col("Negative Prompt", 20, "left", key="negative_prompt"),
        C.Col("Model", 14, "left", key="model"),
        C.Col("Aspect Ratio", 12, "center", key="aspect_ratio"),
        C.Col("Duration", 11, "center", key="duration"),
        C.Col("Credits Used", 13, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.credits),
        C.Col("Videos", 9, "right", fmt=T.FMT_INT, key="videos"),
        C.Col("Gen Time (min)", 13, "right", fmt=T.FMT_DECIMAL1, get=lambda e: e.gen_time),
        C.Col("Kling ID", 22, "left", key="kling_id"),
        C.Col("Capture Source", 15, "center", key="project"),
        C.Col("Status", 11, "center", key="status"),
    ]

    header_row = row
    C.data_table(ws, cols, ds.kling_events, start_row=row, table_name="KlingLog")
    C.freeze_below(ws, header_row + 1, col=2)
