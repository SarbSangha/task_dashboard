"""Interactive dashboard workbook: the Usage & Spend page as one Excel file.

The Dashboard sheet copies the page - KPI cards, the filter bar (Tool,
Account, Department, Person, Client, Search, and a From / To date range
inside the period), the three charts with their
measure toggles - and the tab sheets copy its tabs (Activity, People, Tools,
Clients, Daily, Monthly, Departments, Compare). Every number is a live
formula over the period's rows, so changing a filter cell recalculates the
cards, redraws the charts and re-ranks every tab, as the page does.

Plain formulas only (SUMIFS / COUNTIFS / INDEX / MATCH, no macros, no
dynamic arrays), so it works in any Excel, Google Sheets and LibreOffice.

The figures follow live_sheet.build_live_sheet and management.PeriodView:
  - a row's ₹ is fixed for the period (costing shares a fee over the whole
    period before any filter), so a filtered total is a SUMIFS over rows;
  - Total spent = row ₹ + unused plan fees + untracked subscriptions, the
    last two only while no filter is on (PeriodView.filtered);
  - Search narrows Activity and People only, as on the page;
  - a narrower From / To counts as a filter (plan fees left out) and is
    compared with the same days of the previous period (shifted back by
    the gap between the two periods' starts).

Hidden sheets: Data (one row per generation, for Activity), Agg (charged
rows summed per period/day/tool/account/person/client, for every total),
Calc (all the formulas), Lists (dropdown values).
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.chart import AreaChart, BarChart, DoughnutChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.drawing.line import LineProperties
from openpyxl.chart.data_source import AxDataSource, StrRef
from openpyxl.formatting.rule import ColorScaleRule, DataBarRule, FormulaRule, Rule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.styles.numbers import NumberFormat
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation
from sqlalchemy.orm import Session

from models_new import User

from .costing import PAY_PER_USE
from .facts import (
    CHARGED,
    IST_MINUTES,
    NO_CLIENT,
    UNASSIGNED,
    UNASSIGNED_DEPARTMENT,
    UNASSIGNED_USER_ID,
    ReportFilters,
    load_day_groups,
    load_excluded_summary,
    load_groups,
    prepare,
    recent_log,
)
from .live_sheet import TOOL_OUTPUT_CATEGORY, classify_generation, load_seats
from .management import build_management, period_label
from .model import build_model
from .workbook import INR_FMT, clean_text
from .xlsx_styles import add_vba_project, apply_merges, apply_style_flags

IST_DELTA = timedelta(minutes=IST_MINUTES)

MAX_ROWS = 50_000          # per period; more than this is too slow to recalculate as live formulas
ACTIVITY_ROWS = 1000       # the page shows 800
PROMPT_CHARS = 300
MATRIX_CELL_LIMIT = 4000   # person x client lookups above this are left out (too slow)

CUR, PREV = "Current", "Previous"
ALL_TOOLS, ALL_ACCOUNTS, ALL_DEPTS, EVERYONE, ALL_CLIENTS = (
    "All tools", "All accounts", "All departments", "Everyone", "All clients")
TOOL_MEASURES = ("By outputs", "By spend", "By credits")      # page TOOL_MODES order
DEPT_MEASURES = ("By spend", "By outputs", "By credits")      # page DEPT_MODES order
PALETTE = ("10B981", "8B5CF6", "38BDF8", "F59E0B", "EC4899", "14B8A6", "F97316", "A3E635")

# Compare (ComparePanel.jsx): its four modes, metrics, sorts and rankings.
# A metric: (label, Calc column, number style, best: hi / lo (lower is better, zeros skipped) / "" none)
CMP_MODES = ("Tool comparison", "People comparison", "Generation comparison", "Credit comparison")
CMP_TOOL_METRICS = (
    ("Outputs", "t_out", "num", "hi"), ("Credits used", "t_cred", "num", "hi"),
    ("Total spend", "t_total", "inr", "hi"), ("Usage spend", "t_usage", "inr", "hi"),
    ("Plan fee", "t_fee", "inr", ""), ("People using it", "t_people", "num", "hi"),
    ("Cost per output", "t_perout", "inr", "lo"), ("Outputs / day", "t_perday", "num", "hi"),
    ("Share of spend", "t_share", "pct", ""))
CMP_PEOPLE_METRICS = (
    ("Outputs", "p_out", "num", "hi"), ("Credits used", "p_cred", "num", "hi"),
    ("Spend", "p_spend", "inr", ""), ("Active days", "p_days", "num", "hi"),
    ("Tools used", "p_ntools", "num", "hi"), ("Outputs / active day", "p_perad", "num", "hi"),
    ("Cost per output", "p_perout", "inr", "lo"), ("Share of spend", "p_share", "pct", ""))
CMP_METRICS = max(len(CMP_TOOL_METRICS), len(CMP_PEOPLE_METRICS))
ENTITY_SORTS = ("High → low", "Low → high", "Order picked")
RANK_SORTS = ("High → low", "Low → high", "Name A → Z", "Name Z → A")
# (label, one, name column, outputs, credits, spend, name-sort key)
CMP_DIMS = (("Tools", "Tool", "t_name", "t_out", "t_cred", "t_usage", "t_name"),
            ("People", "Person", "p_name", "p_out", "p_cred", "p_spend", "p_name"),
            ("Departments", "Department", "d_name", "d_out", "d_cred", "d_spend", "d_name"),
            ("Clients", "Client", "c_name", "c_out", "c_cred", "c_spend", "c_name"),
            ("Days", "Day", "dl_label", "dl_out", "dl_cred", "dl_spend", "dl_date"),
            ("Months", "Month", "ml_label", "ml_out", "ml_cred", "ml_spend", "ml_month"))
CMP_TOP = (("Top 5", 5), ("Top 10", 10), ("Top 20", 20), ("Show all", 0))
RANK_ROWS = 30             # rows a ranking shows at most ("Show all" included)

DASH, ACTIVITY, PEOPLE, TOOLS, CLIENTS, DAILY, MONTHLY, DEPTS, COMPARE = (
    "Dashboard", "Activity", "People", "Tools", "Clients", "Daily", "Monthly", "Departments", "Compare")
TABS = (ACTIVITY, PEOPLE, TOOLS, CLIENTS, DAILY, MONTHLY, DEPTS, COMPARE)
DATA, AGG, CALC, LISTS = "Data", "Agg", "Calc", "Lists"
GROUPS = "Groups"
# The filter-sync macro (vba/ThisWorkbook.cls, built into vba/vbaProject.bin by vba/build_vba.ps1):
# a filter picked on any sheet becomes every sheet's. The workbook is saved as .xlsm.
VBA_DIR = Path(__file__).resolve().parent / "vba"

# Every sheet has its own filter bar (an Excel cell can be picked from in one
# place only, so one set of filters cannot be changed from every sheet). A
# sheet's filters drive its own copy of the calculations: the Calc sheet
# copied as "Calc<suffix>", and its own Match columns on Agg (and on Data for
# the activity sheets), every name in them carrying the suffix. The
# Dashboard keeps the plain names.
SCOPES = {"Dashboard": "", "Activity": "_ac", "People": "_pe", "Tools": "_to", "Clients": "_cl", "Daily": "_da",
          "Monthly": "_mo", "Departments": "_de", "Compare": "_cm", "Person activity": "_gp",
          "Tool activity": "_gt", "Client activity": "_gc"}
# Data columns a sheet needs of its own: (name, column it copies when matching)
DATA_SCOPES = {"Activity": (("dMatch", None), ("dSeq", None), ("dLnkDate", "A")),
               "Person activity": (("dMatch", None), ("dLnkPerson", "E")),
               "Tool activity": (("dMatch", None), ("dLnkTool", "C")),
               "Client activity": (("dMatch", None), ("dLnkClient", "G"))}
FILTER_NAMES = ("fTool", "fAcct", "fDept", "fPerson", "fClient", "fSearch", "fFrom", "fTo")


def _renamer(names, sfx: str) -> Callable[[str], str]:
    """formula -> the same formula with each of `names` given the suffix
    (outside "string literals"; whole names only)."""
    if not sfx or not names:
        return lambda formula: formula
    pattern = re.compile(r"(?<![\w.!'$])(" + "|".join(sorted(map(re.escape, names), key=len, reverse=True))
                         + r")(?![\w(])")

    def ren(formula: str) -> str:
        parts = formula.split('"')
        parts[::2] = [pattern.sub(lambda m: m.group(1) + sfx, part) for part in parts[::2]]
        return '"'.join(parts)
    return ren


@dataclass
class Scope:
    sheet: str
    sfx: str
    ren: Callable[[str], str]
    list_ranges: dict
    start: date
    end: date


def _rename_rules(ws, ren: Callable[[str], str]) -> None:
    """Conditional-format and validation formulas of a written sheet, renamed."""
    for cf in ws.conditional_formatting:
        for rule in cf.rules:
            if rule.formula:
                rule.formula = [ren(f) for f in rule.formula]
    for dv in ws.data_validations.dataValidation:
        if dv.formula1:
            dv.formula1 = ren(dv.formula1)
        if dv.formula2:
            dv.formula2 = ren(dv.formula2)

# Clicking a person, tool or client opens its generations on the page (the
# filter changes). An Excel link can only move, not set a filter, so it opens
# a tab of Activity grouped by that entity instead, on the entity's own section.
# (tab, name prefix, link target back, Data column, Data link column, header, row attribute)
P_ACT, T_ACT, C_ACT = "Person activity", "Tool activity", "Client activity"
GROUPINGS = ((P_ACT, "gp", "person", "dPerson", "dLnkPerson", "Person", "person"),
             (T_ACT, "gt", "tool", "dTool", "dLnkTool", "Tool", "tool"),
             (C_ACT, "gc", "client", "dClient", "dLnkClient", "Client / Project", "client"))
GROUP_TABS = tuple(g[0] for g in GROUPINGS)
PER_GROUP = 200            # an entity's newest matching generations shown in its section
GROUP_ROWS = 3000          # rows a grouped tab shows at most
GROUP_WIDTH = 16           # Groups-sheet columns per grouping

COUNT_FMT = "#,##0"
CREDITS_FMT = "#,##0.00"
PCT_FMT = "0%"
DATE_FMT = "dd mmm yyyy"
DROPDOWN_FMT = '@* "▾"'     # the text, then a ▾ hint pinned to the cell's right edge
INR2_FMT = '"₹"#,##0.00'

# styles - the page's palette: ink text, muted greys, green as the brand colour
INK, MUTED, FAINT, LINE, PANEL = "111827", "6B7280", "9CA3AF", "E5E7EB", "F9FAFB"
GREEN, GREEN_DARK, GREEN_SOFT = "10B981", "047857", "D1FAE5"
RED, RED_SOFT, AMBER = "DC2626", "FEE2E2", "B45309"
HEAD_BG = "1F2937"
CARD_ACCENTS = (GREEN, "8B5CF6", "F59E0B", "EC4899")


def _fill(color: str) -> PatternFill:
    return PatternFill("solid", fgColor=color)


def _cf_fill(color: str) -> PatternFill:
    """A fill for a conditional rule (Excel takes a rule's solid fill from bgColor)."""
    return PatternFill("solid", fgColor=color, bgColor=color)


F_TITLE = Font(size=22, bold=True, color=INK)
F_SUB = Font(size=10, color=MUTED)
F_LABEL = Font(size=10, color=MUTED)
F_CAPTION = Font(size=9, bold=True, color=MUTED)
F_BOLD = Font(bold=True, color=INK)
F_SECTION = Font(size=12, bold=True, color=INK)
F_KPI = Font(size=22, bold=True, color=INK)
F_FOOT = Font(size=9, color=MUTED)
F_CHANGE = Font(size=9, bold=True, color=MUTED)       # coloured red / green by a rule
F_LINK = Font(color="0563C1", underline="single")
F_TAB_ON = Font(bold=True, color="FFFFFF")
F_TAB_OFF = Font(bold=True, color="374151")
F_HEAD = Font(bold=True, color="374151", size=10)
F_THEAD = Font(bold=True, color="FFFFFF", size=10)
F_HELP = Font(size=9, italic=True, color=FAINT)
F_INPUT = Font(bold=True, color=INK)
FILL_INPUT = _fill("FFF7D6")
FILL_HEAD = _fill("F3F4F6")
FILL_THEAD = _fill(HEAD_BG)
FILL_PANEL = _fill(PANEL)
FILL_TAB_ON = _fill(GREEN)
FILL_TAB_OFF = _fill("F3F4F6")
CARD_FILLS = tuple(_fill(c) for c in ("ECFDF5", "F5F3FF", "FFFBEB", "FDF2F8"))
THIN = Side(style="thin", color="D1D5DB")
HAIR = Side(style="thin", color=LINE)
GAP = Side(style="thick", color="FFFFFF")              # white gap between cards / tabs
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
INPUT_BOX = Border(left=Side(style="thin", color="F59E0B"), right=Side(style="thin", color="F59E0B"),
                   top=Side(style="thin", color="F59E0B"), bottom=Side(style="thin", color="F59E0B"))
UNDERLINE = Border(bottom=Side(style="medium", color=GREEN))
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center")
LEFT_MID = Alignment(horizontal="left", vertical="center")
RIGHT_MID = Alignment(horizontal="right", vertical="center")
NAV_ALIGN = Alignment(horizontal="center", vertical="center", shrink_to_fit=True)
HEAD_ALIGN = Alignment(vertical="center", wrap_text=True)

# Indian digit grouping (1,97,224), as the page shows numbers
INDIAN = "[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;#,##0"

# The page's number styles (shared.jsx) on the tab sheets' number cells:
#   fmtINR  ₹ with up to 2 decimals below ₹1,000 and none from ₹1,000
#           (₹86.25, ₹1, ₹19,441, ₹1,97,225)
#   fmtNum  up to 1 decimal (380, 2.2), Indian grouping
#   share   up to 1 decimal of a per cent (99.6%, 0%)
# A cell format cannot drop a trailing "." on a whole number, so each base
# format below shows decimals and a conditional rule (_page_number_rules)
# switches whole numbers, and money from ₹1,000, to the plain format.
MONEY_FMT = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"#,##0.##'
NUM_FMT = "[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;#,##0.#"
SHARE_FMT = "0.#%"
PLAIN_FMT = {MONEY_FMT: ('"₹"#,##0', "AND(ABS({c})<100000,OR(ABS({c})>=1000,ROUND({c},2)=ROUND({c},0)))"),
             NUM_FMT: ("#,##0", "AND(ABS({c})<100000,ROUND({c},1)=ROUND({c},0))"),
             SHARE_FMT: ("0%", "ROUND({c}*100,1)=ROUND({c}*100,0)")}
_DXF_IDS: dict = {}


def _plain_dxf(code: str) -> DifferentialStyle:
    """A conditional style that only changes the number format (ids past
    the cell formats', one per format code)."""
    num_id = _DXF_IDS.setdefault(code, 300 + len(_DXF_IDS))
    return DifferentialStyle(numFmt=NumberFormat(numFmtId=num_id, formatCode=code))


def _page_number_rules(ws, rng: str, fmt: str) -> None:
    """Whole numbers (and money from ₹1,000) shown without decimals, as the page does."""
    if fmt not in PLAIN_FMT:
        return
    code, test = PLAIN_FMT[fmt]
    first = rng.split(":")[0]
    ws.conditional_formatting.add(rng, Rule(type="expression", dxf=_plain_dxf(code),
                                            formula=[f"AND(ISNUMBER({first}),{test.format(c=first)})"]))


def _indian(expr: str) -> str:
    return f'TEXT({expr},"{INDIAN}")'


# The same styles as text, for cells that build a sentence or a card
# (the KPI cards, Compare). Each takes a formula expression.
def _t_inr(x: str) -> str:
    """fmtINR: ₹19,441 / ₹86.25 / ₹9.5 / ₹1."""
    return (f'"₹"&IF(ABS({x})>=1000,TEXT({x},"{INDIAN}"),IF(ROUND({x},2)=ROUND({x},0),TEXT({x},"0"),'
            f'IF(ROUND({x},2)=ROUND({x},1),TEXT({x},"0.0"),TEXT({x},"0.00"))))')


def _t_num(x: str) -> str:
    """fmtNum: 380 / 2.2 / 3,12,594."""
    return f'IF(ROUND({x},1)=ROUND({x},0),TEXT({x},"{INDIAN}"),TEXT({x},"#,##0.0"))'


def _t_pct(x: str) -> str:
    """A share (a fraction) as the page writes it: 99.6% / 0%."""
    return f'{_t_num(f"({x})*100")}&"%"'


def _t_cinr(x: str) -> str:
    """fmtCompactINR: ₹2.0L / ₹19.5K / ₹86."""
    return (f'IF({x}>=100000,"₹"&TEXT({x}/100000,"0.0")&"L",IF({x}>=1000,"₹"&TEXT({x}/1000,"0.0")&"K",'
            f'"₹"&TEXT(ROUND({x},0),"0")))')


class DashboardTooLarge(ValueError):
    """More rows than an interactive workbook can recalculate."""


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
@dataclass
class Row:
    period: str
    when: Optional[datetime]        # IST
    tool: str
    account: str
    account_id: Optional[int]
    user_id: int
    person: str
    dept: str
    client: str
    task: str
    out_type: str
    what: str
    prompt: str
    credits: float
    cost: float
    status: str
    basis: str
    link: str

    @property
    def day(self) -> Optional[date]:
        return self.when.date() if self.when else None


@dataclass
class DashboardData:
    start: date
    end: date
    prev_start: date
    prev_end: date
    generated_at: datetime
    rows: list                      # current period, newest first
    prev_rows: list
    plan_fee: dict                  # tool -> period fee of its tracked subscriptions
    unused: dict                    # tool -> unused fee (in Total spent when unfiltered)
    untracked: dict                 # tool -> fee of a subscription whose usage isn't captured
    prev_unused: float
    prev_untracked: float
    people: dict                    # person -> department, for every person in the rows or holding a seat
    person_by_id: dict              # user id -> person display name
    account_by_id: dict             # account id -> label
    seats: list = field(default_factory=list)       # (person, tool, account label): tools assigned to a person
    all_people: dict = field(default_factory=dict)  # person -> department: everyone the Person filter lists

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def label(self) -> str:
        return period_label(self.start, self.end)


def _people_meta(db: Session, filters: ReportFilters, model) -> dict:
    """user id -> (name, department), as the live sheet names them."""
    meta = {UNASSIGNED_USER_ID: (UNASSIGNED, UNASSIGNED_DEPARTMENT, "")}
    for u in model.users:
        meta[u.user_id] = (u.label, u.department, u.employee_id or "")
    for uid, uname, uemp, udept in db.query(User.id, User.name, User.employee_id, User.department).all():
        if int(uid) not in meta:
            meta[int(uid)] = (
                filters.display.person_name(uid, uname) or f"User {uid}",
                filters.display.department_name(udept) or UNASSIGNED_DEPARTMENT,
                (uemp or "").strip(),
            )
    return meta


def _load_rows(db: Session, filters: ReportFilters, period: str, meta: dict, base_url: str) -> tuple[list, set]:
    prepare(db, filters)
    raw = recent_log(db, filters, MAX_ROWS + 1)
    if len(raw) > MAX_ROWS:
        raise DashboardTooLarge(
            f"This period has more than {MAX_ROWS:,} generations - too many for the interactive dashboard. "
            "Pick a shorter period, or use the Full Excel workbook.")
    rows, user_ids = [], set()
    for r in raw:
        name, dept, _emp = meta.get(r.user_id, meta[UNASSIGNED_USER_ID])
        user_ids.add(r.user_id)
        out_type, what = classify_generation(r.tool, r.model, r.prompt)
        link = (f"{base_url}/open-output?ref={quote(r.tool)}:{quote(str(r.record_id))}"
                if r.has_output and base_url else "")
        rows.append(Row(
            period=period,
            when=(r.occurred_at + IST_DELTA) if r.occurred_at else None,
            tool=r.tool,
            account=filters.display.account_label(r.account, r.tool) or "—",
            account_id=r.account,
            user_id=r.user_id,
            person=name,
            dept=dept,
            client=r.client or NO_CLIENT,
            task=(r.task or "").strip(),
            out_type=out_type,
            what=what,
            prompt=(r.prompt or "").strip()[:PROMPT_CHARS],
            credits=round(float(r.credits or 0.0), 2),
            cost=float(r.rupees or 0.0),     # unrounded: rounding each row drifts the totals off the page's
            status=r.charge_status,
            basis=r.basis or "",
            link=link,
        ))
    return rows, user_ids


def collect(db: Session, filters: ReportFilters, *, dashboard_url: str = "",
            generated_at: Optional[datetime] = None) -> DashboardData:
    """Every row of the period and the one before, unfiltered: the workbook
    applies the filters itself. `filters` carries only the dates and the
    test-account setting."""
    prepare(db, filters)
    groups = load_groups(db, filters)
    day_groups = load_day_groups(db, filters)
    mgmt = build_management(db, filters, groups, day_groups=day_groups)
    model = build_model(groups, load_excluded_summary(db, filters))
    meta = _people_meta(db, filters, model)

    base_url = (dashboard_url or "").rstrip("/")
    rows, ids = _load_rows(db, filters, CUR, meta, base_url)
    prev_filters = filters.shifted(mgmt.prev.start, mgmt.prev.end)
    prev_rows, prev_ids = _load_rows(db, prev_filters, PREV, meta, base_url)

    # As on the page, the Person filter lists everyone (not deleted), and a
    # person picked there sees the tools assigned to them they did not use.
    active_ids = {int(i) for (i,) in db.query(User.id).filter(User.is_deleted.is_(False)).all()}
    seats_by_id = {uid: tools for uid, tools in load_seats(db, filters.display).items() if uid in active_ids}
    everyone = ids | prev_ids | active_ids

    # The Person filter matches on the name, so two people sharing one get
    # their employee id added.
    names = defaultdict(set)
    for uid in everyone:
        names[meta.get(uid, meta[UNASSIGNED_USER_ID])[0]].add(uid)
    person_by_id = {}
    for uid in everyone:
        name, _dept, emp = meta.get(uid, meta[UNASSIGNED_USER_ID])
        person_by_id[uid] = f"{name} ({emp or uid})" if len(names[name]) > 1 else name
    for r in rows + prev_rows:
        r.person = person_by_id[r.user_id]
    people = {}
    for r in rows + prev_rows:
        people.setdefault(r.person, r.dept)
    seats = []
    for uid, tools in seats_by_id.items():
        person = person_by_id[uid]
        people.setdefault(person, meta.get(uid, meta[UNASSIGNED_USER_ID])[1])
        for tool, account_ids in tools.items():
            for label in sorted({filters.display.account_label(i, tool) or "—" for i in account_ids}):
                seats.append((person, tool, label))
    all_people = dict(people)
    for uid in active_ids:
        all_people.setdefault(person_by_id[uid], meta.get(uid, meta[UNASSIGNED_USER_ID])[1])

    cur = mgmt.cur
    plan_fee, unused, untracked = defaultdict(float), defaultdict(float), defaultdict(float)
    for s in cur.subscriptions:
        plan_fee[s.tool] += float(s.period_fee or 0.0)
        unused[s.tool] += float(s.not_used or 0.0)
    for s in cur.other_subscriptions:
        if not s.to_confirm:
            untracked[s.tool] += float(s.period_fee or 0.0)
    account_by_id = {r.account_id: r.account for r in rows + prev_rows if r.account_id is not None}
    return DashboardData(
        start=filters.start, end=filters.end, prev_start=mgmt.prev.start, prev_end=mgmt.prev.end,
        generated_at=generated_at or (datetime.utcnow() + IST_DELTA),
        rows=rows, prev_rows=prev_rows,
        plan_fee=dict(plan_fee), unused={t: v for t, v in unused.items() if v}, untracked=dict(untracked),
        prev_unused=float(mgmt.prev.not_used or 0.0), prev_untracked=float(mgmt.prev.other_total or 0.0),
        people=people, person_by_id=person_by_id, account_by_id=account_by_id,
        seats=seats, all_people=all_people,
    )


# --------------------------------------------------------------------------- #
# Writing helpers
# --------------------------------------------------------------------------- #
def _cell(ws, value=None, fmt=None, font=None, fill=None, align=None, border=None, text=False):
    if text and value is not None:
        value = clean_text(value)
    c = WriteOnlyCell(ws, value=value)
    if text and value is not None:
        c.data_type = "s"          # a name such as "=x" must stay text
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


def _txt(ws, value):
    """Text for the big data sheets: a bare str is far cheaper than a cell
    object; only text starting with '=' needs one to stay text."""
    if value is None:
        return None
    value = clean_text(value)
    return _cell(ws, value, text=True) if value.startswith("=") else value


class Grid:
    """A small sheet's cells by (row, col), appended in row order at the end
    (write-only sheets only append). ren, if given, rewrites each formula as
    it is written (a sheet's filter scope, see Scope)."""

    def __init__(self, ren: Optional[Callable[[str], str]] = None):
        self.cells: dict = {}
        self.ren = ren

    def put(self, row: int, col: int, value=None, **style) -> None:
        self.cells[(row, col)] = (value, style)

    def flush(self, ws) -> None:
        if not self.cells:
            return
        max_row = max(r for r, _c in self.cells)
        max_col = max(c for _r, c in self.cells)
        for r in range(1, max_row + 1):
            line = []
            for c in range(1, max_col + 1):
                spec = self.cells.get((r, c))
                if spec is None:
                    line.append(None)
                    continue
                value, style = spec
                if self.ren and isinstance(value, str) and value.startswith("=") and not style.get("text"):
                    value = self.ren(value)
                line.append(_cell(ws, value, **style))
            ws.append(line)


def _col(n: int) -> str:
    return get_column_letter(n)


def _letters(cell: str) -> str:
    return cell.rstrip("0123456789")


def _name(wb, name: str, ref: str) -> None:
    wb.defined_names[name] = DefinedName(name, attr_text=ref)


def _abs(sheet: str, col: str, r1: int, r2: Optional[int] = None) -> str:
    return f"'{sheet}'!${col}${r1}" if r2 is None else f"'{sheet}'!${col}${r1}:${col}${r2}"


def _rank(key_name: str, idx_name: str, k: str, i: str) -> str:
    """1 = largest key; ties keep list order; a negative key is not ranked."""
    return f'=IF({k}<0,"",COUNTIF({key_name},">"&{k})+COUNTIFS({key_name},{k},{idx_name},"<"&{i})+1)'


def _sumifs(measure: str, *extra: str) -> str:
    """SUMIFS over the Agg sheet's current-period rows that pass the filters."""
    crit = ",".join((f'aPeriod,"{CUR}"', "aMatch,1") + extra)
    return f"SUMIFS({measure},{crit})"


def _sum_by(measure: str, field: str, key: str = "name") -> Callable:
    """Column spec: this row's `measure` total for its `key` cell on Agg column `field`."""
    return lambda i, r, c: "=" + _sumifs(measure, f"{field},{c(key)}")


def _filter_test(tool: str, acct: str, dept: str, person: str, client: str, day: str) -> str:
    """AND() arguments: the row passes every dropdown filter and its day
    (shifted into the current period for a previous-period row) is inside
    From / To. With the whole period selected a row with no date passes."""
    return (f'OR(fTool="{ALL_TOOLS}",{tool}=fTool),OR(fAcct="{ALL_ACCOUNTS}",{acct}=fAcct),'
            f'OR(fDept="{ALL_DEPTS}",{dept}=fDept),OR(fPerson="{EVERYONE}",{person}=fPerson),'
            f'OR(fClient="{ALL_CLIENTS}",{client}=fClient),'
            f'OR(kDateAll=1,AND(ISNUMBER({day}),{day}>=kFrom,{day}<=kTo))')


@dataclass
class Block:
    letters: dict
    first: int
    last: int

    def col(self, key: str) -> int:
        from openpyxl.utils import column_index_from_string
        return column_index_from_string(self.letters[key])


class Calc:
    """The hidden Calc sheet: KPI scalars in A:B, then blocks left to right.
    Every block's rows start at FIRST, so a matrix lines up row for row with
    the block it belongs to."""

    FIRST = 3

    def __init__(self, wb):
        self.wb = wb
        self.grid = Grid()
        self.next_col = 4
        self.scalar_row = self.FIRST
        self.grid.put(1, 1, "KPIs", font=F_BOLD)

    def scalar(self, name: str, label: str, value, fmt=None) -> None:
        self.grid.put(self.scalar_row, 1, label, text=True)
        self.grid.put(self.scalar_row, 2, value, fmt=fmt)
        _name(self.wb, name, _abs(CALC, "B", self.scalar_row))
        self.scalar_row += 1

    def block(self, prefix: str, title: str, n: int, columns: list) -> Block:
        """columns: (key, header, spec, fmt). spec is a list of static
        values, or fn(i, r, cell) -> formula, where cell(key) is that
        column's cell on row r. Each column gets the name prefix_key."""
        n = max(n, 1)
        first, last = self.FIRST, self.FIRST + n - 1
        start = self.next_col
        letters = {key: _col(start + j) for j, (key, *_rest) in enumerate(columns)}
        self.next_col = start + len(columns) + 1
        self.grid.put(1, start, title, font=F_BOLD)
        for j, (key, header, spec, fmt) in enumerate(columns):
            ci = start + j
            self.grid.put(2, ci, header, font=F_HEAD)
            for i in range(n):
                r = first + i
                if callable(spec):
                    self.grid.put(r, ci, spec(i, r, lambda k, rr=r: f"{letters[k]}{rr}"), fmt=fmt)
                else:
                    value = spec[i] if i < len(spec) else None
                    self.grid.put(r, ci, value, fmt=fmt, text=isinstance(value, str))
            _name(self.wb, f"{prefix}_{key}", _abs(CALC, letters[key], first, last))
        return Block(letters, first, last)

    def matrix(self, title: str, n: int, headers: list, fn: Callable) -> dict:
        """One column per header, rows aligned with an n-row block;
        fn(header_cell) -> formula. Returns header -> column letter."""
        n = max(n, 1)
        start = self.next_col
        self.grid.put(1, start, title, font=F_BOLD)
        letters = {}
        for j, h in enumerate(headers):
            ci = start + j
            letters[h] = _col(ci)
            self.grid.put(2, ci, h, font=F_HEAD, text=True)
            for i in range(n):
                self.grid.put(self.FIRST + i, ci, fn(f"{_col(ci)}$2"))
        self.next_col = start + max(len(headers), 1) + 1
        return letters


# --------------------------------------------------------------------------- #
# Hidden data sheets
# --------------------------------------------------------------------------- #
def _write_data(wb, ws, rows: list, rens: dict) -> None:
    """One row per current-period generation, newest first, for Activity.
    Row 2 is a sentinel (Seq 0), so MATCH(k-1, Seq, 1)+1 is the k-th match.
    After the Dashboard's Match / Seq / link columns, each activity sheet's
    own (DATA_SCOPES), under its filters (rens[sheet] renames them)."""
    extra = [(sheet, name, src) for sheet, cols in DATA_SCOPES.items() for name, src in cols]
    letters = {(sheet, name): _col(22 + j) for j, (sheet, name, _src) in enumerate(extra)}
    headers = ("Date", "Time", "Tool", "Account", "Person", "Department", "Client", "Output", "What",
               "Prompt", "Credits", "Cost", "Status", "Link", "Search", "Match", "Seq",
               "Link person", "Link tool", "Link client", "Link date") + tuple(
        name + SCOPES[sheet] for sheet, name, _src in extra)
    ws.append([_cell(ws, h, font=F_HEAD) for h in headers])
    ws.append([None] * 15 + [0, 0, None, None, None, None]
              + [0 if name in ("dMatch", "dSeq") else None for _s, name, _src in extra])
    r = 2
    for row in rows:
        r += 1
        hay = " ".join((row.person, row.dept, row.tool, row.out_type, row.what, row.prompt, row.client,
                        row.task)).lower()
        test = _filter_test(f"C{r}", f"D{r}", f"F{r}", f"E{r}", f"G{r}", f"A{r}")
        match = f'=IF(AND({test},OR(fSearch="",ISNUMBER(SEARCH(fSearch,O{r})))),1,0)'
        scoped = []
        for sheet, name, src in extra:
            m = letters[(sheet, "dMatch")]
            if name == "dMatch":
                scoped.append(rens[sheet](match))
            elif name == "dSeq":
                scoped.append(f"={letters[(sheet, name)]}{r - 1}+{m}{r}")
            else:
                scoped.append(f'=IF({m}{r}=1,{src}{r},"")')
        ws.append([
            _cell(ws, row.when.date() if row.when else None, fmt=DATE_FMT),
            row.when.strftime("%H:%M") if row.when else "—",
            _txt(ws, row.tool),
            _txt(ws, row.account),
            _txt(ws, row.person),
            _txt(ws, row.dept),
            _txt(ws, row.client),
            _txt(ws, row.out_type),
            _txt(ws, row.what),
            _txt(ws, row.prompt or "—"),
            row.credits,
            row.cost,
            _txt(ws, row.status),
            _txt(ws, row.link) if row.link else None,
            _txt(ws, hay[:2000]),
            match,
            f"=Q{r - 1}+P{r}",
            # interlinks find an entity's first filtered row here (see _linked)
            f'=IF(P{r}=1,E{r},"")', f'=IF(P{r}=1,C{r},"")', f'=IF(P{r}=1,G{r},"")', f'=IF(P{r}=1,A{r},"")',
        ] + scoped)
    for key, col in (("dDate", "A"), ("dTime", "B"), ("dTool", "C"), ("dAcct", "D"), ("dPerson", "E"),
                     ("dDept", "F"), ("dClient", "G"), ("dOut", "H"), ("dWhat", "I"), ("dPrompt", "J"),
                     ("dCred", "K"), ("dCost", "L"), ("dStatus", "M"), ("dLink", "N"), ("dMatch", "P"), ("dSeq", "Q"),
                     ("dLnkPerson", "R"), ("dLnkTool", "S"), ("dLnkClient", "T"), ("dLnkDate", "U")):
        _name(wb, key, _abs(DATA, col, 2, r))
    for (sheet, name), col in letters.items():
        _name(wb, name + SCOPES[sheet], _abs(DATA, col, 2, r))


def _write_agg(wb, ws, rows: list, rens: dict) -> None:
    """Charged rows of both periods summed per (period, person, day, tool,
    account, client), sorted so each (period, person, day) is contiguous.
    First marks the first matching row of one, which makes people-per-day
    and active-days-per-person plain SUMIFS. Then each sheet's own Match /
    First pair, under its filters (rens[sheet] renames them)."""
    scoped = [sheet for sheet, sfx in SCOPES.items() if sfx]
    pair = {sheet: (_col(15 + 2 * j), _col(16 + 2 * j)) for j, sheet in enumerate(scoped)}
    sums = defaultdict(lambda: [0, 0.0, 0.0])
    for r in rows:
        if r.status != CHARGED or r.day is None:
            continue
        s = sums[(r.period, r.person, r.day, r.tool, r.account, r.client, r.dept, r.basis)]
        s[0] += 1
        s[1] += r.credits
        s[2] += r.cost
    keys = sorted(sums, key=lambda k: (k[0], k[1].lower(), k[1], k[2], k[3], k[4], k[5]))
    headers = ("Period", "Date", "Month", "Tool", "Account", "Person", "Department", "Client", "Basis",
               "Outputs", "Credits", "Cost", "Match", "First") + tuple(
        f"{h}{SCOPES[sheet]}" for sheet in scoped for h in ("Match", "First"))
    ws.append([_cell(ws, h, font=F_HEAD) for h in headers])
    r, group_start, prev_group = 1, 2, None
    for k in keys:
        r += 1
        period, person, day, tool, account, client, dept, basis = k
        if (period, person, day) != prev_group:
            group_start, prev_group = r, (period, person, day)
        outs, credits, cost = sums[k]
        def first_of(m: str, r=r, group_start=group_start) -> str:
            return f"={m}{r}" if r == group_start else f"=IF(AND({m}{r}=1,SUM({m}{group_start}:{m}{r - 1})=0),1,0)"
        test = _filter_test(f"D{r}", f"E{r}", f"G{r}", f"F{r}", f"H{r}",
                            f"(B{r}+kShift)" if period == PREV else f"B{r}")
        match = f"=IF(AND({test}),1,0)"
        ws.append([
            period,
            _cell(ws, day, fmt=DATE_FMT),
            day.strftime("%Y-%m"),
            _txt(ws, tool),
            _txt(ws, account),
            _txt(ws, person),
            _txt(ws, dept),
            _txt(ws, client),
            _txt(ws, basis),
            outs,
            credits,
            cost,
            match,
            first_of("M"),
        ] + [f for sheet in scoped for f in (rens[sheet](match), first_of(pair[sheet][0]))])
    if r == 1:          # no rows: keep every range valid
        r = 2
        ws.append(["", None, "", "", "", "", "", "", "", 0, 0, 0, 0, 0] + [0, 0] * len(scoped))
    for key, col in (("aPeriod", "A"), ("aDate", "B"), ("aMonth", "C"), ("aTool", "D"), ("aAcct", "E"),
                     ("aPerson", "F"), ("aDept", "G"), ("aClient", "H"), ("aBasis", "I"), ("aOut", "J"),
                     ("aCred", "K"), ("aCost", "L"), ("aMatch", "M"), ("aFirst", "N")):
        _name(wb, key, _abs(AGG, col, 2, r))
    for sheet, (m, f) in pair.items():
        _name(wb, "aMatch" + SCOPES[sheet], _abs(AGG, m, 2, r))
        _name(wb, "aFirst" + SCOPES[sheet], _abs(AGG, f, 2, r))


GROUP_ITEM_COLS = ("Data", "Grp", "Run", "Pos")
GROUP_LIST_COLS = ("Name", "Before", "Count", "Base", "End", "Land", "Cost", "Cred")


def _write_groups(wb, ws, rows: list, rens: dict) -> dict:
    """Activity in (entity, newest first) order for the grouped tabs, one
    block of columns per grouping. Items: each entity's header, then its Data
    rows. Run counts matching rows; Pos numbers what a grouped tab shows - the
    header of an entity with a match, then its newest PER_GROUP matches - so
    the tab's row k is the first item with Pos k (as Activity reads Seq).
    The list beside: per entity its count, totals and the tab row its section
    starts on (Land; #N/A when it is not shown). Returns each tab's row count."""
    grid = Grid()
    sizes = {}
    for gi, (tab, pre, _back, _key, helper, _head, attr) in enumerate(GROUPINGS):
        o = gi * GROUP_WIDTH
        ren = rens[tab]
        ic = {k: _col(o + 1 + j) for j, k in enumerate(GROUP_ITEM_COLS)}
        gc = {k: _col(o + 6 + j) for j, k in enumerate(GROUP_LIST_COLS)}
        for j, h in enumerate(GROUP_ITEM_COLS):
            grid.put(1, o + 1 + j, pre + h, font=F_HEAD)
        for j, h in enumerate(GROUP_LIST_COLS):
            grid.put(1, o + 6 + j, pre + h, font=F_HEAD)
        grid.put(1, o + 15, pre + "Total", font=F_HEAD)
        for j in range(4):                       # sentinel: Pos 0
            grid.put(2, o + 1 + j, 0)
        members = defaultdict(list)
        for pos, row in enumerate(rows, start=2):    # position in the d* names (1 is the sentinel)
            members[getattr(row, attr)].append(pos)
        names = _ranked_by_cost(rows, lambda x: getattr(x, attr))
        r, shown = 2, 0
        for g, name in enumerate(names, start=1):
            gr = 1 + g
            r += 1
            grid.put(r, o + 1, 0)
            grid.put(r, o + 2, g)
            grid.put(r, o + 3, f"={ic['Run']}{r - 1}")
            grid.put(r, o + 4, f"={gc['Base']}{gr}")
            grid.put(gr, o + 7, f"={ic['Run']}{r}")
            for p in members[name]:
                r += 1
                grid.put(r, o + 1, p)
                grid.put(r, o + 2, g)
                grid.put(r, o + 3, ren(f"={ic['Run']}{r - 1}+INDEX(dMatch,{p})"))
                grid.put(r, o + 4, f"={gc['Base']}{gr}+MIN({ic['Run']}{r}-{gc['Before']}{gr},{PER_GROUP})")
            prev_end = f"{gc['End']}{gr - 1}" if g > 1 else "0"
            grid.put(gr, o + 6, name, text=True)
            grid.put(gr, o + 8, f"={ic['Run']}{r}-{gc['Before']}{gr}")
            grid.put(gr, o + 9, f"={prev_end}+IF({gc['Count']}{gr}>0,1,0)")
            grid.put(gr, o + 10, f"={gc['Base']}{gr}+MIN({gc['Count']}{gr},{PER_GROUP})")
            grid.put(gr, o + 12, ren(f"=SUMIFS(dCost,{helper},{gc['Name']}{gr})"))
            grid.put(gr, o + 13, ren(f"=SUMIFS(dCred,{helper},{gc['Name']}{gr})"))
            shown += min(len(members[name]), PER_GROUP) + 1
        n = max(1, min(shown, GROUP_ROWS))
        sizes[tab] = n
        for g in range(1, len(names) + 1):
            gr = 1 + g
            grid.put(gr, o + 11, f"=IF(AND({gc['Count']}{gr}>0,{gc['Base']}{gr}<={n}),{gc['Base']}{gr},NA())")
        grid.put(2, o + 15, f"={gc['End']}{1 + len(names)}" if names else 0)
        for h in GROUP_ITEM_COLS:
            _name(wb, pre + h, _abs(GROUPS, ic[h], 2, r))
        for h in GROUP_LIST_COLS:
            _name(wb, pre + h, _abs(GROUPS, gc[h], 2, 1 + max(len(names), 1)))
        _name(wb, pre + "Total", _abs(GROUPS, _col(o + 15), 2))
    grid.flush(ws)
    return sizes


# --------------------------------------------------------------------------- #
# Calc: every formula behind the dashboard
# --------------------------------------------------------------------------- #
@dataclass
class Layout:
    tools: list
    people: list            # (name, department) sorted by department: each department's people are contiguous
    clients: list
    depts: list
    accounts: list
    days: list
    months: list
    blocks: dict = field(default_factory=dict)


def _layout(data: DashboardData) -> Layout:
    rows = data.rows + data.prev_rows
    tools = _ranked_by_cost(data.rows, lambda r: r.tool)
    seat_tools = sorted({t for _p, t, _a in data.seats}, key=str.lower)
    for t in (_ranked_by_cost(data.prev_rows, lambda r: r.tool) + sorted(data.plan_fee) + sorted(data.untracked)
              + seat_tools):
        if t not in tools:
            tools.append(t)
    clients = _ranked_by_cost(data.rows, lambda r: r.client)
    for c in _ranked_by_cost(data.prev_rows, lambda r: r.client):
        if c not in clients:
            clients.append(c)
    people = sorted(data.people.items(), key=lambda kv: (kv[1].lower(), kv[0].lower()))
    days = [data.start + timedelta(days=i) for i in range(data.days)]
    months = sorted({d.strftime("%Y-%m") for d in days})
    return Layout(
        tools=tools or ["—"], people=people or [("—", "—")], clients=clients or ["—"],
        depts=sorted({d for _p, d in people} | set(data.all_people.values()), key=str.lower) or ["—"],
        accounts=sorted({r.account for r in rows}, key=str.lower), days=days, months=months,
    )


def _ranked_by_cost(rows: list, key) -> list:
    total = defaultdict(float)
    for r in rows:
        total[key(r)] += r.cost
    return sorted(total, key=lambda k: (-total[k], str(k).lower()))


def _build_calc(wb, data: DashboardData, lay: Layout) -> Calc:
    calc = Calc(wb)
    filtered = (f'IF(OR(fTool<>"{ALL_TOOLS}",fAcct<>"{ALL_ACCOUNTS}",fDept<>"{ALL_DEPTS}",'
                f'fPerson<>"{EVERYONE}",fClient<>"{ALL_CLIENTS}",kDateAll=0),1,0)')
    ppu = f'aBasis,"{PAY_PER_USE}"'
    # From / To, kept inside the period (a blank or non-date box means its
    # end of the period); previous-period rows are compared shifted forward
    # by kShift days.
    calc.scalar("kStart", "Period start", data.start, DATE_FMT)
    calc.scalar("kEnd", "Period end", data.end, DATE_FMT)
    # (a day picked from the From / To dropdown may arrive as text: read it as a date)
    calc.scalar("kFromIn", "From as picked", '=IF(ISNUMBER(fFrom),fFrom,IFERROR(DATEVALUE(fFrom),""))', DATE_FMT)
    calc.scalar("kToIn", "To as picked", '=IF(ISNUMBER(fTo),fTo,IFERROR(DATEVALUE(fTo),""))', DATE_FMT)
    calc.scalar("kFrom", "From (in the period)", "=IF(ISNUMBER(kFromIn),MIN(MAX(INT(kFromIn),kStart),kEnd),kStart)",
                DATE_FMT)
    calc.scalar("kTo", "To (in the period, not before From)",
                "=IF(ISNUMBER(kToIn),MAX(MIN(INT(kToIn),kEnd),kFrom),kEnd)", DATE_FMT)
    calc.scalar("kDateAll", "Whole period selected", "=IF(AND(kFrom=kStart,kTo=kEnd),1,0)")
    calc.scalar("kShift", "Days from the previous period's start to this one's", (data.start - data.prev_start).days)
    calc.scalar("kFlt", "Any filter on (plan fees then left out)", f"={filtered}")
    calc.scalar("kItem", "Usage spend (rows)", "=" + _sumifs("aCost"), INR_FMT)
    calc.scalar("kPPU", "Pay-per-use", "=" + _sumifs("aCost", ppu), INR_FMT)
    calc.scalar("kUnused", "Unused plan fees", round(sum(data.unused.values()), 2), INR_FMT)
    calc.scalar("kUntracked", "Untracked subscriptions", round(sum(data.untracked.values()), 2), INR_FMT)
    calc.scalar("kPlans", "Plans", "=kItem-kPPU+IF(kFlt=1,0,kUnused)", INR_FMT)
    calc.scalar("kTotal", "Total spent", "=kPPU+kPlans+IF(kFlt=1,0,kUntracked)", INR_FMT)
    calc.scalar("kPrevItem", "Previous usage", f'=SUMIFS(aCost,aPeriod,"{PREV}",aMatch,1)', INR_FMT)
    calc.scalar("kPrevUnused", "Previous unused plan fees", round(data.prev_unused, 2), INR_FMT)
    calc.scalar("kPrevUntracked", "Previous untracked", round(data.prev_untracked, 2), INR_FMT)
    calc.scalar("kPrevTotal", "Previous total", "=kPrevItem+IF(kFlt=1,0,kPrevUnused+kPrevUntracked)", INR_FMT)
    calc.scalar("kOutputs", "Outputs", "=" + _sumifs("aOut"), COUNT_FMT)
    calc.scalar("kCredits", "Credits", "=" + _sumifs("aCred"), CREDITS_FMT)
    calc.scalar("kPrevOutputs", "Previous outputs", f'=SUMIFS(aOut,aPeriod,"{PREV}",aMatch,1)', COUNT_FMT)
    calc.scalar("kPrevCredits", "Previous credits", f'=SUMIFS(aCred,aPeriod,"{PREV}",aMatch,1)', CREDITS_FMT)
    calc.scalar("kDays", "Days selected (From to To)", "=kTo-kFrom+1")
    calc.scalar("kMonths", "Months (days / 30, at least 1)", "=MAX(kDays/30,1)")
    calc.scalar("kPeople", "People", '=COUNTIFS(p_out,">0",p_named,1)')
    calc.scalar("kTools", "Tools", '=COUNTIF(t_out,">0")')
    # management.change_text: '▲ 12%', '▼ 5%', '▲ <1%', '— no change', 'new', '—'
    calc.scalar("kChange", "Change vs previous", (
        '=IF(kPrevTotal=0,IF(kTotal>0,"new","—"),'
        'IF(ROUND((kTotal-kPrevTotal)/kPrevTotal*100,0)=0,'
        'IF(ROUND(kTotal-kPrevTotal,2)=0,"— no change",IF(kTotal>kPrevTotal,"▲","▼")&" <1%"),'
        'IF(kTotal>kPrevTotal,"▲ ","▼ ")&ABS(ROUND((kTotal-kPrevTotal)/kPrevTotal*100,0))&"%"))'))
    calc.scalar("mToolIdx", "Usage-by-tool measure",
                f'=IF(mTool="{TOOL_MEASURES[1]}",2,IF(mTool="{TOOL_MEASURES[2]}",3,1))')
    calc.scalar("mDeptIdx", "Department measure",
                f'=IF(mDept="{DEPT_MEASURES[1]}",2,IF(mDept="{DEPT_MEASURES[2]}",3,1))')
    calc.scalar("kActCount", "Activity rows matching", "=MAX(dSeq)")
    calc.scalar("kShowUnused", "Tools tab: list tools not used", '=IF(fShowUnused="No",0,1)')

    people, tools, clients, depts = lay.people, lay.tools, lay.clients, lay.depts
    np_, nt, nc = len(people), len(tools), len(clients)

    def p_column(col: str) -> str:
        """A People-aligned matrix column, all its rows."""
        return f"${col}${Calc.FIRST}:${col}${Calc.FIRST + np_ - 1}"

    def cross(row_field: str, row_name: str, col_field: str) -> Callable:
        """Matrix cell: outputs for this row's entity (INDEX into its block) x the column header."""
        return lambda h: "=" + _sumifs("aOut", f"{row_field},INDEX({row_name},ROW()-2)", f"{col_field},{h}")

    # Matrices first: the blocks below read their columns.
    pt = calc.matrix("Person x tool (outputs)", np_, tools, cross("aPerson", "p_name", "aTool"))
    pm = calc.matrix("Person x month (outputs)", np_, lay.months, cross("aPerson", "p_name", "aMonth"))
    pc = (calc.matrix("Person x client (outputs)", np_, clients, cross("aPerson", "p_name", "aClient"))
          if np_ * nc <= MATRIX_CELL_LIMIT else {})
    ct = calc.matrix("Client x tool (outputs)", nc, tools, cross("aClient", "c_name", "aTool"))
    dt = calc.matrix("Department x tool (outputs)", len(depts), tools, cross("aDept", "d_name", "aTool"))
    dyt = calc.matrix("Day x tool (outputs)", len(lay.days), tools, cross("aDate", "dl_date", "aTool"))
    mt = calc.matrix("Month x tool (outputs)", len(lay.months), tools, cross("aMonth", "ml_month", "aTool"))

    def top_of(letters: dict, r: int, count_cell: str) -> str:
        """The header of the largest cell in row r of a matrix."""
        if not letters:
            return '="—"'
        cols = list(letters.values())
        head, line = f"${cols[0]}$2:${cols[-1]}$2", f"${cols[0]}{r}:${cols[-1]}{r}"
        return f'=IF({count_cell}<=0,"—",INDEX({head},MATCH(MAX({line}),{line},0)))'

    def tools_text(r: int) -> str:
        parts = [f'IF({c}{r}>0,{c}$2&" ("&{c}{r}&"), ","")' for c in pt.values()]
        return "=" + "&".join(parts)

    def tool_count(r: int) -> str:
        cols = list(pt.values())
        return f'=COUNTIF(${cols[0]}{r}:${cols[-1]}{r},">0")'

    def column_count(letters: dict, names: list, i: int) -> str:
        col = letters.get(names[i]) if i < len(names) else None
        return f'=COUNTIF({p_column(col)},">0")' if col else '="—"'

    def column_top(letters: dict, names: list, i: int) -> str:
        col = letters.get(names[i]) if i < len(names) else None
        if not col:
            return '="—"'
        rng = p_column(col)
        return f'=IF(MAX({rng})<=0,"—",INDEX(p_name,MATCH(MAX({rng}),{rng},0)))'

    # ---- people ----
    lay.blocks["p"] = calc.block("p", "People", np_, [
        ("name", "Person", [p for p, _d in people], None),
        ("dept", "Department", [d for _p, d in people], None),
        ("named", "Named", [0 if p == UNASSIGNED else 1 for p, _d in people], None),
        ("out", "Outputs", _sum_by("aOut", "aPerson"), COUNT_FMT),
        ("cred", "Credits", _sum_by("aCred", "aPerson"), CREDITS_FMT),
        ("spend", "Spent", _sum_by("aCost", "aPerson"), INR_FMT),
        ("days", "Active days", lambda i, r, c: f'=SUMIFS(aFirst,aPeriod,"{CUR}",aPerson,{c("name")})', COUNT_FMT),
        ("toolsh", "Tools (helper)", lambda i, r, c: tools_text(r), None),
        ("tools", "Tools used",
         lambda i, r, c: f'=IF(LEN({c("toolsh")})=0,"—",LEFT({c("toolsh")},LEN({c("toolsh")})-2))', None),
        ("toptool", "Top tool", lambda i, r, c: top_of(pt, r, c("out")), None),
        ("topclient", "Top client", lambda i, r, c: top_of(pc, r, c("out")), None),
        ("perout", "Per output", lambda i, r, c: f'=IF({c("out")}>0,{c("spend")}/{c("out")},0)', INR2_FMT),
        ("share", "Share",
         lambda i, r, c: f'=IF(kItem>0,{c("spend")}/kItem,IF(kOutputs>0,{c("out")}/kOutputs,0))', PCT_FMT),
        ("ntools", "Tools used", lambda i, r, c: tool_count(r), COUNT_FMT),
        ("perad", "Outputs / active day", lambda i, r, c: f'=IF({c("days")}>0,{c("out")}/{c("days")},0)', "0.0"),
        ("hit", "Search hit", lambda i, r, c: (
            f'=IF(fSearch="",1,IF(ISNUMBER(SEARCH(fSearch,{c("name")}&" "&{c("dept")}&" "&{c("tools")})),1,0))'),
         None),
        ("idx", "#", list(range(1, np_ + 1)), None),
        ("key", "Rank key",
         lambda i, r, c: f'=IF(AND({c("out")}>0,{c("hit")}=1),ROUND({c("spend")},2),-1)', None),
        ("rank", "Rank", lambda i, r, c: _rank("p_key", "p_idx", c("key"), c("idx")), None),
        # Compare picks its four busiest when none is picked, as the page does
        ("okey", "Outputs key", lambda i, r, c: f'=IF({c("out")}>0,{c("out")},-1)', None),
        ("orank", "Outputs rank", lambda i, r, c: _rank("p_okey", "p_idx", c("okey"), c("idx")), None),
    ])

    # ---- tools ----
    # A person picked: the tools assigned to them (Lists' seat columns) are
    # listed even unused, "Not used", while the Tools tab's Show unused
    # switch is on - the switch also hides paid tools nobody used.
    seat_test = (f'IF(fPerson="{EVERYONE}",0,IF(AND(COUNTIFS(sPerson,fPerson,sTool,{{n}})>0,'
                 f'OR(fTool="{ALL_TOOLS}",fTool={{n}}),'
                 f'OR(fAcct="{ALL_ACCOUNTS}",COUNTIFS(sPerson,fPerson,sTool,{{n}},sAcct,fAcct)>0),'
                 f'OR(fDept="{ALL_DEPTS}",COUNTIFS(p_name,fPerson,p_dept,fDept)>0),'
                 f'OR(fSearch="",ISNUMBER(SEARCH(fSearch,{{n}})))),1,0))')
    seat_tools = {t for _p, t, _a in data.seats}
    fixed_fee = [round(data.plan_fee.get(t, 0.0) + data.untracked.get(t, 0.0), 2) for t in tools]
    fixed_unused = [round(data.unused.get(t, 0.0) + data.untracked.get(t, 0.0), 2) for t in tools]
    # every tracked tool has a category; an assigned one without is not tracked
    categories = [TOOL_OUTPUT_CATEGORY.get(t, "Subscription" if t in data.untracked
                                           else "Not tracked" if t in seat_tools else "AI Output") for t in tools]
    lay.blocks["t"] = calc.block("t", "Tools", nt, [
        ("name", "Tool", list(tools), None),
        ("cat", "Category", categories, None),
        ("out", "Outputs", _sum_by("aOut", "aTool"), COUNT_FMT),
        ("cred", "Credits", _sum_by("aCred", "aTool"), CREDITS_FMT),
        ("usage", "Usage", _sum_by("aCost", "aTool"), INR_FMT),
        ("feec", "Plan fee (period)", fixed_fee, INR_FMT),
        # a seat its person did not use carries no fee, as on the page: the fee is the login's
        ("fee", "Plan fee", lambda i, r, c: f'=IF(AND({c("out")}=0,{c("seat")}=1),0,{c("feec")})', INR_FMT),
        ("unusedc", "Unused (no filter)", fixed_unused, INR_FMT),
        ("unused", "Unused", lambda i, r, c: f'=IF(kFlt=1,0,{c("unusedc")})', INR_FMT),
        ("total", "Total", lambda i, r, c: f'={c("usage")}+{c("unused")}', INR_FMT),
        ("people", "People", lambda i, r, c: column_count(pt, tools, i), COUNT_FMT),
        ("top", "Top user", lambda i, r, c: column_top(pt, tools, i), None),
        ("perout", "Per output", lambda i, r, c: f'=IF({c("out")}>0,{c("usage")}/{c("out")},0)', INR2_FMT),
        ("perday", "Outputs / day", lambda i, r, c: f'={c("out")}/kDays', "0.0"),
        ("share", "Share", lambda i, r, c: f'=IF(kTotal>0,{c("total")}/kTotal,0)', PCT_FMT),
        ("measure", "Measure", lambda i, r, c: f'=CHOOSE(mToolIdx,{c("out")},{c("total")},{c("cred")})', None),
        ("seat", "Assigned to the person", lambda i, r, c: "=" + seat_test.format(n=c("name")), None),
        ("listed", "Listed", lambda i, r, c: f'=IF(OR({c("out")}>0,{c("total")}>0,{c("seat")}=1),1,0)', None),
        ("notused", "Not used", lambda i, r, c: f'=IF(AND({c("listed")}=1,{c("out")}=0),1,0)', None),
        ("label", "Shown as", lambda i, r, c: f'={c("name")}&IF({c("notused")}=1,"  ·  Not used","")', None),
        ("idx", "#", list(range(1, nt + 1)), None),
        # used tools first among equal totals (ahead of a not-used one)
        ("key", "Rank key", lambda i, r, c: (
            f'=IF(AND({c("listed")}=1,OR({c("out")}>0,kShowUnused=1)),'
            f'ROUND({c("total")},2)+IF({c("out")}>0,0.001,0),-1)'), None),
        ("rank", "Rank", lambda i, r, c: _rank("t_key", "t_idx", c("key"), c("idx")), None),
        ("okey", "Outputs key", lambda i, r, c: f'=IF({c("out")}>0,{c("out")},-1)', None),
        ("orank", "Outputs rank", lambda i, r, c: _rank("t_okey", "t_idx", c("okey"), c("idx")), None),
        ("mkey", "Measure key", lambda i, r, c: f'=IF({c("measure")}>0,ROUND({c("measure")},4),-1)', None),
        ("mrank", "Measure rank", lambda i, r, c: _rank("t_mkey", "t_idx", c("mkey"), c("idx")), None),
    ])

    # ---- clients ----
    lay.blocks["c"] = calc.block("c", "Clients", nc, [
        ("name", "Client / Project", list(clients), None),
        ("out", "Outputs", _sum_by("aOut", "aClient"), COUNT_FMT),
        ("cred", "Credits", _sum_by("aCred", "aClient"), CREDITS_FMT),
        ("spend", "Spent", _sum_by("aCost", "aClient"), INR_FMT),
        ("people", "People", lambda i, r, c: column_count(pc, clients, i), COUNT_FMT),
        ("top", "Top user", lambda i, r, c: column_top(pc, clients, i), None),
        ("toptool", "Top tool", lambda i, r, c: top_of(ct, r, c("out")), None),
        ("perout", "Per output", lambda i, r, c: f'=IF({c("out")}>0,{c("spend")}/{c("out")},0)', INR2_FMT),
        ("share", "Share", lambda i, r, c: f'=IF(kItem>0,{c("spend")}/kItem,0)', PCT_FMT),
        ("idx", "#", list(range(1, nc + 1)), None),
        ("key", "Rank key", lambda i, r, c: f'=IF({c("out")}>0,ROUND({c("spend")},2),-1)', None),
        ("rank", "Rank", lambda i, r, c: _rank("c_key", "c_idx", c("key"), c("idx")), None),
    ])

    # ---- departments: a department's people are rows a..b of the People block ----
    pb = lay.blocks["p"]
    span = {}
    for i, (_p, d) in enumerate(people):
        a = span.get(d, (pb.first + i, None))[0]
        span[d] = (a, pb.first + i)

    def dept_top(i, r, c):
        if i >= len(depts) or depts[i] not in span:
            return '="—"'
        a, b = span[depts[i]]
        s, n = pb.letters["spend"], pb.letters["name"]
        rng = f"${s}${a}:${s}${b}"
        return f'=IF({c("people")}=0,"—",INDEX(${n}${a}:${n}${b},MATCH(MAX({rng}),{rng},0)))'

    lay.blocks["d"] = calc.block("d", "Departments", len(depts), [
        ("name", "Department", list(depts), None),
        ("out", "Outputs", _sum_by("aOut", "aDept"), COUNT_FMT),
        ("cred", "Credits", _sum_by("aCred", "aDept"), CREDITS_FMT),
        ("spend", "Spent", _sum_by("aCost", "aDept"), INR_FMT),
        ("people", "People", lambda i, r, c: f'=COUNTIFS(p_dept,{c("name")},p_out,">0")', COUNT_FMT),
        ("top", "Top user", dept_top, None),
        ("toptool", "Top tool", lambda i, r, c: top_of(dt, r, c("out")), None),
        ("perperson", "Per person",
         lambda i, r, c: f'=IF({c("people")}>0,{c("spend")}/{c("people")},0)', INR_FMT),
        ("share", "Share", lambda i, r, c: f'=IF(kItem>0,{c("spend")}/kItem,0)', PCT_FMT),
        ("measure", "Measure", lambda i, r, c: f'=CHOOSE(mDeptIdx,{c("spend")},{c("out")},{c("cred")})', None),
        ("idx", "#", list(range(1, len(depts) + 1)), None),
        ("key", "Rank key", lambda i, r, c: f'=IF({c("out")}>0,ROUND({c("spend")},2),-1)', None),
        ("rank", "Rank", lambda i, r, c: _rank("d_key", "d_idx", c("key"), c("idx")), None),
        ("mkey", "Measure key", lambda i, r, c: f'=IF({c("measure")}>0,ROUND({c("measure")},4),-1)', None),
        ("mrank", "Measure rank", lambda i, r, c: _rank("d_mkey", "d_idx", c("mkey"), c("idx")), None),
    ])

    # ---- days (oldest first: the trend chart's order) ----
    lay.blocks["dl"] = calc.block("dl", "Daily", len(lay.days), [
        ("date", "Date", list(lay.days), DATE_FMT),
        ("label", "Label", [f"{d.day} {d.strftime('%b')}" for d in lay.days], None),
        ("month", "Month", [d.strftime("%Y-%m") for d in lay.days], None),
        ("out", "Outputs", _sum_by("aOut", "aDate", "date"), COUNT_FMT),
        ("people", "People", lambda i, r, c: f'=SUMIFS(aFirst,aPeriod,"{CUR}",aDate,{c("date")})', COUNT_FMT),
        ("cred", "Credits", _sum_by("aCred", "aDate", "date"), CREDITS_FMT),
        ("spend", "Spent", _sum_by("aCost", "aDate", "date"), INR_FMT),
        ("toptool", "Top tool", lambda i, r, c: top_of(dyt, r, c("out")), None),
        ("perout", "Per output", lambda i, r, c: f'=IF({c("out")}>0,{c("spend")}/{c("out")},0)', INR2_FMT),
        ("idx", "#", list(range(1, len(lay.days) + 1)), None),
        ("key", "Rank key", lambda i, r, c: f'=IF({c("out")}>0,{c("date")},-1)', None),
        ("rank", "Rank", lambda i, r, c: _rank("dl_key", "dl_idx", c("key"), c("idx")), None),
    ])

    # ---- months ----
    lay.blocks["ml"] = calc.block("ml", "Monthly", len(lay.months), [
        ("month", "Month", list(lay.months), None),
        ("label", "Label", [datetime.strptime(m, "%Y-%m").strftime("%b %Y") for m in lay.months], None),
        ("days", "Active days", lambda i, r, c: f'=COUNTIFS(dl_month,{c("month")},dl_out,">0")', COUNT_FMT),
        ("people", "People", lambda i, r, c: column_count(pm, lay.months, i), COUNT_FMT),
        ("out", "Outputs", _sum_by("aOut", "aMonth", "month"), COUNT_FMT),
        ("cred", "Credits", _sum_by("aCred", "aMonth", "month"), CREDITS_FMT),
        ("spend", "Spent", _sum_by("aCost", "aMonth", "month"), INR_FMT),
        ("toptool", "Top tool", lambda i, r, c: top_of(mt, r, c("out")), None),
        ("perday", "Per active day", lambda i, r, c: f'=IF({c("days")}>0,{c("spend")}/{c("days")},0)', INR_FMT),
        ("idx", "#", list(range(1, len(lay.months) + 1)), None),
        ("key", "Rank key", lambda i, r, c: f'=IF({c("out")}>0,{c("idx")},-1)', None),
        ("rank", "Rank", lambda i, r, c: _rank("ml_key", "ml_idx", c("key"), c("idx")), None),
    ])

    # ---- chart feeds: top 5 tools + Others, top 6 departments ----
    def donut_value(i, r, c):
        if i < 5:
            return f'=IF({c("idx")}="",0,INDEX(t_measure,{c("idx")}))'
        col = _letters(c("value"))
        return f'=MAX(0,SUMIF(t_measure,">0")-SUM({col}{r - 5}:{col}{r - 1}))'

    lay.blocks["dn"] = calc.block("dn", "Usage by tool (chart)", 6, [
        ("idx", "Row", lambda i, r, c: '=""' if i == 5 else f'=IFERROR(MATCH({i + 1},t_mrank,0),"")', None),
        ("name", "Tool", lambda i, r, c: (f'=IF({c("value")}>0,"Others","")' if i == 5
                                           else f'=IF({c("idx")}="","",INDEX(t_name,{c("idx")}))'), None),
        ("value", "Value", donut_value, None),
        ("pct", "Share", lambda i, r, c: f'=IF(SUM(dn_value)>0,{c("value")}/SUM(dn_value),0)', PCT_FMT),
    ])
    lay.blocks["dc"] = calc.block("dc", "Departments (chart)", 6, [
        ("idx", "Row", lambda i, r, c: f'=IFERROR(MATCH({i + 1},d_mrank,0),"")', None),
        ("name", "Department", lambda i, r, c: f'=IF({c("idx")}="","",INDEX(d_name,{c("idx")}))', None),
        ("value", "Value", lambda i, r, c: f'=IF({c("idx")}="",0,ROUND(INDEX(d_measure,{c("idx")}),0))', "#,##0"),
    ])
    # The department chart draws only the departments it has (no empty bars)
    calc.scalar("kDcN", "Department bars", '=MAX(1,COUNTIF(dc_name,"?*"))')
    _dynamic_range(wb, "dcNames", lay.blocks["dc"], "name", "kDcN")
    _dynamic_range(wb, "dcValues", lay.blocks["dc"], "value", "kDcN")
    _build_compare_calc(calc, wb, lay)
    return calc


def _dynamic_range(wb, name: str, block: Block, key: str, count: str) -> None:
    """A name over the first `count` cells of a block column, for a chart
    whose number of bars follows the filters."""
    col = block.letters[key]
    _name(wb, name, f"'{CALC}'!${col}${block.first}:INDEX('{CALC}'!${col}${block.first}:${col}${block.last},{count})")


def _chart_ref(name: str) -> str:
    """A chart series reference to a workbook name ([0] = this workbook)."""
    return f"[0]!{name}"


def _build_compare_calc(calc: Calc, wb, lay: Layout) -> None:
    """Compare, as ComparePanel.jsx works it out. Inputs (Compare sheet):
    cMode, cMetric (Chart), cSort, cDim (By), cTop (How many), cPick (the
    six pick cells). Side by side: the valid picks (or, none picked, the four
    busiest), sorted by the chart metric, each metric's best. Rankings: one
    dimension's rows with outputs / credits, sorted, top N."""
    def choose(items) -> str:
        return ",".join(items)

    tool_cols = [m[1] for m in CMP_TOOL_METRICS]
    people_cols = [m[1] for m in CMP_PEOPLE_METRICS]
    calc.scalar("kCmpMode", "Compare: mode (1 tools, 2 people, 3 outputs, 4 credits)",
                "=IFERROR(MATCH(cMode,lstCmpModes,0),1)")
    calc.scalar("kCmpSide", "Compare: side by side", "=IF(kCmpMode<=2,1,0)")
    calc.scalar("kCmpWho", "Compare: 1 tools, 2 people", "=IF(kCmpMode=2,2,1)")
    calc.scalar("kCmpMetric", "Compare: chart metric",
                "=IFERROR(MATCH(cMetric,CHOOSE(kCmpWho,lstToolMetrics,lstPeopleMetrics),0),1)")
    calc.scalar("kCmpStyle", "Compare: chart metric style", (
        f'=IF(kCmpSide=0,"num",CHOOSE(kCmpWho,CHOOSE(kCmpMetric,{choose(chr(34) + m[2] + chr(34) for m in CMP_TOOL_METRICS)}),'
        f'IFERROR(CHOOSE(kCmpMetric,{choose(chr(34) + m[2] + chr(34) for m in CMP_PEOPLE_METRICS)}),"num")))'))
    calc.scalar("kCmpSortS", "Compare: side-by-side sort", "=IFERROR(MATCH(cSort,lstEntitySorts,0),1)")
    calc.scalar("kCmpSortR", "Compare: ranking sort", "=IFERROR(MATCH(cSort,lstRankSorts,0),1)")
    calc.scalar("kCmpDim", "Compare: ranking dimension", "=IFERROR(MATCH(cDim,lstDims,0),1)")
    calc.scalar("kCmpTop", "Compare: how many (0 = all)",
                f"=IFERROR(INDEX({{{choose(str(n) for _t, n in CMP_TOP)}}},MATCH(cTop,lstTop,0)),10)")

    # ---- side by side: the six pick cells ----
    def pick_ok(i, r, c):
        before = f'COUNTIF(${_letters(c("pick"))}${Calc.FIRST}:${_letters(c("pick"))}{r - 1},{c("pick")})' if i else "0"
        return (f'=IF({c("ridx")}="",0,IF({before}>0,0,'
                f'IF(kCmpWho=1,INDEX(t_listed,{c("ridx")}),IF(INDEX(p_out,{c("ridx")})>0,1,0))))')

    calc.block("cp", "Compare picks", PICKS, [
        ("pick", "Picked", lambda i, r, c: f'=INDEX(cPick,1,{i + 1})&""', None),
        ("ridx", "Row", lambda i, r, c: (f'=IF({c("pick")}="","",'
                                         f'IFERROR(MATCH({c("pick")},CHOOSE(kCmpWho,t_name,p_name),0),""))'), None),
        ("ok", "Valid", pick_ok, None),
        ("seq", "Valid so far", lambda i, r, c: f'={c("ok")}' + (f'+{_letters(c("seq"))}{r - 1}' if i else ""), None),
    ])
    calc.scalar("kCmpValid", "Compare: valid picks", "=MAX(cp_seq)")

    def metric_value(idx: str, metric: str) -> str:
        tool = f"INDEX(CHOOSE({metric},{choose(tool_cols)}),{idx})"
        people = f"INDEX(CHOOSE({metric},{choose(people_cols)}),{idx})"
        return f'IFERROR(IF(kCmpWho=1,{tool},{people}),"")'

    def sort_rank(i, r, c):
        ev, k = c("ev"), c("k")
        higher = f'COUNTIFS(ce_ev,">"&{ev})+COUNTIFS(ce_ev,{ev},ce_k,"<"&{k})+1'
        lower = f'COUNTIFS(ce_ev,"<"&{ev})+COUNTIFS(ce_ev,{ev},ce_k,"<"&{k})+1'
        return f'=IF({c("eidx")}="","",CHOOSE(kCmpSortS,{higher},{lower},{k}))'

    calc.block("ce", "Compare entities", PICKS, [
        ("k", "#", list(range(1, PICKS + 1)), None),
        ("eidx", "Row", lambda i, r, c: (
            f'=IF(kCmpSide=0,"",IF(kCmpValid>0,IFERROR(INDEX(cp_ridx,MATCH({c("k")},cp_seq,0)),""),'
            f'IF({c("k")}<=4,IFERROR(MATCH({c("k")},CHOOSE(kCmpWho,t_orank,p_orank),0),""),"")))'), None),
        ("ev", "Chart metric", lambda i, r, c: f'=IF({c("eidx")}="","",{metric_value(c("eidx"), "kCmpMetric")})', None),
        ("srank", "Shown at", sort_rank, None),
    ])
    shown = [("s", "#", list(range(1, PICKS + 1)), None),
             ("didx", "Row", lambda i, r, c: f'=IFERROR(INDEX(ce_eidx,MATCH({c("s")},ce_srank,0)),"")', None),
             ("name", "Name", lambda i, r, c: (f'=IF({c("didx")}="","",'
                                               f'INDEX(CHOOSE(kCmpWho,t_name,p_name),{c("didx")}))'), None),
             ("top", "Top user / tool", lambda i, r, c: (f'=IF({c("didx")}="","",'
                                                          f'INDEX(CHOOSE(kCmpWho,t_top,p_toptool),{c("didx")}))'), None)]
    for m in range(1, CMP_METRICS + 1):
        shown.append((f"v{m}", f"Metric {m}",
                      lambda i, r, c, m=m: f'=IF({c("didx")}="","",{metric_value(c("didx"), str(m))})', None))
    shown.append(("cv", "Chart value", lambda i, r, c: (
        f'=IF({c("didx")}="","",CHOOSE(kCmpMetric,{choose(c(f"v{m}") for m in range(1, CMP_METRICS + 1))}))'), None))
    calc.block("cd", "Compare shown", PICKS, shown)

    def best(direction: str, rng: str) -> str:
        if direction == "hi":
            return f'IF(MAX({rng})>0,MAX({rng}),"")'
        if direction == "lo":       # the smallest above 0 (no array formula: plain SMALL / COUNTIF)
            return f'IF(COUNTIF({rng},">0")=0,"",SMALL({rng},COUNTIF({rng},"<=0")+1))'
        return '""'

    for m in range(1, CMP_METRICS + 1):
        rng = f"cd_v{m}"
        t_dir = CMP_TOOL_METRICS[m - 1][3] if m <= len(CMP_TOOL_METRICS) else ""
        p_dir = CMP_PEOPLE_METRICS[m - 1][3] if m <= len(CMP_PEOPLE_METRICS) else ""
        calc.scalar(f"kCmpBest{m}", f"Compare: best of metric {m}",
                    f'=IF(COUNT({rng})<2,"",CHOOSE(kCmpWho,{best(t_dir, rng)},{best(p_dir, rng)}))')
        calc.scalar(f"kCmpMax{m}", f"Compare: largest of metric {m}", f"=MAX(MAX({rng}),0)")
    calc.scalar("kCmpBestChart", "Compare: best of the chart metric",
                f"=CHOOSE(kCmpMetric,{choose(f'kCmpBest{m}' for m in range(1, CMP_METRICS + 1))})")

    # ---- rankings: one dimension's rows ----
    def dim_range(pos: int) -> str:
        return f"CHOOSE(kCmpDim,{choose(d[pos] for d in CMP_DIMS)})"

    n_rank = max(len(lay.tools), len(lay.people), len(lay.depts), len(lay.clients), len(lay.days), len(lay.months))

    def rank_of(i, r, c):
        val, sk, i_ = c("val"), c("sk"), c("i")
        tie_v = f'COUNTIFS(rk_hv,{val},rk_i,"<"&{i_})+1'
        tie_s = f'COUNTIFS(rk_sk,{sk},rk_in,1,rk_i,"<"&{i_})+1'
        return (f'=IF({c("in")}=0,"",CHOOSE(kCmpSortR,COUNTIFS(rk_hv,">"&{val})+{tie_v},'
                f'COUNTIFS(rk_hv,"<"&{val})+{tie_v},COUNTIFS(rk_sk,"<"&{sk},rk_in,1)+{tie_s},'
                f'COUNTIFS(rk_sk,">"&{sk},rk_in,1)+{tie_s}))')

    calc.block("rk", "Compare ranking (all rows)", n_rank, [
        ("i", "#", list(range(1, n_rank + 1)), None),
        ("nm", "Name", lambda i, r, c: f'=IF(kCmpSide=1,"",IFERROR(INDEX({dim_range(2)},{c("i")})&"",""))', None),
        ("outs", "Outputs", lambda i, r, c: f'=IF({c("nm")}="",0,IFERROR(INDEX({dim_range(3)},{c("i")}),0))', None),
        ("cred", "Credits", lambda i, r, c: f'=IF({c("nm")}="",0,IFERROR(INDEX({dim_range(4)},{c("i")}),0))', None),
        ("spend", "Spend", lambda i, r, c: f'=IF({c("nm")}="",0,IFERROR(INDEX({dim_range(5)},{c("i")}),0))', None),
        ("val", "Value", lambda i, r, c: f'=IF(kCmpMode=4,{c("cred")},{c("outs")})', None),
        ("in", "Ranked", lambda i, r, c: f'=IF(AND({c("nm")}<>"",{c("val")}>0),1,0)', None),
        ("hv", "Value if ranked", lambda i, r, c: f'=IF({c("in")}=1,{c("val")},"")', None),
        ("sk", "Name order", lambda i, r, c: f'=IF({c("in")}=0,"",IFERROR(INDEX({dim_range(6)},{c("i")}),""))', None),
        ("rank", "Rank", rank_of, None),
    ])
    calc.scalar("kRkCount", "Ranking: rows", "=SUM(rk_in)")
    calc.scalar("kRkTotal", "Ranking: total", "=SUMIFS(rk_val,rk_in,1)")
    calc.scalar("kRkAvg", "Ranking: average", "=IF(kRkCount>0,kRkTotal/kRkCount,0)")
    calc.scalar("kRkHigh", "Ranking: highest", "=IF(kRkCount=0,0,MAX(rk_hv))")
    calc.scalar("kRkLow", "Ranking: lowest", "=IF(kRkCount=0,0,MIN(rk_hv))")
    calc.scalar("kRkHighName", "Ranking: highest name", '=IFERROR(INDEX(rk_nm,MATCH(kRkHigh,rk_hv,0)),"")')
    calc.scalar("kRkLowName", "Ranking: lowest name", '=IFERROR(INDEX(rk_nm,MATCH(kRkLow,rk_hv,0)),"")')
    calc.scalar("kRkShow", "Ranking: rows shown",
                f"=MIN({RANK_ROWS},IF(kCmpTop=0,kRkCount,MIN(kCmpTop,kRkCount)))")
    calc.block("ro", "Compare ranking (shown)", RANK_ROWS, [
        ("k", "#", list(range(1, RANK_ROWS + 1)), None),
        ("ri", "Row", lambda i, r, c: f'=IF({c("k")}>kRkShow,"",IFERROR(MATCH({c("k")},rk_rank,0),""))', None),
        ("name", "Name", lambda i, r, c: f'=IF({c("ri")}="","",INDEX(rk_nm,{c("ri")}))', None),
        ("val", "Value", lambda i, r, c: f'=IF({c("ri")}="","",INDEX(rk_val,{c("ri")}))', None),
        ("share", "Share", lambda i, r, c: f'=IF({c("ri")}="","",IF(kRkTotal>0,{c("val")}/kRkTotal,0))', None),
        ("vs", "vs avg", lambda i, r, c: f'=IF({c("ri")}="","",IF(kRkAvg>0,({c("val")}-kRkAvg)/kRkAvg,0))', None),
        ("per", "Per output", lambda i, r, c: (
            f'=IF({c("ri")}="","",IF(INDEX(rk_outs,{c("ri")})>0,'
            f'IF(kCmpMode=4,INDEX(rk_cred,{c("ri")}),INDEX(rk_spend,{c("ri")}))/INDEX(rk_outs,{c("ri")}),0))'), None),
    ])

    # ---- the chart: one series per number style, so its labels read as
    # the page's (₹19.4K / 2.2 / 0.4%); a bar sits in its style's series ----
    def feed(style: str, scale: str, digits: int):
        return lambda i, r, c: f'=IF(kCmpStyle="{style}",ROUND({c("val")}{scale},{digits}),0)'

    lay.blocks["cf"] = calc.block("cf", "Compare chart", RANK_ROWS, [
        ("k", "#", list(range(1, RANK_ROWS + 1)), None),
        ("name", "Name", lambda i, r, c: (f'=IF(kCmpSide=1,IF({c("k")}<={PICKS},INDEX(cd_name,{c("k")}),""),'
                                          f'INDEX(ro_name,{c("k")}))'), None),
        ("val", "Value", lambda i, r, c: (f'=IF({c("name")}="",0,N(IF(kCmpSide=1,INDEX(cd_cv,{c("k")}),'
                                          f'INDEX(ro_val,{c("k")}))))'), None),
        ("inr", "₹", feed("inr", "", 2), '[>=1000]"₹"0.0,"K";[>0]"₹"#,##0;""'),
        ("num", "Number", feed("num", "", 1), '[>=1000]0.0,"K";[>0]General;""'),
        ("pct", "%", feed("pct", "*100", 1), '[>0]General"%";""'),
    ])
    calc.scalar("kCfN", "Compare chart: bars", '=MAX(1,COUNTIF(cf_name,"?*"))')
    for key, name in (("name", "cfNames"), ("inr", "cfInr"), ("num", "cfNum"), ("pct", "cfPct")):
        _dynamic_range(wb, name, lay.blocks["cf"], key, "kCfN")


# --------------------------------------------------------------------------- #
# Visible sheets
# --------------------------------------------------------------------------- #
TAB_HEAD = 7          # a tab's table header; above it: title, note, tabs, filter bar, a gap
R_BAR = 5             # the filter bar's boxes (captions on the row above)
BOX_WIDTH = 16        # a filter box spans columns until at least this wide
# The Dashboard's filters, as each tab's bar shows them: (caption, name, shown)
# A sheet's filters, as the Dashboard's: (caption, name, list key; "date" for From / To, None for Search)
FILTER_BOXES = (("TOOL", "fTool", "tool"), ("ACCOUNT", "fAcct", "acct"), ("DEPARTMENT", "fDept", "dept"),
                ("PERSON", "fPerson", "person"), ("CLIENT / PROJECT", "fClient", "client"),
                ("SEARCH", "fSearch", None), ("FROM", "fFrom", "date"), ("TO", "fTo", "date"))
HEADER_FILTER_NOTE = "Use ▼ on the headers to filter or sort; after changing the filters above, click Data › Reapply."
CHANGE_RULES = (  # the change text, coloured as on the page: ▲ green, ▼ red
    ('LEFT({c},1)="▲"', GREEN_DARK), ('LEFT({c},1)="▼"', RED))

# Each tab's row count, shown on its tab as the page does ("Tools 8")
TAB_COUNTS = {ACTIVITY: "kActCount", PEOPLE: "COUNT(p_rank)", TOOLS: "COUNT(t_rank)", CLIENTS: "COUNT(c_rank)",
              DAILY: "COUNT(dl_rank)", MONTHLY: "COUNT(ml_rank)", DEPTS: "COUNT(d_rank)"}
TAB_COUNT_NAMES = ("kActCount", "p_rank", "t_rank", "c_rank", "dl_rank", "ml_rank", "d_rank")


def _nav(grid: Grid, row: int, current: str) -> None:
    """A tab bar: the current sheet filled green, the others grey; white
    borders between them read as separate tabs."""
    grid.put(row, 2, "Go to", font=F_CAPTION, align=LEFT_MID)
    for j, name in enumerate((DASH,) + TABS):
        border = Border(left=GAP, right=GAP)
        count = _renamer(TAB_COUNT_NAMES, SCOPES[name])(TAB_COUNTS[name]) if name in TAB_COUNTS else None
        label = f'"{name}  "&{count}' if count else f'"{name}"'
        if name == current:
            grid.put(row, 3 + j, f"={label}", font=F_TAB_ON, fill=FILL_TAB_ON, align=NAV_ALIGN, border=border)
        else:
            grid.put(row, 3 + j, f"=HYPERLINK(\"#'{name}'!A1\",{label})", font=F_TAB_OFF, fill=FILL_TAB_OFF,
                     align=NAV_ALIGN, border=border)


def _sheet_setup(ws, *, tab_color: str = "9CA3AF", landscape: bool = True) -> None:
    ws.sheet_view.showGridLines = False
    ws.sheet_properties.tabColor = tab_color
    if landscape:
        ws.page_setup.orientation = "landscape"
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
    ws.row_dimensions[1].height = 34
    ws.row_dimensions[3].height = 22


def _sheet_head(grid: Grid, title: str, note) -> None:
    """Title, note, tab bar; the filter bar below them is added by _filter_bar
    once the tab's column widths are known."""
    grid.put(1, 2, title, font=F_TITLE, align=LEFT_MID, text=True)
    grid.put(2, 2, note, font=F_HELP, text=not str(note).startswith("="))
    _nav(grid, 3, title)


def _date_validation(list_ranges: dict, start: date, end: date) -> DataValidation:
    """A From / To box: a dropdown of the period's days (typing a day of the
    period works too). With macros on, clicking the box opens a calendar
    instead (vba/DatePick.frm)."""
    return DataValidation(type="list", formula1=list_ranges["date"], allow_blank=True, showErrorMessage=True,
                          errorTitle="Date outside the period",
                          error=f"Pick a day from {start:%d %b %Y} to {end:%d %b %Y}.")


def _filter_bar(grid: Grid, ws, widths: dict, scope: Scope) -> list:
    """The filters across a sheet's top, as the Dashboard's yellow boxes.
    Each box holds a formula showing the Dashboard's filter, so a change on
    the Dashboard reaches every sheet. Picking from its dropdown (typing in
    Search or a date) replaces that formula: the sheet then uses its own
    value - the box turns blue, "this sheet only" by its caption - until
    the box is cleared (Delete), when it follows the Dashboard again. (One
    value cannot be set from several sheets without macros.) The sheet's
    names fTool<suffix> ... are that rule. A box spans columns until it is
    BOX_WIDTH wide; columns past the sheet's table get that width (filled in
    `widths`). Returns the ranges to merge."""
    ws.row_dimensions[R_BAR].height = 22
    ws.row_dimensions[R_BAR + 1].height = 8
    merges, c = [], 2
    for label, name, list_key in FILTER_BOXES:
        first, span = c, 0
        while span < BOX_WIDTH:
            widths.setdefault(_col(c), BOX_WIDTH)
            span += widths[_col(c)]
            c += 1
        last = c - 1
        cell = f"{_col(first)}{R_BAR}"
        box = _abs(scope.sheet, _col(first), R_BAR)
        dash = ws.parent.defined_names[name].attr_text          # the Dashboard's box
        # what the Dashboard says ("" when Search / a date is empty there)
        shown = dash if list_key not in (None, "date") else f'IF({dash}="","",{dash})'
        grid.put(R_BAR - 1, first, (f'="{label}"&IF(_xlfn.ISFORMULA({cell}),"",IF({cell}="",'
                                    f'"  ·  Dashboard: "&{shown},"  ·  this sheet only"))'),
                 font=F_CAPTION, fill=FILL_PANEL)
        for col in range(first + 1, last + 1):
            grid.put(R_BAR - 1, col, None, fill=FILL_PANEL)
        fmt = DATE_FMT if list_key == "date" else None    # (a ▾ fill format turns a long name into ####)
        grid.put(R_BAR, first, f"={shown}", fmt=fmt, font=F_INPUT, fill=FILL_INPUT, align=LEFT_MID,
                 border=Border(left=INPUT_BOX.left, right=INPUT_BOX.right if last == first else None,
                               top=INPUT_BOX.top, bottom=INPUT_BOX.bottom))
        for col in range(first + 1, last + 1):
            grid.put(R_BAR, col, None, fill=FILL_INPUT,
                     border=Border(right=INPUT_BOX.right if col == last else None, top=INPUT_BOX.top,
                                   bottom=INPUT_BOX.bottom))
        if last > first:
            merges.append(f"{_col(first)}{R_BAR}:{_col(last)}{R_BAR}")
        ws.conditional_formatting.add(f"{_col(first)}{R_BAR}:{_col(last)}{R_BAR}", FormulaRule(
            formula=[f"NOT(_xlfn.ISFORMULA(${_col(first)}${R_BAR}))"], fill=_cf_fill("DBEAFE")))
        _name(ws.parent, name + scope.sfx, f'IF({box}="",{shown},{box})')
        _name(ws.parent, f"bx_{name}{scope.sfx}", box)     # the box itself, for the sync macro (see VBA_DIR)
        if list_key == "date":
            dv = _date_validation(scope.list_ranges, scope.start, scope.end)
        elif list_key:
            dv = DataValidation(type="list", formula1=scope.list_ranges.get((list_key, scope.sfx),
                                                                          scope.list_ranges[list_key]),
                                allow_blank=True,
                                showErrorMessage=True, errorTitle="Pick from the list",
                                error="Choose a value from the dropdown.")
        else:
            continue
        dv.add(cell)
        ws.data_validations.append(dv)
    grid.put(R_BAR - 1, c, ("These follow the Dashboard's filters. Pick here to change this sheet only (the box "
                            "turns blue); press Delete in a box to follow the Dashboard again."),
             font=F_HELP, text=True)
    return merges


def _widths(ws, widths: dict) -> None:
    for col, width in widths.items():
        ws.column_dimensions[col].width = width


def _table_head(grid: Grid, ws, headers: list) -> None:
    """A dark header row; number columns' headers right-aligned over their figures."""
    ws.row_dimensions[TAB_HEAD].height = 26
    for j, (header, numeric) in enumerate(headers):
        align = Alignment(horizontal="right" if numeric else "left", vertical="center", wrap_text=True)
        grid.put(TAB_HEAD, 2 + j, header, font=F_THEAD, fill=FILL_THEAD, align=align, text=True)


def _table_rules(ws, last_col: int, n_rows: int) -> None:
    """Row styling that follows the data: a hairline under and zebra on rows
    that hold an entry, nothing on the unused rows below; top 3 ranks marked."""
    first, last = TAB_HEAD + 1, TAB_HEAD + max(n_rows, 1)
    body = f"B{first}:{_col(last_col)}{last}"
    ws.conditional_formatting.add(body, FormulaRule(
        formula=[f'AND($A{first}<>"",MOD(ROW(),2)=0)'], fill=FILL_PANEL, border=Border(bottom=HAIR)))
    ws.conditional_formatting.add(body, FormulaRule(formula=[f'$A{first}<>""'], border=Border(bottom=HAIR)))
    ws.conditional_formatting.add(f"B{first}:B{last}", FormulaRule(
        formula=[f"AND(ISNUMBER($B{first}),$B{first}<=3)"], fill=_fill(GREEN_SOFT),
        font=Font(bold=True, color=GREEN_DARK)))


def _column_rules(ws, col: str, style: Optional[str], n_rows: int, fmt: Optional[str] = None) -> None:
    first, last = TAB_HEAD + 1, TAB_HEAD + max(n_rows, 1)
    rng = f"{col}{first}:{col}{last}"
    _page_number_rules(ws, rng, fmt)
    if style in ("bar", "share"):
        ws.conditional_formatting.add(rng, DataBarRule(
            start_type="num", start_value=0, end_type="max", color=GREEN if style == "bar" else "8B5CF6"))
    elif style == "scale":
        ws.conditional_formatting.add(rng, ColorScaleRule(
            start_type="num", start_value=0, start_color="FFFFFF", end_type="max", end_color="6EE7B7"))
    elif style == "status":
        for formula, color in ((f'{col}{first}="{CHARGED}"', GREEN_DARK), (f'{col}{first}="Pending"', AMBER),
                               (f'AND({col}{first}<>"",{col}{first}<>"{CHARGED}",{col}{first}<>"Pending")', RED)):
            ws.conditional_formatting.add(rng, FormulaRule(formula=[formula], font=Font(bold=True, color=color)))


def _header_filter(grid: Grid, ws, last_col: int, n_rows: int) -> None:
    """Excel's filter dropdowns on the header row. The range starts at the
    hidden key column A, so sorting from a dropdown carries each row's key
    (which entity it shows) with it."""
    grid.put(TAB_HEAD, 1, "Key", font=F_HEAD)
    ws.auto_filter.ref = f"A{TAB_HEAD}:{_col(last_col)}{TAB_HEAD + max(n_rows, 1)}"


# Tab cells show numbers as the page does (see MONEY_FMT)
PAGE_FMT = {INR_FMT: MONEY_FMT, INR2_FMT: MONEY_FMT, COUNT_FMT: NUM_FMT, CREDITS_FMT: NUM_FMT, "0.0": NUM_FMT,
            PCT_FMT: SHARE_FMT}


def _spec(column: tuple) -> tuple:
    """(header, block column name, number format, width[, style[, link]]) -> 6-tuple.
    style: name (bold), bar / share (data bar), scale (colour scale), status.
    link: a key of the link targets (see _link_targets): the cell jumps there."""
    column = column + (None,) * (6 - len(column))
    return column[:2] + (PAGE_FMT.get(column[2], column[2]),) + column[3:]


# Interlinks: a name in one tab jumps to the same entity's row in another,
# as clicking it drills in on the page. The target row is looked up live
# (MATCH on the target tab's column), so it stays right however that tab is
# ranked, filtered or sorted; an entity the target doesn't list (filtered
# out, or older than the Activity window) stays plain text.
F_XLINK = Font(color="1D4ED8")
F_XLINK_BOLD = Font(color="1D4ED8", bold=True)
LINKS_NOTE = "Blue names are links: they open that person, tool, client, department or day in its own tab."

ACTIVITY_COLUMNS = (
    ("When", "dDate", DATE_FMT, 13, None, "date"), ("Time", "dTime", None, 12),   # wide enough for its tab label
    ("Person", "dPerson", None, 22, "name", "person"), ("Tool", "dTool", None, 12, "name", "tool"),
    ("Account", "dAcct", None, 26), ("Output", "dOut", None, 15), ("What", "dWhat", None, 18),
    ("Prompt", "dPrompt", None, 48), ("Client / Project", "dClient", None, 20, None, "client"),
    ("Department", "dDept", None, 16, None, "dept"), ("Credits", "dCred", CREDITS_FMT, 10),
    ("Cost (₹)", "dCost", INR2_FMT, 11, "bar"), ("Status", "dStatus", None, 12, "status"),
)


def _link_targets(lay: Layout, n_activity: int) -> dict:
    """key -> where a link lands. Targets are found WITHOUT reading the
    target tab's own cells (those hold links back, which would be a circular
    reference):
      ("ranked", sheet, calc names, rows): the entity's index in its Calc
          block, looked up in the tab's hidden key column A - which depends
          on Calc only, and moves with its row when the tab is sorted;
      ("activity", Data link column, rows): the entity's first filtered row
          in Data, whose Seq is its Activity row - shown only if within the
          Activity window. A day's rows are together there (newest first);
      ("group", sheet, Groups names): the entity's section on its grouped
          Activity tab, where only its generations are listed."""
    return {
        "person": ("ranked", PEOPLE, "p_name", len(lay.people)),
        "tool": ("ranked", TOOLS, "t_name", len(lay.tools)),
        "client": ("ranked", CLIENTS, "c_name", len(lay.clients)),
        "dept": ("ranked", DEPTS, "d_name", len(lay.depts)),
        "date": ("ranked", DAILY, "dl_date", len(lay.days)),
        "act_person": ("group", P_ACT, "gpName", "gpLand"),
        "act_tool": ("group", T_ACT, "gtName", "gtLand"),
        "act_client": ("group", C_ACT, "gcName", "gcLand"),
        "act_date": ("activity", "dLnkDate" + SCOPES[ACTIVITY], n_activity),
    }


def _linked(value: str, target: tuple, label: Optional[str] = None) -> str:
    """value, as a link to its row in the target table (plain if not there)."""
    shown = label or value
    if target[0] == "ranked":
        _kind, sheet, names, n = target
        keys = f"'{sheet}'!$A${TAB_HEAD + 1}:$A${TAB_HEAD + max(n, 1)}"
        row = f"MATCH(MATCH({value},{names},0),{keys},0)"
    elif target[0] == "group":
        _kind, sheet, names, land = target
        row = f"INDEX({land},MATCH({value},{names},0))"
    else:
        _kind, helper, n = target
        sheet = ACTIVITY
        seq = f"INDEX(dSeq{SCOPES[ACTIVITY]},MATCH({value},{helper},0))"
        row = f"IF({seq}<={n},{seq},NA())"
    return f"IFERROR(HYPERLINK(\"#'{sheet}'!C\"&({TAB_HEAD}+{row}),{shown}),{shown})"


def _swatch(expr: str) -> str:
    """A legend entry: a colour square before the name (the cell font gives the colour)."""
    return f'"■  "&{expr}'


def _body_expr(r: int, spec: tuple, targets: dict) -> tuple:
    """(expression, font) of a body cell showing the row's entry ($A is its index).
    link is a target key, or (target key, column to look up) when the cell
    shows one thing but opens another (a department opens its top person)."""
    _h, name_ref, _fmt, _w, style, link = spec
    value = f"INDEX({name_ref},$A{r})"
    if link:
        key, lookup = link if isinstance(link, tuple) else (link, name_ref)
        return (_linked(f"INDEX({lookup},$A{r})", targets[key], label=value),
                F_XLINK_BOLD if style == "name" else F_XLINK)
    return value, F_BOLD if style == "name" else None


def _body_cell(grid: Grid, r: int, c: int, spec: tuple, targets: dict) -> None:
    expr, font = _body_expr(r, spec, targets)
    grid.put(r, c, f'=IF($A{r}="","",{expr})', fmt=spec[2], font=font)


def _write_ranked_tab(ws, title: str, note: str, rank_name: str, n: int, columns: list, targets: dict,
                      scope: Scope, extra: Optional[Callable] = None) -> list:
    """A tab listing a block's rows in rank order: row k shows the entity
    ranked k under the current filters, so the table re-sorts as they change.
    columns: (header, block column name, number format, width[, style[, link]]).
    extra(grid, ws, last_row): adds the tab's own controls."""
    columns = [_spec(c) for c in columns]
    grid = Grid(scope.ren)
    _sheet_setup(ws)
    _sheet_head(grid, title, f"{note} {LINKS_NOTE} {HEADER_FILTER_NOTE}")
    if extra:
        extra(grid, ws, TAB_HEAD + max(n, 1))
    _table_head(grid, ws, [("#", True)] + [(h, fmt is not None) for h, _r, fmt, *_x in columns])
    for k in range(1, max(n, 1) + 1):
        r = TAB_HEAD + k
        grid.put(r, 1, f'=IFERROR(MATCH({k},{rank_name},0),"")')
        grid.put(r, 2, f'=IF($A{r}="","",{k})', font=F_LABEL, align=CENTER)
        for j, spec in enumerate(columns):
            _body_cell(grid, r, 3 + j, spec, targets)
    last_col = 2 + len(columns)
    _header_filter(grid, ws, last_col, n)
    _table_rules(ws, last_col, n)
    for j, spec in enumerate(columns):
        _column_rules(ws, _col(3 + j), spec[4], n, spec[2])
    widths = {"A": 4, "B": 5}
    widths.update({_col(3 + j): spec[3] + (3 if spec[2] else 0) for j, spec in enumerate(columns)})
    merges = _filter_bar(grid, ws, widths, scope)
    _widths(ws, widths)
    ws.column_dimensions["A"].hidden = True
    ws.freeze_panes = f"C{TAB_HEAD + 1}"
    grid.flush(ws)
    _rename_rules(ws, scope.ren)
    return merges


def _tools_switch(grid: Grid, ws, last_row: int) -> None:
    """The page's "Show unused" switch, top right of the Tools tab, with how
    many tools are not used; those rows are greyed like the page's."""
    grid.put(1, 11, "Show unused", font=F_HEAD, align=RIGHT_MID, text=True)
    grid.put(1, 12, "Yes", fmt=DROPDOWN_FMT, font=F_INPUT, fill=FILL_INPUT, border=INPUT_BOX, align=LEFT_MID,
             text=True)
    grid.put(1, 13, '=COUNTIF(t_notused,1)&" not used"', font=F_FOOT, align=LEFT_MID)
    dv = DataValidation(type="list", formula1='"Yes,No"', allow_blank=False, showErrorMessage=True,
                        errorTitle="Yes or No", error="Choose Yes or No.")
    dv.add("L1")
    ws.data_validations.append(dv)
    _name(ws.parent, "fShowUnused", _abs(TOOLS, "L", 1))
    first = TAB_HEAD + 1
    ws.conditional_formatting.add(f"D{first}:M{last_row}", FormulaRule(
        formula=[f'AND($A{first}<>"",IFERROR(INDEX(t_notused,$A{first})=1,FALSE))'], font=Font(color=FAINT)))


def _write_activity(ws, n_rows: int, targets: dict, scope: Scope) -> list:
    grid = Grid(scope.ren)
    _sheet_setup(ws)
    _sheet_head(grid, ACTIVITY, (f'="Showing "&MIN(kActCount,{n_rows})&" of "&kActCount&" matching generations, '
                                 f'newest first"&IF(kActCount>{n_rows},". The rest are in the Full Excel workbook.","")'
                                 f'&". {LINKS_NOTE} {HEADER_FILTER_NOTE}"'))
    columns = [_spec(c) for c in ACTIVITY_COLUMNS]
    _table_head(grid, ws, [("S.No", True)] + [(h, fmt is not None and h != "When") for h, _r, fmt, *_x in columns]
                + [("Link", False)])
    link_col = 3 + len(columns)
    for k in range(1, max(n_rows, 1) + 1):
        r = TAB_HEAD + k
        grid.put(r, 1, f'=IF({k}>kActCount,"",MATCH({k - 1},dSeq,1)+1)')
        grid.put(r, 2, f'=IF($A{r}="","",{k})', font=F_LABEL, align=CENTER)
        for j, spec in enumerate(columns):
            _body_cell(grid, r, 3 + j, spec, targets)
        grid.put(r, link_col, (f'=IF($A{r}="","",IF(INDEX(dLink,$A{r})="","",'
                               f'HYPERLINK(INDEX(dLink,$A{r}),"Open ↗")))'), font=F_LINK)
    _header_filter(grid, ws, link_col, n_rows)
    _table_rules(ws, link_col, n_rows)
    for j, spec in enumerate(columns):
        _column_rules(ws, _col(3 + j), spec[4], n_rows, spec[2])
    widths = {"A": 4, "B": 6}
    widths.update({_col(3 + j): spec[3] for j, spec in enumerate(columns)})
    widths[_col(link_col)] = 9
    merges = _filter_bar(grid, ws, widths, scope)
    _widths(ws, widths)
    ws.column_dimensions["A"].hidden = True
    ws.freeze_panes = f"C{TAB_HEAD + 1}"
    grid.flush(ws)
    _rename_rules(ws, scope.ren)
    return merges


def _write_group_activity(ws, grouping: tuple, n_rows: int, targets: dict, scope: Scope) -> list:
    """Activity grouped by person, tool or client: each one's section is a
    header row (its name, outputs, credits and cost) over its generations,
    newest first, all under the sheet's own filters. Links to an entity land on
    its header; the name there leads back to the entity's tab.
    Hidden columns: A the Data row (blank on a header), after Link the item."""
    tab, pre, back, key_col, _helper, head, _attr = grouping
    one = head.split(" /")[0].lower()
    # the grouped column moves to the front; no data bars, a header holds the section total
    columns = [_spec(c) for c in ACTIVITY_COLUMNS if c[1] != key_col]
    columns = [c[:4] + (None if c[4] == "bar" else c[4],) + c[5:] for c in columns]
    grid = Grid(scope.ren)
    _sheet_setup(ws)
    _sheet_head(grid, tab, (f"Generations by {one}, each {one}'s together, newest first (up to {PER_GROUP} each), "
                            f"under this sheet's filters. Clicking a {one} on another tab opens its section here; "
                            f"its name leads back. {LINKS_NOTE.split(': ')[0]}."))
    _table_head(grid, ws, [("#", True), (head, False)]
                + [(h, fmt is not None and h != "When") for h, _r, fmt, *_x in columns] + [("Link", False)])
    first_col = 4
    link_col = first_col + len(columns)
    item_col = _col(link_col + 1)
    for k in range(1, n_rows + 1):
        r = TAB_HEAD + k
        it = f"${item_col}{r}"
        g = f"INDEX({pre}Grp,{it})"
        count = f"INDEX({pre}Count,{g})"
        header = {
            "dDate": f'{count}&IF({count}=1," output"," outputs")',
            "dCred": f"INDEX({pre}Cred,{g})",
            "dCost": f"INDEX({pre}Cost,{g})",
            "dPrompt": (f'IF({count}>{PER_GROUP},"Newest {PER_GROUP} of "&{count}&" shown; '
                        f'the Full Excel workbook has them all.","")'),
        }
        grid.put(r, link_col + 1, f'=IF({k}>{pre}Total,"",MATCH({k - 1},{pre}Pos,1)+1)')
        grid.put(r, 1, f'=IF({it}="","",IF(INDEX({pre}Data,{it})=0,"",INDEX({pre}Data,{it})))')
        grid.put(r, 2, f'=IF($A{r}="","",{k}-INDEX({pre}Base,{g}))', font=F_LABEL, align=CENTER)
        name = f"INDEX({pre}Name,{g})"
        grid.put(r, 3, f'=IF(OR({it}="",$A{r}<>""),"",{_linked(name, targets[back])})', font=F_XLINK_BOLD)
        for j, spec in enumerate(columns):
            expr, font = _body_expr(r, spec, targets)
            grid.put(r, first_col + j, f'=IF({it}="","",IF($A{r}="",{header.get(spec[1], chr(34) * 2)},{expr}))',
                     fmt=spec[2], font=font)
        grid.put(r, link_col, (f'=IF($A{r}="","",IF(INDEX(dLink,$A{r})="","",'
                               f'HYPERLINK(INDEX(dLink,$A{r}),"Open ↗")))'), font=F_LINK)
    first, last = TAB_HEAD + 1, TAB_HEAD + n_rows
    body = f"B{first}:{_col(link_col)}{last}"
    ws.conditional_formatting.add(body, FormulaRule(
        formula=[f'AND(${item_col}{first}<>"",$A{first}="")'], fill=_cf_fill(GREEN_SOFT),
        font=Font(bold=True, color=INK), border=Border(top=HAIR, bottom=HAIR)))
    ws.conditional_formatting.add(body, FormulaRule(formula=[f'$A{first}<>""'], border=Border(bottom=HAIR)))
    for j, spec in enumerate(columns):
        _column_rules(ws, _col(first_col + j), spec[4], n_rows, spec[2])
    widths = {"A": 4, "B": 6, "C": 26}
    widths.update({_col(first_col + j): spec[3] for j, spec in enumerate(columns)})
    widths[_col(link_col)] = 9
    merges = _filter_bar(grid, ws, widths, scope)
    _widths(ws, widths)
    for col in ("A", item_col):
        ws.column_dimensions[col].hidden = True
    ws.freeze_panes = f"D{first}"
    grid.flush(ws)
    _rename_rules(ws, scope.ren)
    return merges


PICKS = 6


# Compare sheet rows
RC_INPUT = 8          # Comparison / Chart / Sort / By / How many (captions on the row above)
RC_PICK = 10          # the six pick cells
RC_CARD = 13          # cards: colour strip, name, value, label, three detail lines, padding
RC_CHART = 23         # chart title; the chart below it
RC_TABLE = 40         # table header; body rows in pairs (value, bar) below
BAR_CHARS = 30        # a full mini bar
CMP_ONE = ("tool", "person", "department", "client", "day", "month")


def _tint(color: str, keep: float = 0.12) -> str:
    """A light tint of a hex colour (its share `keep`, the rest white)."""
    rgb = [int(color[i:i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(255 - (255 - v) * keep):02X}" for v in rgb)


def _styled(style: Optional[str], x: str) -> str:
    """Text of x in a metric's number style."""
    return {"inr": _t_inr, "pct": _t_pct, "num": _t_num}[style](x) if style else '""'


def _write_compare(ws, lay: Layout, list_ranges: dict, data: DashboardData, scope: Scope) -> list:
    """The page's Compare tab: pick a comparison type; Tool / People
    comparison shows the picks as cards, a bar chart of the Chart metric and
    every metric side by side (★ the best); Generation / Credit comparison
    ranks one dimension's rows. Everything follows the sheet's own filters."""
    grid = Grid(scope.ren)
    _sheet_setup(ws)
    _sheet_head(grid, COMPARE, "Pick a comparison type in the yellow box. Tool / People comparison: pick up to 6 "
                               "(empty = the 4 busiest); ★ marks the best of each metric. Generation / Credit "
                               "comparison ranks every tool, person, team, client, day or month (up to 30 rows). "
                               "Every figure follows the filters above.")
    last_col = 2 + PICKS
    cols = [_col(3 + j) for j in range(PICKS)]

    # Controls
    ws.row_dimensions[RC_INPUT].height = 22
    controls = (("COMPARISON TYPE", "cMode", CMP_MODES[0], "lstCmpModes"),
                ("CHART", "cMetric", CMP_TOOL_METRICS[0][0],
                 'INDIRECT(IF(kCmpWho=2,"lstPeopleMetrics","lstToolMetrics"))'),
                ("SORT", "cSort", ENTITY_SORTS[0], 'INDIRECT(IF(kCmpSide=1,"lstEntitySorts","lstRankSorts"))'),
                ("BY", "cDim", CMP_DIMS[0][0], "lstDims"),
                ("HOW MANY", "cTop", "Top 10", "lstTop"))
    for k, (label, name, value, source) in enumerate(controls):
        c = 2 + k
        grid.put(RC_INPUT - 1, c, label, font=F_CAPTION, fill=FILL_PANEL, text=True)
        grid.put(RC_INPUT, c, value, fmt=DROPDOWN_FMT, font=F_INPUT, fill=FILL_INPUT, border=INPUT_BOX,
                 align=LEFT_MID, text=True)
        _name(ws.parent, name, _abs(COMPARE, _col(c), RC_INPUT))
        dv = DataValidation(type="list", formula1=source, allow_blank=False, showErrorMessage=True,
                            errorTitle="Pick from the list", error="Choose a value from the dropdown.")
        dv.add(f"{_col(c)}{RC_INPUT}")
        ws.data_validations.append(dv)
    grid.put(RC_INPUT - 1, 7, None, fill=FILL_PANEL)
    grid.put(RC_INPUT - 1, 8, None, fill=FILL_PANEL)
    grid.put(RC_INPUT, 7, '=IF(kCmpSide=1,"Chart and Sort apply here","By, Sort and How many apply here")',
             font=F_HELP, fill=FILL_PANEL, align=LEFT_MID)
    grid.put(RC_INPUT, 8, None, fill=FILL_PANEL)
    # a control the current type does not use is greyed, as the page hides it
    for rng, test in ((f"C{RC_INPUT - 1}:C{RC_INPUT}", "kCmpSide=0"),
                      (f"E{RC_INPUT - 1}:F{RC_INPUT}", "kCmpSide=1")):
        ws.conditional_formatting.add(rng, FormulaRule(formula=[test], font=Font(color="D1D5DB"), fill=_cf_fill(PANEL)))

    # Picks
    ws.row_dimensions[RC_PICK].height = 22
    grid.put(RC_PICK, 2, ('=IF(kCmpSide=0,"Picks (Tool / People comparison)",'
                          'IF(kCmpWho=1,"Tools to compare →","People to compare →"))'),
             font=F_CAPTION, fill=FILL_HEAD, align=LEFT_MID)
    for j, col in enumerate(cols):
        grid.put(RC_PICK, 3 + j, None, fmt=DROPDOWN_FMT, font=F_INPUT, fill=FILL_INPUT, border=INPUT_BOX,
                 align=LEFT_MID)
    _name(ws.parent, "cPick", f"'{COMPARE}'!$C${RC_PICK}:${cols[-1]}${RC_PICK}")
    dv = DataValidation(type="list", formula1='INDIRECT(IF(kCmpWho=2,"lstPeople","lstTools"))', allow_blank=True,
                        showErrorMessage=True, errorTitle="Pick from the list", error="Choose a value from the dropdown.")
    dv.add(f"C{RC_PICK}:{cols[-1]}{RC_PICK}")
    ws.data_validations.append(dv)
    ws.conditional_formatting.add(f"C{RC_PICK}:{cols[-1]}{RC_PICK}", FormulaRule(
        formula=["kCmpSide=0"], font=Font(color="D1D5DB"), fill=_cf_fill(PANEL)))

    # Cards: side by side, one per shown pick; rankings, the four stats
    name_row, value_row, label_row = RC_CARD + 1, RC_CARD + 2, RC_CARD + 3
    ws.row_dimensions[RC_CARD].height = 4
    ws.row_dimensions[value_row].height = 30
    stat_labels = ('"Total "&IF(kCmpMode=4,"credits","outputs")', '"Average"', '"Highest"', '"Lowest"')
    stat_values = ("kRkTotal", "kRkAvg", "kRkHigh", "kRkLow")
    stat_notes = (f'kRkCount&" "&LOWER(INDEX(lstDims,kCmpDim))',
                  f'"per "&CHOOSE(kCmpDim,{",".join(chr(34) + o + chr(34) for o in CMP_ONE)})',
                  "kRkHighName", "kRkLowName")
    grid.put(name_row, 2, ('=IF(AND(kCmpSide=1,INDEX(cd_name,1)=""),"Nothing to compare for this selection.",'
                           'IF(AND(kCmpSide=0,kRkCount=0),"No "&IF(kCmpMode=4,"credit usage","generations")'
                           '&" for this selection.",""))'), font=F_HELP)
    for j, col in enumerate(cols):
        s = j + 1
        nm = f"INDEX(cd_name,{s})"
        val = f"INDEX(cd_cv,{s})"
        v = {m: f"INDEX(cd_v{m},{s})" for m in (1, 2, 3)}
        side = {
            name_row: f'IF({nm}="","",{nm}&IF(AND(kCmpBestChart<>"",{val}=kCmpBestChart),"  ♛",""))',
            value_row: (f'IF({nm}="","",IF(kCmpStyle="inr",{_t_inr(val)},'
                        f'IF(kCmpStyle="pct",{_t_pct(val)},{_t_num(val)})))'),
            label_row: f'IF({nm}="","",INDEX(CHOOSE(kCmpWho,lstToolMetrics,lstPeopleMetrics),kCmpMetric))',
            RC_CARD + 4: f'IF({nm}="","","Outputs   "&{_t_num(v[1])})',
            RC_CARD + 5: f'IF({nm}="","","Credits   "&{_t_num(v[2])})',
            RC_CARD + 6: f'IF({nm}="","","Spend   "&{_t_inr(v[3])})',
            RC_CARD + 7: f'IF({nm}="","",IF(kCmpWho=1,"Top user   ","Top tool   ")&INDEX(cd_top,{s}))',
        }
        rank = {name_row: stat_labels[j] if j < 4 else '""',
                value_row: _t_num(stat_values[j]) if j < 4 else '""',
                label_row: stat_notes[j] if j < 4 else '""'}
        fonts = {name_row: Font(bold=True, color=INK), value_row: Font(size=18, bold=True, color=INK),
                 label_row: F_FOOT}
        for r in range(RC_CARD, RC_CARD + 9):
            border = Border(left=GAP, right=GAP)
            if r in side:
                formula = f'=IF(kCmpSide=1,{side[r]},IF(kRkCount=0,"",{rank.get(r, chr(34) * 2)}))'
                grid.put(r, 3 + j, formula, font=fonts.get(r, F_FOOT), align=LEFT_MID, border=border)
            else:
                grid.put(r, 3 + j, None, border=border)
        card = f"{col}{RC_CARD}:{col}{RC_CARD + 8}"
        ws.conditional_formatting.add(f"{col}{RC_CARD}", FormulaRule(
            formula=[f'${col}${name_row}<>""'], fill=_cf_fill(PALETTE[j])))
        ws.conditional_formatting.add(card, FormulaRule(formula=[f'${col}${name_row}<>""'],
                                                        fill=_cf_fill(_tint(PALETTE[j]))))

    # Chart title (the chart is added after the sheet is written)
    for c in range(2, last_col + 1):
        grid.put(RC_CHART, c, None, border=UNDERLINE)
    grid.put(RC_CHART, 2, ('=IF(kCmpSide=1,INDEX(CHOOSE(kCmpWho,lstToolMetrics,lstPeopleMetrics),kCmpMetric),'
                           'IF(kCmpMode=4,"Credits","Outputs")&" by "&LOWER(INDEX(lstDims,kCmpDim)))'),
             font=F_SECTION, border=UNDERLINE)

    # Table: every metric side by side, or the ranking
    ws.row_dimensions[RC_TABLE].height = 24
    one = ",".join(f'"{d[1]}"' for d in CMP_DIMS)
    grid.put(RC_TABLE, 2, f'=IF(kCmpSide=1,"Metric","#     "&CHOOSE(kCmpDim,{one}))', font=F_THEAD,
             fill=FILL_THEAD, align=LEFT_MID)
    rank_heads = ('IF(kCmpMode=4,"Credits","Outputs")', '"Share"', '"vs avg"',
                  'IF(kCmpMode=4,"Credits / output","Cost / output")')
    for j, col in enumerate(cols):
        head = rank_heads[j] if j < len(rank_heads) else '""'
        grid.put(RC_TABLE, 3 + j, f"=IF(kCmpSide=1,INDEX(cd_name,{j + 1}),{head})",
                 font=Font(bold=True, color=_tint(PALETTE[j], 0.75), size=10), fill=FILL_THEAD,
                 align=LEFT_MID if j else LEFT_MID)
    ws.conditional_formatting.add(f"C{RC_TABLE}:{cols[-1]}{RC_TABLE}", FormulaRule(   # ranking: plain headers
        formula=["kCmpSide=0"], font=Font(bold=True, color="FFFFFF")))
    body_first = RC_TABLE + 1
    body_last = body_first + 2 * RANK_ROWS - 1
    for k in range(RANK_ROWS):
        r, bar = body_first + 2 * k, body_first + 2 * k + 1
        ws.row_dimensions[r].height = 17
        ws.row_dimensions[bar].height = 7
        ro = f"INDEX(ro_name,{k + 1})"
        rank_label = f'IF({ro}="","",{k + 1}&"     "&{ro})'
        if k < CMP_METRICS:
            t = CMP_TOOL_METRICS[k] if k < len(CMP_TOOL_METRICS) else ("", "", None, "")
            p = CMP_PEOPLE_METRICS[k] if k < len(CMP_PEOPLE_METRICS) else ("", "", None, "")
            lower = "  (lower is better)"
            labels = [f'"{x[0]}{lower if x[3] == "lo" else ""}"' for x in (t, p)]
            side_label = f"CHOOSE(kCmpWho,{labels[0]},{labels[1]})"
        else:
            side_label = '""'
        grid.put(r, 2, f"=IF(kCmpSide=1,{side_label},{rank_label})", font=F_LABEL, align=LEFT_MID)
        for j, col in enumerate(cols):
            m = k + 1
            if k < CMP_METRICS:
                v = f"INDEX(cd_v{m},{j + 1})"
                text = f"IF(kCmpWho=1,{_styled(t[2], v)},{_styled(p[2], v)})"
                star = f'IF(AND(kCmpBest{m}<>"",{v}=kCmpBest{m})," ★","")'
                side_val = f'IF(INDEX(cd_name,{j + 1})="","",IF({v}="","",{text}&{star}))'
                side_bar = f'IF(N({v})>0,REPT("█",ROUND(N({v})/MAX(kCmpMax{m},1E-9)*{BAR_CHARS},0)),"")'
            else:
                side_val = side_bar = '""'
            rv = {0: _t_num(f"INDEX(ro_val,{k + 1})"), 1: _t_pct(f"INDEX(ro_share,{k + 1})"),
                  2: (f'IF(INDEX(ro_vs,{k + 1})>=0,"+","")&TEXT(ROUND(INDEX(ro_vs,{k + 1})*100,0),"0")&"%"'),
                  3: (f"IF(kCmpMode=4,{_t_num(f'INDEX(ro_per,{k + 1})')},{_t_inr(f'INDEX(ro_per,{k + 1})')})")}
            rank_val = f'IF({ro}="","",{rv[j]})' if j in rv else '""'
            rank_bar = (f'IF({ro}="","",REPT("█",ROUND(INDEX(ro_val,{k + 1})/MAX(kRkHigh,1E-9)*{BAR_CHARS},0)))'
                        if j == 0 else '""')
            grid.put(r, 3 + j, f"=IF(kCmpSide=1,{side_val},{rank_val})", align=LEFT_MID)
            grid.put(bar, 3 + j, f"=IF(kCmpSide=1,{side_bar},{rank_bar})",
                     font=Font(size=5, color=PALETTE[j]), align=Alignment(vertical="top"))
        if k < CMP_METRICS:     # the charted metric's row, as the page marks it
            ws.conditional_formatting.add(f"B{r}:{cols[-1]}{bar}", FormulaRule(
                formula=[f"AND(kCmpSide=1,kCmpMetric={k + 1})"], fill=_cf_fill("F0FDF4")))
    body = f"C{body_first}:{cols[-1]}{body_last}"
    ws.conditional_formatting.add(body, FormulaRule(formula=[f'RIGHT(C{body_first},1)="★"'],
                                                    font=Font(bold=True, color=GREEN_DARK)))
    ws.conditional_formatting.add(f"E{body_first}:E{body_last}", FormulaRule(
        formula=[f'AND(kCmpSide=0,LEFT(E{body_first},1)="+")'], font=Font(color=GREEN_DARK)))
    ws.conditional_formatting.add(f"E{body_first}:E{body_last}", FormulaRule(
        formula=[f'AND(kCmpSide=0,LEFT(E{body_first},1)="-")'], font=Font(color=RED)))
    ws.conditional_formatting.add(f"B{body_first + 1}:{cols[-1]}{body_last}", FormulaRule(
        formula=[f'AND(MOD(ROW(),2)=0,$B{body_first}<>"")'], border=Border(bottom=HAIR)))

    widths = {"A": 2, "B": 30, **{col: 22 for col in cols}, "I": 15, "J": 15, "K": 12}
    merges = _filter_bar(grid, ws, widths, scope)
    _widths(ws, widths)
    grid.flush(ws)
    _rename_rules(ws, scope.ren)
    return merges


def _add_compare_chart(ws, calc_ws, lay: Layout, sfx: str) -> None:
    """Horizontal bars of the Chart metric (or the ranking), as many as there
    are entities. Three series, one per number style, so each bar's label
    reads as the page's; a bar is 0 (hidden) in the other two."""
    cf = lay.blocks["cf"]
    chart = BarChart()
    chart.type = "bar"
    chart.grouping = "clustered"
    chart.overlap = 100
    chart.gapWidth = 110
    chart.legend = None
    chart.height, chart.width = 8.0, 17.0
    for key, name in (("inr", "cfInr"), ("num", "cfNum"), ("pct", "cfPct")):
        chart.add_data(Reference(calc_ws, min_col=cf.col(key), min_row=cf.first, max_row=cf.last))
        series = chart.series[-1]
        series.val.numRef.f = _chart_ref(name + sfx)
        series.cat = AxDataSource(strRef=StrRef(f=_chart_ref("cfNames" + sfx)))
        for i in range(RANK_ROWS):
            point = DataPoint(idx=i)
            point.graphicalProperties.solidFill = PALETTE[i % len(PALETTE)]
            series.dPt.append(point)
        series.dLbls = DataLabelList(showVal=True, showSerName=False, showCatName=False, showLegendKey=False,
                                     showPercent=False, dLblPos="outEnd")
    chart.x_axis.scaling.orientation = "maxMin"     # first entity on top
    chart.x_axis.delete = False
    chart.y_axis.delete = True
    chart.y_axis.majorGridlines = None
    _no_border(chart)
    ws.add_chart(chart, f"B{RC_CHART + 1}")


# Lists columns that formulas read by name (Compare's dropdowns switch list
# by mode through INDIRECT, which takes a name)
LIST_NAMES = {"cmp_mode": "lstCmpModes", "cmp_tool_m": "lstToolMetrics", "cmp_people_m": "lstPeopleMetrics",
              "cmp_esort": "lstEntitySorts", "cmp_rsort": "lstRankSorts", "cmp_dim": "lstDims", "cmp_top": "lstTop",
              "tools_only": "lstTools", "people_only": "lstPeople",
              "seat_person": "sPerson", "seat_tool": "sTool", "seat_acct": "sAcct"}


def _write_lists(wb, ws, lay: Layout, data: DashboardData) -> dict:
    """Dropdown values, one column each, then the seats (who is assigned
    which tool, on which login). Returns key -> range for validation."""
    everyone = sorted(set(data.all_people) | {p for p, _d in lay.people}, key=str.lower)
    seats = sorted(set(data.seats)) or [("", "", "")]
    columns = {
        "tool": [ALL_TOOLS] + list(lay.tools),
        "acct": [ALL_ACCOUNTS] + list(lay.accounts),
        "dept": [ALL_DEPTS] + list(lay.depts),
        "person": [EVERYONE] + everyone,
        "client": [ALL_CLIENTS] + list(lay.clients),
        "tool_m": list(TOOL_MEASURES),
        "dept_m": list(DEPT_MEASURES),
        "tools_only": list(lay.tools),
        "people_only": sorted({r.person for r in data.rows if r.person != UNASSIGNED}, key=str.lower) or ["—"],
        "cmp_mode": list(CMP_MODES),
        "cmp_tool_m": [m[0] for m in CMP_TOOL_METRICS],
        "cmp_people_m": [m[0] for m in CMP_PEOPLE_METRICS],
        "cmp_esort": list(ENTITY_SORTS),
        "cmp_rsort": list(RANK_SORTS),
        "cmp_dim": [d[0] for d in CMP_DIMS],
        "cmp_top": [t for t, _n in CMP_TOP],
        "seat_person": [s[0] for s in seats],
        "seat_tool": [s[1] for s in seats],
        "seat_acct": [s[2] for s in seats],
        "date": [data.start + timedelta(days=i) for i in range(data.days)],   # From / To dropdowns
    }
    ranges = {}
    for j, (key, values) in enumerate(columns.items()):
        ranges[key] = _abs(LISTS, _col(1 + j), 1, max(len(values), 1))
        if key in LIST_NAMES:
            _name(wb, LIST_NAMES[key], ranges[key])
    # Dropdowns that follow another filter, as on the page: Person lists the
    # picked department's people, Account the accounts used with the picked
    # tool. Each sheet's own pair of lists (its filters may differ when macros
    # are off): a counter column numbers the matching rows, a list column
    # reads them in order; the name is the list's filled part.
    dept_of = {p: d for p, d in lay.people}
    pairs_p = [(p, dept_of.get(p) or data.all_people.get(p) or "") for p in everyone] or [("", "")]
    pairs_a = sorted({(r.account, r.tool) for r in data.rows + data.prev_rows}, key=lambda x: (x[0].lower(), x[1]))
    pairs_a = pairs_a or [("", "")]
    static = {"dep_person": [p for p, _d in pairs_p], "dep_dept": [d for _p, d in pairs_p],
              "dep_acct": [a for a, _t in pairs_a], "dep_tool": [t for _a, t in pairs_a]}
    first = 1 + len(columns)
    letters = {key: _col(first + j) for j, key in enumerate(static)}
    for key, values in static.items():
        ranges[key] = _abs(LISTS, letters[key], 1, len(values))
    formulas = {}           # column letter -> row -> formula / value
    col = first + len(static)
    for sfx in dict.fromkeys(SCOPES.values()):
        for kind, n, all_value, pick, match in (
                ("person", len(pairs_p), EVERYONE, f"fDept{sfx}",
                 lambda r, f: f'OR({f}="{ALL_DEPTS}",{letters["dep_dept"]}{r}={f})'),
                ("acct", len(pairs_a), ALL_ACCOUNTS, f"fTool{sfx}",
                 lambda r, f: f'AND({f}<>"{ALL_TOOLS}",{letters["dep_tool"]}{r}={f})')):
            count, listed = _col(col), _col(col + 1)
            col += 2
            source = letters["dep_person" if kind == "person" else "dep_acct"]
            formulas[count] = {r: (f'=IF({match(r, pick)},{"1" if r == 1 else f"MAX({count}$1:{count}{r - 1})+1"},"")')
                               for r in range(1, n + 1)}
            formulas[listed] = {1: all_value}
            formulas[listed].update({k + 1: (f'=IFERROR(INDEX(${source}$1:${source}${n},'
                                             f'MATCH({k},${count}$1:${count}${n},0)),"")') for k in range(1, n + 1)})
            filled = (f"OFFSET('{LISTS}'!${listed}$1,0,0,1+MAX('{LISTS}'!${count}$1:${count}${n}),1)")
            name = f"lstDep{kind.capitalize()}{sfx}"
            if kind == "acct":       # every account while no tool is picked
                filled = f'IF({pick}="{ALL_TOOLS}",{ranges["acct"]},{filled})'
            _name(wb, name, filled)
            ranges[(kind, sfx)] = name
    height = max([len(v) for v in columns.values()] + [len(v) for v in static.values()]
                 + [max(rows) for rows in formulas.values()])
    for i in range(height):
        line = [(_cell(ws, v[i], fmt=DATE_FMT) if isinstance(v[i], date) else _cell(ws, v[i], text=True))
                if i < len(v) else None for v in columns.values()]
        line += [_cell(ws, v[i], text=True) if i < len(v) else None for v in static.values()]
        line += [rows.get(i + 1) for rows in formulas.values()]
        ws.append(line)
    return ranges


# Dashboard rows
R_CARD = 5            # accent strip; label, value, two footer lines below it
R_FILTER = 12         # filter inputs (labels on the row above)
R_DATE = 14           # From / To date inputs (labels on the row above, help below)
R_CHART_HEAD = 17     # chart titles; their totals and measure toggles on the next row
R_CHART = 19          # charts are anchored here
R_DONUT = 20          # the donut: a 4.8 cm square from F20, its centre at the F / G edge in row 24
R_DONUT_TOTAL = 23    # the total in the donut's hole (two rows), "outputs" below it
R_LEGEND = 21         # the donut's legend, beside it in H:I
DONUT_CM = 4.8


def _write_dashboard(ws, wb, data: DashboardData, lay: Layout, calc_ws, list_ranges: dict, initial: dict,
                     targets: dict) -> list:
    """Writes the Dashboard sheet; returns the ranges to merge after saving
    (write-only sheets cannot merge)."""
    grid = Grid()
    _sheet_setup(ws, tab_color=GREEN)
    grid.put(1, 2, "Usage & Spend", font=F_TITLE, align=LEFT_MID, text=True)
    grid.put(2, 2, "Who generated what, with which tool, for which client, and what it cost", font=F_SUB, text=True)
    grid.put(1, 10, f"{period_label(data.start, data.end)} · {data.days} days", font=F_SECTION, align=LEFT_MID,
             text=True)
    grid.put(2, 10, f"Data as of {data.generated_at.strftime('%d %b %Y, %H:%M')} IST", font=F_SUB, text=True)
    _nav(grid, 3, DASH)

    # KPI cards: an accent strip, label, value, two footer lines. Values are
    # text, so a big number spills across its card instead of "######".
    # Figures written as the page writes them (fmtINR / fmtNum); the last two
    # cards open the page's next step, as their links do there.
    cards = (
        ("TOTAL SPENT", f"={_t_inr('kTotal')}",
         '=IF(OR(kChange="—",kChange=""),"",kChange&" vs previous period")',
         f'="Usage "&{_t_inr("kPPU")}&" · Plans "&{_t_inr("kPlans")}'),
        ("AVERAGE SPEND", f'={_t_inr("kTotal/kDays")}&" / day"',
         f'={_t_inr("kTotal/kMonths")}&" / month · "&kDays&" days"', None),
        ("OUTPUTS GENERATED", f"={_t_num('kOutputs')}",
         f'={_t_num("kOutputs/kDays")}&" / day · "&{_t_inr("IF(kOutputs>0,kItem/kOutputs,0)")}&" each · "'
         f'&{_t_num("kCredits")}&" credits"',
         f"=HYPERLINK(\"#'{COMPARE}'!A1\",\"Compare generations →\")"),
        ("PEOPLE & TOOLS", '=kPeople&" people · "&kTools&" tools"',
         f'={_t_inr("IF(kPeople>0,kItem/kPeople,0)")}&" per person (avg)"',
         f"=HYPERLINK(\"#'{PEOPLE}'!A1\",\"Open people report →\")"),
    )
    ws.row_dimensions[R_CARD].height = 5
    ws.row_dimensions[R_CARD + 1].height = 20
    ws.row_dimensions[R_CARD + 2].height = 34
    for k, (label, value, foot1, foot2) in enumerate(cards):
        c0 = 2 + 3 * k
        fill, accent = CARD_FILLS[k], _fill(CARD_ACCENTS[k])
        for r in range(R_CARD, R_CARD + 5):
            for c in range(c0, c0 + 3):
                grid.put(r, c, None, fill=accent if r == R_CARD else fill,
                         border=Border(left=GAP) if c == c0 else None)
        grid.put(R_CARD + 1, c0, label, font=Font(size=9, bold=True, color=CARD_ACCENTS[k]), fill=fill,
                 border=Border(left=GAP), align=LEFT_MID, text=True)
        grid.put(R_CARD + 2, c0, value, font=F_KPI, fill=fill, border=Border(left=GAP), align=LEFT_MID)
        grid.put(R_CARD + 3, c0, foot1, font=F_CHANGE if k == 0 else F_FOOT, fill=fill, border=Border(left=GAP))
        if foot2:
            link = "HYPERLINK" in foot2
            grid.put(R_CARD + 4, c0, foot2, font=Font(size=9, bold=True, color=CARD_ACCENTS[k]) if link else F_FOOT,
                     fill=fill, border=Border(left=GAP))
    for formula, color in CHANGE_RULES:
        ws.conditional_formatting.add(f"B{R_CARD + 3}", FormulaRule(
            formula=[formula.format(c=f"B{R_CARD + 3}")], font=Font(size=9, bold=True, color=color)))

    # Filter panel: labels, yellow dropdowns, help line, on a light panel
    filters = (("TOOL", "fTool", "tool", initial.get("tool") or ALL_TOOLS),
               ("ACCOUNT", "fAcct", "acct", initial.get("account") or ALL_ACCOUNTS),
               ("DEPARTMENT", "fDept", "dept", initial.get("department") or ALL_DEPTS),
               ("PERSON", "fPerson", "person", initial.get("person") or EVERYONE),
               ("CLIENT / PROJECT", "fClient", "client", initial.get("client") or ALL_CLIENTS),
               ("SEARCH", "fSearch", None, initial.get("search") or None))
    merges = []
    for r in range(R_FILTER - 1, R_DATE + 2):
        for c in range(2, 14):
            grid.put(r, c, None, fill=FILL_PANEL)
    ws.row_dimensions[R_FILTER].height = 22
    for k, (label, name, list_key, value) in enumerate(filters):
        c = 2 + 2 * k
        grid.put(R_FILTER - 1, c, label, font=F_CAPTION, fill=FILL_PANEL, text=True)
        # One box = two cells merged (see merges), so Excel's own dropdown
        # arrow sits at the box's right edge. (No ▾ fill format: it turns a
        # name longer than the box into ####.)
        grid.put(R_FILTER, c, value, font=F_INPUT, fill=FILL_INPUT,
                 align=LEFT_MID, border=Border(left=INPUT_BOX.left, top=INPUT_BOX.top, bottom=INPUT_BOX.bottom),
                 text=value is not None)
        grid.put(R_FILTER, c + 1, None, fill=FILL_INPUT,
                 border=Border(right=INPUT_BOX.right, top=INPUT_BOX.top, bottom=INPUT_BOX.bottom))
        merges.append(f"{_col(c)}{R_FILTER}:{_col(c + 1)}{R_FILTER}")
        _name(wb, name, _abs(DASH, _col(c), R_FILTER))
        if list_key:
            dv = DataValidation(type="list", formula1=list_ranges.get((list_key, ""), list_ranges[list_key]),
                                allow_blank=False,
                                showErrorMessage=True, errorTitle="Pick from the list",
                                error="Choose a value from the dropdown.")
            dv.add(f"{_col(c)}{R_FILTER}")
            ws.data_validations.append(dv)
    # Date range inside the period: From / To boxes, then what is selected
    ws.row_dimensions[R_DATE].height = 22
    for k, (label, name, value) in enumerate((("FROM", "fFrom", data.start), ("TO", "fTo", data.end))):
        c = 2 + 2 * k
        grid.put(R_DATE - 1, c, label, font=F_CAPTION, fill=FILL_PANEL, text=True)
        grid.put(R_DATE, c, value, fmt=DATE_FMT, font=F_INPUT, fill=FILL_INPUT, align=LEFT_MID,
                 border=Border(left=INPUT_BOX.left, top=INPUT_BOX.top, bottom=INPUT_BOX.bottom))
        grid.put(R_DATE, c + 1, None, fill=FILL_INPUT,
                 border=Border(right=INPUT_BOX.right, top=INPUT_BOX.top, bottom=INPUT_BOX.bottom))
        merges.append(f"{_col(c)}{R_DATE}:{_col(c + 1)}{R_DATE}")
        _name(wb, name, _abs(DASH, _col(c), R_DATE))
        dv = _date_validation(list_ranges, data.start, data.end)
        dv.add(f"{_col(c)}{R_DATE}")
        ws.data_validations.append(dv)
    grid.put(R_DATE - 1, 6, "SELECTED", font=F_CAPTION, fill=FILL_PANEL, text=True)
    grid.put(R_DATE, 6, ('=IF(kDateAll=1,"Whole period · "&kDays&" days",'
                         'TEXT(kFrom,"d mmm")&" – "&TEXT(kTo,"d mmm yyyy")&" · "&kDays&" day"&IF(kDays=1,"","s")'
                         '&" · compared with the same days of the previous period")'),
             font=F_BOLD, fill=FILL_PANEL, align=LEFT_MID)
    grid.put(R_DATE + 1, 2, ("Click a yellow box and pick from its dropdown; pick “All …” (or clear Search) to reset. "
                             "Click From / To for a calendar (with macros on; else pick a day from the dropdown) to narrow the period; clear them for the whole period. "
                             "The cards and charts follow these filters; every other sheet has its own at its top. "
                             "Search narrows Activity and People."), font=F_HELP, fill=FILL_PANEL, text=True)

    # Chart headers, underlined, with totals and measure toggles
    for c in range(2, 14):
        grid.put(R_CHART_HEAD, c, None, border=UNDERLINE)
    grid.put(R_CHART_HEAD, 2, "Spend trend (daily)", font=F_SECTION, border=UNDERLINE, text=True)
    grid.put(R_CHART_HEAD, 6, "Usage by tool", font=F_SECTION, border=UNDERLINE, text=True)
    grid.put(R_CHART_HEAD, 10, '="Department-wise "&CHOOSE(mDeptIdx,"spend","outputs","credits")', font=F_SECTION,
             border=UNDERLINE)
    vr = R_CHART_HEAD + 1
    ws.row_dimensions[vr].height = 22
    grid.put(vr, 2, f"={_t_inr('kTotal')}", font=Font(size=14, bold=True, color=INK), align=LEFT_MID)
    grid.put(vr, 3, '=IF(OR(kChange="—",kChange=""),"",kChange)', font=F_CHANGE, align=RIGHT_MID)
    for formula, color in CHANGE_RULES:
        ws.conditional_formatting.add(f"C{vr}", FormulaRule(formula=[formula.format(c=f"C{vr}")],
                                                            font=Font(size=9, bold=True, color=color)))
    dept_total = "CHOOSE(mDeptIdx,kItem,kOutputs,kCredits)"
    grid.put(vr, 10, f"=IF(mDeptIdx=1,{_t_inr(dept_total)},{_t_num(dept_total)})",
             font=Font(size=14, bold=True, color=INK), align=LEFT_MID)
    grid.put(vr, 8, f"=HYPERLINK(\"#'{COMPARE}'!A1\",\"Compare →\")", font=F_XLINK, align=RIGHT_MID)
    for col, name, value, key in ((9, "mTool", TOOL_MEASURES[0], "tool_m"), (13, "mDept", DEPT_MEASURES[0], "dept_m")):
        grid.put(vr, col, value, fmt=DROPDOWN_FMT, font=F_INPUT, fill=FILL_INPUT, border=INPUT_BOX, align=LEFT_MID,
                 text=True)
        _name(wb, name, _abs(DASH, _col(col), vr))
        dv = DataValidation(type="list", formula1=list_ranges[key], allow_blank=False)
        dv.add(f"{_col(col)}{vr}")
        ws.data_validations.append(dv)

    # Usage by tool, as the page draws it: the total inside the donut (cells
    # behind the see-through chart's hole) and the legend beside it.
    total = "SUM(dn_value)"
    grid.put(R_DONUT_TOTAL, 6, f"=IF(mToolIdx=2,{_t_cinr(total)},{_t_num(total)})",
             font=Font(size=16, bold=True, color=INK), align=Alignment(horizontal="center", vertical="bottom"))
    grid.put(R_DONUT_TOTAL + 2, 6, '=CHOOSE(mToolIdx,"outputs","spent","credits")', font=F_FOOT,
             align=Alignment(horizontal="center", vertical="top"))
    merges.extend([f"F{R_DONUT_TOTAL}:G{R_DONUT_TOTAL + 1}", f"F{R_DONUT_TOTAL + 2}:G{R_DONUT_TOTAL + 2}"])
    for i in range(6):
        r = R_LEGEND + i
        tool = f"INDEX(dn_name,{i + 1})"         # the swatch shows the slice colour; the name links to Tools
        grid.put(r, 8, f'=IF({tool}="","",{_linked(tool, targets["tool"], label=_swatch(tool))})',
                 font=Font(color=PALETTE[i], bold=True), align=LEFT_MID)
        value = f"INDEX(dn_value,{i + 1})"
        grid.put(r, 9, (f'=IF({tool}="","",TEXT(INDEX(dn_pct,{i + 1}),"0%")&"      "&'
                        f'IF(mToolIdx=2,{_t_cinr(value)},{_t_num(value)}))'), font=F_LABEL, align=RIGHT_MID)

    _widths(ws, {"A": 2, **{_col(c): 13 for c in range(2, 14)}, "N": 2})
    grid.flush(ws)
    _add_charts(ws, calc_ws, lay)
    return merges


def _no_border(chart) -> None:
    chart.graphical_properties = GraphicalProperties(ln=LineProperties(noFill=True))


def _add_charts(ws, calc_ws, lay: Layout) -> None:
    dl, dn, dc = lay.blocks["dl"], lay.blocks["dn"], lay.blocks["dc"]
    anchor_row = R_CHART
    grid_line = GraphicalProperties(ln=LineProperties(solidFill=LINE))

    trend = AreaChart()
    trend.legend = None
    trend.height, trend.width = 8.2, 10.2
    trend.add_data(Reference(calc_ws, min_col=dl.col("spend"), min_row=dl.first - 1, max_row=dl.last),
                   titles_from_data=True)
    trend.set_categories(Reference(calc_ws, min_col=dl.col("label"), min_row=dl.first, max_row=dl.last))
    series = trend.series[0]
    series.graphicalProperties.solidFill = "A7F3D0"
    series.graphicalProperties.line.solidFill = PALETTE[0]
    series.graphicalProperties.line.width = 22000
    trend.y_axis.numFmt = '[>=1000]"₹"0.0,"K";"₹"0'      # the page's ₹20.0K ticks
    trend.y_axis.majorGridlines.spPr = grid_line
    trend.x_axis.tickLblSkip = max(1, len(lay.days) // 6)
    trend.x_axis.delete = False
    trend.y_axis.delete = False
    _no_border(trend)
    ws.add_chart(trend, f"B{anchor_row}")

    donut = DoughnutChart(holeSize=62)
    donut.height = donut.width = DONUT_CM
    donut.add_data(Reference(calc_ws, min_col=dn.col("value"), min_row=dn.first - 1, max_row=dn.last),
                   titles_from_data=True)
    donut.set_categories(Reference(calc_ws, min_col=dn.col("name"), min_row=dn.first, max_row=dn.last))
    for i in range(6):
        point = DataPoint(idx=i)
        point.graphicalProperties.solidFill = PALETTE[i]
        point.graphicalProperties.line.solidFill = "FFFFFF"
        donut.series[0].dPt.append(point)
    donut.legend = None          # the legend is the cells beside it, as on the page
    # see-through, so the total in the cells behind shows in the hole
    donut.graphical_properties = GraphicalProperties(noFill=True, ln=LineProperties(noFill=True))
    donut.plot_area.graphicalProperties = GraphicalProperties(noFill=True)
    ws.add_chart(donut, f"F{R_DONUT}")

    bars = BarChart()
    bars.type = "col"
    bars.legend = None
    bars.gapWidth = 180      # slim bars like the page's, even for one department
    bars.height, bars.width = 8.2, 10.2
    bars.add_data(Reference(calc_ws, min_col=dc.col("value"), min_row=dc.first - 1, max_row=dc.last),
                  titles_from_data=True)
    bars.set_categories(Reference(calc_ws, min_col=dc.col("name"), min_row=dc.first, max_row=dc.last))
    # only the departments there are: no empty bars (dcNames / dcValues follow the count)
    bars.series[0].val.numRef.f = _chart_ref("dcValues")
    bars.series[0].cat = AxDataSource(strRef=StrRef(f=_chart_ref("dcNames")))
    for i in range(6):
        point = DataPoint(idx=i)
        point.graphicalProperties.solidFill = PALETTE[i]
        bars.series[0].dPt.append(point)
    # Value only (Excel otherwise adds the series and category names), shown
    # as the rounded value the feed cells hold.
    bars.dataLabels = DataLabelList(showVal=True, showSerName=False, showCatName=False, showLegendKey=False,
                                    showPercent=False, numFmt="#,##0")
    bars.y_axis.delete = True
    bars.x_axis.delete = False
    bars.y_axis.majorGridlines = None
    _no_border(bars)
    ws.add_chart(bars, f"J{anchor_row}")


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #
def resolve_initial(data: DashboardData, *, tool: Optional[str] = None, account_ids=(),
                    department: Optional[str] = None, user_id: Optional[int] = None,
                    client: Optional[str] = None, search: Optional[str] = None) -> dict:
    """The page's current filters as the workbook's starting filter values.
    The Account dropdown is single-choice: several logins ticked start it
    at All accounts."""
    tools = {r.tool for r in data.rows + data.prev_rows} | set(data.plan_fee) | set(data.untracked)
    labels = {data.account_by_id[i] for i in account_ids if i in data.account_by_id}
    clients = {r.client for r in data.rows + data.prev_rows}
    return {
        "tool": tool if tool in tools else None,
        "account": labels.pop() if len(labels) == 1 else None,
        "department": department if department in set(data.people.values()) | set(data.all_people.values()) else None,
        "person": data.person_by_id.get(user_id) if user_id is not None else None,
        "client": client if client in clients else None,
        "search": (search or "").strip() or None,
    }


def write_dashboard_workbook(data: DashboardData, path: str, *, initial: Optional[dict] = None,
                             macros: bool = True) -> None:
    """macros: add the filter-sync macro; `path` must then end in .xlsm."""
    initial = initial or {}
    lay = _layout(data)
    wb = Workbook(write_only=True)
    calc_copies = tuple(CALC + sfx for sfx in SCOPES.values() if sfx)
    sheets = {name: wb.create_sheet(name)
              for name in (DASH,) + TABS + GROUP_TABS + (DATA, AGG, CALC, LISTS, GROUPS) + calc_copies}

    # Calc first: its names are what each sheet's copy renames
    before = set(wb.defined_names)
    calc = _build_calc(wb, data, lay)
    calc_names = [n for n in wb.defined_names if n not in before]
    rens = {sheet: _renamer(FILTER_NAMES + tuple(calc_names) + ("aMatch", "aFirst")
                            + tuple(name for name, _src in DATA_SCOPES.get(sheet, ())), sfx)
            for sheet, sfx in SCOPES.items()}
    calc.grid.flush(sheets[CALC])
    for sheet, sfx in SCOPES.items():
        if not sfx:
            continue
        copy = Grid(rens[sheet])
        copy.cells = calc.grid.cells
        copy.flush(sheets[CALC + sfx])
        for name in calc_names:
            ref = wb.defined_names[name].attr_text.replace(f"'{CALC}'!", f"'{CALC}{sfx}'!")
            _name(wb, name + sfx, rens[sheet](ref))
    _write_data(wb, sheets[DATA], data.rows, rens)
    group_rows = _write_groups(wb, sheets[GROUPS], data.rows, rens)
    _write_agg(wb, sheets[AGG], data.rows + data.prev_rows, rens)
    list_ranges = _write_lists(wb, sheets[LISTS], lay, data)
    scopes = {sheet: Scope(sheet, sfx, rens[sheet], list_ranges, data.start, data.end)
              for sheet, sfx in SCOPES.items()}

    n_activity = min(len(data.rows), ACTIVITY_ROWS)
    targets = _link_targets(lay, n_activity)
    merges = {DASH: _write_dashboard(sheets[DASH], wb, data, lay, sheets[CALC], list_ranges, initial, targets)}
    merges[ACTIVITY] = _write_activity(sheets[ACTIVITY], n_activity, targets, scopes[ACTIVITY])
    merges[PEOPLE] = _write_ranked_tab(sheets[PEOPLE], PEOPLE, "Everyone with at least one output, by spend. Search also narrows this list.",
                      "p_rank", len(lay.people), [
                          ("Person", "p_name", None, 24, "name", "act_person"), ("Department", "p_dept", None, 18, None, "dept"),
                          ("Tools used", "p_tools", None, 34), ("Top client", "p_topclient", None, 20, None, "client"),
                          ("Outputs", "p_out", COUNT_FMT, 10), ("Active days", "p_days", COUNT_FMT, 11),
                          ("Credits", "p_cred", CREDITS_FMT, 11), ("Spent", "p_spend", INR_FMT, 12, "bar"),
                          ("Per output", "p_perout", INR2_FMT, 11), ("Share", "p_share", PCT_FMT, 9, "share")], targets,
                      scopes[PEOPLE])
    merges[TOOLS] = _write_ranked_tab(sheets[TOOLS], TOOLS, "Tools by total spend. Plan fees not used by anyone count only "
                                            "while no filter is on. With a person picked, the tools assigned to "
                                            "them that they did not use are listed as Not used.",
                      "t_rank", len(lay.tools), [
                          ("Tool", "t_label", None, 24, "name", ("act_tool", "t_name")), ("Category", "t_cat", None, 18),
                          ("People", "t_people", COUNT_FMT, 8), ("Top user", "t_top", None, 22, None, "person"),
                          ("Outputs", "t_out", COUNT_FMT, 10), ("Credits", "t_cred", CREDITS_FMT, 11),
                          ("Usage", "t_usage", INR_FMT, 12), ("Plan fee", "t_fee", INR_FMT, 12),
                          ("Total", "t_total", INR_FMT, 12, "bar"), ("Per output", "t_perout", INR2_FMT, 11),
                          ("Share", "t_share", PCT_FMT, 9, "share")], targets, scopes[TOOLS],
                      extra=_tools_switch)
    merges[CLIENTS] = _write_ranked_tab(sheets[CLIENTS], CLIENTS, "Clients and projects by spend.", "c_rank", len(lay.clients), [
                          ("Client / Project", "c_name", None, 28, "name", "act_client"), ("People", "c_people", COUNT_FMT, 8),
                          ("Top user", "c_top", None, 22, None, "person"), ("Top tool", "c_toptool", None, 14, None, "tool"),
                          ("Outputs", "c_out", COUNT_FMT, 10), ("Credits", "c_cred", CREDITS_FMT, 11),
                          ("Spent", "c_spend", INR_FMT, 12, "bar"), ("Per output", "c_perout", INR2_FMT, 11),
                          ("Share", "c_share", PCT_FMT, 9, "share")], targets,
                      scopes[CLIENTS])
    merges[DAILY] = _write_ranked_tab(sheets[DAILY], DAILY, "Days with activity, newest first.", "dl_rank", len(lay.days), [
                          ("Date", "dl_date", DATE_FMT, 14, "name", "act_date"), ("People", "dl_people", COUNT_FMT, 8),
                          ("Outputs", "dl_out", COUNT_FMT, 10), ("Top tool", "dl_toptool", None, 14, None, "tool"),
                          ("Credits", "dl_cred", CREDITS_FMT, 11), ("Spent", "dl_spend", INR_FMT, 12, "scale"),
                          ("Per output", "dl_perout", INR2_FMT, 11)], targets,
                      scopes[DAILY])
    merges[MONTHLY] = _write_ranked_tab(sheets[MONTHLY], MONTHLY, "Months with activity, newest first.", "ml_rank", len(lay.months), [
                          ("Month", "ml_label", None, 12, "name"), ("Active days", "ml_days", COUNT_FMT, 11),
                          ("People", "ml_people", COUNT_FMT, 8), ("Outputs", "ml_out", COUNT_FMT, 10),
                          ("Top tool", "ml_toptool", None, 14, None, "tool"), ("Credits", "ml_cred", CREDITS_FMT, 11),
                          ("Spent", "ml_spend", INR_FMT, 12, "bar"), ("Per active day", "ml_perday", INR_FMT, 13)], targets,
                      scopes[MONTHLY])
    merges[DEPTS] = _write_ranked_tab(sheets[DEPTS], DEPTS, "Departments by spend.", "d_rank", len(lay.depts), [
                          ("Department", "d_name", None, 22, "name", ("person", "d_top")), ("People", "d_people", COUNT_FMT, 8),
                          ("Top user", "d_top", None, 22, None, "person"), ("Top tool", "d_toptool", None, 14, None, "tool"),
                          ("Outputs", "d_out", COUNT_FMT, 10), ("Credits", "d_cred", CREDITS_FMT, 11),
                          ("Spent", "d_spend", INR_FMT, 12, "bar"), ("Per person", "d_perperson", INR_FMT, 12),
                          ("Share", "d_share", PCT_FMT, 9, "share")], targets,
                      scopes[DEPTS])
    merges[COMPARE] = _write_compare(sheets[COMPARE], lay, list_ranges, data, scopes[COMPARE])
    _add_compare_chart(sheets[COMPARE], sheets[CALC + SCOPES[COMPARE]], lay, SCOPES[COMPARE])
    for grouping in GROUPINGS:
        merges[grouping[0]] = _write_group_activity(sheets[grouping[0]], grouping, group_rows[grouping[0]],
                                                    targets, scopes[grouping[0]])

    for name in (DATA, AGG, CALC, LISTS, GROUPS) + calc_copies:
        sheets[name].sheet_state = "hidden"
    wb.calculation.fullCalcOnLoad = True
    wb.save(path)
    apply_style_flags(path)
    for name, refs in merges.items():
        apply_merges(path, name, refs)
    if macros:
        add_vba_project(path, (VBA_DIR / "vbaProject.bin").read_bytes())


def generate_dashboard_workbook(db: Session, filters: ReportFilters, path: str, *, dashboard_url: str = "",
                                selection: Optional[dict] = None) -> None:
    """`filters`: the period and the test-account setting only. `selection`:
    the page's current filters (resolve_initial's keywords), which become the
    workbook's starting filter values."""
    data = collect(db, filters, dashboard_url=dashboard_url)
    write_dashboard_workbook(data, path, initial=resolve_initial(data, **(selection or {})))
