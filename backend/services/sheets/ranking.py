"""keyword_ranking sheets: wide-layout parsing and value normalisation.

Layout (found by header text, never fixed rows or column letters):

    row  <header>      S.No | Keyword | Live URL | 21-Aug-2026 (Baseline) | 24-Aug-2026 | ...
    row  <sub-header>                            | Position | AI Overview  | Position | AI Overview
    rows <data>        one keyword per row

Each date is a merged header over its Position / AI Overview pair, and the
job adds a new pair to the right on every run, so the number of runs is
whatever the sheet holds today.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .public_export import cell_text

SEARCH_ROWS = 25
SNO_HEADERS = {"s.no", "s.no.", "sno", "s no", "#", "no", "no.", "sr no", "sr. no.", "serial", "sl no"}
_DATE_RE = re.compile(r"(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{4})")
_ISO_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_NOT_IN_TOP = re.compile(r"^not\s+in\s+top\s+(\d+)$")
_SPACES = re.compile(r"\s+")

BUCKET_RANKED = "ranked"
BUCKET_FAILED = "failed"
BUCKET_UNPARSED = "unparsed"
AI_CITED, AI_NOT_CITED, AI_NONE = "cited", "not_cited", "none"
AI_FAILED, AI_UNPARSED, AI_BLANK = "failed", "unparsed", "blank"
MAX_POSITION = 200


def _norm(value) -> str:
    return _SPACES.sub(" ", cell_text(value).strip().lower())


def normalize_keyword(text: str) -> str:
    return _SPACES.sub(" ", (text or "").strip().lower())


@dataclass(frozen=True)
class Position:
    position: Optional[int]
    bucket: str            # ranked | not_in_top_<N> | failed | unparsed | blank
    depth: Optional[int] = None


def normalize_position(raw) -> Position:
    """30 / 30.0 / "7" -> ranked; "Not in Top 10" (any spacing/case) -> not_in_top_10;
    "CHECK FAILED" -> failed; blank -> blank; anything else -> unparsed."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return Position(None, "blank")
    if isinstance(raw, bool):
        return Position(None, BUCKET_UNPARSED)
    if isinstance(raw, (int, float)):
        if float(raw).is_integer() and 1 <= int(raw) <= MAX_POSITION:
            return Position(int(raw), BUCKET_RANKED)
        return Position(None, BUCKET_UNPARSED)
    text = _norm(raw)
    if text.isdigit() and 1 <= int(text) <= MAX_POSITION:
        return Position(int(text), BUCKET_RANKED)
    m = _NOT_IN_TOP.match(text)
    if m:
        depth = int(m.group(1))
        return Position(None, f"not_in_top_{depth}", depth)
    if "fail" in text or "error" in text:
        return Position(None, BUCKET_FAILED)
    return Position(None, BUCKET_UNPARSED)


def normalize_ai(raw) -> str:
    """Yes -> cited; No -> not_cited (an AI Overview exists, our URL isn't in it);
    No AI Overview -> none; Check failed -> failed; blank -> blank; else unparsed."""
    text = _norm(raw)
    if not text:
        return AI_BLANK
    if text in ("yes", "y", "cited"):
        return AI_CITED
    if text in ("no", "n", "not cited"):
        return AI_NOT_CITED
    if text in ("no ai overview", "no aio", "none", "no overview"):
        return AI_NONE
    if "fail" in text or "error" in text:
        return AI_FAILED
    return AI_UNPARSED


def parse_header_date(value) -> tuple:
    """(date or None, label, is_baseline) from a run header cell."""
    if isinstance(value, datetime):
        return value.date(), value.strftime("%d-%b-%Y"), False
    if isinstance(value, date):
        return value, value.strftime("%d-%b-%Y"), False
    label = cell_text(value)
    baseline = "baseline" in label.lower()
    m = _DATE_RE.search(label)
    if m:
        day, month, year = m.groups()
        for text, fmt in ((f"{day} {month[:3]} {year}", "%d %b %Y"), (f"{day} {month} {year}", "%d %B %Y")):
            try:
                return datetime.strptime(text, fmt).date(), label, baseline
            except ValueError:
                continue
    m = _ISO_RE.search(label)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))), label, baseline
        except ValueError:
            pass
    return None, label, baseline


def infer_trigger(check_date: date, is_baseline: bool) -> str:
    if is_baseline:
        return "baseline"
    return "scheduled" if check_date.weekday() == 0 else "manual"


@dataclass
class RunColumn:
    run_key: str
    check_date: date
    label: str
    is_baseline: bool
    position_col: int
    ai_col: Optional[int]

    @property
    def letter(self) -> str:
        return get_column_letter(self.position_col)


@dataclass
class KeywordRow:
    row_number: int
    s_no: str
    keyword: str
    url: str
    url_link: Optional[str]
    cells: dict = field(default_factory=dict)   # run_key -> (raw_position, raw_ai)


@dataclass
class RankingTab:
    name: str
    header_row: Optional[int] = None
    sub_header_row: Optional[int] = None
    first_data_row: Optional[int] = None
    columns: dict = field(default_factory=dict)   # sno / keyword / url -> column index
    runs: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    problems: list = field(default_factory=list)

    @property
    def is_ranking(self) -> bool:
        return bool(self.header_row and "keyword" in self.columns and self.runs)


def _merged_value(ws, row: int, col: int):
    value = ws.cell(row, col).value
    if value not in (None, ""):
        return value
    for rng in ws.merged_cells.ranges:
        if rng.min_row <= row <= rng.max_row and rng.min_col <= col <= rng.max_col:
            return ws.cell(rng.min_row, rng.min_col).value
    return None


def _has_keyword_header(ws, r: int) -> bool:
    texts = {_norm(_merged_value(ws, r, c)) for c in range(1, min(ws.max_column, 60) + 1)}
    return "keyword" in texts or "keywords" in texts


def _find_header_row(ws, config: dict) -> tuple:
    """(row, note). A configured header row is used only if it really holds
    the Keyword header; otherwise the row is found by its text, so a wrong
    setting can never stop the import."""
    explicit = config.get("headerRow")
    if explicit and _has_keyword_header(ws, int(explicit)):
        return int(explicit), None
    for r in range(1, min(ws.max_row, SEARCH_ROWS) + 1):
        if _has_keyword_header(ws, r):
            note = (f"Header row is set to {explicit}, but the 'Keyword' header is on row {r}; using row {r}"
                    if explicit else None)
            return r, note
    return None, None


def parse_tab(ws, config: Optional[dict] = None) -> RankingTab:
    config = config or {}
    tab = RankingTab(name=ws.title)
    header, note = _find_header_row(ws, config)
    if not header:
        tab.problems.append("No row in the first 25 has a 'Keyword' header")
        return tab
    if note:
        tab.problems.append(note)
    tab.header_row = header
    width = ws.max_column

    def has_position(r):
        return any(_norm(ws.cell(r, c).value) == "position" for c in range(1, width + 1))

    # Configured sub-header / first-data rows are trusted only when they fit
    # the header actually found.
    sub = int(config.get("subHeaderRow") or 0) or None
    if sub and (sub <= header or not has_position(sub)):
        sub = None
    if not sub:
        for r in (header + 1, header + 2):
            if has_position(r):
                sub = r
                break
    tab.sub_header_row = sub
    first = int(config.get("firstDataRow") or 0) or None
    tab.first_data_row = first if first and first > (sub or header) else (sub or header) + 1

    for c in range(1, width + 1):
        h = _norm(_merged_value(ws, header, c))
        if not h:
            continue
        if "keyword" not in tab.columns and h in ("keyword", "keywords"):
            tab.columns["keyword"] = c
        elif "sno" not in tab.columns and h in SNO_HEADERS:
            tab.columns["sno"] = c
        elif "url" not in tab.columns and ("url" in h or h in ("link", "page", "target page")):
            tab.columns["url"] = c

    seen_keys: dict = {}
    if sub:
        for c in range(1, width + 1):
            if _norm(ws.cell(sub, c).value) != "position":
                continue
            ai_col = c + 1 if c + 1 <= width and _norm(ws.cell(sub, c + 1).value).startswith("ai overview") else None
            raw_header = _merged_value(ws, header, c)
            check_date, label, baseline = parse_header_date(raw_header)
            if check_date is None:
                tab.problems.append(f"Column {get_column_letter(c)}: unreadable run date '{label or '(blank)'}'")
                continue
            if ai_col is None:
                tab.problems.append(f"Column {get_column_letter(c)}: Position without an AI Overview column")
            iso = check_date.isoformat()
            seen_keys[iso] = seen_keys.get(iso, 0) + 1
            key = iso if seen_keys[iso] == 1 else f"{iso}#{seen_keys[iso]}"
            tab.runs.append(RunColumn(key, check_date, label, baseline, c, ai_col))

    kcol, ucol, scol = tab.columns.get("keyword"), tab.columns.get("url"), tab.columns.get("sno")
    if not kcol:
        tab.problems.append("No 'Keyword' column")
        return tab
    for r in range(tab.first_data_row, ws.max_row + 1):
        keyword = cell_text(ws.cell(r, kcol).value)
        url_cell = ws.cell(r, ucol) if ucol else None
        url = cell_text(url_cell.value) if url_cell is not None else ""
        link = getattr(getattr(url_cell, "hyperlink", None), "target", None) if url_cell is not None else None
        cells = {}
        for run in tab.runs:
            pos = ws.cell(r, run.position_col).value
            ai = ws.cell(r, run.ai_col).value if run.ai_col else None
            if pos not in (None, "") or ai not in (None, ""):
                cells[run.run_key] = (pos, ai)
        if not keyword:
            if cells:
                tab.problems.append(f"Row {r}: results but no keyword")
            continue
        tab.rows.append(KeywordRow(row_number=r, s_no=cell_text(ws.cell(r, scol).value) if scol else "",
                                   keyword=keyword, url=url, url_link=link, cells=cells))
    return tab


def parse_ranking_workbook(data: bytes, config: Optional[dict] = None) -> dict:
    """{tab name: RankingTab} for every tab (non-ranking tabs come back with
    is_ranking False and a reason in problems)."""
    wb = load_workbook(io.BytesIO(data), data_only=True)
    return {ws.title: parse_tab(ws, config) for ws in wb.worksheets}


def looks_like_ranking(data: bytes) -> bool:
    return any(t.is_ranking for t in parse_ranking_workbook(data).values())
