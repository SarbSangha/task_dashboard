"""Sheet 6 -- ChatGPT Usage Log: one row per captured prompt/response."""

from __future__ import annotations

from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import ReportDataset

LAST_COL = 10


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)

    row = C.title_band(
        ws, "ChatGPT Usage Log — Raw Data (auto-fetched)",
        "One row = one ChatGPT interaction · sortable & filterable via the header dropdowns",
        last_col=LAST_COL,
    )

    cols = [
        C.Col("Date", 13, "center", fmt=T.FMT_DATE, get=lambda e: e.when),
        C.Col("Employee ID", 13, "center", key="employee_id"),
        C.Col("Employee Name", 20, "left", key="employee_name"),
        C.Col("Department", 18, "left", key="department"),
        C.Col("Input (Prompt Summary)", 34, "left", key="prompt"),
        C.Col("Output (Response Summary)", 34, "left", key="response"),
        C.Col("Conversation ID", 20, "left", key="conversation_id"),
        C.Col("Tokens (approx)", 14, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.tokens),
        C.Col("Cost (future)", 13, "right", get=lambda e: "—"),
        C.Col("Status", 12, "center", key="status"),
    ]

    header_row = row
    C.data_table(ws, cols, ds.chatgpt_events, start_row=row, table_name="ChatGPTLog")
    C.freeze_below(ws, header_row + 1, col=2)
