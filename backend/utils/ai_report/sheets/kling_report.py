"""Sheet -- Kling Report: one row per employee, plus a per-employee/client
breakdown beside it. Kling only - nothing from any other provider ever lands
on this sheet.

The one-sheet "final Kling report" the team has been assembling by hand
(Employee Name / Department / No. of Videos / Kling Credits Used / Client
Heavy Use) - built entirely from figures the rest of this workbook already
computes, so it can never silently disagree with the Employee Summary or
Generations Log sheets:

  * Videos / Credits come straight from ``Employee.kling_videos`` /
    ``Employee.kling_credits`` - the same aggregate the Employee Summary
    sheet's "Kling Videos Made" / "Kling Credits Used" columns show.
  * "Client Heavy Use" is a Client-Mapping tally over ``ds.merged_events``
    (Kling rows only), listing every client that employee worked on this
    period, heaviest generation count first - the same source
    generations_log.py's Client pivot reads.

Only employees with at least one Kling video in the period appear, sorted by
video count (heaviest use first), matching the reference format.

The second table (User Name / Client / No. of Generations / Credit) is the
same ``ds.merged_events`` Kling rows regrouped one level finer - by employee
AND client, rather than by employee alone - so the two tables can never
disagree with each other either.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass

from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import ReportDataset

NO_CLIENT = "No Client"

_MAIN_COL_COUNT = 5
_BREAKDOWN_START_COL = _MAIN_COL_COUNT + 2  # one blank column of separation
_BREAKDOWN_COL_COUNT = 4
LAST_COL = _BREAKDOWN_START_COL + _BREAKDOWN_COL_COUNT - 1


@dataclass
class _ReportRow:
    name: str
    department: str
    videos: int
    credits: float
    clients: str


@dataclass
class _ClientBreakdownRow:
    name: str
    client: str
    generations: int
    credits: float


def _client_heavy_use_by_employee(ds: ReportDataset) -> dict[str, str]:
    """employee_id -> comma-separated client names, heaviest usage first."""
    counts: dict[str, Counter] = {}
    for ev in ds.merged_events:
        if ev.tool != "Kling":
            continue
        client = (ev.client_name or "").strip()
        if not client:
            continue
        counts.setdefault(ev.employee_id, Counter())[client] += 1
    return {
        employee_id: ", ".join(name for name, _n in counter.most_common())
        for employee_id, counter in counts.items()
    }


def _build_rows(ds: ReportDataset) -> list[_ReportRow]:
    heavy_use = _client_heavy_use_by_employee(ds)
    rows = [
        _ReportRow(
            name=emp.name,
            department=emp.department,
            videos=emp.kling_videos,
            credits=emp.kling_credits,
            clients=heavy_use.get(emp.employee_id, ""),
        )
        for emp in ds.employees
        if emp.kling_videos
    ]
    rows.sort(key=lambda r: r.videos, reverse=True)
    return rows


def _build_client_breakdown_rows(ds: ReportDataset) -> list[_ClientBreakdownRow]:
    """One row per (employee, client) combination, Kling events only."""
    buckets: dict[tuple[str, str], list] = defaultdict(lambda: [0, 0.0])
    for ev in ds.merged_events:
        if ev.tool != "Kling":
            continue
        key = (ev.employee_name, ev.client_name or NO_CLIENT)
        bucket = buckets[key]
        bucket[0] += 1
        bucket[1] += ev.credits or 0.0

    rows = [
        _ClientBreakdownRow(name=name, client=client, generations=count, credits=credits)
        for (name, client), (count, credits) in buckets.items()
    ]
    rows.sort(key=lambda r: (r.name, -r.generations, r.client))
    return rows


COLS = [
    C.Col("Employee Name", 26, "left", key="name"),
    C.Col("Department", 22, "left", key="department"),
    C.Col("Kling Videos", 14, "right", fmt=T.FMT_INT_DASH, key="videos"),
    C.Col("Kling Credits Used", 18, "right", fmt=T.FMT_INT_DASH, key="credits"),
    C.Col("Client Heavy Use", 44, "left", key="clients"),
]

BREAKDOWN_COLS = [
    C.Col("User Name", 24, "left", key="name"),
    C.Col("Client", 22, "left", key="client"),
    C.Col("No. of Generations", 18, "right", fmt=T.FMT_INT_DASH, key="generations"),
    C.Col("Credit", 14, "right", fmt=T.FMT_INT_DASH, key="credits"),
]


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)

    rows = _build_rows(ds)
    breakdown_rows = _build_client_breakdown_rows(ds)
    row = C.title_band(
        ws, "Kling Report — Employee · Department · Videos · Credits · Client",
        f"{ds.period.label} · one row per employee with Kling activity · {len(rows)} employee(s)",
        last_col=LAST_COL,
    )

    header_row = row
    next_row = C.data_table(ws, COLS, rows, start_row=row, table_name="KlingReport")
    C.freeze_below(ws, header_row + 1)

    # User/Client breakdown sits beside the employee table (not below it), same
    # side-by-side layout the Generations Log sheet's Tool/Client pivots use.
    C.data_table(
        ws, BREAKDOWN_COLS, breakdown_rows, start_row=header_row,
        start_col=_BREAKDOWN_START_COL, table_name="KlingReportByClient",
    )

    if not rows:
        C.label_value(
            ws, "No usage recorded", "No Kling generations were captured in this period.",
            row=next_row, value_col=3,
        )
