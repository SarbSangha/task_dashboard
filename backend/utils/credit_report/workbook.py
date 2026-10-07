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

Link rule: every internal link is a HYPERLINK formula whose label is the
text of the cell it lands on, optionally decorated with a leading
"⬅ Back to " / "⬅ " or a trailing " →". E.g. a "Bob" link lands on a cell
that reads "Bob", "Total →" lands on a "Total" row. tests/credit_report_smoke.py
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

from .facts import CHARGED, FAILED, NO_CLIENT, PENDING, UNASSIGNED_USER_ID, ReportFilters
from .model import ReportModel, Top

logger = logging.getLogger(__name__)

IST = timedelta(minutes=330)
XLSX_MIMETYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

HOME = "Home"
DEPT = "By Department"
USER = "By User"
TOOL = "By Tool"
CLIENT = "By Client"
DEPT_TOOL = "Dept × Tool"
USER_TOOL = "User × Tool"
USER_CLIENT = "User × Client"
TREND = "Monthly Trend"
QUALITY = "Data Quality"
LOG = "Generation Log"
PERIOD = "Period Explorer"
DRILL = "Month Drill-down"
LISTS = "Lists"            # hidden: dropdown values for Period Explorer
SHEET_ORDER = (HOME, PERIOD, DEPT, USER, TOOL, CLIENT, DEPT_TOOL, USER_TOOL, USER_CLIENT, TREND, DRILL, QUALITY, LOG)

SHEET_PURPOSE = {
    HOME: "Headline numbers, quick answers and this index.",
    PERIOD: "Pick any From / To dates and filters; every total, table and top answer recalculates.",
    DRILL: "One block per month: departments, users, tools and clients for that month.",
    DEPT: "Credits, pending credits, top user and top tool for each department.",
    USER: "Every user's credits, ranks, credits per generation, client tagging, top tool and client.",
    TOOL: "Credits, credits per generation, top user and top department for each tool.",
    CLIENT: "Credits, users, top user and top tool for each client.",
    DEPT_TOOL: "Which tool each department uses most (credits).",
    USER_TOOL: "Each user's credits per tool, sorted by department. Filterable.",
    USER_CLIENT: "For which clients each user used each tool, sorted by client.",
    TREND: "Month summary and change, plus every tool, department, user and client by month.",
    QUALITY: "Unassigned, no client, pending, failed, possible duplicates, zero-credit rows.",
    LOG: "Every generation: date, user, tool, client, prompt, output, credits, charge status.",
}

HEADER_ROW = 4
FIRST_DATA_ROW = 5
MAX_CELL_TEXT = 32_000            # Excel's hard cell limit is 32,767
TRUNCATION_MARKER = "…(truncated)"
MAX_LINK_TEXT = 250               # a formula string literal tops out at 255
DUPLICATE_WINDOW_SECONDS = 5
DROP_COLUMN_FILL_BELOW = 0.20     # drop Task / Model when more than 80% empty
DUPLICATE_LABEL = "Possible duplicate"
UNASSIGNED_NOTE = "No owner: imported by a history sync and never claimed"

CREDITS_FMT = "#,##0.00"
COUNT_FMT = "#,##0"
PCT_FMT = "0.0%"
DATETIME_FMT = "yyyy-mm-dd hh:mm:ss"
DATE_ONLY_FMT = "yyyy-mm-dd"
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

    def link(self, target: str, label: str, **kw):
        kw.setdefault("font", F_LINK)
        return self.cell(link_formula(target, label), **kw)

    def go(self, sheet: str, row: int, label: str, col: str = "A", **kw):
        """A navigation link: '<target text> →'."""
        return self.link(internal_target(sheet, row, col), f"{label} →", **kw)

    def credits(self, value, **kw):
        return self.cell(value, fmt=CREDITS_FMT, **kw)

    def count(self, value, **kw):
        return self.cell(value, fmt=COUNT_FMT, **kw)

    def pct(self, value, **kw):
        return self.cell(value, fmt=PCT_FMT, **kw)

    def header(self, labels):
        return [self.text(h, font=F_HEADER, fill=FILL_HEADER, align=Alignment(wrap_text=True, vertical="center"))
                for h in labels]

    def total_cell(self, value=None, fmt=None):
        return self.cell(value, fmt=fmt, font=F_BOLD, border=TOP_BORDER)


def _new_sheet(wb, name, widths, freeze="A5"):
    ws = wb.create_sheet(name)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    if freeze:
        ws.freeze_panes = freeze
    return ws, Writer(ws)


def _preamble(ws, w: Writer, sheet_name: str, subtitle: str):
    """Rows 1-3: back link + "Explore by date" link, title (= the sheet's name), subtitle."""
    ws.append([w.link(internal_target(HOME, 1), "⬅ Back to Home"), w.go(PERIOD, 2, PERIOD)])
    ws.append([w.text(sheet_name, font=F_TITLE)])
    ws.append([w.text(subtitle, font=F_SUBTITLE)])


def _add_table(ws, headers, last_row: int, name: str, header_row: int = HEADER_ROW):
    """Excel Table over header_row..last_row with filter dropdowns."""
    if last_row <= header_row:
        return
    ref = f"A{header_row}:{get_column_letter(len(headers))}{last_row}"
    table = Table(displayName=name, ref=ref)
    table.tableColumns = [TableColumn(id=i, name=str(h)) for i, h in enumerate(headers, start=1)]
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
    def plan(cls, model: ReportModel) -> "Layout":
        lay = cls()
        for i, d in enumerate(model.departments):
            lay.dept_row[d.name] = FIRST_DATA_ROW + i
            lay.dept_tool_row[d.name] = FIRST_DATA_ROW + i
        lay.dept_total_row = FIRST_DATA_ROW + len(model.departments) + 1
        for i, u in enumerate(model.users):
            lay.user_row[u.user_id] = FIRST_DATA_ROW + i
        for i, t in enumerate(model.tools):
            lay.tool_row[t.name] = FIRST_DATA_ROW + i
            lay.user_tool_col[t.name] = get_column_letter(3 + i)
        for i, c in enumerate(model.clients):
            lay.client_row[c.name] = FIRST_DATA_ROW + i
        for i, uid in enumerate(model.user_tool_order):
            lay.user_tool_first_dept_row.setdefault(model.user(uid).department, FIRST_DATA_ROW + i)
        for i, (_uid, _dept, client, _tool, _t) in enumerate(model.user_client_rows):
            lay.user_client_first_row.setdefault(client, FIRST_DATA_ROW + i)
        row = FIRST_DATA_ROW
        for uid in model.log_user_order:
            lay.log_first_row[uid] = row
            row += model.log_counts.get(uid, 0)
        return lay


# --------------------------------------------------------------------------- #
# Generation Log (written first)
# --------------------------------------------------------------------------- #
@dataclass
class LogStats:
    first_row: dict = field(default_factory=dict)        # user_id -> first row
    first_by_status: dict = field(default_factory=dict)  # charge status -> first row
    first_duplicate_row: Optional[int] = None
    first_zero_credit_row: Optional[int] = None
    month_first: dict = field(default_factory=dict)      # "YYYY-MM" -> (earliest timestamp, row)
    duplicates: int = 0
    duplicate_credits: float = 0.0
    rows: int = 0
    credits_by_status: dict = field(default_factory=dict)


def log_headers(model: ReportModel) -> list:
    headers = ["Date / time (IST)", "Date", "Month", "Week", "Quarter", "User", "Employee ID", "Department", "Tool",
               "Client"]
    if model.task_fill >= DROP_COLUMN_FILL_BELOW:
        headers.append("Task")
    if model.model_fill >= DROP_COLUMN_FILL_BELOW:
        headers.append("Model / type")
    headers += ["Prompt", "Output", "Credits", "Charge status", "Charged", "Raw status", DUPLICATE_LABEL, "Back to user"]
    return headers


def _is_duplicate_pair(a, b) -> bool:
    """Same user, tool and prompt within DUPLICATE_WINDOW_SECONDS, both charged credits."""
    if a["tool"] != b["tool"] or not a["prompt"] or a["prompt"] != b["prompt"]:
        return False
    if a["ts"] is None or b["ts"] is None:
        return False
    if a["charge"] != CHARGED or b["charge"] != CHARGED or a["credits"] <= 0 or b["credits"] <= 0:
        return False
    return abs((b["ts"] - a["ts"]).total_seconds()) <= DUPLICATE_WINDOW_SECONDS


def flag_duplicates(rows: Iterable) -> Iterable:
    """Stream rows through a short per-user window and mark both rows of every
    possible duplicate pair. Rows arrive sorted by user, then time, so the
    window only ever holds one user's last few seconds of rows."""
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
            "dup": False,
        }
        while window and (
            window[0]["user"] != entry["user"] or window[0]["ts"] is None or entry["ts"] is None
            or (entry["ts"] - window[0]["ts"]).total_seconds() > DUPLICATE_WINDOW_SECONDS
        ):
            yield window.pop(0)
        for prev in window:
            if _is_duplicate_pair(prev, entry):
                prev["dup"] = entry["dup"] = True
        window.append(entry)
    yield from window


def _write_log(sheets, model: ReportModel, lay: Layout, rows: Iterable, dashboard_url: str, period_label: str) -> LogStats:
    ws, w = sheets[LOG]
    headers = log_headers(model)
    lay.log_cols = {h: get_column_letter(i) for i, h in enumerate(headers, start=1)}
    _preamble(ws, w, LOG, f"{period_label} · Sorted by user, then date. Every charge status is listed; "
                          "summary sheets count Charged rows only. Filter Date or Month for a period "
                          "(they group by year, month and day).")
    ws.append(w.header(headers))
    stats = LogStats()
    base = (dashboard_url or "").rstrip("/")
    current = FIRST_DATA_ROW
    for e in flag_duplicates(rows):
        r = e["row"]
        uid = e["user"]
        try:
            u = model.user(uid)
        except KeyError:  # captured after the summaries were read
            u = None
        stats.first_row.setdefault(uid, current)
        stats.first_by_status.setdefault(r.charge_status, current)
        credits = e["credits"]
        stats.credits_by_status[r.charge_status] = stats.credits_by_status.get(r.charge_status, 0.0) + credits
        if e["dup"]:
            stats.duplicates += 1
            stats.duplicate_credits += credits
            if stats.first_duplicate_row is None:
                stats.first_duplicate_row = current
        if r.charge_status == CHARGED and credits == 0 and stats.first_zero_credit_row is None:
            stats.first_zero_credit_row = current
        if r.has_output and base:
            output = w.link(f"{base}/open-output?ref={quote(r.tool)}:{quote(str(r.record_id))}", "Open output")
        else:
            output = w.text("—")
        user_name = u.label if u else f"User {uid}"
        ts = e["ts"]
        day = datetime(ts.year, ts.month, ts.day) if ts else None
        if ts:
            key = f"{ts:%Y-%m}"
            if key not in stats.month_first or ts < stats.month_first[key][0]:
                stats.month_first[key] = (ts, current)
        values = {
            "Date / time (IST)": w.cell(ts, fmt=DATETIME_FMT, align=TOP_ALIGN),
            "Date": w.cell(day, fmt=DATE_ONLY_FMT, align=TOP_ALIGN),
            "Month": w.cell(day.replace(day=1) if day else None, fmt=MONTH_FMT, align=TOP_ALIGN),
            "Week": w.cell(day - timedelta(days=day.weekday()) if day else None, fmt=WEEK_FMT, align=TOP_ALIGN),
            "Quarter": w.text(f"{ts.year}-Q{(ts.month - 1) // 3 + 1}" if ts else "", align=TOP_ALIGN),
            "User": w.text(user_name, align=TOP_ALIGN),
            "Employee ID": w.text(u.employee_id if u else "", align=TOP_ALIGN),
            "Department": w.text(u.department if u else "", align=TOP_ALIGN),
            "Tool": w.text(r.tool, align=TOP_ALIGN),
            "Client": w.text(r.client or NO_CLIENT, align=TOP_ALIGN),
            "Task": w.text(r.task or "—", align=TOP_ALIGN),
            "Model / type": w.text(r.model or "—", align=TOP_ALIGN),
            "Prompt": w.text(r.prompt or "", align=WRAP),
            "Output": output,
            "Credits": w.credits(credits, align=TOP_ALIGN),
            "Charge status": w.text(r.charge_status, align=TOP_ALIGN,
                                    fill=FILL_PENDING if r.charge_status == PENDING else (FILL_WARN if r.charge_status == FAILED else None)),
            "Charged": w.cell(r.charge_status == CHARGED, align=TOP_ALIGN),
            "Raw status": w.text((r.status or "").strip() or "(none)", align=TOP_ALIGN),
            DUPLICATE_LABEL: w.text(DUPLICATE_LABEL if e["dup"] else "", align=TOP_ALIGN, fill=FILL_WARN if e["dup"] else None),
            "Back to user": (w.link(internal_target(USER, lay.user_row[uid]), f"⬅ {user_name}")
                             if uid in lay.user_row else w.text("")),
        }
        ws.append([values[h] for h in headers])
        current += 1
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
                  + [w.total_cell(sum(stats.credits_by_status.values()), CREDITS_FMT)])
    if stats.rows != sum(model.log_counts.values()):
        # Only possible if data changed between the summary queries and the
        # log stream, which the router's REPEATABLE READ snapshot prevents.
        logger.warning("credit report: log has %s rows, summaries expected %s",
                       stats.rows, sum(model.log_counts.values()))
    return stats


# --------------------------------------------------------------------------- #
# Summary sheets
# --------------------------------------------------------------------------- #
def _user_name(model):
    return lambda uid: model.user(uid).label


def _top_user_link(w, model, lay, top: Top):
    if not top:
        return w.text("—")
    return w.link(internal_target(USER, lay.user_row[top.first]), model.user(top.first).label)


def _top_link(w, sheet: str, rows: dict, top: Top):
    if not top:
        return w.text("—")
    return w.link(internal_target(sheet, rows[top.first]), str(top.first))


def _trend_link(w, lay, kind: str, key, label: str):
    """'<name> →' to the entity's row (users, clients) or column (tools,
    departments) in Monthly Trend's credits tables."""
    t = lay.trend
    if t is None:
        return w.text("—")
    if kind == "user" and key in t.user_row:
        return w.go(TREND, t.user_row[key], label)
    if kind == "client" and key in t.client_row:
        return w.go(TREND, t.client_row[key], label)
    if kind == "tool" and key in t.tool_col:
        return w.go(TREND, t.tool_credits_header, label, col=t.tool_col[key])
    if kind == "dept" and key in t.dept_col:
        return w.go(TREND, t.dept_credits_header, label, col=t.dept_col[key])
    return w.text("—")


def _write_departments(sheets, model, lay, period_label):
    ws, w = sheets[DEPT]
    headers = ["Department", "Credits", "% of total", "Generations", "Pending credits", "Active users",
               "Top user", "Top user credits · gens", "Top tool", "Top tool credits · gens", "Users in User × Tool",
               "Monthly trend"]
    _preamble(ws, w, DEPT, f"{period_label} · Charged credits. Department name opens its row in Dept × Tool.")
    ws.append(w.header(headers))
    for d in model.departments:
        t = d.totals
        ws.append([
            w.link(internal_target(DEPT_TOOL, lay.dept_tool_row[d.name]), d.name),
            w.credits(t.credits), w.pct(d.share), w.count(t.generations), w.credits(t.pending_credits),
            w.count(d.users),
            _top_user_link(w, model, lay, d.top_user), w.text(top_detail(d.top_user, _user_name(model))),
            _top_link(w, TOOL, lay.tool_row, d.top_tool), w.text(top_detail(d.top_tool)),
            w.go(USER_TOOL, lay.user_tool_first_dept_row[d.name], d.name, col="B"),
            _trend_link(w, lay, "dept", d.name, d.name),
        ])
    if not model.departments:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.departments) - 1, "tblDepartments")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(t.credits, CREDITS_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT), w.total_cell(t.generations, COUNT_FMT),
               w.total_cell(t.pending_credits, CREDITS_FMT), w.total_cell(len(t.users), COUNT_FMT)])


def _write_users(sheets, model, lay, period_label):
    ws, w = sheets[USER]
    headers = ["User", "Employee ID", "Department", "Credits", "% of company total", "Generations",
               "Credits per generation", "Pending credits", "% generations with a client", "Rank in company",
               "Rank in department", "Most used tool", "Most used tool credits · gens", "Top client",
               "Top client credits · gens", "Monthly trend"]
    _preamble(ws, w, USER, f"{period_label} · Charged credits. User name opens their first row in the "
                           f"Generation Log. \"Unassigned\" = {UNASSIGNED_NOTE.lower()}; it is not ranked.")
    ws.append(w.header(headers))
    for u in model.users:
        t = u.totals
        name_cell = (w.link(internal_target(LOG, lay.log_first_row[u.user_id], lay.log_cols.get("User", "B")), u.label)
                     if u.user_id in lay.log_first_row else w.text(u.label))
        if u.is_unassigned:
            name_cell.font = Font(color="0563C1", underline="single", italic=True)
        ws.append([
            name_cell,
            w.text(u.employee_id),
            w.link(internal_target(DEPT, lay.dept_row[u.department]), u.department),
            w.credits(t.credits), w.pct(u.share), w.count(t.generations), w.credits(t.credits_per_generation),
            w.credits(t.pending_credits), w.pct(u.client_rate),
            w.count(u.company_rank) if isinstance(u.company_rank, int) else w.text(u.company_rank),
            w.count(u.department_rank) if isinstance(u.department_rank, int) else w.text(u.department_rank),
            _top_link(w, TOOL, lay.tool_row, u.top_tool), w.text(top_detail(u.top_tool)),
            _top_link(w, CLIENT, lay.client_row, u.top_client), w.text(top_detail(u.top_client)),
            _trend_link(w, lay, "user", u.user_id, u.label),
        ])
    if not model.users:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.users) - 1, "tblUsers")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(), w.total_cell(),
               w.total_cell(t.credits, CREDITS_FMT), w.total_cell(1.0 if t.credits else 0.0, PCT_FMT),
               w.total_cell(t.generations, COUNT_FMT), w.total_cell(t.credits_per_generation, CREDITS_FMT),
               w.total_cell(t.pending_credits, CREDITS_FMT)])


def _write_tools(sheets, model, lay, period_label):
    ws, w = sheets[TOOL]
    headers = ["Tool", "Credits", "% of total", "Generations", "Credits per generation", "Pending credits", "Users",
               "Top user", "Top user credits · gens", "Top department", "Top department credits · gens", "Cost",
               "Monthly trend"]
    _preamble(ws, w, TOOL, f"{period_label} · Charged credits. Tool name opens its column in User × Tool.")
    ws.append(w.header(headers))
    for r in model.tools:
        t = r.totals
        ws.append([
            w.link(internal_target(USER_TOOL, HEADER_ROW, lay.user_tool_col[r.name]), r.name),
            w.credits(t.credits), w.pct(r.share), w.count(t.generations), w.credits(t.credits_per_generation),
            w.credits(t.pending_credits), w.count(r.users),
            _top_user_link(w, model, lay, r.top_user), w.text(top_detail(r.top_user, _user_name(model))),
            _top_link(w, DEPT, lay.dept_row, r.top_department), w.text(top_detail(r.top_department)),
            w.text(r.cost_note or "Recorded", fill=FILL_WARN if r.cost_note else None, align=WRAP),
            _trend_link(w, lay, "tool", r.name, r.name),
        ])
    if not model.tools:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.tools) - 1, "tblTools")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(t.credits, CREDITS_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT), w.total_cell(t.generations, COUNT_FMT),
               w.total_cell(t.credits_per_generation, CREDITS_FMT), w.total_cell(t.pending_credits, CREDITS_FMT)])


def _write_clients(sheets, model, lay, period_label):
    ws, w = sheets[CLIENT]
    headers = ["Client", "Credits", "% of total", "Generations", "Pending credits", "Users",
               "Top user", "Top user credits · gens", "Top tool", "Top tool credits · gens", "Monthly trend"]
    _preamble(ws, w, CLIENT, f"{period_label} · Charged credits. Client name opens its first row in User × Client.")
    ws.append(w.header(headers))
    for r in model.clients:
        t = r.totals
        first = lay.user_client_first_row.get(r.name)
        name = (w.link(internal_target(USER_CLIENT, first, "C"), r.name) if first else w.text(r.name))
        if r.name == NO_CLIENT:
            name.font = Font(color="0563C1", underline="single", italic=True)
        ws.append([
            name, w.credits(t.credits), w.pct(r.share), w.count(t.generations), w.credits(t.pending_credits),
            w.count(r.users),
            _top_user_link(w, model, lay, r.top_user), w.text(top_detail(r.top_user, _user_name(model))),
            _top_link(w, TOOL, lay.tool_row, r.top_tool), w.text(top_detail(r.top_tool)),
            _trend_link(w, lay, "client", r.name, r.name),
        ])
    if not model.clients:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.clients) - 1, "tblClients")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER), w.total_cell(t.credits, CREDITS_FMT),
               w.total_cell(1.0 if t.credits else 0.0, PCT_FMT), w.total_cell(t.generations, COUNT_FMT),
               w.total_cell(t.pending_credits, CREDITS_FMT)])


def _write_dept_tool(sheets, model, lay, period_label):
    ws, w = sheets[DEPT_TOOL]
    tools = [t.name for t in model.tools]
    headers = unique_headers(["Department"] + tools + ["Total", "Most used tool", "Most used tool credits · gens"])
    _preamble(ws, w, DEPT_TOOL, f"{period_label} · Charged credits. Darker cells are heavier use. "
                                "Department name opens its row in By Department.")
    ws.append(w.header(headers))
    for d in model.departments:
        ws.append([w.link(internal_target(DEPT, lay.dept_row[d.name]), d.name)]
                  + [w.credits(model.dept_tool.get((d.name, t), 0.0)) for t in tools]
                  + [w.credits(d.totals.credits, font=F_BOLD),
                     _top_link(w, TOOL, lay.tool_row, d.top_tool), w.text(top_detail(d.top_tool))])
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
              + [w.total_cell(model.totals.credits, CREDITS_FMT)])


def _write_user_tool(sheets, model, lay, period_label):
    ws, w = sheets[USER_TOOL]
    tools = [t.name for t in model.tools]
    headers = unique_headers(["User", "Department"] + tools + ["Total"])
    _preamble(ws, w, USER_TOOL, f"{period_label} · Charged credits, sorted by department then credits. "
                                "Filter the Department column for one team.")
    ws.append(w.header(headers))
    for uid in model.user_tool_order:
        u = model.user(uid)
        ws.append([w.link(internal_target(USER, lay.user_row[uid]), u.label),
                   w.link(internal_target(DEPT, lay.dept_row[u.department]), u.department)]
                  + [w.credits(model.user_tool.get((uid, t), 0.0)) for t in tools]
                  + [w.credits(u.totals.credits, font=F_BOLD)])
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
              + [w.total_cell(model.totals.credits, CREDITS_FMT)])


def _write_user_client(sheets, model, lay, period_label):
    ws, w = sheets[USER_CLIENT]
    headers = ["User", "Department", "Client", "Tool", "Generations", "Credits", "Pending credits"]
    _preamble(ws, w, USER_CLIENT, f"{period_label} · Charged credits, sorted by client. "
                                  "For which client each user used each tool.")
    ws.append(w.header(headers))
    for uid, dept, client, tool, t in model.user_client_rows:
        ws.append([
            w.link(internal_target(USER, lay.user_row[uid]), model.user(uid).label),
            w.text(dept),
            w.link(internal_target(CLIENT, lay.client_row[client]), client),
            w.text(tool),
            w.count(t.generations), w.credits(t.credits), w.credits(t.pending_credits),
        ])
    if not model.user_client_rows:
        _empty_row(ws, w, len(headers))
        return
    _add_table(ws, headers, FIRST_DATA_ROW + len(model.user_client_rows) - 1, "tblUserClient")
    ws.append([])
    t = model.totals
    ws.append([w.text("Total", font=F_BOLD, border=TOP_BORDER)] + [w.total_cell() for _ in range(3)]
              + [w.total_cell(t.generations, COUNT_FMT), w.total_cell(t.credits, CREDITS_FMT),
                 w.total_cell(t.pending_credits, CREDITS_FMT)])


def _write_quality(sheets, model, lay, stats: LogStats, period_label):
    ws, w = sheets[QUALITY]
    headers = ["Issue", "Generations", "Credits", "What it means", "Go to rows"]
    _preamble(ws, w, QUALITY, f"{period_label} · Links open the first matching row; filter that column to see them all.")
    ws.append(w.header(headers))
    t = model.totals
    unassigned = next((u for u in model.users if u.is_unassigned), None)
    no_client = next((c for c in model.clients if c.name == NO_CLIENT), None)
    status_col = lay.log_cols.get("Charge status", "A")

    def first_status_link(status):
        row = stats.first_by_status.get(status)
        return w.go(LOG, row, status, col=status_col) if row else w.text("—")

    issues = [
        ("Unassigned", unassigned.totals.generations if unassigned else 0, unassigned.totals.credits if unassigned else 0.0,
         f"{UNASSIGNED_NOTE}. Counted in every sheet as user and department \"Unassigned\". "
         "An admin can claim them in Generation Recovery.",
         w.go(USER, lay.user_row[UNASSIGNED_USER_ID], "Unassigned") if unassigned else w.text("—")),
        (NO_CLIENT, no_client.totals.generations if no_client else 0, no_client.totals.credits if no_client else 0.0,
         "Charged generations where nobody picked a client at generate time.",
         w.go(CLIENT, lay.client_row[NO_CLIENT], NO_CLIENT) if no_client else w.text("—")),
        (PENDING, t.pending_generations, t.pending_credits,
         "Still in flight (submitted, queued, running, reconciling, streaming, draft…). Not in any total. "
         "Filter Generation Log → Charge status = Pending.",
         first_status_link(PENDING)),
        (FAILED, t.failed_generations, t.failed_credits,
         "Failed, cancelled or refunded. Not in any total. Filter Charge status = Failed / Refunded.",
         first_status_link(FAILED)),
        (DUPLICATE_LABEL, stats.duplicates, stats.duplicate_credits,
         f"Same user, tool and prompt within {DUPLICATE_WINDOW_SECONDS} seconds, both charged credits. "
         f"Filter Generation Log → {DUPLICATE_LABEL}.",
         w.go(LOG, stats.first_duplicate_row, DUPLICATE_LABEL, col=lay.log_cols[DUPLICATE_LABEL])
         if stats.first_duplicate_row else w.text("—")),
        ("Zero-credit generations", t.zero_credit, 0.0,
         "Charged rows that recorded 0 credits. Suno and Flow never capture a cost (see By Tool → Cost).",
         w.go(LOG, stats.first_zero_credit_row, f"{0:,.2f}", col=lay.log_cols["Credits"])
         if stats.first_zero_credit_row else w.text("—")),
    ]
    ex = model.excluded
    issues.append(("Test & admin accounts excluded", ex.get("generations", 0), ex.get("credits", 0.0),
                   f"{ex.get('accounts', 0)} account(s) left out by the export option. Not in any total.",
                   w.go(HOME, 5, "Test & admin accounts")))
    for i, (issue, gens, credits, meaning, link) in enumerate(issues):
        lay.quality_row[issue] = FIRST_DATA_ROW + i
        ws.append([w.text(issue, font=F_BOLD), w.count(gens), w.credits(credits), w.text(meaning, align=WRAP), link])
    _add_table(ws, headers, FIRST_DATA_ROW + len(issues) - 1, "tblDataQuality")


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
        qa.append(("Which tool is used the most?", _answer(top_tool, str), (TOOL, lay.tool_row[top_tool.first], top_tool.first, "A")))
    leaders = [u for u in people if u.company_rank == 1]
    if leaders:
        lead = leaders[0]
        tie = f" · tied with {', '.join(u.label for u in leaders[1:])}" if len(leaders) > 1 else ""
        qa.append(("Who is the top user in the company?",
                   f"{lead.label} — {figures(lead.totals.credits, lead.totals.generations)}{tie}",
                   (USER, lay.user_row[lead.user_id], lead.label, "A")))
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
    qa.append(("What happened in a specific period?",
               "Pick From / To dates (and any filters) in Period Explorer; every total recalculates",
               (PERIOD, 2, PERIOD, "A")))
    unassigned = next((u for u in model.users if u.is_unassigned), None)
    if unassigned:
        qa.append(("How many charged credits have no owner?",
                   f"{figures(unassigned.totals.credits, unassigned.totals.generations)} "
                   f"({unassigned.share:.1%} of the total)",
                   (USER, lay.user_row[UNASSIGNED_USER_ID], unassigned.label, "A")))
    return qa


def _top_from_rows(rows) -> Top:
    from .model import top_of
    return top_of({r.name: (r.totals.credits, r.totals.generations) for r in rows})


def _answer(top: Top, name_of) -> str:
    text = f"{name_of(top.first)} — {figures(top.credits, top.generations)}"
    if len(top.keys) > 1:
        text += " · tied with " + ", ".join(name_of(k) for k in top.keys[1:])
    return text


def _write_home(sheets, model, lay, filters, generated_at, dashboard_url):
    ws, w = sheets[HOME]
    t = model.totals
    ws.append([w.text("Home", font=F_HOME_TAG, fill=FILL_HEADER)])                                       # 1
    ws.append([w.text("Credit Consumption Report", font=F_TITLE)])                                     # 2
    ws.append([w.text("Period", font=F_BOLD), w.text(filters.period.get("label") or f"{filters.start} – {filters.end}")])
    ws.append([w.text("Filters applied", font=F_BOLD), w.text(_filters_line(filters))])                 # 4
    ws.append([w.text("Test & admin accounts", font=F_BOLD), w.text(_exclusion_line(filters, model), align=WRAP)])  # 5
    ws.append([w.text("Generated at", font=F_BOLD), w.text(f"{generated_at:%Y-%m-%d %H:%M} IST")])      # 6
    ws.append([w.text("Output links open on", font=F_BOLD), w.text(dashboard_url or "Not configured")])  # 7
    ws.append([w.text("How credits are counted", font=F_BOLD),
               w.text("Every total counts Charged generations only. Pending and Failed / Refunded rows are listed "
                      "in the Generation Log and Data Quality but never added to a total.", align=WRAP)])  # 8
    ws.append([w.text("Explore any period", font=F_SECTION), w.go(PERIOD, 2, PERIOD, font=Font(
        color="0563C1", underline="single", bold=True, size=12))])                                      # 9

    if model.is_empty:
        ws.append([w.text("No credit activity was found for this period and these filters. "
                          "Try a wider date range or remove a filter.", font=F_SECTION, fill=FILL_EMPTY)])
    else:
        top_tool = _top_from_rows(model.tools)
        top_dept = _top_from_rows(model.departments)
        leaders = [u for u in model.users if u.company_rank == 1]
        kpis = [
            ("CHARGED CREDITS", w.credits(t.credits, font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(DEPT, lay.dept_total_row, "Total")),
            ("PENDING CREDITS", w.credits(t.pending_credits, font=F_KPI_VALUE, fill=FILL_PENDING),
             w.go(QUALITY, lay.quality_row[PENDING], PENDING)),
            ("GENERATIONS", w.count(t.generations, font=F_KPI_VALUE, fill=FILL_KPI), w.go(LOG, 2, LOG)),
            ("ACTIVE USERS", w.count(len([u for u in t.users if u != UNASSIGNED_USER_ID]), font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(USER, 2, USER)),
            ("ACTIVE DEPARTMENTS", w.count(len([d for d in model.departments if d.totals.generations]),
                                           font=F_KPI_VALUE, fill=FILL_KPI), w.go(DEPT, 2, DEPT)),
            ("MOST USED TOOL", w.text(", ".join(top_tool.keys) or "—", font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(TOOL, lay.tool_row[top_tool.first], top_tool.first) if top_tool else w.text("")),
            ("TOP USER", w.text(", ".join(u.label for u in leaders) or "—", font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(USER, lay.user_row[leaders[0].user_id], leaders[0].label) if leaders else w.text("")),
            ("TOP DEPARTMENT", w.text(", ".join(top_dept.keys) or "—", font=F_KPI_VALUE, fill=FILL_KPI),
             w.go(DEPT, lay.dept_row[top_dept.first], top_dept.first) if top_dept else w.text("")),
        ]
        ws.append([w.text(label, font=F_KPI_LABEL, fill=FILL_KPI) for label, _v, _l in kpis])           # 10
        ws.append([value for _l, value, _x in kpis])                                                   # 11
        ws.append([link for _l, _v, link in kpis])                                                     # 12
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

        _add_bar_chart(ws, sheets[DEPT][0], len(model.departments), "Credits by department", "E14")
        _add_bar_chart(ws, sheets[TOOL][0], len(model.tools), "Credits by tool", "E31")
        _add_trend_chart(ws, sheets[TREND][0], model, lay, "E48")

    ws.append([w.text("Sheets in this report", font=F_SECTION)])
    ws.append(w.header(["Sheet", "What it shows", "Open"]))
    for name in SHEET_ORDER[1:]:
        ws.append([w.text(name, font=F_BOLD), w.text(SHEET_PURPOSE[name], align=WRAP), w.go(name, 2, name)])


def _add_bar_chart(ws, source_ws, count: int, title: str, anchor: str):
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
    chart.add_data(Reference(source_ws, min_col=2, min_row=HEADER_ROW, max_row=HEADER_ROW + shown), titles_from_data=True)
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
def report_filename(filters: ReportFilters) -> str:
    return f"credit-report_{filters.start.isoformat()}_to_{filters.end.isoformat()}.xlsx"


def write_workbook(path: str, model: ReportModel, filters: ReportFilters, log_rows: Iterable,
                   *, dashboard_url: str = "", generated_at: Optional[datetime] = None) -> LogStats:
    """Render the report to ``path``. ``log_rows`` is consumed once, in order."""
    generated_at = generated_at or (datetime.utcnow() + IST)
    period_label = filters.period.get("label") or f"{filters.start} – {filters.end}"
    from . import workbook_periods as WP

    lay = Layout.plan(model)
    lay.trend = WP.plan_trend(model)
    lay.drill = WP.plan_drill(model)
    lay.trend_credits_header_row = lay.trend.tool_credits_header
    ntools, ndepts, nmonths = len(model.tools), len(model.departments), len(model.months)
    log_widths = {"Date / time (IST)": 19, "Date": 11, "Month": 10, "Week": 12, "Quarter": 9, "Charged": 9,
                  "User": 26, "Employee ID": 13, "Department": 22, "Tool": 14, "Client": 26,
                  "Task": 26, "Model / type": 20, "Prompt": 60, "Output": 14, "Credits": 12, "Charge status": 16,
                  "Raw status": 16, DUPLICATE_LABEL: 18, "Back to user": 26}

    wb = Workbook(write_only=True)
    # Period Explorer formulas carry no cached values: make every app compute on open.
    wb.calculation.fullCalcOnLoad = True
    sheets = {
        HOME: _new_sheet(wb, HOME, [44, 56, 20, 20, 20, 20, 20, 20], freeze="A2"),
        PERIOD: _new_sheet(wb, PERIOD, [22, 16, 16, 12, 10, 8, 14, 4, 20, 14] + [16, 12, 12, 10, 8, 8, 12, 4] * 3,
                           freeze="A4"),
        DEPT: _new_sheet(wb, DEPT, [28, 14, 10, 12, 14, 11, 26, 34, 16, 32, 24]),
        USER: _new_sheet(wb, USER, [30, 13, 22, 14, 12, 12, 13, 13, 13, 11, 12, 18, 32, 24, 32]),
        TOOL: _new_sheet(wb, TOOL, [18, 14, 10, 12, 13, 13, 9, 26, 34, 22, 32, 48]),
        CLIENT: _new_sheet(wb, CLIENT, [30, 14, 10, 12, 13, 9, 26, 34, 18, 32]),
        DEPT_TOOL: _new_sheet(wb, DEPT_TOOL, [28] + [14] * ntools + [14, 18, 32], freeze="B5"),
        USER_TOOL: _new_sheet(wb, USER_TOOL, [30, 22] + [14] * ntools + [14], freeze="C5"),
        USER_CLIENT: _new_sheet(wb, USER_CLIENT, [30, 22, 30, 16, 12, 14, 14]),
        TREND: _new_sheet(wb, TREND, [28] + [14] * max(ntools, ndepts, nmonths, 10) + [14, 12], freeze="B4"),
        DRILL: _new_sheet(wb, DRILL, [22, 14, 12, 12, 4, 28, 12, 12, 12, 4, 16, 12, 12, 10, 4, 28, 12, 12, 10],
                          freeze="A4"),
        QUALITY: _new_sheet(wb, QUALITY, [30, 13, 14, 80, 24]),
        LOG: _new_sheet(wb, LOG, [log_widths[h] for h in log_headers(model)]),
        LISTS: _new_sheet(wb, LISTS, [28, 30, 18, 30, 16], freeze=None),
    }
    sheets[LISTS][0].sheet_state = "hidden"

    stats = _write_log(sheets, model, lay, log_rows, dashboard_url, period_label)
    lay.log_first_row.update(stats.first_row)
    _write_departments(sheets, model, lay, period_label)
    _write_users(sheets, model, lay, period_label)
    _write_tools(sheets, model, lay, period_label)
    _write_clients(sheets, model, lay, period_label)
    _write_dept_tool(sheets, model, lay, period_label)
    _write_user_tool(sheets, model, lay, period_label)
    _write_user_client(sheets, model, lay, period_label)
    WP.write_trend(sheets, model, lay, lay.trend, lay.drill, period_label)
    WP.write_drill(sheets, model, lay, lay.trend, lay.drill, {m: row for m, (_ts, row) in stats.month_first.items()},
                   lay.log_cols.get("Month", "A"), period_label)
    _write_quality(sheets, model, lay, stats, period_label)
    list_refs = WP.write_lists(sheets, model)
    WP.write_explorer(sheets, model, lay, filters, lay.log_cols, FIRST_DATA_ROW + stats.rows - 1, list_refs, period_label)
    _write_home(sheets, model, lay, filters, generated_at, dashboard_url)
    wb.save(path)
    return stats
