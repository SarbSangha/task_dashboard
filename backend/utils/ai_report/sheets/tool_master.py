"""Sheet 4 -- Tool Master: the AI-tool inventory (all subscribed tools)."""

from __future__ import annotations

from openpyxl.worksheet.worksheet import Worksheet

from .. import components as C
from .. import theme as T
from ..dataset import ReportDataset

LAST_COL = 11


def render(ws: Worksheet, ds: ReportDataset) -> None:
    C.hide_gridlines(ws)

    row = C.title_band(
        ws, f"Tool Master — All {len(ds.tools)} Subscribed AI Tools",
        "Complete inventory · integration state · captured fields · ownership",
        last_col=LAST_COL,
    )

    cols = [
        C.Col("Tool Name", 20, "left", key="name"),
        C.Col("Vendor", 16, "left", key="vendor"),
        C.Col("Integration Status", 16, "center", key="integration_status"),
        C.Col("Category", 22, "left", key="category"),
        C.Col("Data Fields Captured", 40, "left", key="captured_fields"),
        C.Col("Version", 10, "center", key="version"),
        C.Col("API Status", 12, "center", key="api_status"),
        C.Col("Subscription", 14, "center", key="subscription"),
        C.Col("Owner", 18, "left", key="owner"),
        C.Col("Last Sync", 14, "center", fmt=T.FMT_DATE, get=lambda t: t.last_sync),
        C.Col("Future Expansion", 16, "center", key="future_expansion"),
    ]

    def status_fill(_i, tool):
        if tool.integration_status == "Integrated":
            return T.solid(T.FILL_INTEGRATED)
        return T.solid(T.FILL_PENDING)

    header_row = row
    next_row = C.data_table(
        ws, cols, ds.tools, start_row=row, table_name="ToolMaster", row_fill=status_fill,
    )
    C.freeze_below(ws, header_row + 1)

    # Totals callout below the table (mirrors the reference footer).
    integrated = sum(1 for t in ds.tools if t.integration_status == "Integrated")
    C.label_value(ws, "Total tools subscribed", f"{len(ds.tools)}", row=next_row, value_col=3)
    C.label_value(ws, "Tools currently integrated", f"{integrated}", row=next_row + 1, value_col=3)
