"""Sheet 5 -- Employee Summary: every employee, auto-calculated (incl. zeros)."""

from __future__ import annotations

from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import ReportDataset

LAST_COL = 14
_ADOPTION_COL = 11  # column K


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)

    row = C.title_band(
        ws, f"Employee Summary — All {len(ds.employees)} Employees (auto-calculated)",
        "Every employee appears here whether or not they used any AI tool — this is what makes adoption gaps visible at a glance.",
        last_col=LAST_COL,
    )

    cols = [
        C.Col("Employee ID", 12, "center", key="employee_id"),
        C.Col("Employee Name", 20, "left", key="name"),
        C.Col("Department", 18, "left", key="department"),
        C.Col("ChatGPT Sessions", 13, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.chatgpt_sessions),
        C.Col("ChatGPT Last Used", 15, "center", fmt=T.FMT_DATE, get=lambda e: e.chatgpt_last),
        C.Col("Kling Videos Made", 13, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.kling_videos),
        C.Col("Kling Credits Used", 14, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.kling_credits),
        C.Col("Kling Last Used", 14, "center", fmt=T.FMT_DATE, get=lambda e: e.kling_last),
        C.Col("Total AI Usage", 12, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.total_usage),
        C.Col("Tools Used", 10, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.tools_used),
        C.Col("Adoption Status", 20, "center", get=lambda e: e.adoption_status),
        C.Col("Composite Score", 14, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.composite_score),
        C.Col("AI Maturity Level", 15, "center", get=lambda e: e.maturity_level),
        C.Col("Usage Category", 14, "center", get=lambda e: e.usage_category),
    ]

    header_row = row
    next_row = C.data_table(ws, cols, ds.employees, start_row=row, table_name="EmployeeSummary")
    C.freeze_below(ws, header_row + 1, col=2)

    _apply_adoption_formatting(ws, header_row, len(ds.employees))


def _apply_adoption_formatting(ws: Worksheet, header_row: int, n_rows: int) -> None:
    """Colour the Adoption Status column by value (conditional formatting)."""
    if n_rows == 0:
        return
    col = C.col_letter(_ADOPTION_COL)
    rng = f"{col}{header_row + 1}:{col}{header_row + n_rows}"
    ws.conditional_formatting.add(
        rng,
        CellIsRule(operator="equal", formula=['"Not Used"'],
                   fill=PatternFill("solid", fgColor=T.FILL_NOT_USED),
                   font=Font(name=T.FONT_NAME, size=10, color=T.TEXT_NOT_USED)),
    )
    ws.conditional_formatting.add(
        rng,
        CellIsRule(operator="equal", formula=['"Using Multiple Tools"'],
                   fill=PatternFill("solid", fgColor=T.FILL_MULTI),
                   font=Font(name=T.FONT_NAME, size=10, color=T.TEXT_MULTI)),
    )
    ws.conditional_formatting.add(
        rng,
        CellIsRule(operator="equal", formula=['"Using 1 Tool"'],
                   fill=PatternFill("solid", fgColor=T.FILL_ONE),
                   font=Font(name=T.FONT_NAME, size=10, color=T.TEXT_ONE)),
    )
