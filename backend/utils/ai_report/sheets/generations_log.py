"""Sheet -- Generations Log.

One row per (Client, Employee, Tool) combination actually used in the
report period, plus Tool and Client roll-up pivots beside it. This is the
"AI Software - Tool Generations Log" template the business asked for
(Client / Name / Tool / No. of Generations / Credit columns, with a
Tool-totals and a Client-totals pivot alongside the main log) - built
entirely from ``ds.merged_events``, the same cross-provider log every other
sheet in this workbook already reads, so it can never silently disagree with
the Dashboard/Employee Summary sheets. No new query, no new capture path.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import ReportDataset

NO_CLIENT = "No Client"


@dataclass
class _LogRow:
    client: str
    name: str
    tool: str
    generations: int
    credit: float


@dataclass
class _PivotRow:
    label: str
    generations: int


def _group_rows(ds: ReportDataset) -> list[_LogRow]:
    """Pre-aggregated (count + credit sum), not one row per individual
    generation - a single employee/tool/client combination can easily
    produce dozens of raw events a day, and the reference template's own
    legend describes "one row per usage instance" at this grouped grain, not
    the individual-event grain the raw provider log sheets already cover."""
    buckets: dict[tuple[str, str, str], list] = defaultdict(lambda: [0, 0.0])
    for ev in ds.merged_events:
        key = (ev.client_name or NO_CLIENT, ev.employee_name, ev.tool)
        bucket = buckets[key]
        bucket[0] += 1
        bucket[1] += ev.credits or 0.0

    rows = [
        _LogRow(client=client, name=name, tool=tool, generations=count, credit=credit)
        for (client, name, tool), (count, credit) in buckets.items()
    ]
    rows.sort(key=lambda r: (r.client, r.name, r.tool))
    return rows


def _tool_pivot(ds: ReportDataset) -> list[_PivotRow]:
    # Reuses ds.tool_usage's already-computed total_volume instead of
    # re-summing merged_events, so this pivot can never silently disagree
    # with the figure the Dashboard sheet's "Tool Adoption" chart plots.
    return [_PivotRow(t.tool, t.total_volume) for t in ds.tool_usage]


def _client_pivot(ds: ReportDataset) -> list[_PivotRow]:
    counts: dict[str, int] = defaultdict(int)
    for ev in ds.merged_events:
        counts[ev.client_name or NO_CLIENT] += 1
    rows = [_PivotRow(client, count) for client, count in counts.items()]
    # "No Client" sinks to the bottom regardless of volume - it's the
    # unassigned bucket, not a real client competing for a top spot.
    rows.sort(key=lambda r: (r.label == NO_CLIENT, -r.generations, r.label))
    return rows


LOG_COLS = [
    C.Col("Client", 20, "left", key="client"),
    C.Col("Name", 18, "left", key="name"),
    C.Col("Tool", 16, "left", key="tool"),
    C.Col("No. of Generations", 18, "right", fmt=T.FMT_INT_DASH, key="generations"),
    C.Col("Credit", 14, "right", fmt=T.FMT_INT_DASH, key="credit"),
]

TOOL_PIVOT_COLS = [
    C.Col("Tool", 18, "left", key="label"),
    C.Col("Total Generations", 16, "right", fmt=T.FMT_INT_DASH, key="generations"),
]

CLIENT_PIVOT_COLS = [
    C.Col("Client", 18, "left", key="label"),
    C.Col("Total Generations", 16, "right", fmt=T.FMT_INT_DASH, key="generations"),
]

_LOG_LAST_COL = len(LOG_COLS)
_TOOL_PIVOT_START_COL = _LOG_LAST_COL + 2  # one blank column of separation
_TOOL_PIVOT_LAST_COL = _TOOL_PIVOT_START_COL + len(TOOL_PIVOT_COLS) - 1
_CLIENT_PIVOT_START_COL = _TOOL_PIVOT_LAST_COL + 2
_CLIENT_PIVOT_LAST_COL = _CLIENT_PIVOT_START_COL + len(CLIENT_PIVOT_COLS) - 1
LAST_COL = _CLIENT_PIVOT_LAST_COL


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)

    rows = _group_rows(ds)
    row = C.title_band(
        ws, "Generations Log — Client · Employee · Tool",
        f"{ds.period.label} · one row per Client/Employee/Tool combination · {len(rows)} row(s)",
        last_col=LAST_COL,
    )

    header_row = row
    next_row = C.data_table(ws, LOG_COLS, rows, start_row=row, table_name="GenerationsLog")
    C.freeze_below(ws, header_row + 1)

    # Tool and Client roll-ups sit beside the main log (not below it), so
    # both stay visible without scrolling - the same side-by-side layout the
    # reference template used.
    C.data_table(
        ws, TOOL_PIVOT_COLS, _tool_pivot(ds), start_row=header_row,
        start_col=_TOOL_PIVOT_START_COL, table_name="GenerationsLogByTool",
    )
    C.data_table(
        ws, CLIENT_PIVOT_COLS, _client_pivot(ds), start_row=header_row,
        start_col=_CLIENT_PIVOT_START_COL, table_name="GenerationsLogByClient",
    )

    if not rows:
        C.label_value(
            ws, "No usage recorded", "No generations were captured in this period.",
            row=next_row, value_col=3,
        )
