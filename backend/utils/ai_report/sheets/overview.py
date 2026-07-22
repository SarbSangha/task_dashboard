"""Sheet 3 -- Overview: quick-summary cards + combined chronological raw log."""

from __future__ import annotations

from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import Event, ReportDataset

LAST_COL = 13


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)
    k = ds.kpis
    # True period totals (not the capped raw-row counts), so the summary agrees
    # with the Dashboard and Employee Summary even when raw logs are truncated.
    cg_events = k.total_sessions
    kl_events = k.total_generations
    total_events = cg_events + kl_events

    row = C.title_band(
        ws, "Overview — Quick Summary + Combined Raw Data (Both Tools)",
        "Top = at a glance · Bottom = every logged ChatGPT and Kling event in one place, sorted by date",
        last_col=LAST_COL,
    )

    cards = [
        C.Kpi("Total Employees", k.total_employees, T.FMT_INT),
        C.Kpi("Total Events Logged", total_events, T.FMT_INT),
        C.Kpi("ChatGPT Events", cg_events, T.FMT_INT),
        C.Kpi("Kling Events", kl_events, T.FMT_INT),
        C.Kpi("Employees Using ≥ 1 Tool", k.employees_using_ai, T.FMT_INT),
    ]
    row = C.kpi_cards(ws, cards, row=row, span=2)

    row = C.callout(
        ws,
        f"Overall AI adoption: {k.adoption_pct:.0%} of employees used at least one tracked AI tool this period.",
        row=row, last_col=LAST_COL,
    )

    row = C.section_header(
        ws, "Combined Raw Data — All Logged Events (ChatGPT + Kling)", row=row, last_col=LAST_COL,
    )

    cols = [
        C.Col("Date", 13, "center", fmt=T.FMT_DATE, get=lambda e: e.when),
        C.Col("Employee ID", 12, "center", key="employee_id"),
        C.Col("Employee Name", 18, "left", key="employee_name"),
        C.Col("Department", 16, "left", key="department"),
        C.Col("Tool Used", 12, "center", key="tool"),
        C.Col("Prompt / Input", 30, "left", key="prompt"),
        C.Col("Response / Output", 28, "left", key="response"),
        C.Col("Model", 14, "left", key="model"),
        C.Col("Credits", 11, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.credits),
        C.Col("Videos", 9, "right", fmt=T.FMT_INT_DASH, get=lambda e: e.videos),
        C.Col("Gen Time (min)", 13, "right", fmt=T.FMT_DECIMAL1, get=lambda e: e.gen_time),
        C.Col("Status", 11, "center", key="status"),
        C.Col("Reference ID", 22, "left", key="ref_id"),
    ]

    def tool_fill(_i, ev: Event):
        return T.solid(T.TINT_KLING) if ev.tool == "Kling" else T.solid(T.TINT_CHATGPT)

    header_row = row
    C.data_table(ws, cols, ds.merged_events, start_row=row, table_name="CombinedLog", row_fill=tool_fill)
    C.freeze_below(ws, header_row + 1, col=2)
