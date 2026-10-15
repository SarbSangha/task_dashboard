"""
Credit Consumption Report - Excel rendering.

Written with openpyxl in write-only (streaming) mode, so the Generation Log
goes straight from the database cursor to disk and memory stays flat no
matter how wide the date range is. Write-only mode needs every row
position decided before the row is written, so cross-sheet link targets
come from a Layout computed up front from the ReportModel.

The Generation Log is written first (it is still the last tab): writing it
records where each user's rows actually begin and where the first pending,
failed, duplicate and zero-credit rows are, and later sheets link to those
recorded rows rather than predicted ones.

Every other sheet is rendered into a navigation.BufferedSheet first, so
navigation.resolve() can give each link target a "⬅" back cell and point
the link at it before anything reaches the file (see navigation.py).

Link rule: every internal link is a HYPERLINK formula whose label is the
text of the cell it lands on, optionally decorated with a leading
"⬅ Back to " / "⬅ " or a trailing " →" / " ›". E.g. a "Bob" link lands on a
cell that reads "Bob", "Total →" lands on a "Total" row. A link that lands on
a back cell matches its row (or, for a column, its header) instead, and a
back link's own label is checked by a round trip. tests/credit_report_smoke.py
enforces this for every link in the file. HYPERLINK formulas (rather than
sheet hyperlink objects) have no per-sheet count limit, which matters on a
log with hundreds of thousands of rows.
"""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable, Optional
from urllib.parse import quote

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.formatting.rule import ColorScaleRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.filters import AutoFilter
from openpyxl.worksheet.table import Table, TableColumn, TableStyleInfo

from . import navigation as N
from .facts import (CHARGED, CREDITS_NOT_CAPTURED, FAILED, NO_CLIENT, PENDING, UNASSIGNED, UNASSIGNED_USER_ID,
                    ReportFilters, cost_note)
from .model import ReportModel, Top
from .navigation import (  # noqa: F401  (sheet names are part of this module's API)
    BY_DATE, CLIENT, DEPT, DEPT_TOOL, DRILL, HOME, LOG, PERIOD, QUALITY, SHEET_PARENT, TOOL, TREND, USER,
    USER_CLIENT, USER_TOOL,
)

logger = logging.getLogger(__name__)

IST = timedelta(minutes=330)
XLSX_MIMETYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

LISTS = "Lists"            # hidden: dropdown values for Period Explorer
SHEET_ORDER = (HOME, PERIOD, BY_DATE, DEPT, USER, TOOL, CLIENT, DEPT_TOOL, USER_TOOL, USER_CLIENT, TREND, DRILL,
               QUALITY, LOG)

SHEET_PURPOSE = {
    HOME: "Headline numbers, quick answers and this index.",
    PERIOD: "Pick any From / To dates and filters; every total, table and top answer recalculates.",
    BY_DATE: "Every date, then one block per date: who worked that day, for which clients, with which tools.",
    DRILL: "One block per month: departments, users, tools and clients for that month.",
    DEPT: "Departments, then one block per department: its people and the tools they use.",
    USER: "Ranked users, then one block per user: tools used, clients, date-wise use, tool › date › client.",
    TOOL: "Ranked tools (most used first), then one block per tool: users, clients, date-wise use.",
    CLIENT: "Credits, users, top user and top tool for each client.",
    DEPT_TOOL: "Which tool each department uses most (credits).",
    USER_TOOL: "Each user's credits per tool, sorted by department. Filterable.",
    USER_CLIENT: "For which clients each user used each tool, sorted by client.",
    TREND: "Month summary and change, plus every tool, department, user and client by month.",
    QUALITY: "Unassigned, no client, pending, failed, possible duplicates, zero-credit rows.",
    LOG: "Every generation, grouped user › tool › newest first: client, prompt, output, credits, status.",
}

HEADER_ROW = 4
FIRST_DATA_ROW = 5
MAX_CELL_TEXT = 32_000            # Excel's hard cell limit is 32,767
TRUNCATION_MARKER = "…(truncated)"
MAX_LINK_TEXT = 250               # a formula string literal tops out at 255
DUPLICATE_WINDOW_SECONDS = 5
DROP_COLUMN_FILL_BELOW = 0.20     # drop Task / Model when more than 80% empty
DUPLICATE_LABEL = "Possible double charge"
UNASSIGNED_NOTE = "No owner: imported by a history sync and never claimed"
PROMPT_PREVIEW_CHARS = 120
PROMPT_NEWLINE = " ⏎ "
NO_RAW_STATUS = "(not sent by tool)"
STALE_PENDING_HOURS = 24
LINK_LEGEND = "Links: → open details · ⬅ go back · ↔ same item in another view."

# Data Quality issues, in row order (rows are fixed so the log can link back
# to them while it streams, before the Data Quality sheet is written).
STALE_PENDING = f"Pending for over {STALE_PENDING_HOURS} hours"
ZERO_MISSED = "Charged with 0 credits"
NOT_CAPTURED = "Cost not captured"
EXCLUDED = "Test & admin accounts excluded"
RECORDED_TWICE = "Kling job recorded twice"
OWNER_UNCERTAIN = "Owner uncertain"
NO_JOB_ID = "Kling row with no job ID"
RATE_ASSUMED = "Rate assumed"
FREE_PREVIEW = "Free preview model"
UPLOADS = "Uploads (not generations)"
QUALITY_ISSUES = (UNASSIGNED, NO_CLIENT, PENDING, STALE_PENDING, FAILED, DUPLICATE_LABEL, RECORDED_TWICE,
                  OWNER_UNCERTAIN, NO_JOB_ID, ZERO_MISSED, NOT_CAPTURED, RATE_ASSUMED, FREE_PREVIEW, UPLOADS, EXCLUDED)
QUALITY_LINK_COL = "F"
# Fixed short names for the log's "⬅ Data Quality" cells (they fit the column).
QUALITY_SHORT = {PENDING: "Pending", STALE_PENDING: "Pending 24h+", FAILED: "Failed",
                 DUPLICATE_LABEL: "Double charge", ZERO_MISSED: "Zero credits", NOT_CAPTURED: "No cost",
                 OWNER_UNCERTAIN: "Owner uncertain", NO_JOB_ID: "No job ID", RATE_ASSUMED: "Rate assumed",
                 FREE_PREVIEW: "Free preview"}

# Plain names for the reader (Step 4): table headers as shown, outside the log.
HUMAN_HEADERS = {"Generations": "Items generated", "Charged credits": "Credits used", "Credits": "Credits used",
                 "Active users": "People", "Users": "People"}
RUPEES = "₹ cost"
# Indian digit grouping (₹1,09,095): lakh and crore groups by value.
INR_FMT = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"#,##0'
INR2_FMT = '"₹"#,##0.00'

# Generation Log back columns (it is streamed, so they are fixed, not resolved).
# The first three sit at the left, frozen with the header.
LOG_BACK_USER = "⬅ User"
LOG_BACK_TOOL = "⬅ Tool"
LOG_BACK_DATE = "⬅ Date"            # first row of a (user, tool, day, client) run -> Tool › Date › Client
LOG_BACK_TOOL_DATE = "⬅ Tool date"  # same row -> the tool's Date › User › Client
LOG_BACK_CLIENT = "⬅ Client"        # newest run of a (user, tool, client) -> User × Client
LOG_BACK_BYDATE = "⬅ By Date"       # first row of a run -> By Date's User › Client › Tool
LOG_BACK_COLUMNS = (LOG_BACK_USER, "⬅ Tool", LOG_BACK_DATE, LOG_BACK_TOOL_DATE, LOG_BACK_CLIENT, LOG_BACK_BYDATE)
LOG_BACK_QUALITY = "⬅ Data Quality"
LOG_BACK_DRILL = "⬅ Drill-down"
PROMPT_FULL = "Prompt (full)"
LOG_NOTE = "Use filters, don't re-sort: links point to fixed rows."
FILL_LOG_USER = PatternFill("solid", fgColor="BDD7EE")
FILL_LOG_TOOL = PatternFill("solid", fgColor="DDEBF7")

CREDITS_FMT = "#,##0.00"
COUNT_FMT = "#,##0"
PCT_FMT = "0.0%"
DATETIME_FMT = "dd mmm yyyy (ddd) hh:mm:ss"
DATE_ONLY_FMT = "dd mmm yyyy (ddd)"
MONTH_FMT = "mmm yyyy"
WEEK_FMT = "dd mmm yyyy"

NAVY = "1F3864"
F_TITLE = Font(bold=True, size=16, color=NAVY)
F_SUBTITLE = Font(italic=True, color="595959")
F_HEADER = Font(bold=True, color="FFFFFF")
F_LINK = Font(color="0563C1", underline="single")
F_BOLD = Font(bold=True)
F_ITALIC = Font(italic=True, color="595959")
F_KPI_VALUE = Font(bold=True, size=14, color=NAVY)
F_KPI_LABEL = Font(bold=True, size=9, color="595959")
F_SECTION = Font(bold=True, size=12, color=NAVY)
F_HOME_TAG = Font(bold=True, size=9, color="FFFFFF")
FILL_HEADER = PatternFill("solid", fgColor=NAVY)
FILL_KPI = PatternFill("solid", fgColor="DDEBF7")
FILL_PENDING = PatternFill("solid", fgColor="FFF2CC")
FILL_EMPTY = PatternFill("solid", fgColor="FFF2CC")
FILL_WARN = PatternFill("solid", fgColor="FCE4D6")
TOP_BORDER = Border(top=Side(style="thin", color="808080"))
WRAP = Alignment(wrap_text=True, vertical="top")
TOP_ALIGN = Alignment(vertical="top")
TABLE_STYLE = "TableStyleMedium2"
COLOR_SCALE = ColorScaleRule(
    start_type="min", start_color="FFFFFF",
    mid_type="percentile", mid_value=50, mid_color="FFEB84",
    end_type="max", end_color="F8696B",
)
EMPTY_MESSAGE = "No data for this period and these filters."


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def clean_text(value) -> str:
    """Strip characters XML cannot hold and keep under Excel's cell limit."""
    text = ILLEGAL_CHARACTERS_RE.sub("", str(value if value is not None else ""))
    if len(text) > MAX_CELL_TEXT:
        text = text[: MAX_CELL_TEXT - len(TRUNCATION_MARKER)] + TRUNCATION_MARKER
    return text


def _formula_text(value: str) -> str:
    text = clean_text(value).replace("\n", " ")
    if len(text) > MAX_LINK_TEXT:
        text = text[: MAX_LINK_TEXT - 1] + "…"
    return text.replace('"', '""')


def internal_target(sheet: str, row: int, col: str = "A") -> str:
    return f"#'{sheet}'!{col}{row}"


def link_formula(target: str, text: str) -> str:
    return f'=HYPERLINK("{_formula_text(target)}","{_formula_text(text)}")'


def ist(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "").split("+")[0])
        except ValueError:
            return None
    if isinstance(value, datetime):
        return (value.replace(tzinfo=None) + IST).replace(microsecond=0)
    return None


def human_header(label, sheet: str = "") -> str:
    """A table header as the reader sees it ("Generations" -> "Items generated");
    the Generation Log keeps its own column names."""
    return label if sheet == LOG else HUMAN_HEADERS.get(label, label)


def shown_headers(labels, sheet: str = "") -> list:
    """human_header for a whole header row, keeping a label as written when
    its plain name would repeat another column's (table names must be unique)."""
    out, seen = [], set()
    for label in labels:
        name = human_header(label, sheet)
        if str(name).lower() in seen:
            name = label
        seen.add(str(name).lower())
        out.append(name)
    return out


def unique_headers(labels) -> list:
    """Excel Table column names must be non-empty and unique ignoring case."""
    seen, out = set(), []
    for raw in labels:
        base = clean_text(raw).strip() or "Column"
        name, n = base, 2
        while name.lower() in seen:
            name, n = f"{base} ({n})", n + 1
        seen.add(name.lower())
        out.append(name)
    return out


def figures(credits: float, generations: int) -> str:
    return f"{credits:,.2f} credits · {generations:,} gen{'' if generations == 1 else 's'}"


def top_detail(top: Top, name_of=str) -> str:
    """Credits and generations of a "top" answer, plus any tied names."""
    if not top:
        return "—"
    text = figures(top.credits, top.generations)
    if len(top.keys) > 1:
        text += " · tied with " + ", ".join(name_of(k) for k in top.keys[1:])
    return text


class Writer:
    """Builds WriteOnlyCells for one sheet."""

    def __init__(self, ws):
        self.ws = ws
        # Read by navigation.resolve(): links that are plain sheet navigation
        # (no back cell needed), and links to a column whose back cell sits
        # in a given row above its header.
        self.nav_ids: set = set()
        self.back_rows: dict = {}
        self._marked: list = []          # keeps marked cells alive so their ids stay unique

    def cell(self, value=None, *, fmt=None, font=None, fill=None, align=None, border=None, text=False):
        if text and value is not None:
            value = clean_text(value)
        c = WriteOnlyCell(self.ws, value=value)
        if text and value is not None:
            # A prompt such as "=1+1" must stay text, never become a formula.
            c.data_type = "s"
        if fmt:
            c.number_format = fmt
        if font:
            c.font = font
        if fill:
            c.fill = fill
        if align:
            c.alignment = align
        if border:
            c.border = border
        return c

    def text(self, value, **kw):
        return self.cell(value, text=True, **kw)

    def link(self, target: str, label: str, *, back_row: Optional[int] = None, **kw):
        kw.setdefault("font", F_LINK)
        c = self.cell(link_formula(target, label), **kw)
        if back_row is not None:
            self.back_rows[id(c)] = back_row
            self._marked.append(c)
        return c

    def nav(self, target: str, label: str, **kw):
        """A sheet-navigation link; the target sheet's breadcrumb is its way back."""
        c = self.link(target, label, **kw)
        self.nav_ids.add(id(c))
        self._marked.append(c)
        return c

    def go(self, sheet: str, row: int, label: str, col: str = "A", **kw):
        """A navigation link: '<target text> →'."""
        return self.link(internal_target(sheet, row, col), f"{label} →", **kw)

    def credits(self, value, **kw):
        return self.cell(value, fmt=CREDITS_FMT, **kw)

    def count(self, value, **kw):
        return self.cell(value, fmt=COUNT_FMT, **kw)

    def pct(self, value, **kw):
        return self.cell(value, fmt=PCT_FMT, **kw)

    def rupees(self, value, **kw):
        return self.cell(round(value or 0.0, 2), fmt=INR_FMT, **kw)

    def header(self, labels):
        sheet = getattr(self.ws, "title", "")
        return [self.text(h, font=F_HEADER, fill=FILL_HEADER, align=Alignment(wrap_text=True, vertical="center"))
                for h in shown_headers(labels, sheet)]

    def total_cell(self, value=None, fmt=None):
        return self.cell(value, fmt=fmt, font=F_BOLD, border=TOP_BORDER)


def crumb_labels(sheet: str) -> list:
    """Row 1 of a sheet, as text: back link, crumbs, the sheet itself, Period Explorer link."""
    if sheet not in SHEET_PARENT:
        return []
    labels = [f"⬅ Back to {SHEET_PARENT[sheet]}"] + [f"{a}{N.CRUMB_SUFFIX}" for a in N.ancestors(sheet)] + [sheet]
    if sheet != PERIOD:
        labels.append(f"{PERIOD} →")
    return labels


def _new_sheet(wb, name, widths, freeze="A5", buffered=True):
    """A write-only sheet. Buffered sheets collect rows until navigation.resolve()."""
    ws = wb.create_sheet(name)
    widths = list(widths)
    # Row 1 holds one breadcrumb per cell; a cell's text can't spill into a
    # filled neighbour, so each of those columns must fit its crumb. The
    # log's first columns are narrow "⬅" columns: there the crumbs sit one
    # empty cell apart and spill into it instead (see _crumb_row).
    for i, label in enumerate([] if name in SPACED_CRUMBS else crumb_labels(name)):
        need = len(label) + 3
        if i < len(widths):
            widths[i] = max(widths[i], need)
        else:
            widths.append(need)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    if freeze:
        ws.freeze_panes = freeze
    writer = Writer(ws)
    return (N.BufferedSheet(ws, writer) if buffered else ws), writer


SPACED_CRUMBS = {LOG}


def _crumb_row(ws, w: Writer, sheet_name: str):
    """Row 1: '⬅ Back to <parent>', 'Home ›', ..., '<this sheet>', 'Period Explorer →'."""
    parent = SHEET_PARENT[sheet_name]
    cells = [w.nav(internal_target(parent, N.landing_row(parent)), f"⬅ Back to {parent}")]
    cells += [w.nav(internal_target(a, N.landing_row(a)), f"{a}{N.CRUMB_SUFFIX}") for a in N.ancestors(sheet_name)]
    cells.append(w.text(sheet_name, font=F_BOLD))
    if sheet_name != PERIOD:
        cells.append(w.nav(internal_target(PERIOD, 2), f"{PERIOD} →"))
    if sheet_name in SPACED_CRUMBS:
        cells = [c for crumb in cells for c in (crumb, w.cell())]
    ws.append(cells)


def _preamble(ws, w: Writer, sheet_name: str, subtitle: str, title_extra=()):
    """Rows 1-3: breadcrumbs, title (= the sheet's name), subtitle."""
    _crumb_row(ws, w, sheet_name)
    ws.append([w.text(sheet_name, font=F_TITLE)] + list(title_extra))
    ws.append([w.text(f"{subtitle}  {LINK_LEGEND}", font=F_SUBTITLE)])


def _add_table(ws, headers, last_row: int, name: str, header_row: int = HEADER_ROW):
    """Excel Table over header_row..last_row with filter dropdowns."""
    if last_row <= header_row:
        return
    ref = f"A{header_row}:{get_column_letter(len(headers))}{last_row}"
    table = Table(displayName=name, ref=ref)
    sheet = getattr(ws, "title", "")
    # The column names must match the header cells, which Writer.header shows humanized.
    table.tableColumns = [TableColumn(id=i, name=clean_text(h))
                          for i, h in enumerate(shown_headers(headers, sheet), start=1)]
    table.autoFilter = AutoFilter(ref=ref)
    table.tableStyleInfo = TableStyleInfo(name=TABLE_STYLE, showRowStripes=True)
    # openpyxl warns that write-only tables need their columns set by hand;
    # they are set just above, so the warning is noise.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="In write-only mode you must add table columns manually")
        ws.add_table(table)


def _empty_row(ws, w: Writer, ncols: int):
    ws.append([w.text(EMPTY_MESSAGE, fill=FILL_EMPTY)] + [w.cell(fill=FILL_EMPTY) for _ in range(ncols - 1)])


# --------------------------------------------------------------------------- #
# Layout: every link target, decided before anything is written
# --------------------------------------------------------------------------- #
@dataclass
class Layout:
    dept_row: dict = field(default_factory=dict)
    dept_total_row: int = FIRST_DATA_ROW
    user_row: dict = field(default_factory=dict)
    tool_row: dict = field(default_factory=dict)
    client_row: dict = field(default_factory=dict)
    dept_tool_row: dict = field(default_factory=dict)
    dept_block_row: dict = field(default_factory=dict)         # department -> its block's header row on By Department
    date_order: list = field(default_factory=list)             # dates with activity, newest first (By Date)
    date_row: dict = field(default_factory=dict)               # date -> row in By Date's list
    date_block_row: dict = field(default_factory=dict)         # date -> its block's header row on By Date
    date_block_end: dict = field(default_factory=dict)
    date_uct_row: dict = field(default_factory=dict)           # (date, user id, client, tool) -> User › Client › Tool row
    block_sections: dict = field(default_factory=dict)         # (sheet, user / tool / department) -> [(section, title row)]
    dept_block_end: dict = field(default_factory=dict)
    tool_block_row: dict = field(default_factory=dict)         # tool -> its block's header row on By Tool
    tool_block_end: dict = field(default_factory=dict)
    tool_users_row: dict = field(default_factory=dict)         # (tool, user id) -> row in that tool's Users table
    user_block_row: dict = field(default_factory=dict)         # user id -> its block's header row on By User
    user_block_end: dict = field(default_factory=dict)
    user_tools_row: dict = field(default_factory=dict)         # (user id, tool) -> row in that user's Tools used
    user_tdc_row: dict = field(default_factory=dict)           # (user id, tool, day, client) -> Tool › Date › Client row
    user_tdc_date_row: dict = field(default_factory=dict)      # (user id, day or week) -> its first T›D›C row
    user_tdc_client_row: dict = field(default_factory=dict)    # (user id, client) -> its first T›D›C row
    user_clients_row: dict = field(default_factory=dict)       # (user id, client) -> row in the user's Clients
    user_date_row: dict = field(default_factory=dict)          # (user id, day or week) -> row in the user's Date-wise
    user_weekly: dict = field(default_factory=dict)            # user id -> Date-wise grouped by week?
    tool_duc_row: dict = field(default_factory=dict)           # (tool, day, user id, client) -> Date › User › Client row
    tool_duc_date_row: dict = field(default_factory=dict)      # (tool, day or week) -> its first D›U›C row
    tool_date_row: dict = field(default_factory=dict)          # (tool, day or week) -> row in the tool's Date-wise
    tool_weekly: dict = field(default_factory=dict)
    uc_row: dict = field(default_factory=dict)                 # (user id, client, tool) -> User × Client row
    uc_first_run: dict = field(default_factory=dict)           # (user id, tool, client) -> its newest log run key
    tool_list_order: list = field(default_factory=list)        # tools, most used first (By Tool list order)
    user_tool_col: dict = field(default_factory=dict)          # tool -> column letter on User x Tool
    user_tool_first_dept_row: dict = field(default_factory=dict)
    user_client_first_row: dict = field(default_factory=dict)  # client -> first row on User x Client
    quality_row: dict = field(default_factory=dict)
    trend_credits_header_row: int = FIRST_DATA_ROW
    log_first_row: dict = field(default_factory=dict)           # predicted; replaced by actual after the log
    log_cols: dict = field(default_factory=dict)                # header -> column letter
    trend: object = None                                        # workbook_periods.TrendLayout
    drill: object = None                                        # workbook_periods.DrillLayout

    @classmethod
    def plan(cls, model: ReportModel, blocks=None) -> "Layout":
        from . import workbook_blocks as WB
        from .blocks import BlockData, usage_key

        blocks = blocks or BlockData()
        lay = cls()
        for i, d in enumerate(model.departments):
            lay.dept_row[d.name] = FIRST_DATA_ROW + i
            lay.dept_tool_row[d.name] = FIRST_DATA_ROW + i
        lay.dept_total_row = FIRST_DATA_ROW + len(model.departments) + 1
        for i, u in enumerate(model.users):
            lay.user_row[u.user_id] = FIRST_DATA_ROW + i
        # By Tool lists tools most used first (credits, then generations).
        def tool_key(t):
            agg = blocks.tools[t.name].total if t.name in blocks.tools else None
            return usage_key(t.name, agg) if agg else (-round(t.totals.credits, 4), -t.totals.generations, 0, t.name)
        lay.tool_list_order = [t.name for t in sorted(model.tools, key=tool_key)]
        for i, name in enumerate(lay.tool_list_order):
            lay.tool_row[name] = FIRST_DATA_ROW + i
        for i, t in enumerate(model.tools):
            lay.user_tool_col[t.name] = get_column_letter(3 + i)
        for i, c in enumerate(model.clients):
            lay.client_row[c.name] = FIRST_DATA_ROW + i
        for i, uid in enumerate(model.user_tool_order):
            lay.user_tool_first_dept_row.setdefault(model.user(uid).department, FIRST_DATA_ROW + i)
        for i, (uid, _dept, client, tool, _t) in enumerate(model.user_client_rows):
            lay.user_client_first_row.setdefault(client, FIRST_DATA_ROW + i)
            lay.uc_row[(uid, client, tool)] = FIRST_DATA_ROW + i
        # The newest (user, tool, day, client) run of each (user, tool, client):
        # User × Client's log link opens it.
        for key, _row in sorted(blocks.log.quad_row.items(), key=lambda kv: kv[1]):
            uid, tool, _day, client = key
            lay.uc_first_run.setdefault((uid, tool, client), key)
        # Each user's log rows start with a user header row (see blocks.build_blocks).
        lay.log_first_row = dict(blocks.log.user_header)
        lay.quality_row = {issue: FIRST_DATA_ROW + i for i, issue in enumerate(QUALITY_ISSUES)}
        if model.departments:
            WB.plan_dept_blocks(model, blocks, lay, FIRST_DATA_ROW + len(model.departments) + 3)
        WB.plan_date_blocks(blocks, lay)
        # Detail blocks start below each list: list, blank, Total, blank.
        if model.users:
            WB.plan_user_blocks(model, blocks, lay, FIRST_DATA_ROW + len(model.users) + 3)
        if model.tools:
            WB.plan_tool_blocks(lay.tool_list_order, blocks, lay, FIRST_DATA_ROW + len(model.tools) + 3)
        return lay


# --------------------------------------------------------------------------- #
# Generation Log (written first)
# --------------------------------------------------------------------------- #
@dataclass
class LogStats:
    first_row: dict = field(default_factory=dict)        # user_id -> first row
    first_by_status: dict = field(default_factory=dict)  # charge status -> first row
    first_issue_row: dict = field(default_factory=dict)  # Data Quality issue -> first log row
    month_first: dict = field(default_factory=dict)      # "YYYY-MM" -> first log row of that month (log order)
    duplicates: int = 0
    duplicate_credits: float = 0.0
    stale_pending: int = 0
    stale_pending_credits: float = 0.0
    zero_missed_by_tool: dict = field(default_factory=dict)    # tool -> Charged rows with 0 credits
    not_captured_by_tool: dict = field(default_factory=dict)   # Suno / Flow: 0 = never captured
    rows: int = 0                 # physical rows under the header (generations + header / separator rows)
    data_rows: int = 0            # generations only
    credits_by_status: dict = field(default_factory=dict)
    rupees_by_status: dict = field(default_factory=dict)
    rupees_by_tool: dict = field(default_factory=dict)    # Charged ₹ per tool (reconciliation)
    issue_counts: dict = field(default_factory=dict)      # issue -> [rows, credits, ₹]
    plan_mismatches: int = 0      # rows that did not land where blocks.LogPlan said

    @property
    def first_duplicate_row(self) -> Optional[int]:
        return self.first_issue_row.get(DUPLICATE_LABEL)


def log_headers(model: ReportModel) -> list:
    headers = [LOG_BACK_USER, LOG_BACK_TOOL, LOG_BACK_DATE, LOG_BACK_TOOL_DATE, LOG_BACK_CLIENT, LOG_BACK_BYDATE,
               "Date / time (IST)",
               "Date", "Month", "Week", "Quarter", "User", "Employee ID", "Department", "Tool", "Client"]
    if model.task_fill >= DROP_COLUMN_FILL_BELOW:
        headers.append("Task")
    if model.model_fill >= DROP_COLUMN_FILL_BELOW:
        headers.append("Model / type")
    headers += ["Prompt", "Output", "Credits", RUPEES, "Cost note", "Charge status", "Charged", "Raw status",
                DUPLICATE_LABEL, LOG_BACK_QUALITY, LOG_BACK_DRILL, PROMPT_FULL]
    return headers


def prompt_preview(prompt: Optional[str]) -> str:
    """First PROMPT_PREVIEW_CHARS characters on one line; the full text is in PROMPT_FULL."""
    text = clean_text(prompt or "").replace("\r\n", "\n").replace("\r", "\n").replace("\n", PROMPT_NEWLINE)
    return text if len(text) <= PROMPT_PREVIEW_CHARS else text[:PROMPT_PREVIEW_CHARS] + "…"


def _is_duplicate_pair(a, b) -> bool:
    """A possible double charge: same user, tool and prompt within
    DUPLICATE_WINDOW_SECONDS, both charged credits, and the same output.
    Different outputs are deliberate variations or a batch (each one is a
    real charge); one job recorded twice is removed earlier (dedupe.py)."""
    if a["tool"] != b["tool"] or not a["prompt"] or a["prompt"] != b["prompt"]:
        return False
    if a["ts"] is None or b["ts"] is None:
        return False
    if a["charge"] != CHARGED or b["charge"] != CHARGED or a["credits"] <= 0 or b["credits"] <= 0:
        return False
    if not a["output"] or a["output"] != b["output"]:
        return False
    return abs((b["ts"] - a["ts"]).total_seconds()) <= DUPLICATE_WINDOW_SECONDS


def flag_duplicates(rows: Iterable) -> Iterable:
    """Stream rows through a short per-user, per-tool window and mark both
    rows of every possible duplicate pair. Rows arrive grouped by user and
    tool and sorted by time (either direction), so the window only ever holds
    one (user, tool)'s nearest few seconds of rows."""
    window: list = []
    for r in rows:
        entry = {
            "row": r,
            "user": int(r.user_id),
            "tool": r.tool,
            "prompt": (r.prompt or "").strip(),
            "ts": ist(r.occurred_at),
            "charge": r.charge_status,
            "credits": float(r.credits or 0.0),
            "output": (getattr(r, "output_key", None) or "").strip(),
            "dup": False,
        }
        while window and (
            window[0]["user"] != entry["user"] or window[0]["tool"] != entry["tool"]
            or window[0]["ts"] is None or entry["ts"] is None
            or abs((entry["ts"] - window[0]["ts"]).total_seconds()) > DUPLICATE_WINDOW_SECONDS
        ):
            yield window.pop(0)
        for prev in window:
            if _is_duplicate_pair(prev, entry):
                prev["dup"] = entry["dup"] = True
        window.append(entry)
    yield from window


def duplicate_ids(rows: Iterable) -> set:
    """{(tool, record id)} of possible duplicates, from rows in time order
    (stream_log without a tool order): the log's own order can put the two
    rows of a pair apart, so it reads this set instead of a window."""
    return duplicate_summary(rows)[0]


def duplicate_summary(rows: Iterable) -> tuple:
    """(ids as duplicate_ids returns them, rows, ₹ of those rows)."""
    ids, rupees = set(), 0.0
    for e in flag_duplicates(rows):
        if e["dup"]:
            ids.add((e["row"].tool, str(e["row"].record_id)))
            rupees += float(getattr(e["row"], "rupees", 0.0) or 0.0)
    return ids, len(ids), rupees


def _entries(rows: Iterable, duplicates: set) -> Iterable:
    for r in rows:
        yield {"row": r, "user": int(r.user_id), "ts": ist(r.occurred_at), "credits": float(r.credits or 0.0),
               "dup": (r.tool, str(r.record_id)) in duplicates}


HOME_KPI_LINK_ROW = 12        # Home's "Details →" row under the headline numbers
HOME_KPI_GENERATIONS_COL = "C"


@dataclass(frozen=True)
class KlingMarks:
    """Kling log rows to flag (record ids as text): the kept row of a job
    whose owner is uncertain, and Charged rows with no job ID."""

    uncertain: frozenset = frozenset()
    no_job_id: frozenset = frozenset()

    @classmethod
    def of(cls, kling) -> "KlingMarks":
        if kling is None:
            return cls()
        return cls(uncertain=frozenset(str(j.kept.id) for j in kling.uncertain),
                   no_job_id=frozenset(str(r.id) for r in kling.no_job_id))


def _log_issues(r, e, credits: float, stale_before: datetime, marks: KlingMarks = KlingMarks()) -> list:
    """Data Quality issues this log row belongs to (QUALITY_ISSUES names)."""
    issues = []
    if r.charge_status == PENDING:
        issues.append(PENDING)
        if e["ts"] is not None and e["ts"] < stale_before:
            issues.append(STALE_PENDING)
    elif r.charge_status == FAILED:
        issues.append(FAILED)
    if e["dup"]:
        issues.append(DUPLICATE_LABEL)
    if r.tool == "Kling" and str(r.record_id) in marks.uncertain:
        issues.append(OWNER_UNCERTAIN)
    if r.tool == "Kling" and str(r.record_id) in marks.no_job_id:
        issues.append(NO_JOB_ID)
    if r.charge_status == CHARGED and credits == 0:
        issues.append(NOT_CAPTURED if r.tool in CREDITS_NOT_CAPTURED else ZERO_MISSED)
    if r.charge_status == CHARGED and getattr(r, "rate_assumed", 0):
        issues.append(RATE_ASSUMED)
    if r.charge_status == CHARGED and getattr(r, "preview", 0):
        issues.append(FREE_PREVIEW)
    return issues


def _write_log(sheets, model: ReportModel, lay: Layout, rows: Iterable, dashboard_url: str, period_label: str,
               generated_at: datetime, blocks=None, duplicates: set = frozenset(),
               marks: KlingMarks = KlingMarks()) -> LogStats:
    """Stream the log: user header row, then per tool a separator row and its
    generations newest first (blocks.LogPlan decided every row up front)."""
    from .blocks import BlockData
    from .workbook_blocks import (DATE_UCT_LINK_COL, TOOL_DUC_LINK_COL, TOOL_USERS_LINK_COL, USER_ALL_GENS_COL,
                                  USER_TDC_LINK_COL, USER_TOOLS_LINK_COL)

    blocks = blocks or BlockData()
    plan = blocks.log
    ws, w = sheets[LOG]
    headers = log_headers(model)
    lay.log_cols = {h: get_column_letter(i) for i, h in enumerate(headers, start=1)}
    # The log is streamed, so its back cells are fixed here rather than
    # resolved: Home's "Generations" headline lands on C2.
    _preamble(ws, w, LOG, f"{period_label} · {LOG_NOTE} Grouped by user, then tool (most used first), then day "
                          "(newest first), then client, then time; a shaded row starts each user and each tool. Every charge status is listed; summary "
                          f"sheets count Charged rows only. Prompt shows the first {PROMPT_PREVIEW_CHARS} characters; "
                          f"the whole prompt is in \"{PROMPT_FULL}\" (last column).",
              title_extra=[] if model.is_empty else [
                  w.cell(), w.link(internal_target(HOME, HOME_KPI_LINK_ROW, HOME_KPI_GENERATIONS_COL),
                                   N.back_label(HOME), font=N.F_BACK,
                                   fill=N.FILL_BACK)])
    ws.append(w.header(headers))
    stats = LogStats()
    base = (dashboard_url or "").rstrip("/")
    stale_before = generated_at - timedelta(hours=STALE_PENDING_HOURS)
    drill_rows = lay.drill.block_row if lay.drill else {}
    current = FIRST_DATA_ROW
    width = len(headers)
    col = {h: i for i, h in enumerate(headers)}

    def back(sheet, row, column, label):
        return w.link(internal_target(sheet, row, column), label, font=N.F_BACK, fill=N.FILL_BACK)

    def back_user(uid, tool, name):
        row = lay.user_tools_row.get((uid, tool))
        return back(USER, row, USER_TOOLS_LINK_COL, N.back_label(USER)) if row else w.cell()

    def back_tool(uid, tool):
        row = lay.tool_users_row.get((tool, uid))
        return back(TOOL, row, TOOL_USERS_LINK_COL, N.back_label(TOOL)) if row else w.cell()

    def check(planned, what):
        if planned is not None and planned != current:
            stats.plan_mismatches += 1
            logger.warning("credit report: %s planned for log row %s, written at %s", what, planned, current)

    def marker_row(fill, cells: dict):
        out = [w.cell(fill=fill) for _ in range(width)]
        for h, c in cells.items():
            c.fill = fill
            out[col[h]] = c
        return out

    seen_user, seen_pair, seen_run = None, None, None
    seen_uc = set()
    for e in _entries(rows, duplicates):
        r = e["row"]
        uid = e["user"]
        try:
            u = model.user(uid)
        except KeyError:  # captured after the summaries were read
            u = None
        user_name = u.label if u else f"User {uid}"
        department = u.department if u else ""
        ts = e["ts"]
        day = datetime(ts.year, ts.month, ts.day) if ts else None
        if uid != seen_user:
            # User header row: "⬅ User" returns to the user's block header.
            seen_user, seen_pair = uid, None
            check(plan.user_header.get(uid), f"{user_name}'s header")
            stats.first_row.setdefault(uid, current)
            ut = blocks.users.get(uid)
            text = (f"{user_name} · {ut.total.rows:,} generation{'' if ut.total.rows == 1 else 's'} · "
                    f"{ut.total.credits:,.2f} credits · {len(ut.tools)} tool{'' if len(ut.tools) == 1 else 's'}"
                    if ut else user_name)
            ws.append(marker_row(FILL_LOG_USER, {
                LOG_BACK_USER: (back(USER, lay.user_block_row[uid], USER_ALL_GENS_COL, N.back_label(USER))
                                if uid in lay.user_block_row else w.cell()),
                "Date / time (IST)": w.text(text, font=F_BOLD),
                "User": w.text(user_name, font=F_BOLD), "Department": w.text(department)}))
            current += 1
        if (uid, r.tool) != seen_pair:
            # Separator: Tools used ("⬅ User") and the tool's Users table ("⬅ Tool") link here.
            seen_pair, seen_run = (uid, r.tool), None
            check(plan.pair_row.get((uid, r.tool)), f"{user_name} · {r.tool} separator")
            pt = blocks.users.get(uid).tools.get(r.tool) if blocks.users.get(uid) else None
            text = (f"{user_name} · {r.tool} · {pt.rows:,} generation{'' if pt.rows == 1 else 's'} · "
                    f"{pt.credits:,.2f} credits" if pt else f"{user_name} · {r.tool}")
            ws.append(marker_row(FILL_LOG_TOOL, {
                LOG_BACK_USER: back_user(uid, r.tool, user_name), LOG_BACK_TOOL: back_tool(uid, r.tool),
                "Date / time (IST)": w.text(text, font=F_BOLD),
                "User": w.text(user_name), "Department": w.text(department), "Tool": w.text(r.tool, font=F_BOLD)}))
            current += 1
        day_key = day.date() if day else None
        client = r.client or NO_CLIENT
        run = (uid, r.tool, day_key, client)
        back_date = back_tool_date = back_client = back_by_date = w.cell()
        if run != seen_run:
            # First row of a (user, tool, day, client) run: the user's Tool ›
            # Date › Client row ("⬅ Date"), the tool's Date › User › Client row
            # ("⬅ Tool date") and, for its newest run, User × Client ("⬅ Client")
            # link here.
            seen_run = run
            check(plan.quad_row.get(run), f"{user_name} · {r.tool} · {day_key} · {client}")
            tdc = lay.user_tdc_row.get(run)
            if tdc:
                back_date = back(USER, tdc, USER_TDC_LINK_COL, N.back_label(USER, f"{day_key:%d %b}"))
            duc = lay.tool_duc_row.get((r.tool, day_key, uid, client))
            if duc:
                back_tool_date = back(TOOL, duc, TOOL_DUC_LINK_COL, N.back_label(TOOL, f"{day_key:%d %b}"))
            uct = lay.date_uct_row.get((day_key, uid, client, r.tool))
            if uct:
                back_by_date = back(BY_DATE, uct, DATE_UCT_LINK_COL, N.back_label(BY_DATE, f"{day_key:%d %b}"))
            uc = (uid, client, r.tool)
            if uc not in seen_uc and lay.uc_first_run.get((uid, r.tool, client)) == run and uc in lay.uc_row:
                seen_uc.add(uc)
                back_client = back(USER_CLIENT, lay.uc_row[uc], UC_LINK_COL, N.back_label(USER_CLIENT))

        stats.first_by_status.setdefault(r.charge_status, current)
        credits = e["credits"]
        rupees = float(getattr(r, "rupees", 0.0) or 0.0)
        stats.credits_by_status[r.charge_status] = stats.credits_by_status.get(r.charge_status, 0.0) + credits
        stats.rupees_by_status[r.charge_status] = stats.rupees_by_status.get(r.charge_status, 0.0) + rupees
        if r.charge_status == CHARGED:
            stats.rupees_by_tool[r.tool] = stats.rupees_by_tool.get(r.tool, 0.0) + rupees
        if e["dup"]:
            stats.duplicates += 1
            stats.duplicate_credits += credits
        issues = _log_issues(r, e, credits, stale_before, marks)
        for issue in issues:
            c = stats.issue_counts.setdefault(issue, [0, 0.0, 0.0])
            c[0] += 1
            c[1] += credits
            c[2] += rupees
        if STALE_PENDING in issues:
            stats.stale_pending += 1
            stats.stale_pending_credits += credits
        if ZERO_MISSED in issues:
            stats.zero_missed_by_tool[r.tool] = stats.zero_missed_by_tool.get(r.tool, 0) + 1
        if NOT_CAPTURED in issues:
            stats.not_captured_by_tool[r.tool] = stats.not_captured_by_tool.get(r.tool, 0) + 1
        # Data Quality links to the first row of each issue; that row's
        # back cell returns to the issue (or to the list, if several).
        claimed = [i for i in issues if i not in stats.first_issue_row]
        for issue in claimed:
            stats.first_issue_row[issue] = current
        if len(claimed) == 1:
            back_quality = back(QUALITY, lay.quality_row[claimed[0]], QUALITY_LINK_COL,
                                f"⬅ {QUALITY_SHORT.get(claimed[0], claimed[0])}")
        elif claimed:
            back_quality = back(QUALITY, N.list_row(QUALITY), "A", N.back_label(QUALITY, listed=True))
        else:
            back_quality = w.cell()
        output_url = f"{base}/open-output?ref={quote(r.tool)}:{quote(str(r.record_id))}" if r.has_output and base else ""
        output = w.link(output_url, "Open output") if output_url else w.text("—")
        back_drill = w.cell()
        if ts:
            key = f"{ts:%Y-%m}"
            if key not in stats.month_first:
                # First generation row of the month in log order: Month
                # Drill-down's "first row" link lands here.
                stats.month_first[key] = current
                if key in drill_rows:
                    back_drill = back(DRILL, drill_rows[key] + 1, "B", N.back_label(DRILL))
        raw_status = (getattr(r, "raw_status", None) or r.status or "").strip()
        values = {
            LOG_BACK_USER: back_user(uid, r.tool, user_name),
            LOG_BACK_TOOL: back_tool(uid, r.tool),
            LOG_BACK_DATE: back_date,
            LOG_BACK_TOOL_DATE: back_tool_date,
            LOG_BACK_CLIENT: back_client,
            LOG_BACK_BYDATE: back_by_date,
            "Date / time (IST)": w.cell(ts, fmt=DATETIME_FMT, align=TOP_ALIGN),
            "Date": w.cell(day, fmt=DATE_ONLY_FMT, align=TOP_ALIGN),
            "Month": w.cell(day.replace(day=1) if day else None, fmt=MONTH_FMT, align=TOP_ALIGN),
            "Week": w.cell(day - timedelta(days=day.weekday()) if day else None, fmt=WEEK_FMT, align=TOP_ALIGN),
            "Quarter": w.text(f"{ts.year}-Q{(ts.month - 1) // 3 + 1}" if ts else "", align=TOP_ALIGN),
            "User": w.text(user_name, align=TOP_ALIGN),
            "Employee ID": w.text(u.employee_id if u else "", align=TOP_ALIGN),
            "Department": w.text(department, align=TOP_ALIGN),
            "Tool": w.text(r.tool, align=TOP_ALIGN),
            "Client": w.text(client, align=TOP_ALIGN),
            "Task": w.text(r.task or "—", align=TOP_ALIGN),
            "Model / type": w.text(r.model or "—", align=TOP_ALIGN),
            # No wrapping anywhere in a data row, so every row stays one line (15pt).
            "Prompt": w.text(prompt_preview(r.prompt), align=TOP_ALIGN),
            "Output": output,
            "Credits": w.credits(credits, align=TOP_ALIGN,
                                 fill=FILL_WARN if ZERO_MISSED in issues else None),
            RUPEES: w.cell(round(rupees, 2), fmt=INR2_FMT, align=TOP_ALIGN),
            "Cost note": w.text(cost_note(r), align=TOP_ALIGN),
            "Charge status": w.text(r.charge_status, align=TOP_ALIGN,
                                    fill=FILL_PENDING if r.charge_status == PENDING else (FILL_WARN if r.charge_status == FAILED else None)),
            "Charged": w.cell(r.charge_status == CHARGED, align=TOP_ALIGN),
            "Raw status": w.text(raw_status or NO_RAW_STATUS, align=TOP_ALIGN),
            DUPLICATE_LABEL: w.text(DUPLICATE_LABEL if e["dup"] else "", align=TOP_ALIGN, fill=FILL_WARN if e["dup"] else None),
            LOG_BACK_QUALITY: back_quality,
            LOG_BACK_DRILL: back_drill,
            PROMPT_FULL: w.text(r.prompt or "", align=TOP_ALIGN),
        }
        ws.append([values[h] for h in headers])
        current += 1
        stats.data_rows += 1
    stats.rows = current - FIRST_DATA_ROW
    last = current - 1
    if last < FIRST_DATA_ROW:
        _empty_row(ws, w, len(headers))
    else:
        _add_table(ws, headers, last, "tblGenerationLog")
        ws.append([])
        credit_idx = headers.index("Credits")
        ws.append([w.text("Total (every charge status)", font=F_BOLD, border=TOP_BORDER)]
                  + [w.total_cell() for _ in range(credit_idx - 1)]
                  + [w.total_cell(sum(stats.credits_by_status.values()), CREDITS_FMT),
                     w.total_cell(round(sum(stats.rupees_by_status.values()), 2), INR2_FMT)])
    if stats.data_rows != sum(model.log_counts.values()) or (plan.last_row and plan.last_row != last):
        # Only possible if data changed between the summary queries and the
        # log stream, which the router's REPEATABLE READ snapshot prevents.
        logger.warning("credit report: log has %s rows (last row %s), summaries expected %s (last row %s)",
                       stats.data_rows, last, sum(model.log_counts.values()), plan.last_row)
    return stats


# --------------------------------------------------------------------------- #
# Summary sheets
# --------------------------------------------------------------------------- #
def _user_name(model):
    return lambda uid: model.user(uid).label


def as_datetime(d) -> Optional[datetime]:
    return datetime(d.year, d.month, d.day) if d else None


def user_link(w, lay, uid, label: str, tool: Optional[str] = None):
    """A user's name, linking to their block on By User - to the tool's row in
    its Tools used table when a tool is given - else to their list row."""
    if tool is not None and (uid, tool) in lay.user_tools_row:
        return w.link(internal_target(USER, lay.user_tools_row[(uid, tool)]), label)
    if uid in lay.user_block_row:
        return w.link(internal_target(USER, lay.user_block_row[uid]), label)
    return w.link(internal_target(USER, lay.user_row[uid]), label) if uid in lay.user_row else w.text(label)


def tool_link(w, lay, tool: str, uid=None, label: Optional[str] = None):
    """A tool's name, linking to its block on By Tool - to the user's row in
    its Users table when a user is given - else to its list row."""
    label = label or tool
    if uid is not None and (tool, uid) in lay.tool_users_row:
        return w.link(internal_target(TOOL, lay.tool_users_row[(tool, uid)]), label)
    if tool in lay.tool_block_row:
        return w.link(internal_target(TOOL, lay.tool_block_row[tool]), label)
    return w.link(internal_target(TOOL, lay.tool_row[tool]), label) if tool in lay.tool_row else w.text(label)


def client_link(w, lay, client: str):
    return w.link(internal_target(CLIENT, lay.client_row[client]), client) if client in lay.client_row else w.text(client)


def _top_user_link(w, model, lay, top: Top):
    if not top:
        return w.text("—")
    return user_link(w, lay, top.first, model.user(top.first).label)


def _top_named_user_cell(w, model, lay, row):
    """'Top named user' beside a top user that is Unassigned."""
    if row.top_user.first == UNASSIGNED_USER_ID and row.top_named_user:
        return user_link(w, lay, row.top_named_user.first, model.user(row.top_named_user.first).label)
    return w.text("—")


def _top_link(w, sheet: str, rows: dict, top: Top, lay=None):
    if not top:
        return w.text("—")
    if sheet == TOOL and lay is not None:
        return tool_link(w, lay, top.first)
    return w.link(internal_target(sheet, rows[top.first]), str(top.first))


def sideways(name: str, view: str) -> str:
    """Label of a link to the same item in another view: '↔ Bob in Monthly Trend'.

    Link direction rule: a name goes down (to the item's own block or row,
    or deeper); only "⬅" cells go back; a sideways link has its own "↔" cell
    and goes one way - where it lands, the item's name is plain text and the
    "⬅" cell is the way back."""
    return f"↔ {name} in {view}"


def _trend_link(w, lay, kind: str, key, label: str):
    """'<name> →' to the entity's row (users, clients) or column (tools,
    departments) in Monthly Trend's credits tables."""
    t = lay.trend
    if t is None:
        return w.text("—")
    text = sideways(label, TREND)
    if kind == "user" and key in t.user_row:
        return w.link(internal_target(TREND, t.user_row[key]), text)
    if kind == "client" and key in t.client_row:
        return w.link(internal_target(TREND, t.client_row[key]), text)
    # Columns: the back cell sits in the table's title row, just above the header.
    if kind == "tool" and key in t.tool_col:
        return w.link(internal_target(TREND, t.tool_credits_header, t.tool_col[key]), text,
                      back_row=t.tool_credits_header - 1)
    if kind == "dept" and key in t.dept_col:
        return w.link(internal_target(TREND, t.dept_credits_header, t.dept_col[key]), text,
                      back_row=t.dept_credits_header - 1)
    return w.text("—")


def _write_departments(sheets, model, lay, period_label, blocks):
    from . import workbook_blocks as WB

    ws, w = sheets[DEPT]
    headers = ["Department", "Credits", RUPEES, "% of total", "Generations", "Pending credits", "Active users",
               "Top user", "Top user credits · gens", "Top named user", "Top tool", "Top tool credits · gens",
               "In User × Tool", "In Monthly Trend", "In Dept × Tool"]
    _preamble(ws, w, DEPT, f"{period_label} · Charged credits. A department name opens its block below (its people "
                           "and the tools they use; collapse it with the − button). ↔ cells open the same department "
                           "in another sheet.")
    ws.append(w.header(headers))
    for d in model.departments:
        t = d.totals
        block = lay.dept_block_row.get(d.name)
        ws.append([
            w.nav(internal_target(DEPT, block), d.name) if block else w.text(d.name),
            w.credits(t.credits), w.rupees(t.rupees), w.pct(d.share), w.count(t.generations),
            w.credits(t.pending_credits), w.count(d.users),
            _top_user_link(w, model, lay, d.top_user), w.text(top_detail(d.top_user, _user_name(model))),
            _top_named_user_cell(w, model, lay, d),
            _top_link(w, TOOL, lay.tool_row, d.top_tool, lay), w.text(top_detail(d.top_tool)),
            w.link(internal_target(USER_TOOL, lay.user_tool_first_dept_row[d.name], "B"), sideways(d.name, USER_TOOL)),
            _trend_link(w, lay, "dept", d.name, d.name),
            w.link(internal_target(DEPT_TOOL, lay.dept_tool_row[d.name]), sideways(d.name, DEPT_TOOL)),
        ])
    if not model.departments:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.departments) - 1, "tblDepartments")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(t.credits, CREDITS_FMT),
               w.total_cell(round(t.rupees, 2), INR_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT), w.total_cell(t.generations, COUNT_FMT),
               w.total_cell(t.pending_credits, CREDITS_FMT), w.total_cell(len(t.users), COUNT_FMT)])
    ws.append([])
    WB.write_dept_blocks(sheets, model, blocks, lay)


def dept_members(model, department: str) -> list:
    """The department's people, in By User order (most credits first)."""
    return [u for u in model.users if u.department == department]


def _pick_detail(pick) -> str:
    if not pick.name:
        return "—"
    a = pick.agg
    text = f"{a.credits:,.2f} credits · {a.gens:,} gen{'' if a.gens == 1 else 's'}"
    return text + " (by generations: no credits recorded)" if pick.by_generations else text


def _write_users(sheets, model, lay, period_label, blocks):
    from . import workbook_blocks as WB

    ws, w = sheets[USER]
    headers = ["User", "Employee ID", "Department", "Credits", RUPEES, "% of company total", "Generations",
               "Credits per generation", "Pending credits", "% generations with a client", "Rank in company",
               "Rank in department", "Most used tool", "Most used tool credits · gens", "Mostly works on client",
               "Client share", "In Monthly Trend", "Open"]
    _preamble(ws, w, USER, f"{period_label} · Charged credits. A name or \"Open block →\" opens that user's block "
                           "below (tools, clients, date-wise, tool › date › client; collapse it with the − button). "
                           f"\"Unassigned\" = {UNASSIGNED_NOTE.lower()}; it is not ranked.")
    ws.append(w.header(headers))
    for u in model.users:
        t = u.totals
        d = blocks.users.get(u.user_id)
        block = lay.user_block_row.get(u.user_id)
        # Down to the block is plain navigation: its header links straight back here.
        name_cell = w.nav(internal_target(USER, block), u.label) if block else w.text(u.label)
        if u.is_unassigned:
            name_cell.font = Font(color="0563C1", underline="single", italic=True)
        tool = d.most_used_tool() if d else None
        client = d.top_client() if d else None
        ws.append([
            name_cell,
            w.text(u.employee_id),
            w.link(internal_target(DEPT, lay.dept_row[u.department]), u.department),
            w.credits(t.credits), w.rupees(t.rupees), w.pct(u.share), w.count(t.generations),
            w.credits(t.credits_per_generation),
            w.credits(t.pending_credits), w.pct(u.client_rate),
            w.count(u.company_rank) if isinstance(u.company_rank, int) else w.text(u.company_rank),
            w.count(u.department_rank) if isinstance(u.department_rank, int) else w.text(u.department_rank),
            user_link(w, lay, u.user_id, tool.name, tool=tool.name) if tool and tool.name else w.text("—"),
            w.text(_pick_detail(tool) if tool else "—"),
            client_link(w, lay, client.name) if client and client.name else w.text("—"),
            w.text(f"{client.share:.0%} of {'generations' if client.by_generations else 'credits'}"
                   if client and client.name else "—"),
            _trend_link(w, lay, "user", u.user_id, u.label),
            w.nav(internal_target(USER, block), "Open block →") if block else w.text("—"),
        ])
    if not model.users:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.users) - 1, "tblUsers")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(), w.total_cell(),
               w.total_cell(t.credits, CREDITS_FMT), w.total_cell(round(t.rupees, 2), INR_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT),
               w.total_cell(t.generations, COUNT_FMT), w.total_cell(t.credits_per_generation, CREDITS_FMT),
               w.total_cell(t.pending_credits, CREDITS_FMT)])
    ws.append([])
    WB.write_user_blocks(sheets, model, blocks, lay)


def _write_tools(sheets, model, lay, period_label, blocks):
    from . import workbook_blocks as WB

    ws, w = sheets[TOOL]
    headers = ["Tool", "Credits", RUPEES, "% of total", "Generations", "Credits per generation", "Pending credits",
               "Users",
               "Rank", "Top user", "Top user credits · gens", "Top named user", "Top client", "Top department",
               "Top department credits · gens", "Cost", "In Monthly Trend", "In User × Tool", "Open"]
    by_name = {t.name: t for t in model.tools}
    free = model.tools and all(t.totals.credits == 0 for t in model.tools)
    _preamble(ws, w, TOOL, f"{period_label} · Charged credits, most used first"
                           + (" (no credits recorded, so ranked by generations)" if free else "")
                           + ". A name or \"Open block →\" opens that tool's block below (users, clients, date-wise).")
    ws.append(w.header(headers))
    for i, name in enumerate(lay.tool_list_order):
        r = by_name[name]
        t = r.totals
        d = blocks.tools.get(name)
        block = lay.tool_block_row.get(name)
        client = d.top_client() if d else None
        ws.append([
            w.nav(internal_target(TOOL, block), name) if block else w.text(name),
            w.credits(t.credits), w.rupees(t.rupees), w.pct(r.share), w.count(t.generations),
            w.credits(t.credits_per_generation),
            w.credits(t.pending_credits), w.count(r.users),
            w.text("1 ★ Most used" if i == 0 else str(i + 1), font=F_BOLD if i == 0 else None),
            _top_user_link(w, model, lay, r.top_user), w.text(top_detail(r.top_user, _user_name(model))),
            _top_named_user_cell(w, model, lay, r),
            client_link(w, lay, client.name) if client and client.name else w.text("—"),
            _top_link(w, DEPT, lay.dept_row, r.top_department), w.text(top_detail(r.top_department)),
            w.text(r.cost_note or "Recorded", fill=FILL_WARN if r.cost_note else None, align=WRAP),
            _trend_link(w, lay, "tool", name, name),
            # Lands above the tool's column header (row 2), where its back cell sits.
            w.link(internal_target(USER_TOOL, HEADER_ROW, lay.user_tool_col[name]), sideways(name, USER_TOOL),
                   back_row=N.TITLE_ROW),
            w.nav(internal_target(TOOL, block), "Open block →") if block else w.text("—"),
        ])
    if not model.tools:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.tools) - 1, "tblTools")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(t.credits, CREDITS_FMT),
               w.total_cell(round(t.rupees, 2), INR_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT), w.total_cell(t.generations, COUNT_FMT),
               w.total_cell(t.credits_per_generation, CREDITS_FMT), w.total_cell(t.pending_credits, CREDITS_FMT)])
    ws.append([])
    WB.write_tool_blocks(sheets, model, blocks, lay, lay.tool_list_order)


def _write_clients(sheets, model, lay, period_label):
    ws, w = sheets[CLIENT]
    headers = ["Client", "Credits", RUPEES, "% of total", "Generations", "Pending credits", "Users",
               "Top user", "Top user credits · gens", "Top named user", "Top tool", "Top tool credits · gens",
               "In Monthly Trend", "In User × Client"]
    _preamble(ws, w, CLIENT, f"{period_label} · Charged credits. ↔ cells open the same client in another sheet.")
    ws.append(w.header(headers))
    for r in model.clients:
        t = r.totals
        first = lay.user_client_first_row.get(r.name)
        name = w.text(r.name, font=Font(italic=True) if r.name == NO_CLIENT else None)
        ws.append([
            name, w.credits(t.credits), w.rupees(t.rupees), w.pct(r.share), w.count(t.generations),
            w.credits(t.pending_credits), w.count(r.users),
            _top_user_link(w, model, lay, r.top_user), w.text(top_detail(r.top_user, _user_name(model))),
            _top_named_user_cell(w, model, lay, r),
            _top_link(w, TOOL, lay.tool_row, r.top_tool, lay), w.text(top_detail(r.top_tool)),
            _trend_link(w, lay, "client", r.name, r.name),
            w.link(internal_target(USER_CLIENT, first, "C"), sideways(r.name, USER_CLIENT)) if first else w.text("—"),
        ])
    if not model.clients:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.clients) - 1, "tblClients")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(t.credits, CREDITS_FMT),
               w.total_cell(round(t.rupees, 2), INR_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT), w.total_cell(t.generations, COUNT_FMT),
               w.total_cell(t.pending_credits, CREDITS_FMT)])


def _write_dept_tool(sheets, model, lay, period_label):
    ws, w = sheets[DEPT_TOOL]
    tools = [t.name for t in model.tools]
    headers = unique_headers(["Department"] + tools + ["Total", RUPEES, "Most used tool",
                                                       "Most used tool credits · gens"])
    _preamble(ws, w, DEPT_TOOL, f"{period_label} · Charged credits (each tool counts in its own credits; "
                                f"{RUPEES} is the same use in rupees). Darker cells are heavier use.")
    ws.append(w.header(headers))
    for d in model.departments:
        ws.append([w.text(d.name, font=F_BOLD)]
                  + [w.credits(model.dept_tool.get((d.name, t), 0.0)) for t in tools]
                  + [w.credits(d.totals.credits, font=F_BOLD), w.rupees(d.totals.rupees, font=F_BOLD),
                     _top_link(w, TOOL, lay.tool_row, d.top_tool, lay), w.text(top_detail(d.top_tool))])
    if not model.departments:
        _empty_row(ws, w, len(headers))
        return
    last = FIRST_DATA_ROW + len(model.departments) - 1
    _add_table(ws, headers, last, "tblDeptTool")
    if tools:
        ws.conditional_formatting.add(f"B{FIRST_DATA_ROW}:{get_column_letter(1 + len(tools))}{last}", COLOR_SCALE)
    ws.append([])
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER)]
              + [w.total_cell(t.totals.credits, CREDITS_FMT) for t in model.tools]
              + [w.total_cell(model.totals.credits, CREDITS_FMT), w.total_cell(round(model.totals.rupees, 2), INR_FMT)])


def _write_user_tool(sheets, model, lay, period_label):
    ws, w = sheets[USER_TOOL]
    tools = [t.name for t in model.tools]
    headers = unique_headers(["User", "Department"] + tools + ["Total", RUPEES])
    _preamble(ws, w, USER_TOOL, f"{period_label} · Charged credits, sorted by department then credits. "
                                "Filter the Department column for one team.")
    ws.append(w.header(headers))
    for uid in model.user_tool_order:
        u = model.user(uid)
        ws.append([user_link(w, lay, uid, u.label),
                   w.text(u.department)]
                  + [w.credits(model.user_tool.get((uid, t), 0.0)) for t in tools]
                  + [w.credits(u.totals.credits, font=F_BOLD), w.rupees(u.totals.rupees, font=F_BOLD)])
    if not model.user_tool_order:
        _empty_row(ws, w, len(headers))
        return
    last = FIRST_DATA_ROW + len(model.user_tool_order) - 1
    _add_table(ws, headers, last, "tblUserTool")
    if tools:
        ws.conditional_formatting.add(f"C{FIRST_DATA_ROW}:{get_column_letter(2 + len(tools))}{last}", COLOR_SCALE)
    ws.append([])
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell()]
              + [w.total_cell(t.totals.credits, CREDITS_FMT) for t in model.tools]
              + [w.total_cell(model.totals.credits, CREDITS_FMT), w.total_cell(round(model.totals.rupees, 2), INR_FMT)])


UC_LINK_COL = "I"                  # User × Client: "Generations (n) →" (the log's "⬅ Client" returns here)


def _write_user_client(sheets, model, lay, period_label, blocks=None):
    ws, w = sheets[USER_CLIENT]
    from .workbook_blocks import gens_label

    headers = ["User", "Department", "Client", "Tool", "Generations", "Credits", RUPEES, "Pending credits", "Log rows",
               "Note"]
    _preamble(ws, w, USER_CLIENT, f"{period_label} · Charged credits, sorted by client. "
                                  "For which client each user used each tool. Log rows opens the newest day's "
                                  "generations; filter the log's Client column for every day.")
    ws.append(w.header(headers))
    plan = blocks.log if blocks else None
    for uid, dept, client, tool, t in model.user_client_rows:
        run = lay.uc_first_run.get((uid, tool, client))
        if run and plan and run in plan.quad_row:
            agg = plan.quad[run]
            log_cell = w.link(internal_target(LOG, plan.quad_row[run], lay.log_cols[LOG_BACK_CLIENT]), gens_label(agg))
            runs = [k for k in plan.quad if k[0] == uid and k[1] == tool and k[3] == client]
            total = sum(plan.quad[k].rows for k in runs)
            note = (f"{total:,} generations over {len(runs)} days — filter Client in the log" if len(runs) > 1 else "")
        else:
            log_cell, note = w.text("—"), ""
        ws.append([
            user_link(w, lay, uid, model.user(uid).label),
            w.text(dept),
            w.text(client),
            tool_link(w, lay, tool),
            w.count(t.generations), w.credits(t.credits), w.rupees(t.rupees), w.credits(t.pending_credits),
            log_cell, w.text(note, font=F_ITALIC),
        ])
    if not model.user_client_rows:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.user_client_rows) - 1, "tblUserClient")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER)] + [w.total_cell() for _ in range(3)]
              + [w.total_cell(t.generations, COUNT_FMT), w.total_cell(t.credits, CREDITS_FMT),
                 w.total_cell(round(t.rupees, 2), INR_FMT), w.total_cell(t.pending_credits, CREDITS_FMT)])


def _write_quality(sheets, model, lay, stats: LogStats, period_label, kling: "KlingDedupView" = None,
                   uploads: int = 0):
    ws, w = sheets[QUALITY]
    headers = ["Issue", "Generations", "Credits", RUPEES, "What it means", "Go to rows"]
    _preamble(ws, w, QUALITY, f"{period_label} · Links open the first matching row; filter that column to see them all.")
    ws.append(w.header(headers))
    t = model.totals
    unassigned = next((u for u in model.users if u.is_unassigned), None)
    no_client = next((c for c in model.clients if c.name == NO_CLIENT), None)
    back_col = lay.log_cols[LOG_BACK_QUALITY]

    def first_row_link(issue, label):
        # Lands on the log row's "⬅ Data Quality" cell, which links back here.
        row = stats.first_issue_row.get(issue)
        return w.go(LOG, row, label, col=back_col) if row else w.text("—")

    def per_tool(counts: dict) -> str:
        return ", ".join(f"{tool} {n:,}" for tool, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))

    zero_missed = sum(stats.zero_missed_by_tool.values())
    not_captured = sum(stats.not_captured_by_tool.values())
    ex = model.excluded

    def counted(issue):
        rows, credits, rupees = stats.issue_counts.get(issue, (0, 0.0, 0.0))
        return rows, credits, rupees

    kling = kling or KlingDedupView()
    unc = counted(OWNER_UNCERTAIN)
    issues = {
        UNASSIGNED: (unassigned.totals.generations if unassigned else 0, unassigned.totals.credits if unassigned else 0.0,
                     unassigned.totals.rupees if unassigned else 0.0,
                     f"{UNASSIGNED_NOTE}. Counted in every sheet as the user \"{UNASSIGNED}\". "
                     "An admin can claim them in Generation Recovery.",
                     w.go(USER, lay.user_block_row.get(UNASSIGNED_USER_ID, lay.user_row.get(UNASSIGNED_USER_ID)),
                          UNASSIGNED) if unassigned else w.text("—")),
        NO_CLIENT: (no_client.totals.generations if no_client else 0, no_client.totals.credits if no_client else 0.0,
                    no_client.totals.rupees if no_client else 0.0,
                    "Charged generations where nobody picked a client at generate time (or picked a placeholder "
                    "such as \"Applicant\").",
                    w.go(CLIENT, lay.client_row[NO_CLIENT], NO_CLIENT) if no_client else w.text("—")),
        PENDING: (t.pending_generations, t.pending_credits, 0.0,
                  "Still in flight (submitted, queued, running, reconciling, streaming, draft…). Not in any total. "
                  "Filter Generation Log → Charge status = Pending.",
                  first_row_link(PENDING, PENDING)),
        STALE_PENDING: (stats.stale_pending, stats.stale_pending_credits, 0.0,
                        f"Pending rows started more than {STALE_PENDING_HOURS} hours before this export: the capture "
                        "probably never saw them finish (e.g. ElevenLabs Music stuck at \"generating_music\"). "
                        "Check them in the tool; they are not in any total.",
                        first_row_link(STALE_PENDING, PENDING)),
        FAILED: (t.failed_generations, t.failed_credits, 0.0,
                 "Failed, cancelled or refunded. Not in any total. Filter Charge status = Failed / Refunded.",
                 first_row_link(FAILED, FAILED)),
        DUPLICATE_LABEL: (stats.duplicates, stats.duplicate_credits, counted(DUPLICATE_LABEL)[2],
                          f"Two charges for the same output: same user, tool and prompt within "
                          f"{DUPLICATE_WINDOW_SECONDS} seconds, both charged, identical output. Raise with the vendor. "
                          "(Different outputs are deliberate variations or a batch and are not flagged.)",
                          first_row_link(DUPLICATE_LABEL, DUPLICATE_LABEL)),
        RECORDED_TWICE: (kling.removed_rows, kling.removed_credits, kling.removed_rupees,
                         f"One Kling job recorded more than once by our capture (the click and a later history scan). "
                         f"The extra {kling.removed_rows:,} row(s) of {kling.jobs:,} job(s) are left out of every total, "
                         "keeping the row of the person who started the job; each one is listed below.",
                         w.go(QUALITY, kling.list_row, RECORDED_TWICE) if kling.list_row else w.text("—")),
        OWNER_UNCERTAIN: (unc[0], unc[1], unc[2],
                          "Kling jobs only found by a history scan: credited to the one person who started Kling jobs "
                          f"on that account in the period, otherwise to \"{UNASSIGNED}\".",
                          first_row_link(OWNER_UNCERTAIN, OWNER_UNCERTAIN)),
        NO_JOB_ID: (*counted(NO_JOB_ID),
                    "Charged Kling rows without a Kling job ID: they cannot be checked for double recording, so they "
                    "stay in the totals; listed below.",
                    first_row_link(NO_JOB_ID, NO_JOB_ID)),
        ZERO_MISSED: (zero_missed, 0.0, counted(ZERO_MISSED)[2],
                      "Charged, but 0 credits recorded: Freepik unlimited-plan items (their ₹ uses Freepik's own cost "
                      "estimate) and ElevenLabs when the character counter did not move (₹ from the text length, est.). "
                      + (f"By tool: {per_tool(stats.zero_missed_by_tool)}. " if zero_missed else "")
                      + "Shaded in the log's Credits column.",
                      first_row_link(ZERO_MISSED, f"{0:,.2f}")),
        NOT_CAPTURED: (not_captured, 0.0, counted(NOT_CAPTURED)[2],
                       "Charged rows from tools that record no cost (Higgsfield, Flow, Suno before a fixed price is "
                       "set in Reports → Credit Rates). Their ₹ is an equal share of the subscription (est.). "
                       + (f"By tool: {per_tool(stats.not_captured_by_tool)}." if not_captured else ""),
                       first_row_link(NOT_CAPTURED, f"{0:,.2f}")),
        RATE_ASSUMED: (*counted(RATE_ASSUMED),
                       "Pay-per-use rows from a tool account with no rate of its own in Reports → Credit Rates: costed "
                       "at the tool's latest rate (est.). Enter the account's rate to make it exact.",
                       first_row_link(RATE_ASSUMED, RATE_ASSUMED)),
        FREE_PREVIEW: (*counted(FREE_PREVIEW),
                       "ElevenLabs preview models that are not charged (eleven_v3_dpo, eleven_v4_exp): ₹0.",
                       first_row_link(FREE_PREVIEW, FREE_PREVIEW)),
        UPLOADS: (uploads, 0.0, 0.0,
                  "Freepik reference images people uploaded. They are not generations, cost nothing, and are left "
                  "out of every count.", w.text("—")),
        EXCLUDED: (ex.get("generations", 0), ex.get("credits", 0.0), 0.0,
                   f"{ex.get('accounts', 0)} account(s) left out by the export option. Not in any total.",
                   w.go(HOME, 5, "Test & admin accounts")),
    }
    for issue in QUALITY_ISSUES:
        gens, credits, rupees, meaning, link = issues[issue]
        row = [w.text(issue, font=F_BOLD), w.count(gens), w.credits(credits), w.rupees(rupees),
               w.text(meaning, align=WRAP), link]
        if issue == NO_JOB_ID and kling.no_id_row:
            # "Go to rows" opens the log; the list of these rows is just below.
            row.append(w.link(internal_target(QUALITY, kling.no_id_row), "↓ List"))
        ws.append(row)
    _add_table(ws, headers, FIRST_DATA_ROW + len(QUALITY_ISSUES) - 1, "tblDataQuality")
    _write_kling_lists(ws, w, kling)


@dataclass
class KlingDedupView:
    """The Kling double-recording check as Data Quality shows it (rows planned up front)."""

    dedup: object = None             # dedupe.KlingDedup
    rate_of: object = None           # (account, day) -> rupees per credit, for the removed ₹
    list_row: int = 0                # title row of "recorded twice" list (0 = no list)
    no_id_row: int = 0

    @property
    def jobs(self) -> int:
        return len(self.dedup.jobs) if self.dedup else 0

    @property
    def removed_rows(self) -> int:
        return self.dedup.removed_rows if self.dedup else 0

    @property
    def removed_credits(self) -> float:
        return self.dedup.removed_credits if self.dedup else 0.0

    @property
    def removed_rupees(self) -> float:
        if not self.dedup or not self.rate_of:
            return 0.0
        return sum(r.credits * self.rate_of(r.account, r.day) for j in self.dedup.jobs for r in j.removed)

    def plan(self, first_free_row: int) -> None:
        """Title rows of the two lists below the issues table (blank row, title, header, rows)."""
        row = first_free_row + 1
        if self.dedup and self.dedup.jobs:
            self.list_row = row
            row += 2 + len(self.dedup.jobs) + 1
        if self.dedup and self.dedup.no_job_id:
            self.no_id_row = row


def _write_kling_lists(ws, w: Writer, kling: KlingDedupView) -> None:
    d = kling.dedup
    if not d:
        return

    def who(uid):
        return d.names.get(uid, f"User {uid}") if uid else UNASSIGNED

    if d.jobs:
        ws.append([])
        ws.append([w.text(RECORDED_TWICE, font=F_SECTION),
                   w.text("Removed from every total; the kept row is in the Generation Log.", font=F_ITALIC)])
        headers = ["Date", "Kling job ID", "Kept row", "Kept row recorded by", "Credited to", "How the kept row was found",
                   "Removed row(s)", "Removed rows recorded by", "Credits removed", "Owner uncertain"]
        ws.append(w.header(headers))
        first = kling.list_row + 2
        for j in d.jobs:
            ws.append([w.cell(as_datetime(j.day), fmt=DATE_ONLY_FMT), w.text(j.job), w.text(str(j.kept.id)),
                       w.text(who(j.kept.user_id)), w.text(who(j.owner_id)),
                       w.text("Started in the dashboard" if not j.owner_uncertain else "History scan only"),
                       w.text(", ".join(str(r.id) for r in j.removed)),
                       w.text(", ".join(sorted({who(r.user_id) for r in j.removed}))),
                       w.credits(j.removed_credits), w.text("Yes" if j.owner_uncertain else "No")])
        _add_table(ws, headers, first + len(d.jobs) - 1, "tblKlingRecordedTwice", header_row=first - 1)
    if d.no_job_id:
        ws.append([])
        ws.append([w.text(NO_JOB_ID, font=F_SECTION),
                   w.text("Kept in the totals: without a job ID they cannot be checked.", font=F_ITALIC)])
        headers = ["Date", "Row", "User", "Credits"]
        ws.append(w.header(headers))
        first = kling.no_id_row + 2
        for r in d.no_job_id:
            ws.append([w.cell(as_datetime(r.day), fmt=DATE_ONLY_FMT), w.text(str(r.id)), w.text(who(r.user_id)),
                       w.credits(r.credits)])
        _add_table(ws, headers, first + len(d.no_job_id) - 1, "tblKlingNoJobId", header_row=first - 1)


# --------------------------------------------------------------------------- #
# Home
# --------------------------------------------------------------------------- #
HOME_EXCLUSION_ROW = 5
HOME_KPI_LABEL_ROW = 10


def _filters_line(filters: ReportFilters) -> str:
    if filters.user_id == UNASSIGNED_USER_ID:
        user = "Unassigned (no owner)"
    else:
        user = filters.user_label or (f"User #{filters.user_id}" if filters.user_id is not None else "All")
    return (f"Department: {filters.department or 'All'}  ·  User: {user}  ·  "
            f"Tool: {filters.tool or 'All'}  ·  Client: {filters.client or 'All'}")


def _exclusion_line(filters: ReportFilters, model: ReportModel) -> str:
    if not filters.exclude_test_accounts:
        return "Included (the export option was turned off)."
    names = [name for _uid, name in filters.excluded_accounts]
    if not names:
        return "Excluded, but no admin or configured test accounts were found."
    ex = model.excluded
    shown = ", ".join(names[:10]) + (f" and {len(names) - 10} more" if len(names) > 10 else "")
    return (f"Excluded: {shown}. They used {ex.get('credits', 0.0):,.2f} charged credits in "
            f"{ex.get('generations', 0):,} generations, left out of every sheet.")


def quick_answers(model: ReportModel, lay: Layout) -> list:
    """[(question, answer, link-builder args)] - each link lands on the cell that proves the answer."""
    qa = []
    t = model.totals
    people = [u for u in model.users if not u.is_unassigned]
    qa.append(("How many credits were charged in total?",
               f"{figures(t.credits, t.generations)} across {len(t.users):,} users", (DEPT, lay.dept_total_row, "Total", "A")))
    top_tool = _top_from_rows(model.tools)
    if top_tool:
        qa.append(("Which tool is used the most?", _answer(top_tool, str), (TOOL, lay.tool_block_row.get(top_tool.first, lay.tool_row[top_tool.first]), top_tool.first, "A")))
    if model.top_user:
        lead = model.user(model.top_user.first)
        qa.append(("Who is the top user in the company?",
                   f"{lead.label} — {figures(lead.totals.credits, lead.totals.generations)}{_named_note(model)}",
                   (USER, lay.user_block_row.get(lead.user_id, lay.user_row[lead.user_id]), lead.label, "A")))
    top_dept = _top_from_rows(model.departments)
    if top_dept:
        qa.append(("Which department used the most credits?", _answer(top_dept, str),
                   (DEPT, lay.dept_row[top_dept.first], top_dept.first, "A")))
        d = next(x for x in model.departments if x.name == top_dept.first)
        if d.top_tool:
            qa.append((f"Which tool does {d.name} use most?", _answer(d.top_tool, str),
                       (DEPT_TOOL, lay.dept_tool_row[d.name], d.name, "A")))
    real_clients = [c for c in model.clients if c.name != NO_CLIENT]
    top_client = _top_from_rows(real_clients)
    if top_client:
        qa.append(("Which client consumed the most credits?", _answer(top_client, str),
                   (CLIENT, lay.client_row[top_client.first], top_client.first, "A")))
    qa.append(("How many credits are still pending (not yet charged)?", figures(t.pending_credits, t.pending_generations),
               (QUALITY, lay.quality_row[PENDING], PENDING, "A")))
    qa.append(("Who worked on a given date, and for which clients?",
               f"{BY_DATE}: every date, its users, and each user's generations per client and tool",
               (BY_DATE, 2, BY_DATE, "A")))
    qa.append(("What happened in a specific period?",
               "Pick From / To dates (and any filters) in Period Explorer; every total recalculates",
               (PERIOD, 2, PERIOD, "A")))
    unassigned = next((u for u in model.users if u.is_unassigned), None)
    if unassigned:
        qa.append(("How many charged credits have no owner?",
                   f"{figures(unassigned.totals.credits, unassigned.totals.generations)} "
                   f"({unassigned.share:.1%} of the total)",
                   (USER, lay.user_block_row.get(UNASSIGNED_USER_ID, lay.user_row[UNASSIGNED_USER_ID]),
                    unassigned.label, "A")))
    return qa


def _named_note(model) -> str:
    """' · tied with …' and, when Unassigned is on top, ' · top named user: …'."""
    top = model.top_user
    names = [model.user(k).label for k in top.keys[1:]]
    text = f" · tied with {', '.join(names)}" if names else ""
    if top.first == UNASSIGNED_USER_ID and model.top_named_user:
        named = model.user(model.top_named_user.first)
        text += f" · top named user: {named.label} ({figures(named.totals.credits, named.totals.generations)})"
    return text


def _top_from_rows(rows) -> Top:
    from .model import top_of
    return top_of({r.name: (r.totals.credits, r.totals.generations) for r in rows})


def _answer(top: Top, name_of) -> str:
    text = f"{name_of(top.first)} — {figures(top.credits, top.generations)}"
    if len(top.keys) > 1:
        text += " · tied with " + ", ".join(name_of(k) for k in top.keys[1:])
    return text


def _write_home(sheets, model, lay, filters, generated_at, dashboard_url, front_sheets=()):
    ws, w = sheets[HOME]
    t = model.totals
    ws.append([w.text("Home", font=F_HOME_TAG, fill=FILL_HEADER)])                                       # 1
    ws.append([w.text("Credit Consumption Report", font=F_TITLE)])                                     # 2
    ws.append([w.text("Period", font=F_BOLD), w.text(filters.period.get("label") or f"{filters.start} – {filters.end}")])
    ws.append([w.text("Filters applied", font=F_BOLD), w.text(_filters_line(filters))])                 # 4
    ws.append([w.text("Test & admin accounts", font=F_BOLD), w.text(_exclusion_line(filters, model), align=WRAP),
               w.link(internal_target(QUALITY, lay.quality_row[EXCLUDED], QUALITY_LINK_COL), "⬅ Data Quality",
                      font=N.F_BACK, fill=N.FILL_BACK)])                                                  # 5
    ws.append([w.text("Generated at", font=F_BOLD), w.text(f"{generated_at:%Y-%m-%d %H:%M} IST")])      # 6
    ws.append([w.text("Output links open on", font=F_BOLD), w.text(dashboard_url or "Not configured")])  # 7
    ws.append([w.text("How credits are counted", font=F_BOLD),
               w.text("Every total counts Charged generations only. Pending and Failed / Refunded rows are listed "
                      "in the Generation Log and Data Quality but never added to a total. Each tool counts in its "
                      f"own credits, so compare tools in {RUPEES} (see the Glossary).", align=WRAP)])  # 8
    big_link = Font(color="0563C1", underline="single", bold=True, size=12)
    ws.append([w.text("Explore any period", font=F_SECTION), w.nav(internal_target(PERIOD, 2), f"{PERIOD} →", font=big_link)]
              + [w.nav(internal_target(name, 2), f"{name} →", font=big_link) for name in front_sheets])  # 9

    if model.is_empty:
        ws.append([w.text("No credit activity was found for this period and these filters. "
                          "Try a wider date range or remove a filter.", font=F_SECTION, fill=FILL_EMPTY)])
    else:
        top_tool = _top_from_rows(model.tools)
        top_dept = _top_from_rows(model.departments)
        leaders = [model.user(k) for k in model.top_user.keys]
        top_user_text = ", ".join(u.label for u in leaders) or "—"
        if model.top_user.first == UNASSIGNED_USER_ID and model.top_named_user:
            top_user_text += f" (top named user: {model.user(model.top_named_user.first).label})"
        kpis = [
            ("CHARGED CREDITS", w.credits(t.credits, font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(DEPT, lay.dept_total_row, "Total")),
            ("PENDING CREDITS", w.credits(t.pending_credits, font=F_KPI_VALUE, fill=FILL_PENDING),
             w.go(QUALITY, lay.quality_row[PENDING], PENDING)),
            # The log is streamed: this lands on its fixed back cell (see _write_log).
            ("GENERATIONS", w.count(t.generations, font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(LOG, 2, LOG, col=HOME_KPI_GENERATIONS_COL)),
            ("ACTIVE USERS", w.count(len([u for u in t.users if u != UNASSIGNED_USER_ID]), font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(USER, 2, USER)),
            ("ACTIVE DEPARTMENTS", w.count(len([d for d in model.departments if d.totals.generations]),
                                           font=F_KPI_VALUE, fill=FILL_KPI), w.go(DEPT, 2, DEPT)),
            ("MOST USED TOOL", w.text(", ".join(top_tool.keys) or "—", font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(TOOL, lay.tool_block_row.get(top_tool.first, lay.tool_row[top_tool.first]), top_tool.first)
             if top_tool else w.text("")),
            ("TOP USER", w.text(top_user_text, font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(USER, lay.user_block_row.get(leaders[0].user_id, lay.user_row[leaders[0].user_id]),
                  leaders[0].label) if leaders else w.text("")),
            ("TOP DEPARTMENT", w.text(", ".join(top_dept.keys) or "—", font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(DEPT, lay.dept_row[top_dept.first], top_dept.first) if top_dept else w.text("")),
            (f"{RUPEES.upper()} (CHARGED ITEMS)", w.rupees(t.rupees, font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(DEPT, lay.dept_total_row, "Total")),
        ]
        ws.append([w.text(label, font=F_KPI_LABEL, fill=FILL_KPI) for label, _v, _l in kpis])           # 10
        ws.append([value for _l, value, _x in kpis])                                                   # 11
        ws.append([link for _l, _v, link in kpis])                                                     # 12 = HOME_KPI_LINK_ROW
        ws.append([])                                                                                  # 13
        ws.append([w.text("Quick answers", font=F_SECTION)])                                           # 14
        headers = ["Question", "Answer", "Go to details"]
        ws.append(w.header(headers))                                                                   # 15
        qa = quick_answers(model, lay)
        for q, a, (sheet, row, label, col) in qa:
            ws.append([w.text(q, align=WRAP), w.text(a, align=WRAP), w.go(sheet, row, label, col=col)])
        qa_last = 15 + len(qa)
        _add_table(ws, headers, qa_last, "tblQuickAnswers", header_row=15)
        ws.append([])

        _add_bar_chart(ws, sheets[DEPT][0], len(model.departments), f"{RUPEES} by department", "E14", col=3)
        _add_bar_chart(ws, sheets[TOOL][0], len(model.tools), f"{RUPEES} by tool", "E31", col=3)
        _add_trend_chart(ws, sheets[TREND][0], model, lay, "E48")

    ws.append([w.text("Sheets in this report", font=F_SECTION)])
    ws.append(w.header(["Sheet", "What it shows", "Open"]))
    for name in SHEET_ORDER[1:]:
        ws.append([w.text(name, font=F_BOLD), w.text(SHEET_PURPOSE[name], align=WRAP),
                   w.nav(internal_target(name, 2), f"{name} →")])


def home_section(row: int) -> str:
    """What a Home row belongs to, for the label of a back link to it."""
    return "Headlines" if row <= HOME_KPI_LINK_ROW else "Quick answers"


def _add_bar_chart(ws, source_ws, count: int, title: str, anchor: str, col: int = 2):
    if count <= 0:
        return
    shown = min(count, 15)
    chart = BarChart()
    chart.type = "bar"
    chart.title = title if count <= 15 else f"{title} (top 15)"
    chart.style = 10
    chart.legend = None
    chart.height = 8
    chart.width = 16
    chart.y_axis.numFmt = "#,##0"
    chart.add_data(Reference(source_ws, min_col=col, min_row=HEADER_ROW, max_row=HEADER_ROW + shown),
                   titles_from_data=True)
    chart.set_categories(Reference(source_ws, min_col=1, min_row=FIRST_DATA_ROW, max_row=HEADER_ROW + shown))
    chart.x_axis.scaling.orientation = "maxMin"  # largest at the top
    ws.add_chart(chart, anchor)


def _add_trend_chart(ws, trend_ws, model, lay, anchor: str):
    if not model.months or not model.tools:
        return
    header = lay.trend_credits_header_row
    chart = LineChart()
    chart.title = "Monthly credits by tool"
    chart.style = 12
    chart.height = 8
    chart.width = 16
    chart.y_axis.numFmt = "#,##0"
    chart.y_axis.title = "Credits"
    shown = min(len(model.tools), 8)  # the heaviest tools; the sheet has them all
    chart.add_data(Reference(trend_ws, min_col=2, max_col=1 + shown, min_row=header, max_row=header + len(model.months)),
                   titles_from_data=True)
    chart.set_categories(Reference(trend_ws, min_col=1, min_row=header + 1, max_row=header + len(model.months)))
    ws.add_chart(chart, anchor)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def report_filename(filters: ReportFilters, version: str = "full", ext: str = "xlsx") -> str:
    stem = "ai-tools-management" if version == "management" else "credit-report"
    return f"{stem}_{filters.start.isoformat()}_to_{filters.end.isoformat()}.{ext}"


def write_workbook(path: str, model: ReportModel, filters: ReportFilters, log_rows: Iterable,
                   *, dashboard_url: str = "", generated_at: Optional[datetime] = None, blocks=None,
                   duplicates: Optional[set] = None, management=None, uploads: int = 0) -> LogStats:
    """Render the report to ``path``. ``log_rows`` is consumed once, in order:
    the order blocks.log planned (see generate_report), so every link into the
    log lands on the row the blocks point at. With ``management`` (a
    management.ManagementView) the Summary, Team & Clients, Glossary and a
    Details divider come first."""
    from .blocks import BlockData
    from . import workbook_blocks as WB
    from . import workbook_periods as WP
    from . import workbook_summary as WS

    generated_at = generated_at or (datetime.utcnow() + IST)
    period_label = filters.period.get("label") or f"{filters.start} – {filters.end}"
    blocks = blocks or BlockData()
    lay = Layout.plan(model, blocks)
    lay.trend = WP.plan_trend(model)
    lay.drill = WP.plan_drill(model)
    lay.trend_credits_header_row = lay.trend.tool_credits_header
    ntools, ndepts, nmonths = len(model.tools), len(model.departments), len(model.months)
    log_widths = {LOG_BACK_USER: N.BACK_COL_WIDTH, LOG_BACK_TOOL: N.BACK_COL_WIDTH, LOG_BACK_DATE: N.BACK_COL_WIDTH,
                  LOG_BACK_TOOL_DATE: N.BACK_COL_WIDTH, LOG_BACK_CLIENT: N.BACK_COL_WIDTH,
                  LOG_BACK_BYDATE: N.BACK_COL_WIDTH,
                  "Date / time (IST)": 26, "Date": 18,
                  "Month": 10, "Week": 12, "Quarter": 9, "Charged": 9, "User": 26, "Employee ID": 13,
                  "Department": 22, "Tool": 14, "Client": 26, "Task": 26, "Model / type": 20, "Prompt": 70,
                  "Output": 14, "Credits": 12, RUPEES: 12, "Cost note": 26, "Charge status": 16, "Raw status": 18,
                  DUPLICATE_LABEL: 18, LOG_BACK_QUALITY: N.BACK_COL_WIDTH, LOG_BACK_DRILL: N.BACK_COL_WIDTH,
                  PROMPT_FULL: 80}

    def log_width(header: str) -> float:
        # Wide enough for the header text plus the filter dropdown button;
        # "⬅" columns stay narrow (their header wraps).
        if header.startswith("⬅"):
            return N.BACK_COL_WIDTH
        return max(log_widths[header], len(header) + 5)

    wb = Workbook(write_only=True)
    # Period Explorer formulas carry no cached values: make every app compute on open.
    wb.calculation.fullCalcOnLoad = True
    # The management sheets lead (Summary is the tab that opens), then the details.
    front = {name: wb.create_sheet(name) for name in (WS.SUMMARY, WS.TEAM, WS.GLOSSARY, WS.DETAILS)} if management else {}
    sheets = {
        HOME: _new_sheet(wb, HOME, [44, 56, 20, 20, 20, 20, 20, 20, 22], freeze="B2"),
        # Inputs and helpers in A-J; then Name | Credits | ₹ | Generations | % | Rank | Tie | Prev, four times.
        PERIOD: _new_sheet(wb, PERIOD, [22, 16, 16, 13, 12, 10, 8, 14, 20] + [16, 12, 13, 12, 10, 8, 8, 12, 4] * 3,
                           freeze="B4"),
        # The list starts a row lower: row 4 is the "Jump to:" row.
        BY_DATE: _new_sheet(wb, BY_DATE, [24, 20, 22, 14, 14, 26, 22, 24, 18, 16, 12], freeze="B6"),
        # Column A (the names) stays in view when a link lands on a "⬅" column far right.
        DEPT: _new_sheet(wb, DEPT, [28, 14, 13, 10, 12, 14, 11, 26, 34, 22, 16, 32, 24, 24, 24], freeze="B5"),
        # B and F also hold block dates ("dd mmm yyyy (ddd)").
        USER: _new_sheet(wb, USER, [30, 19, 22, 14, 13, 12, 19, 13, 13, 13, 11, 12, 18, 32, 24, 18, 24, 16],
                         freeze="B5"),
        TOOL: _new_sheet(wb, TOOL, [18, 14, 13, 10, 12, 13, 13, 9, 14, 26, 34, 22, 22, 22, 32, 48, 18, 22, 16],
                         freeze="B5"),
        CLIENT: _new_sheet(wb, CLIENT, [30, 14, 13, 10, 12, 13, 9, 26, 34, 22, 18, 32, 24, 24], freeze="B5"),
        DEPT_TOOL: _new_sheet(wb, DEPT_TOOL, [28] + [14] * ntools + [14, 13, 18, 32], freeze="B5"),
        USER_TOOL: _new_sheet(wb, USER_TOOL, [30, 22] + [14] * ntools + [14, 13], freeze="C5"),
        USER_CLIENT: _new_sheet(wb, USER_CLIENT, [30, 22, 30, 16, 12, 14, 13, 14, 24, 44], freeze="B5"),
        # Column A fits the block titles, whose row holds the column back cells from B on.
        TREND: _new_sheet(wb, TREND, [40] + [14] * max(ntools, ndepts, nmonths, 10) + [14, 12], freeze="B4"),
        DRILL: _new_sheet(wb, DRILL, [22, 14, 13, 12, 10, 4, 28, 14, 13, 12, 10, 4, 16, 14, 13, 12, 10, 4,
                                      28, 14, 13, 12, 10],
                          freeze="B4"),
        # Its back cells sit right of a wide column; the Kling lists below use B-J.
        QUALITY: _new_sheet(wb, QUALITY, [30, 16, 14, 13, 80, 24, 26, 26, 14, 14], freeze="B5"),
        # The three back columns stay in view with the header.
        LOG: _new_sheet(wb, LOG, [log_width(h) for h in log_headers(model)], freeze="G5", buffered=False),
        LISTS: _new_sheet(wb, LISTS, [28, 30, 18, 30, 16], freeze=None, buffered=False),
    }
    sheets[LISTS][0].sheet_state = "hidden"
    chart_data = None
    if management:
        chart_data = wb.create_sheet(WS.CHART_DATA)
        chart_data.sheet_state = "hidden"

    kling = KlingDedupView(dedup=filters.kling,
                           rate_of=(lambda acc, day: filters.cost.rate_on("Kling", acc, day)[0]) if filters.cost else None)
    kling.plan(FIRST_DATA_ROW + len(QUALITY_ISSUES))
    stats = _write_log(sheets, model, lay, log_rows, dashboard_url, period_label, generated_at, blocks,
                       duplicates if duplicates is not None else set(), KlingMarks.of(filters.kling))
    WB.write_by_date(sheets, model, blocks, lay, period_label)
    _write_departments(sheets, model, lay, period_label, blocks)
    _write_users(sheets, model, lay, period_label, blocks)
    _write_tools(sheets, model, lay, period_label, blocks)
    _write_clients(sheets, model, lay, period_label)
    _write_dept_tool(sheets, model, lay, period_label)
    _write_user_tool(sheets, model, lay, period_label)
    _write_user_client(sheets, model, lay, period_label, blocks)
    WP.write_trend(sheets, model, lay, lay.trend, lay.drill, period_label)
    WP.write_drill(sheets, model, lay, lay.trend, lay.drill, stats.month_first, lay.log_cols[LOG_BACK_DRILL],
                   period_label)
    _write_quality(sheets, model, lay, stats, period_label, kling, uploads)
    list_refs = WP.write_lists(sheets, model)
    WP.write_explorer(sheets, model, lay, filters, lay.log_cols, FIRST_DATA_ROW + stats.rows - 1, list_refs, period_label)
    _write_home(sheets, model, lay, filters, generated_at, dashboard_url, front_sheets=tuple(front))
    if management:
        back = (WS.SUMMARY, "A2", f"⬅ Back to {WS.SUMMARY}")
        WS.write_summary(front[WS.SUMMARY], chart_data, management, back_to=(HOME, "A1", f"⬅ Back to {HOME}"))
        WS.write_team(front[WS.TEAM], management, back_to=back)
        WS.write_glossary(front[WS.GLOSSARY], back_to=back)
        WS.write_details(front[WS.DETAILS], list(SHEET_ORDER), SHEET_PURPOSE, back_to=back)

    buffers = {name: ws for name, (ws, _w) in sheets.items() if isinstance(ws, N.BufferedSheet)}
    # Trend and Drill-down hold several tables: label the back columns on each table's header row.
    header_rows = {BY_DATE: [WB.DATE_HEADER_ROW],
                   TREND: [HEADER_ROW] + [h for _k, _t, h in lay.trend.blocks],
                   DRILL: [HEADER_ROW] + [r + 2 for r in lay.drill.block_row.values()]}
    N.resolve(buffers, {name: sheets[name][1] for name in buffers}, SHEET_ORDER, link_formula, internal_target,
              home_section=home_section, header_rows=header_rows)
    for buf in buffers.values():
        buf.flush()
    wb.save(path)
    return stats
