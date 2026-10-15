"""
Credit Consumption Report - the management sheets.

    Summary          one printable A4 landscape page: headline cards, key
                     points, four small charts, needs attention, how to read
    Team & Clients   departments, top 10 people, top 10 clients, tools,
                     subscriptions (1-2 printed pages)
    Glossary         every term in one plain sentence
    Details          (full version only) a divider listing the detail sheets

All figures come from management.ManagementView (rupees; see costing.py).
Written for someone who has never seen the dashboard: no internal terms,
whole rupees in Indian grouping (₹1,09,095), whole percentages, and every
estimate marked "est.".

Navigation follows the workbook's link rules (tests/credit_report_smoke.py):
row 1 holds the way back ("⬅ Back to ..."), row 2 the sheet's name and "↓"
jumps to its sections; each section's title row has a "⬅" cell (column N)
that returns to its jump. The printed page starts at row 3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import Cell
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.comments import Comment
from openpyxl.drawing.line import LineProperties
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import PageSetupProperties

from .facts import NO_CLIENT, UNASSIGNED, UNASSIGNED_USER_ID
from .management import (LOW_USE, NO_FEE, NOT_USED, RENEWAL_PASSED, ManagementView, change_text, inr, pct)

OTHER_AI_LINE = "Other AI subscriptions (usage not tracked)"
# Team & Clients columns A-L: names, departments / accounts, then figures; G holds clients and tools.
TEAM_WIDTHS = (24, 21, 13, 12, 13, 15, 22, 13, 12, 12, 12, 12)

SUMMARY = "Summary"
TEAM = "Team & Clients"
GLOSSARY = "Glossary"
DETAILS = "Details"
CHART_DATA = "Chart data"
MANAGEMENT_SHEETS = (SUMMARY, TEAM, GLOSSARY)

# Neutral navy / grey theme: swap these for the company colours.
THEME = {
    "primary": "1F3864",      # headings, bars, current period line
    "accent": "2F5597",       # card values
    "muted": "595959",        # secondary text
    "faint": "BFBFBF",        # previous period line, rules
    "panel": "EEF2F8",        # card background
    "header_text": "FFFFFF",
    "warn": "FCE4D6",         # needs-attention rows
    "logo_border": "A6A6A6",
}
LOGO_TEXT = "[Company logo]"

NCOLS = 12                    # printed width: A..L
COL_WIDTH = 12.5
BACK_COL = "N"                # section back cells sit right of the printed area
BODY = 11
INR_FMT = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"#,##0'
COUNT_FMT = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;#,##0'
PCT_FMT = "0%"
DATE_FMT = "dd mmm yyyy"


def _font(size=BODY, bold=False, italic=False, color=None, underline=None):
    return Font(name="Calibri", size=size, bold=bold, italic=italic, color=color or "000000", underline=underline)


F_TITLE = _font(22, bold=True, color=THEME["primary"])
F_SUB = _font(BODY, italic=True, color=THEME["muted"])
F_SECTION = _font(14, bold=True, color=THEME["primary"])
F_CARD_LABEL = _font(BODY, bold=True, color=THEME["muted"])
F_CARD_VALUE = _font(24, bold=True, color=THEME["accent"])
F_BODY = _font(BODY)
F_BOLD = _font(BODY, bold=True)
F_SMALL = _font(BODY, color=THEME["muted"])
F_HEADER = _font(BODY, bold=True, color=THEME["header_text"])
F_LINK = _font(BODY, color="0563C1", underline="single")
F_BACK = _font(9, color="7F7F7F", underline="single")
F_TAG = _font(9, bold=True, color=THEME["header_text"])
FILL_PANEL = PatternFill("solid", fgColor=THEME["panel"])
FILL_HEADER = PatternFill("solid", fgColor=THEME["primary"])
FILL_WARN = PatternFill("solid", fgColor=THEME["warn"])
FILL_BACK = PatternFill("solid", fgColor="F2F2F2")
WRAP = Alignment(wrap_text=True, vertical="top", indent=1)
CARD_VALUE = Alignment(horizontal="left", vertical="center", indent=1)
CENTER = Alignment(horizontal="center", vertical="center")
RULE = Border(top=Side(style="thin", color=THEME["faint"]))

# Plain-sentence glossary; the same text is the note on matching headers.
GLOSSARY_TERMS = (
    ("₹ cost / Spend", "What the company paid for the use, in rupees. Pay-per-use tools: credits × the rupee rate "
                       "of the account. Subscriptions: the monthly fee for the period, shared across what was made."),
    ("Total spend", "Pay-per-use cost, plus the subscription fees for the period (used or not), plus other AI "
                    "subscriptions. Fees still to confirm are left out."),
    ("Pay-per-use", "Tools bought as credit packs (Kling, HeyGen, Splice): the cost follows the credits used."),
    ("Subscription", "Tools with a fixed monthly fee (Freepik, ElevenLabs, Higgsfield, Suno, Envato, Epidemic Sound): "
                     "the fee is the same however much they are used."),
    ("Paid, not used", "The part of a subscription fee for this period that no generated item used."),
    ("Other AI subscriptions", "AI tools the company pays for whose usage the dashboard does not record (ChatGPT, "
                               "Claude, Canva, Grammarly, Enhancor): their fees are in total spend but not in cost per item."),
    ("To confirm", "A fee being checked with accounts: a renewal date that has passed (its unused fee is left out "
                   "of the totals until confirmed still billed) or a fee that may be monthly or annual."),
    ("Item generated", "One image, video, voice clip or song made with an AI tool and charged by it."),
    ("Credit / Credits used", "Each tool's own unit of use. A Kling credit is not a Freepik credit, so credits are "
                              "never added across tools: compare tools in ₹."),
    ("Charged", "The tool finished the item and took its cost. Only charged items count in totals."),
    ("Pending", "Still being made when the report was produced; not counted yet."),
    ("est.", "An estimate: the tool records no per-item cost (shared equally), the account has no rate of its own "
             "(its tool's rate is used), or the cost is worked out from the text length."),
    ("Rate assumed", "A pay-per-use account with no rupee rate of its own, costed at its tool's latest rate."),
    ("Cost not tracked", "The tool records no cost per item (Higgsfield, Suno, Flow): each item gets an equal "
                         "share of the subscription, marked est."),
    ("Free preview model", "An ElevenLabs preview model that is not charged: ₹0."),
    ("Unknown user (imported history)", "Items found later in a tool's history, with nobody recorded as making them."),
    ("No client", "Items where nobody picked a client when generating."),
    ("Internal (RMW)", "Work for our own company rather than a client."),
    ("Kling job recorded twice", "One Kling job saved twice by the dashboard; counted once in every total."),
    ("Possible double charge", "Two charges for the same output within seconds: worth raising with the vendor."),
)
_TERM = dict(GLOSSARY_TERMS)
NOTES = {
    "Spend (₹)": _TERM["₹ cost / Spend"], "₹ in period": "The monthly fee pro-rated to this period by days.",
    "Items generated": _TERM["Item generated"], "est.": _TERM["est."],
    "Cost per item (₹)": "Spend on the tool, including subscription fees paid but not used, divided by the items made with it.",
    "₹ per item": "The period's fee divided by the items made with the account.",
    "Status": "In use · Low use (over the per-item limit) · Not used · Renewal date passed — check fee · "
              "Fee not entered.",
    "Change": "Compared with the previous period of the same length.",
}


def _note(text: str):
    c = Comment(text, "AI tools report")
    c.width, c.height = 260, 90
    return c


# --------------------------------------------------------------------------- #
# A page: cells, heights and merges collected first, written in row order
# --------------------------------------------------------------------------- #
@dataclass
class Page:
    ws: object
    cells: dict = field(default_factory=dict)       # (row, col) -> WriteOnlyCell
    heights: dict = field(default_factory=dict)
    last_row: int = 0

    def cell(self, value=None, *, font=F_BODY, fmt=None, fill=None, align=None, border=None, note=None):
        c = WriteOnlyCell(self.ws, value=value)
        c.font = font
        if fmt:
            c.number_format = fmt
        if fill:
            c.fill = fill
        if align is None and value is not None:
            # A one-character gap on each side, so a right-aligned number never
            # runs into the text of the next column ("51% new").
            numeric = isinstance(value, (int, float, date)) and not isinstance(value, bool)
            align = Alignment(horizontal="right" if numeric else "left", indent=1, vertical="center")
        if align:
            c.alignment = align
        if border:
            c.border = border
        if note:
            c.comment = _note(note)
        if isinstance(value, str) and value.startswith("="):
            c.data_type = "s"
        return c

    def put(self, row: int, col, value=None, **kw):
        col = col if isinstance(col, int) else _col(col)
        c = value if isinstance(value, Cell) else self.cell(value, **kw)
        self.cells[(row, col)] = c
        self.last_row = max(self.last_row, row)
        return c

    def link(self, row: int, col, target_sheet: str, target_cell: str, label: str, font=F_LINK, fill=None):
        target = f"#'{target_sheet}'!{target_cell}"
        formula = f'=HYPERLINK("{target}","{label.replace(chr(34), chr(34) * 2)}")'
        c = WriteOnlyCell(self.ws, value=formula)
        c.font = font
        if fill:
            c.fill = fill
        self.cells[(row, col if isinstance(col, int) else _col(col))] = c
        self.last_row = max(self.last_row, row)
        return c

    def merge(self, row: int, first, last, text, *, font=F_BODY, fill=None, height=None, wrap=True, border=None,
              fmt=None, note=None, align=None):
        self.put(row, first, text, font=font, fill=fill, align=align or (WRAP if wrap else None), border=border,
                 fmt=fmt, note=note)
        a, b = _col(first) if isinstance(first, str) else first, _col(last) if isinstance(last, str) else last
        for col in range(a + 1, b + 1):
            self.put(row, col, None, fill=fill, border=border)
        self.ws.merged_cells.add(f"{get_column_letter(a)}{row}:{get_column_letter(b)}{row}")
        if height:
            self.heights[row] = height

    def flush(self) -> None:
        for row in range(1, self.last_row + 1):
            if row in self.heights:
                self.ws.row_dimensions[row].height = self.heights[row]
            cols = [c for (r, c) in self.cells if r == row]
            if not cols:
                self.ws.append([])
                continue
            line = [None] * max(cols)
            for col in cols:
                line[col - 1] = self.cells[(row, col)]
            self.ws.append(line)


def _col(letter: str) -> int:
    n = 0
    for ch in letter:
        n = n * 26 + ord(ch) - 64
    return n


def _lines(text: str, cols: int, size: int = BODY) -> int:
    chars = int(cols * COL_WIDTH * 11 / size * 1.2)
    return max(1, -(-len(text) // max(chars, 1)))


def _setup(ws, *, landscape=True, fit_height=1, last_row=60, title_rows=None, widths=None):
    for i in range(1, NCOLS + 1):
        ws.column_dimensions[get_column_letter(i)].width = COL_WIDTH
    ws.column_dimensions["A"].width = 17                # names: "Internal (RMW)", "Subscriptions paid, not used"
    for i, width in enumerate(widths or (), start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.column_dimensions["M"].width = 3
    ws.column_dimensions[BACK_COL].width = 16
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A3"                      # the way back and the jumps stay in view
    ws.page_setup.orientation = "landscape" if landscape else "portrait"
    ws.page_setup.paperSize = 9                      # A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = fit_height
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    ws.print_options.gridLines = False
    ws.print_options.horizontalCentered = True
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top = ws.page_margins.bottom = 0.45
    ws.print_area = f"A3:{get_column_letter(NCOLS)}{last_row}"
    if title_rows:
        ws.print_title_rows = title_rows


def _top_rows(p: Page, sheet: str, back_to: Optional[tuple], jumps: list):
    """Row 1: the way back. Row 2: the sheet's name and its section jumps."""
    if back_to:
        target_sheet, target_cell, label = back_to
        p.link(1, 1, target_sheet, target_cell, label, font=F_BACK, fill=FILL_BACK)
    else:
        p.put(1, 1, "AI tools report", font=F_SMALL)
    p.put(2, 1, sheet, font=F_TAG, fill=FILL_HEADER)
    for i, (label, row) in enumerate(jumps, start=2):
        p.link(2, i, sheet, f"A{row}", f"↓ {label}", font=F_BACK)


def _section(p: Page, row: int, sheet: str, title: str, jumped: bool = True, col=1):
    p.put(row, col, title, font=F_SECTION)
    p.heights[row] = 22
    if jumped:
        p.link(row, BACK_COL, sheet, "A2", f"⬅ {sheet}", font=F_BACK, fill=FILL_BACK)


def _header(p: Page, row: int, labels: list, notes: bool = True):
    for i, label in enumerate(labels, start=1):
        p.put(row, i, label, font=F_HEADER, fill=FILL_HEADER, align=Alignment(wrap_text=True, vertical="center"),
              note=NOTES.get(label) if notes else None)
    p.heights[row] = 30


def _est_note(rupees: float, est: float) -> str:
    if rupees <= 0 or est <= 0:
        return ""
    share = pct(est, rupees)
    return "est." if share >= 99 else f"est. {max(share, 1)}%"


def _idle_note(s, cur) -> str:
    """Why a used-looking account counts as not used: only excluded test / admin use."""
    if s.last_used and cur.start <= s.last_used <= cur.end:
        return " (only test / admin use)"
    return " (paid, not used)"


def _to_confirm_text(cur) -> str:
    """The Summary's "To confirm" line: fees being checked with the accounts team."""
    subs = cur.subscriptions + cur.other_subscriptions
    held = [s for s in subs if s.to_confirm]
    used = [s for s in subs if s.status == RENEWAL_PASSED and not s.to_confirm]
    freq = [s for s in subs if s.frequency_unconfirmed]
    parts = []
    if held:
        parts.append(f"{inr(sum(s.to_confirm for s in held))} left out of the totals until confirmed still billed "
                     "(renewal date passed): " + ", ".join(f"{s.label} {inr(s.to_confirm)}" for s in held))
    if used:
        parts.append("renewal date passed but used in this period, so counted: " + ", ".join(s.label for s in used))
    if freq:
        parts.append("fee frequency unconfirmed, counted as monthly: "
                     + ", ".join(f"{s.label} {inr(s.period_fee)}" for s in freq))
    return ("To confirm — " + "; ".join(parts) + ".") if parts else ""


def _per_item(value: Optional[float]) -> str:
    if value is None:
        return "—"
    return f"₹{value:,.2f}" if value < 100 else inr(value)


# --------------------------------------------------------------------------- #
# Chart data (hidden sheet)
# --------------------------------------------------------------------------- #
@dataclass
class ChartBlock:
    first: int                       # first data row
    count: int
    largest: float = 0.0             # biggest value (leaves room for its label)


def _top_n(items: list, n: int, others_label: str) -> list:
    """[(name, ₹)] largest first, the tail folded into one 'Others' bar."""
    items = sorted(items, key=lambda kv: (-kv[1], kv[0]))
    if len(items) <= n + 1:
        return items
    rest = items[n:]
    return items[:n] + [(f"{others_label} ({len(rest)})", sum(v for _k, v in rest))]


CHART_LABEL_FMT = INR_FMT


def _write_chart_data(ws, v: ManagementView) -> dict:
    """Each chart's rows on the hidden sheet: a title row, then name | ₹.
    Values carry the ₹ format, so the bars' labels (linked to the cells) show it."""
    from datetime import timedelta

    cur, prev = v.cur, v.prev
    blocks = {}
    written = [0]

    def put(values):
        cells = []
        for i, value in enumerate(values):
            c = WriteOnlyCell(ws, value=value)
            if i and isinstance(value, (int, float)):
                c.number_format = CHART_LABEL_FMT
            cells.append(c)
        ws.append(cells)
        written[0] += 1
        return written[0]

    def series(key, title, items):
        put([title, "₹"])
        first = written[0] + 1
        for name, value in items:
            put([name, round(value)])
        blocks[key] = ChartBlock(first, len(items), max((round(x) for _n, x in items), default=0))

    depts = [(d, a.rupees) for d, a in cur.by_dept.items() if a.rupees > 0]
    series("dept", "Spend by department", _top_n(depts, 7, "Others"))
    clients = [(c, a.rupees) for c, a in cur.by_client.items() if a.rupees > 0]
    series("client", "Spend by client", _top_n(clients, 8, "Others"))
    series("tool", "Spend by tool", [(t, cur.tool_spend(t)) for t in cur.tools if cur.tool_spend(t) > 0])
    header = put(["Day", cur.label, prev.label])
    for i in range(cur.days):
        day = cur.start + timedelta(days=i)
        pday = prev.start + timedelta(days=i)
        put([f"{day.day} {day:%b}", round(cur.by_day.get(day, 0.0)),
             round(prev.by_day.get(pday, 0.0)) if i < prev.days else None])
    blocks["daily"] = ChartBlock(header + 1, cur.days)
    return blocks


def _axes(chart):
    for axis in (chart.x_axis, chart.y_axis):
        axis.delete = False
    chart.y_axis.majorGridlines = None


def _bar(data_ws, block: ChartBlock, title: str, width: float, height: float):
    chart = BarChart()
    chart.type = "bar"
    chart.style = 10
    chart.title = title
    chart.legend = None
    chart.width, chart.height = width, height
    chart.gapWidth = 50
    chart.add_data(Reference(data_ws, min_col=2, min_row=block.first, max_row=block.first + block.count - 1),
                   titles_from_data=False)
    chart.set_categories(Reference(data_ws, min_col=1, min_row=block.first, max_row=block.first + block.count - 1))
    chart.x_axis.scaling.orientation = "maxMin"          # largest at the top
    chart.y_axis.numFmt = INR_FMT
    _axes(chart)
    chart.y_axis.delete = True                            # values are labelled on the bars
    if block.largest:
        chart.y_axis.scaling.min = 0
        chart.y_axis.scaling.max = block.largest * 1.35   # room for the largest bar's label
    series = chart.series[0]
    series.graphicalProperties = GraphicalProperties(solidFill=THEME["primary"])
    series.dLbls = DataLabelList()
    series.dLbls.showVal = True
    series.dLbls.showSerName = series.dLbls.showCatName = series.dLbls.showLegendKey = False
    series.dLbls.position = "outEnd"
    return chart


def _daily(data_ws, block: ChartBlock, title: str, width: float, height: float):
    chart = LineChart()
    chart.title = title
    chart.style = 12
    chart.width, chart.height = width, height
    first, last = block.first, block.first + block.count - 1
    chart.add_data(Reference(data_ws, min_col=2, max_col=3, min_row=first - 1, max_row=last), titles_from_data=True)
    chart.set_categories(Reference(data_ws, min_col=1, min_row=first, max_row=last))
    chart.y_axis.numFmt = INR_FMT
    chart.y_axis.title = "₹ per day"
    _axes(chart)
    chart.legend.position = "b"
    cur, prev = chart.series
    cur.graphicalProperties.line = LineProperties(solidFill=THEME["primary"], w=28575)
    cur.smooth = False
    prev.graphicalProperties.line = LineProperties(solidFill=THEME["faint"], w=15875, prstDash="dash")
    prev.smooth = False
    return chart


# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #
@dataclass
class SummaryRows:
    key_points: int = 15
    charts: int = 25
    attention: int = 15
    how: int = 40


def write_summary(ws, data_ws, v: ManagementView, *, back_to=None, with_details: bool = True) -> None:
    p = Page(ws)
    cur, prev = v.cur, v.prev
    rows = SummaryRows()
    # ---- title --------------------------------------------------------------
    p.put(3, 1, v.title, font=F_TITLE)
    p.heights[3] = 34
    p.merge(3, "K", "L", LOGO_TEXT, font=F_SMALL, wrap=False,
            border=Border(*(Side(style="dashed", color=THEME["logo_border"]),) * 4))
    who = "test & admin accounts left out" if v.excluded_names else "all accounts included"
    p.put(4, 1, f"Prepared {v.generated_at.day} {v.generated_at:%b %Y} from the dashboard · compared with "
                f"{prev.label} · {who}", font=F_SUB)
    p.heights[5] = 8

    # ---- cards ---------------------------------------------------------------
    total, total_prev = cur.total_spend, prev.total_spend
    cards = (("A", "D", "TOTAL SPEND"), ("E", "F", "ITEMS GENERATED"), ("G", "H", "PEOPLE USING AI TOOLS"),
             ("I", "L", "COST PER ITEM, BY TOOL"))
    for first, last, label in cards:
        for col in range(_col(first), _col(last) + 1):
            for r in range(6, 13):
                p.put(r, col, None, fill=FILL_PANEL)
        p.put(6, first, label, font=F_CARD_LABEL, fill=FILL_PANEL)
    p.heights[7] = 34
    p.merge(7, "A", "D", round(total), font=F_CARD_VALUE, fmt=INR_FMT, fill=FILL_PANEL, align=CARD_VALUE,
            note="Pay-per-use cost, plus the subscription fees for the period (used or not), plus other AI "
                 "subscriptions whose usage is not tracked. Fees still to confirm are left out.")
    p.put(8, "A", f"{change_text(total, total_prev)} vs {prev.label} ({inr(total_prev)})", font=F_SMALL, fill=FILL_PANEL)
    p.put(9, "A", f"Pay-per-use {inr(cur.pay_per_use)} · Subscriptions {inr(cur.subscription_total)}", font=F_BODY,
          fill=FILL_PANEL)
    p.put(10, "A", f"{OTHER_AI_LINE}: {inr(cur.other_total)}", font=F_BODY,
          fill=FILL_PANEL)
    est_share = pct(cur.estimated, total)
    p.put(11, "A", f"Estimated (est.): {est_share}% ({inr(cur.estimated)}) · exact: {100 - est_share}%"
          if total else "No spend in this period", font=F_BOLD if est_share >= 25 else F_BODY, fill=FILL_PANEL)
    budget = v.total_budget
    p.put(12, "A", f"Budget {inr(budget)}: {pct(total, budget)}% used" if budget else "No budget set",
          font=F_SMALL, fill=FILL_PANEL)

    items, items_prev = cur.total.items, prev.total.items
    p.merge(7, "E", "F", items, font=F_CARD_VALUE, fmt=COUNT_FMT, fill=FILL_PANEL, align=CARD_VALUE)
    p.put(8, "E", f"{change_text(items, items_prev)} vs before", font=F_SMALL, fill=FILL_PANEL)
    people, people_prev = len(cur.total.users), len(prev.total.users)
    p.merge(7, "G", "H", people, font=F_CARD_VALUE, fmt=COUNT_FMT, fill=FILL_PANEL, align=CARD_VALUE)
    diff = people - people_prev
    p.put(8, "G", (f"{'▲' if diff > 0 else '▼'} {abs(diff)} {'person' if abs(diff) == 1 else 'people'} vs before"
                   if diff else "— same as before"), font=F_SMALL, fill=FILL_PANEL)

    per_tool = [(t, cur.cost_per_item(t)) for t in cur.tools if cur.by_tool.get(t) and cur.by_tool[t].items]
    for i, (tool, value) in enumerate(per_tool[:6]):
        a = cur.by_tool[tool]
        mark = " est." if a.rupees and a.est / a.rupees >= 0.5 else ""
        p.put(7 + i, "I", f"{tool}: {_per_item(value)}{mark}", font=F_BOLD if i == 0 else F_BODY, fill=FILL_PANEL)
    if not per_tool:
        p.put(7, "I", "—", fill=FILL_PANEL)

    split = v.split()
    p.put(13, "A", f"Client work {inr(split['client'])} · Internal {inr(split['internal'])} · "
                   f"No client {inr(split['no_client'])} · Paid, not used {inr(split['not_used'])}", font=F_BODY)
    flag_row = 14
    if cur.accounts_without_rate:
        accounts = ", ".join(f"{t} #{a}" if a is not None else f"{t} (no account)" for t, a in cur.accounts_without_rate)
        has = "has no rupee rate of its own" if len(cur.accounts_without_rate) == 1 else \
            "have no rupee rate of their own"
        p.put(flag_row, "A", f"Rate assumed (est.): {accounts} {has}, so the tool's latest rate is used until one is "
                             "entered in Reports → Credit Rates.", font=F_SMALL)
    confirm = _to_confirm_text(cur)
    if confirm:
        p.merge(15, "A", "L", confirm, font=F_BOLD, fill=FILL_WARN, height=15.5 * _lines(confirm, NCOLS))

    # ---- key points, then needs attention (full width, one line each) --------
    rows.key_points = 17
    _section(p, rows.key_points, SUMMARY, "Key points")
    r = rows.key_points + 1
    for text in [f"• {k}" for k in v.key_points] or ["Nothing stands out in this period."]:
        p.merge(r, "A", "L", text, height=15.5 * _lines(text, NCOLS))
        r += 1
    rows.attention = r + 1
    _section(p, rows.attention, SUMMARY, "Needs attention")
    r = rows.attention + 1
    for i, item in enumerate(v.attention, start=1):
        text = f"{i}. {item.sentence}"
        p.merge(r, "A", "L", text, fill=FILL_WARN, height=15.5 * _lines(text, NCOLS))
        r += 1
    if not v.attention:
        p.merge(r, "A", "L", "Nothing needs attention in this period.")
        r += 1

    # ---- charts --------------------------------------------------------------
    rows.charts = r + 1
    _section(p, rows.charts, SUMMARY, "Where the money went (₹)")
    blocks = _write_chart_data(data_ws, v)
    w_cm, h_cm = 7.4, 6.4
    anchors = ("A", "D", "G", "J")
    chart_row = rows.charts + 1
    if blocks["dept"].count:
        ws.add_chart(_bar(data_ws, blocks["dept"], "By department", w_cm, h_cm), f"{anchors[0]}{chart_row}")
    if blocks["client"].count:
        ws.add_chart(_bar(data_ws, blocks["client"], "By client (top 8)", w_cm, h_cm), f"{anchors[1]}{chart_row}")
    if blocks["tool"].count:
        ws.add_chart(_bar(data_ws, blocks["tool"], "By tool", w_cm, h_cm), f"{anchors[2]}{chart_row}")
    if blocks["daily"].count:
        ws.add_chart(_daily(data_ws, blocks["daily"], "Per day vs before", w_cm, h_cm),
                     f"{anchors[3]}{chart_row}")
    chart_rows = 13                                 # 6.6 cm of 15-point rows
    p.put(chart_row + chart_rows, "A", "Bars and lines show spend on generated items; est. = estimate. "
                                       "Tool bars include subscription fees paid but not used; other AI subscriptions "
                                       "(usage not tracked) are not charted.", font=F_SMALL)

    # ---- how to read ---------------------------------------------------------
    rows.how = chart_row + chart_rows + 2
    _section(p, rows.how, SUMMARY, "How to read this report")
    lines = (
        "Spend is in rupees: pay-per-use tools by the credits used, subscriptions by their monthly fee for the period, "
        "shared across what each person made. Figures marked est. are estimates.",
        f"Every number is compared with {prev.label}. ▲ / ▼ show the change; percentages are rounded.",
        "Team & Clients has departments, people, clients, tools and subscriptions; the Glossary explains each term"
        + ("; the detail sheets after Details list every item." if with_details else "."),
    )
    for i, text in enumerate(lines, start=1):
        p.merge(rows.how + i, "A", "L", text, height=15.5 * _lines(text, NCOLS))
    links_row = rows.how + len(lines) + 1
    p.link(links_row, 1, TEAM, "A2", f"{TEAM} →")
    p.link(links_row, 3, GLOSSARY, "A2", f"{GLOSSARY} →")
    if with_details:
        p.link(links_row, 5, DETAILS, "A2", f"{DETAILS} →")

    _top_rows(p, SUMMARY, back_to, [("Key points", rows.key_points), ("Needs attention", rows.attention),
                                    ("Charts", rows.charts), ("How to read", rows.how)])
    _setup(ws, fit_height=1, last_row=links_row)
    p.flush()


# --------------------------------------------------------------------------- #
# Team & Clients
# --------------------------------------------------------------------------- #
def write_team(ws, v: ManagementView, *, back_to) -> None:
    p = Page(ws)
    cur, prev = v.cur, v.prev
    total = cur.total_spend
    p.put(3, 1, f"{TEAM} — {cur.label}", font=F_TITLE)
    p.heights[3] = 32
    p.put(4, 1, f"Spend in rupees (est. = estimate). % of total spend; change compared with {prev.label}. "
                "Hover a column title for what it means.", font=F_SUB)
    jumps = []
    row = 6

    # ---- departments ----------------------------------------------------------
    jumps.append(("Departments", row))
    _section(p, row, TEAM, "Departments")
    budgets = v.budgets.departments
    headers = ["Department", "People", "Spend (₹)", "% of total", "Change", "Main tool", "Main client", "est."]
    if budgets:
        headers += ["Budget (₹)", "% of budget"]
    _header(p, row + 1, headers)
    r = row + 2
    for dept, a in sorted(cur.by_dept.items(), key=lambda kv: (-kv[1].rupees, kv[0])):
        before = prev.by_dept[dept].rupees if dept in prev.by_dept else 0.0
        client = a.main(a.by_client, skip=(NO_CLIENT,)) or a.main(a.by_client) or "—"
        values = [dept, len(a.users), round(a.rupees), pct(a.rupees, total) / 100, change_text(a.rupees, before),
                  a.main(a.by_tool) or "—", client, _est_note(a.rupees, a.est)]
        fmts = [None, COUNT_FMT, INR_FMT, PCT_FMT, None, None, None, None]
        if budgets:
            budget = v.budget_for(budgets.get(dept))
            values += [round(budget) if budget else "—", (pct(a.rupees, budget) / 100) if budget else "—"]
            fmts += [INR_FMT, PCT_FMT]
        for i, (value, fmt) in enumerate(zip(values, fmts), start=1):
            p.put(r, i, value, fmt=fmt)
        r += 1
    if not cur.filtered and cur.not_used:
        p.put(r, 1, "Subscriptions paid, not used", font=_font(BODY, italic=True))
        p.put(r, 3, round(cur.not_used), fmt=INR_FMT)
        p.put(r, 4, pct(cur.not_used, total) / 100, fmt=PCT_FMT)
        r += 1
    # Other AI subscriptions belong to no department: their own line below the table.
    tracked_total = total - cur.other_total
    p.put(r, 1, "Total (tracked)", font=F_BOLD, border=RULE)
    p.put(r, 2, len(cur.total.users), font=F_BOLD, fmt=COUNT_FMT, border=RULE)
    p.put(r, 3, round(tracked_total), font=F_BOLD, fmt=INR_FMT, border=RULE)
    p.put(r, 4, pct(tracked_total, total) / 100 if total else 0, font=F_BOLD, fmt=PCT_FMT, border=RULE)
    p.put(r, 5, change_text(tracked_total, prev.total_spend - prev.other_total), font=F_BOLD, border=RULE)
    p.put(r, 8, _est_note(tracked_total, cur.estimated), font=F_BOLD, border=RULE)
    r += 1
    if cur.other_total or cur.other_subscriptions:
        p.merge(r, "A", "L", f"{OTHER_AI_LINE}: {inr(cur.other_total)} ({pct(cur.other_total, total)}% of total "
                             f"spend) — no department or item; see Subscriptions below.", font=F_BODY)
        r += 1
    p.merge(r, "A", "L", f"Total spend: {inr(total)} ({change_text(total, prev.total_spend)} vs {prev.label})",
            font=F_BOLD)
    row = r + 2

    # ---- people -----------------------------------------------------------------
    jumps.append(("People", row))
    _section(p, row, TEAM, "Top 10 people")
    _header(p, row + 1, ["Name", "Department", "Spend (₹)", "Items generated", "Main tool", "Main client", "est."])
    r = row + 2
    people = cur.people
    for uid in people[:10]:
        a = cur.by_user[uid]
        client = a.main(a.by_client, skip=(NO_CLIENT,)) or "—"
        for i, (value, fmt) in enumerate(zip(
                [cur.user_name[uid], cur.user_dept.get(uid, ""), round(a.rupees), a.items, a.main(a.by_tool) or "—",
                 client, _est_note(a.rupees, a.est)],
                [None, None, INR_FMT, COUNT_FMT, None, None, None]), start=1):
            p.put(r, i, value, fmt=fmt)
        r += 1
    rest = people[10:]
    if rest:
        spend = sum(cur.by_user[u].rupees for u in rest)
        p.put(r, 1, f"Others ({len(rest)} people)", font=_font(BODY, italic=True))
        p.put(r, 3, round(spend), fmt=INR_FMT)
        p.put(r, 4, sum(cur.by_user[u].items for u in rest), fmt=COUNT_FMT)
        r += 1
    if UNASSIGNED_USER_ID in cur.by_user and cur.by_user[UNASSIGNED_USER_ID].items:
        a = cur.by_user[UNASSIGNED_USER_ID]
        p.put(r, 1, UNASSIGNED, font=_font(BODY, italic=True))
        p.put(r, 3, round(a.rupees), fmt=INR_FMT)
        p.put(r, 4, a.items, fmt=COUNT_FMT)
        p.put(r, 5, a.main(a.by_tool) or "—")
        p.put(r, 7, _est_note(a.rupees, a.est))
        r += 1
    row = r + 1

    # ---- clients ------------------------------------------------------------------
    jumps.append(("Clients", row))
    _section(p, row, TEAM, "Top 10 clients")
    _header(p, row + 1, ["Client", "Spend (₹)", "% of total", "People", "Main tool", "est."])
    p.put(row, 5, "Client fees are not in the dashboard, so spend as % of client fee is not shown.", font=F_SMALL)
    r = row + 2
    work = sorted(((c, a) for c, a in cur.by_client.items() if c != NO_CLIENT and not v.display.is_internal(c)),
                  key=lambda kv: (-kv[1].rupees, kv[0]))

    def client_row(name, a, italic=False):
        nonlocal r
        for i, (value, fmt) in enumerate(zip(
                [name, round(a.rupees), pct(a.rupees, total) / 100, len(a.users), a.main(a.by_tool) or "—",
                 _est_note(a.rupees, a.est)],
                [None, INR_FMT, PCT_FMT, COUNT_FMT, None, None]), start=1):
            p.put(r, i, value, fmt=fmt, font=_font(BODY, italic=True) if italic and i == 1 else F_BODY)
        r += 1

    for name, a in work[:10]:
        client_row(name, a)
    if len(work) > 10:
        from .management import Agg
        others = Agg()
        for _n, a in work[10:]:
            others.rupees += a.rupees
            others.est += a.est
            others.users |= a.users
            for t, x in a.by_tool.items():
                others.by_tool[t] += x
        client_row(f"Others ({len(work) - 10} clients)", others, italic=True)
    for name, a in sorted(cur.by_client.items()):
        if v.display.is_internal(name):
            client_row(name, a, italic=True)
    if NO_CLIENT in cur.by_client:
        client_row(NO_CLIENT, cur.by_client[NO_CLIENT], italic=True)
    row = r + 1

    # ---- tools ----------------------------------------------------------------------
    jumps.append(("Tools", row))
    _section(p, row, TEAM, "Tools")
    _header(p, row + 1, ["Tool", "How it is paid", "Spend (₹)", "Items generated", "People", "Cost per item (₹)",
                         "Departments that depend on it (over 80% of their spend)", "", "", "est."])
    p.ws.merged_cells.add(f"G{row + 1}:I{row + 1}")
    r = row + 2
    from .costing import PAY_PER_USE_TOOLS
    for tool in cur.tools:
        a = cur.by_tool.get(tool)
        spend = cur.tool_spend(tool)
        depends = [d for d, da in cur.by_dept.items() if da.rupees > 0 and da.by_tool.get(tool, 0) / da.rupees > 0.8]
        values = [tool, "Pay-per-use" if tool in PAY_PER_USE_TOOLS else "Subscription", round(spend),
                  a.items if a else 0, len(a.users) if a else 0, _per_item(cur.cost_per_item(tool)),
                  ", ".join(sorted(depends)) or "—", None, None, _est_note(a.rupees, a.est) if a else ""]
        fmts = [None, None, INR_FMT, COUNT_FMT, COUNT_FMT, None, None, None, None, None]
        for i, (value, fmt) in enumerate(zip(values, fmts), start=1):
            if i in (8, 9):
                p.put(r, i, None)
                continue
            p.put(r, i, value, fmt=fmt, align=WRAP if i == 7 else None)
        p.ws.merged_cells.add(f"G{r}:I{r}")
        r += 1
    row = r + 1

    # ---- subscriptions -----------------------------------------------------------------
    jumps.append(("Subscriptions", row))
    _section(p, row, TEAM, "Subscriptions")
    if cur.filtered:
        p.put(row, 4, "Fees are shown in full; the report is filtered, so only part of their use is counted above.",
              font=F_SMALL)
    _header(p, row + 1, ["Tool", "Account", "Monthly fee (₹)", "₹ in period", "Items made", "₹ per item",
                         "Last used", "Renewal date", "Status", "", "", ""])
    p.ws.merged_cells.add(f"I{row + 1}:L{row + 1}")
    r = row + 2
    warn = {NOT_USED, LOW_USE, RENEWAL_PASSED, NO_FEE}
    ordered = (sorted(cur.subscriptions, key=lambda s: (-s.period_fee, s.tool, s.account))
               + sorted(cur.other_subscriptions, key=lambda s: (-s.period_fee, s.tool, s.account)))
    for s in ordered:
        status = s.status + (_idle_note(s, cur) if s.status == NOT_USED else "")
        if s.frequency_unconfirmed:
            status += " · fee frequency unconfirmed"
        flagged = s.status in warn or s.frequency_unconfirmed
        values = [s.tool, s.label, round(s.monthly_fee) if s.monthly_fee is not None else "not entered",
                  round(s.period_fee), s.items if s.tracked else "—", _per_item(s.per_item) if s.tracked else "—",
                  s.last_used if s.tracked else "—", s.renewal_date, status]
        fmts = [None, None, INR_FMT, INR_FMT, COUNT_FMT, None, DATE_FMT, DATE_FMT, None]
        for i, (value, fmt) in enumerate(zip(values, fmts), start=1):
            numeric = isinstance(value, (int, float, date))
            p.put(r, i, value if value is not None else "—", fmt=fmt if numeric else None,
                  fill=FILL_WARN if i == 9 and flagged else None)
        for col in range(10, 13):
            p.put(r, col, None, fill=FILL_WARN if flagged else None)
        p.ws.merged_cells.add(f"I{r}:L{r}")
        r += 1
    counted = cur.subscription_total + cur.other_total if not cur.filtered else cur.subscription_fees
    p.put(r, 1, "Counted in total spend", font=F_BOLD, border=RULE)
    p.put(r, 4, round(counted), font=F_BOLD, fmt=INR_FMT, border=RULE)
    p.put(r, 5, sum(s.items for s in cur.subscriptions), font=F_BOLD, fmt=COUNT_FMT, border=RULE)
    if cur.to_confirm:
        r += 1
        p.put(r, 1, "To confirm, not counted", font=_font(BODY, italic=True))
        p.put(r, 4, round(cur.to_confirm), fmt=INR_FMT)
        p.put(r, 6, "Renewal date passed: left out until confirmed still billed.", font=F_SMALL)
    last = r

    _top_rows(p, TEAM, back_to, jumps)
    # Real names are long ("Internal Brands", "Epidemic Sound #421", "New-business pitches").
    _setup(ws, fit_height=2, last_row=last, title_rows="3:3", widths=TEAM_WIDTHS)
    p.flush()


# --------------------------------------------------------------------------- #
# Glossary and Details
# --------------------------------------------------------------------------- #
def write_glossary(ws, *, back_to) -> None:
    p = Page(ws)
    p.put(3, 1, "Glossary — the words used in this report", font=F_TITLE)
    p.heights[3] = 32
    _header(p, 5, ["Term", "", "", "What it means", "", "", "", "", "", "", "", ""], notes=False)
    ws.merged_cells.add("A5:C5")
    ws.merged_cells.add("D5:L5")
    r = 6
    for term, meaning in GLOSSARY_TERMS:
        p.merge(r, "A", "C", term, font=F_BOLD, height=15.5 * max(_lines(meaning, 9), 1))
        p.merge(r, "D", "L", meaning)
        r += 1
    _top_rows(p, GLOSSARY, back_to, [])
    _setup(ws, fit_height=1, last_row=r - 1)
    p.flush()


def write_details(ws, sheets: list, purposes: dict, *, back_to) -> None:
    """The divider before the detail sheets: one sentence per sheet."""
    p = Page(ws)
    p.put(3, 1, "Details", font=F_TITLE)
    p.put(4, 1, "The sheets after this one back up the Summary: every person, tool, client and day, down to each "
                "item generated. Each one is for:", font=F_SUB)
    _header(p, 6, ["Sheet", "", "What it is for", "", "", "", "", "", "", "", "Open", ""], notes=False)
    ws.merged_cells.add("A6:B6")
    ws.merged_cells.add("C6:J6")
    r = 7
    for name in sheets:
        p.merge(r, "A", "B", name, font=F_BOLD, wrap=False)
        p.merge(r, "C", "J", purposes.get(name, ""), height=15.5 * _lines(purposes.get(name, ""), 8))
        landing = "A1" if name == "Home" else "A2"
        p.link(r, 11, name, landing, f"{name} →")
        r += 1
    _top_rows(p, DETAILS, back_to, [])
    _setup(ws, fit_height=1, last_row=r - 1)
    p.flush()


def write_management_workbook(path: str, v: ManagementView) -> None:
    """The management version: Summary, Team & Clients and Glossary only -
    no prompts, outputs or Generation Log, small enough to email."""
    from openpyxl import Workbook

    wb = Workbook(write_only=True)
    summary, team, glossary = (wb.create_sheet(n) for n in MANAGEMENT_SHEETS)
    data = wb.create_sheet(CHART_DATA)
    data.sheet_state = "hidden"
    back = (SUMMARY, "A2", f"⬅ Back to {SUMMARY}")
    write_summary(summary, data, v, back_to=None, with_details=False)
    write_team(team, v, back_to=back)
    write_glossary(glossary, back_to=back)
    wb.save(path)


__all__ = ["SUMMARY", "TEAM", "GLOSSARY", "DETAILS", "CHART_DATA", "MANAGEMENT_SHEETS", "THEME", "GLOSSARY_TERMS",
           "write_summary", "write_team", "write_glossary", "write_details", "write_management_workbook"]
