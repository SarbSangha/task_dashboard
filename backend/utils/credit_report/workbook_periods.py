"""
Credit Consumption Report - date navigation sheets.

* Monthly Trend      month summary, month x tool / department (rows = months)
                     and user / client x month (rows = people, columns = months)
* Month Drill-down   one static block per month (newest first): department,
                     user, tool and client tables for that month
* Period Explorer    formula-driven: pick From / To dates and filters, every
                     table recalculates from the Generation Log
* Lists              hidden; the dropdown values for the explorer

Period Explorer formulas use only SUMIFS / COUNTIFS / COUNTIF / INDEX / MATCH /
RANK.EQ / MAX / IF / SUBSTITUTE - no FILTER, UNIQUE, SORT, LET or LAMBDA - so
the file works in Excel 2016+, LibreOffice and Google Sheets. They point at
plain ranges of the Generation Log (its size is known when the file is
written) rather than tblGenerationLog[...] structured references, which
Google Sheets and LibreOffice don't read reliably from .xlsx.

Link rule as in workbook.py: a link's label (minus "⬅ Back to " / " →") is
the text of the cell it lands on; month cells are real dates shown "mmm yyyy".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from .facts import NO_CLIENT, UNASSIGNED_USER_ID
from .model import ReportModel, top_of
from . import navigation as N
from . import workbook as W

TREND, DRILL, PERIOD, LISTS = W.TREND, "Month Drill-down", "Period Explorer", "Lists"
MONTH_FMT = "mmm yyyy"
DATE_FMT = "dd mmm yyyy"
ZERO_CHARGED_FMT = '#,##0.00;-#,##0.00;"0 charged"'
CHANGE_FMT = '+#,##0.00;-#,##0.00;0.00'
CHANGE_PCT_FMT = '+0.0%;-0.0%;0.0%'
FILL_INPUT = PatternFill("solid", fgColor="FFF2CC")
FILL_TOP3 = PatternFill("solid", fgColor="E2EFDA")
F_GREY = Font(color="A6A6A6")
F_HELPER = Font(color="808080", italic=True, size=9)
EXPLORER_MAX_LOG_ROWS = 300_000
BANNED_FUNCTIONS = ("FILTER", "UNIQUE", "SORT", "LET", "LAMBDA")


def month_date(month: str) -> datetime:
    y, m = month.split("-")
    return datetime(int(y), int(m), 1)


def month_label(month: str) -> str:
    return month_date(month).strftime("%b %Y")


def _q(text: str) -> str:
    """A text value as a formula string literal."""
    return '"' + str(text).replace('"', '""') + '"'


def _crit_literal(text: str) -> str:
    """An exact-match SUMIFS criterion: escape the * ? ~ wildcards."""
    return _q(str(text).replace("~", "~~").replace("*", "~*").replace("?", "~?"))


# --------------------------------------------------------------------------- #
# Layout plans (every link target known before anything is written)
# --------------------------------------------------------------------------- #
@dataclass
class TrendLayout:
    summary_header: int = 5
    summary_row: dict = field(default_factory=dict)     # month -> row
    blocks: list = field(default_factory=list)          # (key, title, header_row)
    tool_credits_header: int = 0
    tool_col: dict = field(default_factory=dict)        # tool -> letter (credits by month and tool)
    dept_credits_header: int = 0
    dept_col: dict = field(default_factory=dict)
    user_row: dict = field(default_factory=dict)        # user id -> row (user credits by month)
    client_row: dict = field(default_factory=dict)


def plan_trend(model: ReportModel) -> TrendLayout:
    lay = TrendLayout()
    months, tools, depts = model.months, [t.name for t in model.tools], [d.name for d in model.departments]
    row = W.HEADER_ROW                                   # first block's title row

    def block(key, title, n_rows):
        nonlocal row
        header = row + 1
        lay.blocks.append((key, title, header))
        row = header + n_rows + 2
        return header

    lay.summary_header = block("summary", "Month summary", len(months))
    lay.summary_row = {m: lay.summary_header + 1 + i for i, m in enumerate(months)}
    lay.tool_credits_header = block("tool_credits", "Credits by month and tool", len(months))
    lay.tool_col = {t: get_column_letter(2 + i) for i, t in enumerate(tools)}
    block("tool_generations", "Generations by month and tool", len(months))
    lay.dept_credits_header = block("dept_credits", "Credits by month and department", len(months))
    lay.dept_col = {d: get_column_letter(2 + i) for i, d in enumerate(depts)}
    block("dept_generations", "Generations by month and department", len(months))
    user_header = block("user_credits", "Credits by user and month", max(1, len(model.users)))
    lay.user_row = {u.user_id: user_header + 1 + i for i, u in enumerate(model.users)}
    block("user_generations", "Generations by user and month", max(1, len(model.users)))
    client_header = block("client_credits", "Credits by client and month", max(1, len(model.clients)))
    lay.client_row = {c.name: client_header + 1 + i for i, c in enumerate(model.clients)}
    block("client_generations", "Generations by client and month", max(1, len(model.clients)))
    return lay


def month_breakdown(model: ReportModel, month: str) -> dict:
    """Charged rows of one month: {kind: [(key, credits, generations)]}, heaviest first."""
    def rows(store):
        items = [(k[1], v[0], v[1]) for k, v in store.items() if k[0] == month and (v[0] or v[1])]
        return sorted(items, key=lambda r: (-round(r[1], 4), -r[2], str(r[0]).lower()))
    return {"dept": rows(model.month_dept), "user": rows(model.month_user), "tool": rows(model.month_tool),
            "client": rows(model.month_client)}


@dataclass
class DrillLayout:
    index_row: dict = field(default_factory=dict)       # month -> index row
    block_row: dict = field(default_factory=dict)       # month -> block header row
    order: list = field(default_factory=list)           # months, newest first


def plan_drill(model: ReportModel) -> DrillLayout:
    lay = DrillLayout(order=sorted(model.months, reverse=True))
    lay.index_row = {m: W.FIRST_DATA_ROW + i for i, m in enumerate(lay.order)}
    row = W.FIRST_DATA_ROW + len(lay.order) + 1
    for m in lay.order:
        lay.block_row[m] = row
        parts = month_breakdown(model, m)
        row += 3 + max(1, *(len(v) for v in parts.values())) + 1
    return lay


def _summary_top(top, name_of=str) -> str:
    if not top:
        return "—"
    names = [name_of(k) for k in top.keys]
    return names[0] if len(names) == 1 else "Tie: " + ", ".join(names)


# --------------------------------------------------------------------------- #
# Monthly Trend
# --------------------------------------------------------------------------- #
def write_trend(sheets, model, lay, tlay: TrendLayout, dlay: DrillLayout, period_label):
    ws, w = sheets[TREND]
    W._preamble(ws, w, TREND, f"{period_label} · Charged rows only, by IST calendar month. "
                              "Each month opens its block in Month Drill-down.")
    if not model.months:
        W._empty_row(ws, w, 4)
        return
    months = model.months
    tools = [t.name for t in model.tools]
    depts = [d.name for d in model.departments]

    def drill_link(m):
        return w.go(DRILL, dlay.block_row[m], month_label(m))

    def month_cell(m):
        # The month itself opens its Month Drill-down block (a link holds
        # text, so the column sorts as text).
        return w.link(W.internal_target(DRILL, dlay.block_row[m]), month_label(m), font=Font(
            color="0563C1", underline="single", bold=True))

    def top_user_text(parts_user):
        name_of = lambda u: model.user(u).label  # noqa: E731
        top = top_of(parts_user, name_of)
        text = _summary_top(top, name_of)
        named = top_of({k: v for k, v in parts_user.items() if k != UNASSIGNED_USER_ID}, name_of)
        if top.first == UNASSIGNED_USER_ID and named:
            text += f" (top named: {name_of(named.first)})"
        return text

    for key, title, header in tlay.blocks:
        ws.append([w.text(title, font=W.F_SECTION)])
        if key == "summary":
            headers = ["Month", "Credits", "Generations", "Active users", "Top user", "Top tool", "Top department",
                       "Top client", "Change vs previous month", "Change %", "Drill-down"]
            ws.append(w.header(headers))
            prev = None
            for m in months:
                t = model.month_totals.get(m)
                credits, gens = (t.credits, t.generations) if t else (0.0, 0)
                active = len([u for u in (t.users if t else set()) if u != UNASSIGNED_USER_ID])
                parts = {k: {key2: (c, g) for key2, c, g in v} for k, v in month_breakdown(model, m).items()}
                change = credits - prev if prev is not None else None
                ws.append([
                    month_cell(m),
                    w.cell(credits, fmt=ZERO_CHARGED_FMT if (t and t.all_generations) else W.CREDITS_FMT),
                    w.count(gens), w.count(active),
                    w.text(top_user_text(parts["user"])),
                    w.text(_summary_top(top_of(parts["tool"]))),
                    w.text(_summary_top(top_of(parts["dept"]))),
                    w.text(_summary_top(top_of({k: v for k, v in parts["client"].items() if k != NO_CLIENT}))),
                    w.cell(change, fmt=CHANGE_FMT) if change is not None else w.text("—"),
                    w.cell(change / prev, fmt=CHANGE_PCT_FMT) if change is not None and prev else w.text("—"),
                    drill_link(m),
                ])
                prev = credits
            W._add_table(ws, headers, header + len(months), "tblTrendSummary", header_row=header)
        elif key in ("tool_credits", "tool_generations", "dept_credits", "dept_generations"):
            columns = tools if key.startswith("tool") else depts
            store = model.month_tool if key.startswith("tool") else model.month_dept
            idx, fmt = (0, W.CREDITS_FMT) if key.endswith("credits") else (1, W.COUNT_FMT)
            headers = W.unique_headers(["Month"] + columns + ["Total", "Drill-down"])
            ws.append(w.header(headers))
            for m in months:
                values = [store.get((m, c), (0.0, 0))[idx] for c in columns]
                ws.append([month_cell(m)] + [w.cell(v, fmt=fmt) for v in values]
                          + [w.cell(sum(values), fmt=fmt, font=W.F_BOLD), drill_link(m)])
            last = header + len(months)
            name = {"tool_credits": "tblTrendToolCredits", "tool_generations": "tblTrendToolGenerations",
                    "dept_credits": "tblTrendDeptCredits", "dept_generations": "tblTrendDeptGenerations"}[key]
            W._add_table(ws, headers, last, name, header_row=header)
            if columns:
                ws.conditional_formatting.add(f"B{header + 1}:{get_column_letter(1 + len(columns))}{last}", W.COLOR_SCALE)
        else:
            is_user = key.startswith("user")
            idx, fmt = (0, W.CREDITS_FMT) if key.endswith("credits") else (1, W.COUNT_FMT)
            entities = model.users if is_user else model.clients
            first_header = "User" if is_user else "Client"
            headers = W.unique_headers([first_header] + [month_label(m) for m in months] + ["Total"])
            ws.append(w.header(headers))
            for e in entities:
                if is_user:
                    label = W.user_link(w, lay, e.user_id, e.label)
                    values = [model.month_user.get((m, e.user_id), (0.0, 0))[idx] for m in months]
                else:
                    label = w.text(e.name)          # By Client's "↔ … in Monthly Trend" lands here; ⬅ returns
                    values = [model.month_client.get((m, e.name), (0.0, 0))[idx] for m in months]
                ws.append([label] + [w.cell(v, fmt=fmt) for v in values] + [w.cell(sum(values), fmt=fmt, font=W.F_BOLD)])
            last = header + len(entities)
            if entities:
                name = {"user_credits": "tblTrendUserCredits", "user_generations": "tblTrendUserGenerations",
                        "client_credits": "tblTrendClientCredits", "client_generations": "tblTrendClientGenerations"}[key]
                W._add_table(ws, headers, last, name, header_row=header)
                ws.conditional_formatting.add(f"B{header + 1}:{get_column_letter(1 + len(months))}{last}", W.COLOR_SCALE)
            else:
                W._empty_row(ws, w, 2)
        ws.append([])


# --------------------------------------------------------------------------- #
# Month Drill-down
# --------------------------------------------------------------------------- #
DRILL_TABLES = (("dept", "Department", 1), ("user", "User", 6), ("tool", "Tool", 11), ("client", "Client", 16))


def write_drill(sheets, model, lay, tlay: TrendLayout, dlay: DrillLayout, month_first_row: dict, log_back_col: str,
                period_label):
    """month_first_row: month -> its first generation row in the log (log
    order); the link lands on that row's "⬅ Drill-down" cell (log_back_col),
    which links back."""
    ws, w = sheets[DRILL]
    W._preamble(ws, w, DRILL, f"{period_label} · One block per month, newest first. Charged rows only.")
    if not model.months:
        W._empty_row(ws, w, 4)
        return
    ws.append([w.text("Months", font=W.F_SECTION)])
    for m in dlay.order:
        t = model.month_totals.get(m)
        ws.append([w.go(DRILL, dlay.block_row[m], month_label(m)),
                   w.text(W.figures(t.credits, t.generations) if t else "—")])
    ws.append([])

    for m in dlay.order:
        t = model.month_totals.get(m)
        credits, gens = (t.credits, t.generations) if t else (0.0, 0)
        active = len([u for u in (t.users if t else set()) if u != UNASSIGNED_USER_ID])
        label = month_label(m)
        ws.append([w.text(label, font=W.F_TITLE), w.text("Credits", font=W.F_BOLD),
                   w.cell(credits, fmt=ZERO_CHARGED_FMT if (t and t.all_generations) else W.CREDITS_FMT, font=W.F_BOLD),
                   w.text("Generations", font=W.F_BOLD), w.count(gens, font=W.F_BOLD),
                   w.text("Active users", font=W.F_BOLD), w.count(active, font=W.F_BOLD), w.cell(),
                   w.link(W.internal_target(TREND, tlay.summary_row[m]), f"⬅ Back to {label}")])
        first = month_first_row.get(m)
        ws.append([w.text("First log row of this month:", font=W.F_ITALIC),
                   w.link(W.internal_target(W.LOG, first, log_back_col), f"{label} →") if first else w.text("—"),
                   w.text(f"The log is grouped by user and tool: filter its Month column to {label} to see every "
                          "row of this month.",
                          font=W.F_ITALIC)])
        parts = month_breakdown(model, m)
        header_cells = []
        for kind, title, start in DRILL_TABLES:
            pad = [w.cell() for _ in range(start - 1 - len(header_cells))]
            header_cells += pad + w.header([title, "Credits", "Generations", "% of month"])
        ws.append(header_cells)
        height = max(1, *(len(v) for v in parts.values()))
        for i in range(height):
            cells = []
            for kind, _title, start in DRILL_TABLES:
                cells += [w.cell() for _ in range(start - 1 - len(cells))]
                items = parts[kind]
                if i >= len(items):
                    cells += [w.cell() for _ in range(4)]
                    continue
                key, c, g = items[i]
                if kind == "dept":
                    name = w.link(W.internal_target(W.DEPT, lay.dept_row[key]), key)
                elif kind == "user":
                    name = W.user_link(w, lay, key, model.user(key).label)
                elif kind == "tool":
                    name = W.tool_link(w, lay, key)
                else:
                    name = w.link(W.internal_target(W.CLIENT, lay.client_row[key]), key)
                cells += [name, w.credits(c), w.count(g), w.pct(c / credits if credits else 0.0)]
            ws.append(cells)
        ws.append([])


# --------------------------------------------------------------------------- #
# Lists (hidden) + Period Explorer
# --------------------------------------------------------------------------- #
@dataclass
class ExplorerRanges:
    date: str
    status: str
    dept: str
    user: str
    tool: str
    client: str
    credits: str
    month: str


def log_ranges(log_cols: dict, last_row: int) -> ExplorerRanges:
    def rng(header):
        col = log_cols[header]
        return f"'{W.LOG}'!${col}${W.FIRST_DATA_ROW}:${col}${last_row}"
    return ExplorerRanges(date=rng("Date"), status=rng("Charge status"), dept=rng("Department"), user=rng("User"),
                          tool=rng("Tool"), client=rng("Client"), credits=rng("Credits"), month=rng("Month"))


def list_values(model: ReportModel) -> dict:
    return {
        "dept": ["All"] + [d.name for d in model.departments],
        "user": ["All"] + [u.label for u in model.users],
        "tool": ["All"] + [t.name for t in model.tools],
        "client": ["All"] + [c.name for c in model.clients],
        "pending": ["No", "Yes"],
    }


def write_lists(sheets, model):
    ws, w = sheets[LISTS]
    lists = list_values(model)
    cols = ("dept", "user", "tool", "client", "pending")
    ws.append([w.text(h, font=W.F_BOLD) for h in ("Departments", "Users", "Tools", "Clients", "Include Pending")])
    for i in range(max(len(v) for v in lists.values())):
        ws.append([w.text(lists[c][i]) if i < len(lists[c]) else w.cell() for c in cols])
    return {c: f"{LISTS}!${get_column_letter(j + 1)}$2:${get_column_letter(j + 1)}${len(lists[c]) + 1}"
            for j, c in enumerate(cols)}


# Explorer cell map (rows are fixed so formulas and tests can rely on them).
IN_FROM, IN_TO, IN_DEPT, IN_USER, IN_TOOL, IN_CLIENT, IN_PENDING = (f"$B${r}" for r in range(5, 12))
H_FROM, H_TO = "$J$5", "$J$6"               # previous period dates
H_DEPT, H_USER, H_TOOL, H_CLIENT, H_STATUS = (f"$J${r}" for r in range(7, 12))
KPI_HEADER = 19
KPI_ROWS = {"credits": 20, "generations": 21, "active": 22, "per_gen": 23}
TOP_HEADER = 26
TOP_ROWS = {"user": 27, "tool": 28, "dept": 29, "client": 30}
MATRIX_TITLE = 32
JUMP_BACK_COL = 10                           # "⬅ Jump row" on each section title (column J)


@dataclass
class ExplorerLayout:
    matrix_header: int = MATRIX_TITLE + 1
    tables_header: int = 0
    tables: dict = field(default_factory=dict)   # kind -> (start column index, first row, last row)
    # Last row a "top" answer may come from: "Unassigned" (users) and
    # "No client" (clients) are buckets, not people or clients, and are listed
    # last, so top answers stop just above them - as on Home.
    top_last: dict = field(default_factory=dict)


def plan_explorer(model: ReportModel) -> ExplorerLayout:
    lay = ExplorerLayout()
    lay.tables_header = lay.matrix_header + len(model.months) + 3
    counts = {"dept": len(model.departments), "user": len(model.users), "tool": len(model.tools),
              "client": len(model.clients)}
    for kind, start in (("dept", 1), ("user", 9), ("tool", 17), ("client", 25)):
        first, last = lay.tables_header + 1, lay.tables_header + max(1, counts[kind])
        lay.tables[kind] = (start, first, last)
        bucket_last = (kind == "user" and model.users and model.users[-1].user_id == UNASSIGNED_USER_ID) or \
                      (kind == "client" and model.clients and model.clients[-1].name == NO_CLIENT)
        lay.top_last[kind] = last - 1 if bucket_last and last > first else last
    return lay


def _criteria(r: ExplorerRanges, *, prev=False, extra=()) -> str:
    frm, to = (H_FROM, H_TO) if prev else (IN_FROM, IN_TO)
    parts = [r.date, f'">="&{frm}', r.date, f'"<="&{to}', r.status, H_STATUS, r.dept, H_DEPT, r.user, H_USER,
             r.tool, H_TOOL, r.client, H_CLIENT]
    for rng, crit in extra:
        parts += [rng, crit]
    return ",".join(parts)


def _escaped(cell: str) -> str:
    return f'SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({cell},"~","~~"),"*","~*"),"?","~?")'


def write_explorer(sheets, model, lay, filters, log_cols: dict, log_last_row: int, list_refs: dict, period_label):
    ws, w = sheets[PERIOD]
    W._crumb_row(ws, w, PERIOD)
    ws.append([w.text(PERIOD, font=W.F_TITLE)])
    ws.append([w.text(f"Report period {period_label}. Pick any dates and filters below; every table recalculates "
                      "from the Generation Log.", font=W.F_SUBTITLE)])
    has_data = W.FIRST_DATA_ROW <= log_last_row and log_last_row - W.FIRST_DATA_ROW + 1 <= EXPLORER_MAX_LOG_ROWS
    elay_plan = plan_explorer(model)
    # Jump row: down to the sections below the inputs (each title has "⬅ Jump row" back here).
    jumps = [("Top in the selected period", TOP_HEADER - 1), ("Credits by month and tool", MATRIX_TITLE),
             ("By department, user, tool and client", elay_plan.tables_header - 1)]
    jump_font = Font(color="0563C1", underline="single", size=9)
    ws.append([w.text("Jump to:", font=W.F_ITALIC)]
              + [w.nav(W.internal_target(PERIOD, row), f"↓ {name}", font=jump_font) for name, row in jumps]
              if has_data else [])                                                                         # 4

    def jump_back(i):
        return w.link(W.internal_target(PERIOD, 4, get_column_letter(i + 2)), "⬅ Jump row", font=N.F_BACK,
                      fill=N.FILL_BACK)
    pad = [w.cell() for _ in range(JUMP_BACK_COL - 2)]
    if log_last_row < W.FIRST_DATA_ROW or log_last_row - W.FIRST_DATA_ROW + 1 > EXPLORER_MAX_LOG_ROWS:
        msg = ("No generations in this report, so there is nothing to explore." if log_last_row < W.FIRST_DATA_ROW
               else f"This export has more than {EXPLORER_MAX_LOG_ROWS:,} generations, which makes the explorer's "
                    "formulas too slow. Export a shorter date range to use it; Monthly Trend and Month Drill-down "
                    "still cover every month.")
        ws.append([w.text(msg, font=W.F_SECTION, fill=W.FILL_EMPTY)])
        return None
    r = log_ranges(log_cols, log_last_row)
    elay = plan_explorer(model)
    start, end = filters.start, filters.end

    def inp(value, fmt=None):
        c = w.cell(value, fmt=fmt, fill=FILL_INPUT, font=W.F_BOLD)
        return c

    rows = [
        ("From", inp(datetime(start.year, start.month, start.day), DATE_FMT),
         "This month: From = 1st of the month, To = its last day. Last month: the 1st to the last day of last month.",
         "Previous period from", f"={IN_FROM}-({IN_TO}-{IN_FROM}+1)", DATE_FMT),
        ("To", inp(datetime(end.year, end.month, end.day), DATE_FMT),
         f"Whole report: From = {start:%d %b %Y}, To = {end:%d %b %Y}. A quarter: e.g. 1 Jul – 30 Sep.",
         "Previous period to", f"={IN_FROM}-1", DATE_FMT),
        ("Department", inp("All"), "Pick a department, or All.", "Department criterion",
         f'=IF({IN_DEPT}="All","*",{_escaped(IN_DEPT)})', None),
        ("User", inp("All"), "Pick a user, or All.", "User criterion", f'=IF({IN_USER}="All","*",{_escaped(IN_USER)})', None),
        ("Tool", inp("All"), "Pick a tool, or All.", "Tool criterion", f'=IF({IN_TOOL}="All","*",{_escaped(IN_TOOL)})', None),
        ("Client", inp("All"), "Pick a client, or All.", "Client criterion",
         f'=IF({IN_CLIENT}="All","*",{_escaped(IN_CLIENT)})', None),
        ("Include Pending", inp("No"), "No = Charged only (matches every other sheet). Yes = Charged + Pending.",
         "Status criterion", f'=IF({IN_PENDING}="Yes","<>Failed / Refunded","Charged")', None),
    ]
    for label, cell, tip, helper_label, helper, hfmt in rows:                                              # 5-11
        ws.append([w.text(label, font=W.F_BOLD), cell, w.text(tip, font=W.F_ITALIC)] + [w.cell() for _ in range(5)]
                  + [w.text(helper_label, font=F_HELPER), w.cell(helper, fmt=hfmt, font=F_HELPER)])
    ws.append([])                                                                                          # 12
    how = [
        "How to use",
        "Type dates in From / To (yellow cells) and pick filters from the dropdowns; everything below recalculates.",
        "Works in Excel 2016 and later, LibreOffice and Google Sheets (import the file as a Google Sheet). "
        "No macros and no Excel 365-only functions.",
        "Previous period = the same number of days just before From. Column J holds helper values; don't edit them.",
    ]
    for i, line in enumerate(how):                                                                         # 13-16
        ws.append([w.text(line, font=W.F_SECTION if i == 0 else W.F_ITALIC)])
    ws.append([])                                                                                          # 17
    ws.append([w.text("Selected period", font=W.F_SECTION)])                                               # 18
    ws.append(w.header(["Metric", "Selected period", "Previous period", "Change %"]))                       # 19

    # Entity tables are referenced by the KPI / top formulas.
    def table_range(kind, col_offset, *, top=False):
        start_col, first, last = elay.tables[kind]
        col = get_column_letter(start_col + col_offset)
        return f"${col}${first}:${col}${elay.top_last[kind] if top else last}"

    unassigned_gens = None
    if any(u.user_id == UNASSIGNED_USER_ID for u in model.users):
        idx = next(i for i, u in enumerate(model.users) if u.user_id == UNASSIGNED_USER_ID)
        start_col, first, _last = elay.tables["user"]
        unassigned_gens = f"{get_column_letter(start_col + 2)}{first + idx}"
        unassigned_prev = f"{get_column_letter(start_col + 6)}{first + idx}"
    gens_rng, prev_gens_rng = table_range("user", 2), table_range("user", 6)
    active_now = f"COUNTIF({gens_rng},\">0\")" + (f"-IF({unassigned_gens}>0,1,0)" if unassigned_gens else "")
    active_prev = f"COUNTIF({prev_gens_rng},\">0\")" + (f"-IF({unassigned_prev}>0,1,0)" if unassigned_gens else "")
    kpis = [
        ("Credits", f"=SUMIFS({r.credits},{_criteria(r)})", f"=SUMIFS({r.credits},{_criteria(r, prev=True)})", W.CREDITS_FMT),
        ("Generations", f"=COUNTIFS({_criteria(r)})", f"=COUNTIFS({_criteria(r, prev=True)})", W.COUNT_FMT),
        ("Active users", f"={active_now}", f"={active_prev}", W.COUNT_FMT),
        ("Credits per generation", f"=IF(B21=0,0,B20/B21)", f"=IF(C21=0,0,C20/C21)", W.CREDITS_FMT),
    ]
    for label, now_f, prev_f, fmt in kpis:                                                                 # 20-23
        row = 20 + kpis.index((label, now_f, prev_f, fmt))
        ws.append([w.text(label, font=W.F_BOLD), w.cell(now_f, fmt=fmt, font=W.F_KPI_VALUE),
                   w.cell(prev_f, fmt=fmt), w.cell(f'=IF(C{row}=0,"—",(B{row}-C{row})/C{row})', fmt=CHANGE_PCT_FMT)])
    ws.append([])                                                                                          # 24
    ws.append([w.text("Top in the selected period", font=W.F_SECTION)] + pad + [jump_back(0)])             # 25
    ws.append(w.header(["What", "Top", "Credits", "Top named user"]))                                       # 26
    for kind, label in (("user", "Top user"), ("tool", "Top tool"), ("dept", "Top department"), ("client", "Top client")):
        names, credits, tie = (table_range(kind, k, top=True) for k in (0, 1, 5))
        first = f"INDEX({names},MATCH(1,{tie},0))"
        second = f"INDEX({names},MATCH(2,{tie},0))"
        n = f"COUNTIF({credits},MAX({credits}))"
        named = f'IF({n}=1,{first},"Tie: "&{first}&", "&{second}&IF({n}>2," +"&({n}-2)&" more",""))'
        if kind == "user" and unassigned_gens:
            # One top-user rule: Unassigned counts; it wins only with more
            # credits than every named user, and the best named user shows beside it.
            unassigned_cr = unassigned_gens.replace(get_column_letter(elay.tables["user"][0] + 2),
                                                    get_column_letter(elay.tables["user"][0] + 1))
            formula = (f'=IF(MAX({table_range(kind, 1)})<=0,"—",IF({unassigned_cr}>MAX({credits}),"Unassigned",'
                       f'{named}))')
            cells = [w.cell(f"=MAX({table_range(kind, 1)})", fmt=W.CREDITS_FMT),
                     w.cell(f'=IF(B{TOP_ROWS["user"]}="Unassigned",IF(MAX({credits})<=0,"—",{first}),"")')]
        else:
            formula = f'=IF(MAX({credits})<=0,"—",{named})'
            cells = [w.cell(f"=MAX({credits})", fmt=W.CREDITS_FMT)]
        ws.append([w.text(label, font=W.F_BOLD), w.cell(formula, font=W.F_BOLD)] + cells)                  # 27-30
    ws.append([])                                                                                          # 31

    # Month x Tool for the selected range.
    ws.append([w.text("Credits by month and tool (selected range and filters)", font=W.F_SECTION)]
              + pad + [jump_back(1)])                                                                      # 32
    tools = [t.name for t in model.tools]
    headers = W.unique_headers(["Month"] + tools + ["Total"])
    ws.append(w.header(headers))                                                                           # 33
    for i, m in enumerate(model.months):
        row = elay.matrix_header + 1 + i
        d = month_date(m)
        cells = [w.cell(d, fmt=MONTH_FMT, font=W.F_BOLD)]
        for j, t in enumerate(tools):
            crit = _criteria(r, extra=((r.month, f"$A{row}"), (r.tool, _crit_literal(t))))
            cells.append(w.cell(f"=SUMIFS({r.credits},{crit})", fmt=W.CREDITS_FMT))
        last_tool_col = get_column_letter(1 + len(tools))
        cells.append(w.cell(f"=SUM(B{row}:{last_tool_col}{row})", fmt=W.CREDITS_FMT, font=W.F_BOLD) if tools
                     else w.cell(0, fmt=W.CREDITS_FMT))
        ws.append(cells)
    matrix_last = elay.matrix_header + len(model.months)
    if model.months:
        W._add_table(ws, headers, matrix_last, "tblExplorerMonthTool", header_row=elay.matrix_header)
        if tools:
            ws.conditional_formatting.add(
                f"B{elay.matrix_header + 1}:{get_column_letter(1 + len(tools))}{matrix_last}", W.COLOR_SCALE)
    ws.append([])
    ws.append([w.text("By department, user, tool and client (selected range and filters)", font=W.F_SECTION)]
              + pad + [jump_back(2)])

    # Entity tables side by side: Name | Credits | Generations | % | Rank | Tie # | Prev generations
    entities = {
        "dept": [(d.name, d.name, r.dept) for d in model.departments],
        "user": [(u.label, u.label, r.user) for u in model.users],
        "tool": [(t.name, t.name, r.tool) for t in model.tools],
        "client": [(c.name, c.name, r.client) for c in model.clients],
    }
    titles = {"dept": "Department", "user": "User", "tool": "Tool", "client": "Client"}
    header_cells = []
    for kind in ("dept", "user", "tool", "client"):
        start_col = elay.tables[kind][0]
        header_cells += [w.cell() for _ in range(start_col - 1 - len(header_cells))]
        header_cells += w.header([titles[kind], "Credits", "Generations", "% of selected total", "Rank", "Tie #",
                                  "Previous period generations"])
    ws.append(header_cells)                                                                                # tables_header
    height = max(1, *(len(v) for v in entities.values()))
    link_rows = {"dept": lay.dept_row, "tool": lay.tool_row, "client": lay.client_row}
    for i in range(height):
        row = elay.tables_header + 1 + i
        cells = []
        for kind in ("dept", "user", "tool", "client"):
            start_col, first, last = elay.tables[kind]
            cells += [w.cell() for _ in range(start_col - 1 - len(cells))]
            if i >= len(entities[kind]):
                cells += [w.cell() for _ in range(7)]
                continue
            label, key, rng = entities[kind][i]
            col = lambda k: get_column_letter(start_col + k)  # noqa: E731
            if kind == "user":
                name = W.user_link(w, lay, model.users[i].user_id, label)
            elif kind == "tool":
                name = W.tool_link(w, lay, key, label=label)
            else:
                name = w.link(W.internal_target({"dept": W.DEPT, "tool": W.TOOL, "client": W.CLIENT}[kind],
                                                link_rows[kind][key]), label)
            crit = _criteria(r, extra=((rng, _crit_literal(key)),))
            crit_prev = _criteria(r, prev=True, extra=((rng, _crit_literal(key)),))
            credits_rng = f"${col(1)}${first}:${col(1)}${last}"
            top_rng = f"${col(1)}${first}:${col(1)}${elay.top_last[kind]}"
            in_top = row <= elay.top_last[kind]
            cells += [
                name,
                w.cell(f"=SUMIFS({r.credits},{crit})", fmt=W.CREDITS_FMT),
                w.cell(f"=COUNTIFS({crit})", fmt=W.COUNT_FMT),
                w.cell(f"=IF($B$20=0,0,{col(1)}{row}/$B$20)", fmt=W.PCT_FMT),
                w.cell(f'=IF({col(1)}{row}<=0,"",RANK.EQ({col(1)}{row},{credits_rng}))'),
                (w.cell(f'=IF(AND({col(1)}{row}>0,{col(1)}{row}=MAX({top_rng})),'
                        f'COUNTIF(${col(1)}${first}:{col(1)}{row},MAX({top_rng})),"")', font=F_HELPER)
                 if in_top else w.text("not ranked", font=F_HELPER)),
                w.cell(f"=COUNTIFS({crit_prev})", fmt=W.COUNT_FMT),
            ]
        ws.append(cells)

    # Data validation (dropdowns, dates) and highlighting.
    dv_date = DataValidation(type="date", operator="between", formula1="DATE(2000,1,1)", formula2="DATE(2100,12,31)",
                             allow_blank=False, showErrorMessage=True, errorTitle="Date needed",
                             error="Type a date, e.g. 01/10/2026.")
    dv_date.add("B5:B6")
    ws.data_validations.append(dv_date)
    for cell, key in (("B7", "dept"), ("B8", "user"), ("B9", "tool"), ("B10", "client"), ("B11", "pending")):
        dv = DataValidation(type="list", formula1=list_refs[key], allow_blank=False, showErrorMessage=True,
                            errorTitle="Pick from the list", error="Choose a value from the dropdown.")
        dv.add(cell)
        ws.data_validations.append(dv)
    for kind in ("dept", "user", "tool", "client"):
        start_col, first, last = elay.tables[kind]
        if last < first:
            continue
        a, b = get_column_letter(start_col), get_column_letter(start_col + 6)
        c_cr, c_gen, c_rank = (get_column_letter(start_col + k) for k in (1, 2, 4))
        ws.conditional_formatting.add(f"{a}{first}:{b}{last}",
                                      FormulaRule(formula=[f"AND(${c_cr}{first}>0,${c_rank}{first}<=3)"], fill=FILL_TOP3))
        ws.conditional_formatting.add(f"{a}{first}:{b}{last}",
                                      FormulaRule(formula=[f"${c_gen}{first}=0"], font=F_GREY))
    return elay
