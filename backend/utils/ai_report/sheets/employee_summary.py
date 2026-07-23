"""
Sheet -- Employee Summary with an inline, four-level expand/collapse drill-down.

Everything lives on this one sheet; nothing navigates away. Excel outline groups
give the +/- controls in the left margin:

    Level 1  Employee row .......... EMP-2026-0011  Devraj Singh  ...
    Level 2    └ Date row .......... 01-Jul-2026 · 52 events
    Level 3        └ Tool row ...... ⊞ Kling · 50 events · 1,495 credits
    Level 4            └ Log rows .. that day's Kling events for that employee

All detail levels are collapsed on open, so the sheet still reads as the plain
employee table until someone drills in.

Trade-off: because detail rows are interleaved between employee rows, this sheet
cannot also be an Excel Table (a ListObject must be a uniform rectangle), so the
header filter dropdowns are not available here. The ChatGPT / Kling Usage Log
sheets keep full filtering for that purpose.
"""

from __future__ import annotations

from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.properties import Outline
from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import Employee, Event, ReportDataset

LAST_COL = 13
_ADOPTION_COL = 11  # column K

# Guard rail: a single employee with a runaway period cannot explode the sheet.
# The full record always remains on the raw ChatGPT / Kling log sheets.
MAX_DETAIL_ROWS_PER_EMPLOYEE = 1500

_TOOL_TINT = {"ChatGPT": T.TINT_CHATGPT, "Kling": T.TINT_KLING}

# Employee columns. Widths are a deliberate compromise: columns B/C also carry
# the prompt/response text of the nested log rows, so they are wider than a
# name/department alone would need.
_EMP_COLS = [
    C.Col("Employee ID", 15, "center", key="employee_id"),
    C.Col("Employee Name", 30, "left", key="name"),
    C.Col("Department", 30, "left", key="department"),
    C.Col("ChatGPT Sessions", 16, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.chatgpt_sessions),
    C.Col("ChatGPT Last Used", 16, "center", fmt=T.FMT_DATE, get=lambda e: e.chatgpt_last),
    C.Col("Kling Videos Made", 14, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.kling_videos),
    C.Col("Kling Credits Used", 15, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.kling_credits),
    C.Col("Kling Last Used", 24, "center", fmt=T.FMT_DATE, get=lambda e: e.kling_last),
    C.Col("Total AI Usage", 13, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.total_usage),
    C.Col("Tools Used", 11, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.tools_used),
    C.Col("Adoption Status", 20, "center", get=lambda e: e.adoption_status),
    C.Col("Composite Score", 14, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.composite_score),
    C.Col("Usage Category", 14, "center", get=lambda e: e.usage_category),
]

# Nested log columns deliberately line up with the employee columns above them:
#   F = Videos  -> "Kling Videos Made"      G = Credits -> "Kling Credits Used"
#   H = Ref ID  -> "Kling Last Used"        E is left blank as a spacer
# so every number in the sheet sits under the header that describes it.
_LOG_COLS = [
    C.Col("Date", 15, "center", fmt=T.FMT_DATE, get=lambda e: e.when),      # A
    C.Col("Prompt / Input", 30, "left", key="prompt"),                      # B
    C.Col("Response / Output", 30, "left", key="response"),                 # C
    C.Col("Model", 16, "left", key="model"),                                # D
    C.Col("", 16, "center"),                                                # E (spacer)
    C.Col("Videos", 14, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.videos),    # F
    C.Col("Credits", 15, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.credits),  # G
]

# Column indexes used to align the date/tool summary bands with the header.
_COL_CHATGPT_COUNT = 4   # D — "ChatGPT Sessions"
_COL_KLING_COUNT = 6     # F — "Kling Videos Made"
_COL_KLING_CREDITS = 7   # G — "Kling Credits Used"


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)
    # Summary rows sit ABOVE their detail, so each +/- lines up with the row clicked.
    ws.sheet_properties.outlinePr = Outline(summaryBelow=False, summaryRight=False)

    row = C.title_band(
        ws, f"Employee Summary — All {len(ds.employees)} Employees (auto-calculated)",
        "Click the + in the left margin to expand an employee → date → tool → that day's log. "
        "Every employee appears here whether or not they used any AI tool.",
        last_col=LAST_COL,
    )

    header_row = row
    row = C.table_header(ws, _EMP_COLS, row=row)
    index = _index_events(ds.merged_events)

    for i, emp in enumerate(ds.employees):
        base = T.FILL_ALT if i % 2 else T.FILL_WHITE
        C.table_row(ws, _EMP_COLS, emp, row_idx=row, fill=base)
        ws.row_dimensions[row].outlineLevel = 0
        emp_row = row
        row += 1
        next_row = _render_detail(ws, emp, index.get(emp.employee_id, {}), row)
        if next_row > row:
            _collapse(ws, emp_row)  # employee row summarises its date groups
        row = next_row

    C.freeze_below(ws, header_row + 1, col=2)
    _apply_adoption_formatting(ws, header_row + 1, row - 1)

    # Filter dropdowns on the header. A plain AutoFilter (unlike an Excel Table)
    # tolerates the interleaved drill-down rows, so filtering and the +/- outline
    # coexist on this sheet.
    ws.auto_filter.ref = f"A{header_row}:{C.col_letter(LAST_COL)}{max(row - 1, header_row)}"


# --------------------------------------------------------------------------- #
# Detail levels
# --------------------------------------------------------------------------- #
def _index_events(events: list[Event]) -> dict:
    """employee_id -> date -> tool -> [events], built in one pass."""
    index: dict = {}
    for ev in events:
        index.setdefault(ev.employee_id, {}).setdefault(ev.when, {}).setdefault(ev.tool, []).append(ev)
    return index


def _render_detail(ws: Worksheet, emp: Employee, by_date: dict, row: int) -> int:
    """Render date -> tool -> log rows beneath one employee. Returns next row."""
    if not by_date:
        return row

    budget = MAX_DETAIL_ROWS_PER_EMPLOYEE
    for day in sorted(d for d in by_date if d is not None):
        by_tool = by_date[day]
        day_credits = sum((ev.credits or 0) for evs in by_tool.values() for ev in evs)

        # Level 2 — the date. Counts sit under the same headers as the employee
        # row above: ChatGPT under D, Kling under F, credits under G.
        date_row = row
        _band_row(ws, row, level=1, fill=T.solid(T.KPI_BAND), indent=1,
                  cells=_count_cells(day, by_tool, day_credits))
        row += 1

        for tool in sorted(by_tool):
            events = by_tool[tool]
            credits = sum((ev.credits or 0) for ev in events)
            tint = T.solid(_TOOL_TINT.get(tool, T.ALT_ROW))

            # Level 3 — the tool for that date
            tool_row = row
            _band_row(ws, row, level=2, fill=tint, indent=2,
                      cells=_count_cells(f"⊞  {tool}", {tool: events}, credits, label_fmt=None))
            row += 1

            # Level 4 — that day's log for that tool
            shown = events[:budget]
            C.table_header(ws, _LOG_COLS, row=row, apply_widths=False)
            _set_level(ws, row, 3)
            row += 1
            for ev in shown:
                C.table_row(ws, _LOG_COLS, ev, row_idx=row, fill=tint)
                _set_level(ws, row, 3)
                row += 1
            budget -= len(shown)

            if len(events) > len(shown):
                note = ws.cell(row=row, column=1,
                               value=f"… {len(events) - len(shown):,} more {tool} event(s) on this date are not "
                                     f"listed (per-employee detail row cap reached). The counts above remain complete.")
                note.font = T.FONT_NOTE
                C.merge(ws, row, 1, row, LAST_COL)
                _set_level(ws, row, 3)
                row += 1

            _collapse(ws, tool_row)  # tool row summarises its log rows
            if budget <= 0:
                _collapse(ws, date_row)
                return row

        _collapse(ws, date_row)  # date row summarises its tool groups
    return row


def _count_cells(label, by_tool: dict, credits: float, label_fmt=T.FMT_DATE) -> list:
    """Build band cells: label in A, per-tool counts under their own headers."""
    cells = [(1, label, label_fmt, "left")]
    chatgpt = len(by_tool.get("ChatGPT", ()))
    kling = len(by_tool.get("Kling", ()))
    if chatgpt:
        cells.append((_COL_CHATGPT_COUNT, chatgpt, T.FMT_INT, "right"))
    if kling:
        cells.append((_COL_KLING_COUNT, kling, T.FMT_INT, "right"))
    if credits:
        cells.append((_COL_KLING_CREDITS, round(credits), T.FMT_INT, "right"))
    return cells


def _band_row(ws: Worksheet, row: int, *, level: int, fill, indent: int, cells) -> None:
    """A summary band (date or tool) spanning the employee columns."""
    for col in range(1, LAST_COL + 1):
        cell = ws.cell(row=row, column=col)
        cell.fill = fill
        cell.border = T.BORDER_CELL
    for col, value, fmt, align in cells:
        cell = ws.cell(row=row, column=col, value=value)
        cell.font = T.FONT_BODY_BOLD
        cell.alignment = (
            Alignment(horizontal="left", vertical="center", indent=indent)
            if align == "left"
            else Alignment(horizontal="right", vertical="center")
        )
        if fmt:
            cell.number_format = fmt
    ws.row_dimensions[row].height = 18
    _set_level(ws, row, level)


def _set_level(ws: Worksheet, row: int, level: int) -> None:
    """Put a row in an outline group and hide it (collapsed by default)."""
    dim = ws.row_dimensions[row]
    dim.outlineLevel = level
    dim.hidden = True


def _collapse(ws: Worksheet, row: int) -> None:
    """Mark a summary row as collapsed.

    Hiding the detail rows alone is not enough: Excel drives the +/- control from
    the ``collapsed`` flag on the summary row. Without it the outline state is
    inconsistent (children hidden but the control still says "expanded") and
    Excel re-expands the group on open.
    """
    ws.row_dimensions[row].collapsed = True


# --------------------------------------------------------------------------- #
def _apply_adoption_formatting(ws: Worksheet, first_row: int, last_row: int) -> None:
    """Colour the Adoption Status column by value.

    Applied across the whole used range: nested detail rows never contain these
    exact strings, so only real employee rows are affected.
    """
    if last_row < first_row:
        return
    col = C.col_letter(_ADOPTION_COL)
    rng = f"{col}{first_row}:{col}{last_row}"
    for value, fill, colour in (
        ("Not Used", T.FILL_NOT_USED, T.TEXT_NOT_USED),
        ("Using Multiple Tools", T.FILL_MULTI, T.TEXT_MULTI),
        ("Using 1 Tool", T.FILL_ONE, T.TEXT_ONE),
    ):
        ws.conditional_formatting.add(
            rng,
            CellIsRule(operator="equal", formula=[f'"{value}"'],
                       fill=PatternFill("solid", fgColor=fill),
                       font=Font(name=T.FONT_NAME, size=10, color=colour)),
        )
