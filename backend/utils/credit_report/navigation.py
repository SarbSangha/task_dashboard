"""
Credit Consumption Report - "back to where I came from" navigation.

Three layers, all decided before a summary row is written to disk:

* Breadcrumbs (row 1 of every sheet): "⬅ Back to <parent>", then
  "Home ›", "<ancestor> ›", ..., then the sheet's own name. The parent of
  each sheet lives in SHEET_PARENT, and only there.

* A link registry. Summary sheets are rendered into a BufferedSheet first;
  every HYPERLINK formula appended there is recorded as
  (source sheet, row, column) -> (target sheet, row, column). Back links
  ("⬅ ..."), breadcrumbs and other row-1 links, and links marked as plain
  navigation (Writer.nav) are not recorded as sources: they are the way back.

* resolve() gives every recorded target a back cell per source sheet, and
  re-points each incoming link to land on the back cell for its own source
  sheet, so the cell under the cursor after a jump is the way back:
    - a data row: a grey "⬅ <source>" column group right of everything on
      the target sheet, one column per source sheet;
    - a sheet's title (row 2): back cells in row 2 from column C;
    - a column header (Writer.link(..., back_row=n)): one back cell in that
      column, in row n.
  A back cell links to the exact source cell when only one cell of that
  source sheet points at the target (so following a link and then its back
  link is a round trip), else to the source sheet's title, labelled
  "⬅ <sheet> (list)".

The Generation Log is streamed, not buffered (it can hold hundreds of
thousands of rows): its back cells are written by workbook._write_log, and
the links into it point at those cells directly. Home is the root and needs
no back cells.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import column_index_from_string, get_column_letter

HOME = "Home"
PERIOD = "Period Explorer"
DEPT = "By Department"
USER = "By User"
TOOL = "By Tool"
CLIENT = "By Client"
DEPT_TOOL = "Dept × Tool"
USER_TOOL = "User × Tool"
USER_CLIENT = "User × Client"
TREND = "Monthly Trend"
DRILL = "Month Drill-down"
QUALITY = "Data Quality"
LOG = "Generation Log"

#: The one place a sheet's parent is defined (breadcrumbs and "⬅ Back to").
SHEET_PARENT = {
    PERIOD: HOME, DEPT: HOME, USER: HOME, TOOL: HOME, CLIENT: HOME, TREND: HOME, QUALITY: HOME,
    DEPT_TOOL: DEPT, USER_TOOL: DEPT_TOOL,
    USER_CLIENT: USER, LOG: USER_CLIENT,
    DRILL: TREND,
}

#: Fixed short names for back-link labels ("⬅ U×Tool (list)"): they always
#: fit the back columns, so no label is ever cut.
SHORT_NAME = {
    HOME: "Home", PERIOD: "Explorer", DEPT: "Dept", USER: "User", TOOL: "Tool", CLIENT: "Client",
    DEPT_TOOL: "Dept×Tool", USER_TOOL: "U×Tool", USER_CLIENT: "U×Client", TREND: "Trend",
    DRILL: "Drill-down", QUALITY: "Data Quality", LOG: "Log",
}

TITLE_ROW = 2
HEADER_ROW_FOR_BACK = 4           # back-column headers sit in the sheets' table header row
TITLE_BACK_FIRST_COL = 3          # title-row back cells start at C2 (the title overflows into B)
BACK_COL_WIDTH = 17
MAX_BACK_LABEL = 21                # longest fixed label: "⬅ Data Quality (list)" (fits width 17 at size 9)
LIST_SUFFIX = " (list)"
#: Link labels that name an action rather than the cell they land on
#: ("Open block →", "Generations (48) →"); a back link to one is named after
#: its row instead.
ACTION_LABEL_RE = re.compile(r"^(Open block|(All )?[Gg]enerations \([\d,]+(?: · [\d,]+ (?:pending|failed))*\))$")


def is_action_label(label: str) -> bool:
    """Open block / Generations (n) / a jump ("↓ Clients") / a sideways cell ("↔ Bob in By Tool")."""
    return label.startswith(("↓", "↔")) or bool(ACTION_LABEL_RE.match(strip_decoration(label)))
CRUMB_SUFFIX = " ›"

F_BACK = Font(color="7F7F7F", underline="single", size=9)
F_BACK_HEADER = Font(bold=True, color="7F7F7F", size=9)
FILL_BACK = PatternFill("solid", fgColor="F2F2F2")
ALIGN_BACK_HEADER = Alignment(wrap_text=True, vertical="center")

LINK_RE = re.compile(r'^=HYPERLINK\("(?P<target>(?:[^"]|"")*)","(?P<label>(?:[^"]|"")*)"\)$')
INTERNAL_RE = re.compile(r"^#'(?P<sheet>[^']+)'!(?P<col>[A-Z]+)(?P<row>\d+)$")


def ancestors(sheet: str) -> list:
    """Home first, the sheet's parent last."""
    chain, cur = [], SHEET_PARENT.get(sheet)
    while cur:
        chain.append(cur)
        cur = SHEET_PARENT.get(cur)
    return list(reversed(chain))


def landing_row(sheet: str) -> int:
    """Where "go to this sheet" lands: Home's "Home" tag, else the title."""
    return 1 if sheet == HOME else TITLE_ROW


def list_row(sheet: str) -> int:
    """Where a "⬅ <sheet> (list)" return lands: the sheet's list header row
    (no links there, so two list returns can never point at each other)."""
    return 1 if sheet == HOME else HEADER_ROW_FOR_BACK


def parse_link(value) -> Optional[tuple]:
    """(target sheet, row, column letter, label) of an internal HYPERLINK formula."""
    if not isinstance(value, str) or not value.startswith("=HYPERLINK("):
        return None
    m = LINK_RE.match(value)
    if not m:
        return None
    t = INTERNAL_RE.match(m.group("target").replace('""', '"'))
    if not t:
        return None
    return t.group("sheet"), int(t.group("row")), t.group("col"), m.group("label").replace('""', '"')


def back_label(sheet: str, item: str = "", *, listed: bool = False) -> str:
    """'⬅ U×Tool', '⬅ Explorer: chahal' (the item only when it fits) or
    '⬅ U×Client (list)'. Never cut: a label that would not fit drops the item."""
    short = SHORT_NAME.get(sheet, sheet)
    if listed:
        return f"⬅ {short}{LIST_SUFFIX}"
    with_item = f"⬅ {short}: {item}"
    return with_item if item and len(with_item) <= MAX_BACK_LABEL else f"⬅ {short}"


def strip_decoration(label: str) -> str:
    label = label.strip()
    for prefix in ("⬅ Back to ", "⬅ "):
        if label.startswith(prefix):
            label = label[len(prefix):]
    for suffix in (" →", CRUMB_SUFFIX, LIST_SUFFIX):
        if label.endswith(suffix):
            label = label[: -len(suffix)]
    return label


def shown_text(cell) -> str:
    """What a buffered cell shows (a link's label, a month, or its text)."""
    if cell is None:
        return ""
    value = cell.value
    link = LINK_RE.match(value) if isinstance(value, str) else None
    if link:
        return strip_decoration(link.group("label").replace('""', '"'))
    if isinstance(value, datetime):
        return value.strftime("%b %Y") if cell.number_format == "mmm yyyy" else value.strftime("%d %b %Y")
    return "" if value is None else str(value)


class BufferedSheet:
    """Collects a sheet's rows so links can be resolved before writing.

    Everything except append() goes straight to the real write-only sheet
    (tables, conditional formatting, validations, charts, title...).
    """

    def __init__(self, ws, writer):
        self._ws = ws
        self._writer = writer
        self.rows: list = []

    def append(self, cells):
        self.rows.append(list(cells))

    def __getattr__(self, name):
        return getattr(self._ws, name)

    def max_col(self) -> int:
        return max((len(r) for r in self.rows), default=0)

    def cell_at(self, row: int, col: int):
        if row <= len(self.rows) and col <= len(self.rows[row - 1]):
            return self.rows[row - 1][col - 1]
        return None

    def put(self, row: int, col: int, cell) -> None:
        while len(self.rows) < row:
            self.rows.append([])
        r = self.rows[row - 1]
        while len(r) < col - 1:
            r.append(None)
        if len(r) >= col:
            if r[col - 1] is not None and r[col - 1].value not in (None, ""):
                raise ValueError(f"{self._ws.title}!{get_column_letter(col)}{row} is already used")
            r[col - 1] = cell
        else:
            r.append(cell)

    def flush(self) -> None:
        for r in self.rows:
            self._ws.append([c if c is not None else None for c in r])
        self.rows = []


@dataclass(frozen=True)
class Source:
    sheet: str
    row: int
    col: str


MAX_BACK_SLOTS = 3


def _source_label(sheet: str, buf, src) -> str:
    """'⬅ Explorer: chahal' - where the back cell returns to, and the row's item when it fits."""
    if sheet == HOME:
        return back_label(sheet)
    own = shown_text(buf.cell_at(src.row, column_index_from_string(src.col)))
    item = own if sheet in (DRILL, PERIOD) else (shown_text(buf.cell_at(src.row, 1)) or own)
    return back_label(sheet, "" if is_action_label(item) else item)


def resolve(buffers: dict, writers: dict, sheet_order, link_formula, internal_target, *, home_section=None,
            header_rows=None, skip_targets=(LOG, HOME)) -> dict:
    """Add back cells and re-point incoming links. Returns {target sheet: [slot column letters]}.

    buffers: {sheet name: BufferedSheet}; writers: {sheet name: Writer};
    header_rows: {sheet name: [rows]} where the back-column headers go, for
    sheets with several tables (default: row HEADER_ROW_FOR_BACK only).

    A data row gets at most MAX_BACK_SLOTS back cells ("⬅ Back 1-3"), one
    per source sheet that links to it, the sheet's most common sources
    first. Links from any further source sheet land on the target's title
    row instead, whose cell returns to that source sheet.
    """
    header_rows = header_rows or {}
    order = {name: i for i, name in enumerate(sheet_order)}
    # (target sheet, kind, key) -> source sheet -> [(Source, cell, label)]
    incoming = defaultdict(lambda: defaultdict(list))
    for src_sheet, buf in buffers.items():
        w = writers[src_sheet]
        for r, cells in enumerate(buf.rows, start=1):
            if r == 1:
                continue                                   # breadcrumbs / sheet navigation
            for c, cell in enumerate(cells, start=1):
                if cell is None:
                    continue
                link = parse_link(cell.value)
                if not link:
                    continue
                t_sheet, t_row, t_col, label = link
                if label.startswith("⬅") or id(cell) in w.nav_ids or t_sheet in skip_targets:
                    continue
                if t_sheet not in buffers:
                    raise ValueError(f"{src_sheet}!{get_column_letter(c)}{r} links to unbuffered sheet {t_sheet}")
                back_row = w.back_rows.get(id(cell))
                if back_row is not None:
                    key = ("col", back_row, t_col)
                elif t_row <= TITLE_ROW:
                    key = ("title", TITLE_ROW, None)
                else:
                    key = ("row", t_row, None)
                incoming[(t_sheet,) + key][src_sheet].append((Source(src_sheet, r, get_column_letter(c)), cell, label))

    # Rank each target sheet's sources by how many of its rows they reach.
    reach = defaultdict(lambda: defaultdict(int))
    for (t_sheet, kind, _r, _c), by_src in incoming.items():
        if kind == "row":
            for s in by_src:
                reach[t_sheet][s] += 1

    def ranked(t_sheet, sources):
        return sorted(sources, key=lambda s: (-reach[t_sheet][s], order.get(s, 99)))

    # Rows reached from more than MAX_BACK_SLOTS sheets: the extra sources'
    # links land on the item's name (column A of its row) and return through
    # a "⬅ <sheet> (list)" cell in the title area.
    slots = defaultdict(dict)                  # (t_sheet, row) -> {source: slot index}
    unslotted = set()                          # ids of links that land on column A instead of a slot
    for key in [k for k in incoming if k[1] == "row"]:
        t_sheet, _kind, t_row, _c = key
        keep = ranked(t_sheet, incoming[key])
        for i, s in enumerate(keep[:MAX_BACK_SLOTS]):
            slots[(t_sheet, t_row)][s] = i
        for s in keep[MAX_BACK_SLOTS:]:
            for _src, cell, label in incoming[key][s]:
                cell.value = link_formula(internal_target(t_sheet, t_row, "A"), label)
                unslotted.add(id(cell))
            incoming[(t_sheet, "title", TITLE_ROW, None)][s].extend(incoming[key].pop(s))

    slot_cols = {}
    for t_sheet in {t for (t, _r) in slots}:
        buf, w = buffers[t_sheet], writers[t_sheet]
        n = max(len(v) for (t, _r), v in slots.items() if t == t_sheet)
        start = buf.max_col() + 1
        slot_cols[t_sheet] = [get_column_letter(start + i) for i in range(n)]
        for i, letter in enumerate(slot_cols[t_sheet]):
            buf.column_dimensions[letter].width = BACK_COL_WIDTH
            for hr in header_rows.get(t_sheet, (HEADER_ROW_FOR_BACK,)):
                buf.put(hr, start + i, w.text(f"⬅ Back {i + 1}", font=F_BACK_HEADER, fill=FILL_BACK,
                                              align=ALIGN_BACK_HEADER))

    title_cols = defaultdict(dict)
    for (t_sheet, kind, _r, _c), by_src in incoming.items():
        if kind == "title":
            for i, s in enumerate(ranked(t_sheet, [s for s in by_src if by_src[s]])):
                title_cols[t_sheet][s] = get_column_letter(TITLE_BACK_FIRST_COL + i)

    for (t_sheet, kind, t_row, t_col), by_src in incoming.items():
        w = writers[t_sheet]
        buf = buffers[t_sheet]
        for s, links in by_src.items():
            if not links:
                continue
            if kind == "row":
                at_row, at_col = t_row, slot_cols[t_sheet][slots[(t_sheet, t_row)][s]]
            elif kind == "title":
                at_row, at_col = TITLE_ROW, title_cols[t_sheet][s]
            else:
                if len(by_src) > 1:
                    raise ValueError(f"{t_sheet} column {t_col}: one back cell, several source sheets {sorted(by_src)}")
                at_row, at_col = t_row, t_col
            rows_from = {src.row for src, _cell, _label in links}
            listed = any(id(cell) in unslotted for _s, cell, _l in links)
            if not listed and len(rows_from) == 1 and kind != "title":
                # One source row: back to its first linking cell (exact).
                src = min((src for src, _c, _l in links), key=lambda x: column_index_from_string(x.col))
                back = w.link(internal_target(s, src.row, src.col), _source_label(s, buffers[s], src),
                              font=F_BACK, fill=FILL_BACK)
            elif not listed and len({(src.row, src.col) for src, _c, _l in links}) == 1:
                src = links[0][0]
                back = w.link(internal_target(s, src.row, src.col), _source_label(s, buffers[s], src),
                              font=F_BACK, fill=FILL_BACK)
            else:
                back = w.link(internal_target(s, list_row(s)), back_label(s, listed=True), font=F_BACK, fill=FILL_BACK)
            buf.put(at_row, column_index_from_string(at_col), back)
            for _src, cell, label in links:
                if id(cell) not in unslotted:
                    cell.value = link_formula(internal_target(t_sheet, at_row, at_col), label)
    return slot_cols
