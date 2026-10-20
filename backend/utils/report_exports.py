"""
Report export engine.

CSV is always available (stdlib). Excel/PowerPoint/PDF are optional and guarded — if the
engine is not installed the caller gets a clear ExportUnavailable so the API can return 501
and the UI can disable that button (via the capabilities probe).
"""

import csv
import io
import re

from utils.report_render import build_html

MIMES = {
    "html": "text/html",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
}


class ExportUnavailable(Exception):
    pass


# ---- capability probe (used by the router's /capabilities endpoint) ----
def available_formats():
    formats = {"html": True, "csv": True, "xlsx": False, "pptx": False, "pdf": False}
    try:
        import openpyxl  # noqa: F401
        formats["xlsx"] = True
    except Exception:
        pass
    try:
        import pptx  # noqa: F401
        formats["pptx"] = True
    except Exception:
        pass
    try:
        import weasyprint  # noqa: F401
        formats["pdf"] = True
    except Exception:
        pass
    return formats


# ---- flatten a definition into tabular rows ----
def _flatten(definition, *, table_rows=True):
    rows = []  # (section, field, value)
    blocks = (definition or {}).get("blocks") or []
    for i, b in enumerate(blocks, start=1):
        kind = b.get("kind")
        if kind == "question":
            title = f"{i}. {b.get('q', '')}"
            if b.get("why"):
                rows.append((title, "Why", b["why"]))
            if b.get("metric"):
                rows.append((title, "Metric", b["metric"]))
            if b.get("decision"):
                rows.append((title, "Decision", b["decision"]))
        elif kind == "text":
            rows.append((f"{i}. {b.get('heading', 'Narrative')}", "Body", b.get("body", "")))
        elif kind == "kpis" or kind in ("live-exec", "live-kling", "live-cost"):
            title = f"{i}. {b.get('heading') or kind}"
            items = b.get("items") or b.get("snapshotItems") or []
            for it in items:
                rows.append((title, it.get("label", ""), it.get("value", "")))
        elif kind == "table":
            title = f"{i}. {b.get('title', 'Table')}"
            cols = b.get("columns") or []
            for r in b.get("rows") or []:
                rows.append((title, cols[0] if cols else "", " | ".join(str(c) for c in r)))
        # Live table blocks (golden prompts, prompt lists...) send their rows
        # pre-flattened as exportTables - see blockExportTables in the builder.
        for table in _export_tables(b):
            title = f"{i}. {table['title']}"
            if not table_rows:  # Excel: the rows live on the table's own sheet
                rows.append((title, "Rows", f"{len(table['rows'])} — see the sheet \"{_sheet_title(title, set())}\""))
                continue
            for n, r in enumerate(table["rows"], start=1):
                parts = [f"{col}: {_cell_text(c)}" for col, c in zip(table["columns"], r) if _cell_text(c) != ""]
                rows.append((title, f"Row {n}", " | ".join(parts)))
    return rows


def _export_tables(block):
    tables = []
    for t in (block or {}).get("exportTables") or []:
        if isinstance(t, dict) and isinstance(t.get("columns"), list) and isinstance(t.get("rows"), list):
            tables.append({"title": str(t.get("title") or "Table"), "columns": [str(c) for c in t["columns"]], "rows": t["rows"]})
    return tables


def _cell_links(cell):
    if isinstance(cell, dict):
        return [u for u in (cell.get("links") or []) if isinstance(u, str) and u.lower().startswith(("http://", "https://"))]
    return None


def _cell_text(cell):
    links = _cell_links(cell)
    if links is not None:
        return " ".join(links)
    # Control characters pasted into prompts make openpyxl refuse the workbook.
    return "" if cell is None else _ILLEGAL_CHARS.sub("", str(cell))


def _sheet_title(title, used):
    """Excel sheet names: <=31 chars, none of []:*?/\\, unique per workbook."""
    base = "".join(ch for ch in title if ch not in '[]:*?/\\').strip()[:31] or "Table"
    name, n = base, 2
    while name.lower() in used:
        suffix = f" ({n})"
        name, n = f"{base[:31 - len(suffix)]}{suffix}", n + 1
    used.add(name.lower())
    return name


_ILLEGAL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_NUMBER = re.compile(r"^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$")
_PERCENT = re.compile(r"^-?\d+(\.\d+)?%$")


def _as_number(text):
    """The builder sends display strings ("10,650", "100%"); Excel needs real
    numbers or it flags every cell as "number stored as text"."""
    text = (text or "").strip()
    if _NUMBER.match(text):
        value = float(text.replace(",", ""))
        return (int(value) if value.is_integer() else value), ("#,##0" if "," in text else None)
    if _PERCENT.match(text):
        return float(text[:-1]) / 100, "0.0%" if "." in text else "0%"
    return None, None


def _argb(hex_color, default="101F3F"):
    """openpyxl writes a 6-digit colour as transparent lowercase "00rrggbb",
    which Excel drops - leaving white header text on white. Always FF + upper."""
    value = (hex_color or "").strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
        value = default
    return f"FF{value.upper()}"


def _write_table_sheet(wb, table, used_titles, hdr_font, hdr_fill):
    from openpyxl.styles import Alignment, Font

    ws = wb.create_sheet(_sheet_title(table["title"], used_titles))
    cols, rows = table["columns"], table["rows"]
    # A links column fans out into one hyperlink column per output.
    widths = []
    for ci in range(len(cols)):
        counts = [len(_cell_links(r[ci])) for r in rows if ci < len(r) and _cell_links(r[ci]) is not None]
        widths.append(max(counts) if counts else None)
    header = []
    for col, n in zip(cols, widths):
        header.extend([col] if not n or n == 1 else [f"{col} {k}" for k in range(1, n + 1)])
    ws.append(header)
    for cell in ws[1]:
        cell.font, cell.fill = hdr_font, hdr_fill
    link_font = Font(color="0563C1", underline="single")
    for r in rows:
        out_row = ws.max_row + 1
        c_idx = 1
        for ci, n in enumerate(widths):
            value = r[ci] if ci < len(r) else ""
            if n is None:
                number, fmt = _as_number(_cell_text(value))
                cell = ws.cell(row=out_row, column=c_idx, value=_cell_text(value) if number is None else number)
                if fmt:
                    cell.number_format = fmt
                cell.alignment = Alignment(wrap_text=True, vertical="top")
                c_idx += 1
                continue
            links = _cell_links(value) or []
            for k in range(max(n, 1)):
                cell = ws.cell(row=out_row, column=c_idx + k)
                if k < len(links):
                    url = links[k]
                    if len(url) <= 2000:  # Excel's hyperlink length limit
                        cell.value, cell.hyperlink, cell.font = "View output", url, link_font
                    else:
                        cell.value = url
                cell.alignment = Alignment(vertical="top")
            c_idx += max(n, 1)
    from openpyxl.utils import get_column_letter

    for idx, name in enumerate(header, start=1):
        width = (
            80 if name == "Prompt"
            else 16 if name.startswith("Generation")
            else 30 if name in ("Used by", "Client")
            else max(12, min(40, len(name) + 4))
        )
        ws.column_dimensions[get_column_letter(idx)].width = width
    ws.freeze_panes = "A2"


def _report_title(definition):
    return ((definition or {}).get("branding") or {}).get("title") or "report"


# ---- exporters ----
def _csv_bytes(definition):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Section", "Field", "Value"])
    for section, field, value in _flatten(definition):
        w.writerow([section, field, value])
    return buf.getvalue().encode("utf-8-sig")


def _xlsx_bytes(definition):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill
    except Exception as exc:
        raise ExportUnavailable("Excel export requires the 'openpyxl' package.") from exc

    branding = (definition or {}).get("branding") or {}
    navy = _argb(branding.get("navy"))
    wb = Workbook()
    ws = wb.active
    ws.title = "Report"
    ws.append([_report_title(definition)])
    ws["A1"].font = Font(size=14, bold=True)
    ws.append([])
    header = ["Section", "Field", "Value"]
    ws.append(header)
    hdr_fill = PatternFill("solid", fgColor=navy)
    for col in range(1, 4):
        cell = ws.cell(row=3, column=col)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = hdr_fill
    for section, field, value in _flatten(definition, table_rows=False):
        ws.append([section, field, value])
    ws.column_dimensions["A"].width = 46
    ws.column_dimensions["B"].width = 18
    ws.column_dimensions["C"].width = 60
    # Each live table (golden prompts, prompt lists...) also gets a sheet of
    # its own with real columns and clickable output links.
    used_titles = {"report"}
    for i, b in enumerate((definition or {}).get("blocks") or [], start=1):
        for table in _export_tables(b):
            _write_table_sheet(wb, {**table, "title": f"{i}. {table['title']}"}, used_titles, Font(bold=True, color="FFFFFF"), hdr_fill)
    from utils.xlsx_compat import excel_safe

    out = io.BytesIO()
    wb.save(out)
    return excel_safe(out.getvalue())


def _pptx_bytes(definition):
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt
        from pptx.dml.color import RGBColor
    except Exception as exc:
        raise ExportUnavailable("PowerPoint export requires the 'python-pptx' package.") from exc

    branding = (definition or {}).get("branding") or {}
    navy_hex = (branding.get("navy") or "#101f3f").lstrip("#")
    gold_hex = (branding.get("gold") or "#c99a2e").lstrip("#")
    navy = RGBColor.from_string(navy_hex)
    gold = RGBColor.from_string(gold_hex)

    prs = Presentation()
    blank = prs.slide_layouts[6]

    # Title slide
    s = prs.slides.add_slide(blank)
    bg = s.background
    bg.fill.solid()
    bg.fill.fore_color.rgb = navy
    tb = s.shapes.add_textbox(Inches(0.7), Inches(2.2), Inches(9), Inches(2))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = branding.get("title") or "Corporate Report"
    p.font.size = Pt(34)
    p.font.bold = True
    p.font.color.rgb = RGBColor.from_string("FFFFFF")
    p2 = tf.add_paragraph()
    p2.text = branding.get("subtitle") or "AI Intelligence Report"
    p2.font.size = Pt(16)
    p2.font.color.rgb = gold

    for i, b in enumerate(( definition or {}).get("blocks") or [], start=1):
        s = prs.slides.add_slide(blank)
        title = b.get("q") or b.get("heading") or b.get("title") or b.get("kind")
        tb = s.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(9), Inches(1))
        tp = tb.text_frame.paragraphs[0]
        tp.text = f"{i}. {title}"
        tp.font.size = Pt(24)
        tp.font.bold = True
        tp.font.color.rgb = navy
        body = s.shapes.add_textbox(Inches(0.7), Inches(1.6), Inches(8.6), Inches(4.5)).text_frame
        body.word_wrap = True
        lines = []
        if b.get("why"):
            lines.append(f"Why: {b['why']}")
        if b.get("metric"):
            lines.append(f"Metric: {b['metric']}")
        if b.get("decision"):
            lines.append(f"Decision: {b['decision']}")
        if b.get("body"):
            lines.append(b["body"])
        for it in (b.get("items") or b.get("snapshotItems") or []):
            lines.append(f"{it.get('label', '')}: {it.get('value', '')}")
        for r in (b.get("rows") or []):
            lines.append(" | ".join(str(c) for c in r))
        first = True
        for ln in lines or ["(no detail)"]:
            para = body.paragraphs[0] if first else body.add_paragraph()
            para.text = ln
            para.font.size = Pt(14)
            first = False

    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def _pdf_bytes(definition, html_snapshot=None):
    try:
        from weasyprint import HTML
    except Exception as exc:
        raise ExportUnavailable(
            "Server-side PDF requires 'weasyprint'. Use the browser 'Print / Save as PDF' in the Report Builder, or install weasyprint on the server."
        ) from exc
    html = html_snapshot or build_html(definition)
    return HTML(string=html).write_pdf()


def export_report(definition, fmt, html_snapshot=None):
    """Return (bytes, mimetype, extension). Raises ExportUnavailable if engine missing."""
    fmt = (fmt or "").lower()
    if fmt == "html":
        return (html_snapshot or build_html(definition)).encode("utf-8"), MIMES["html"], "html"
    if fmt == "csv":
        return _csv_bytes(definition), MIMES["csv"], "csv"
    if fmt == "xlsx":
        return _xlsx_bytes(definition), MIMES["xlsx"], "xlsx"
    if fmt == "pptx":
        return _pptx_bytes(definition), MIMES["pptx"], "pptx"
    if fmt == "pdf":
        return _pdf_bytes(definition, html_snapshot), MIMES["pdf"], "pdf"
    raise ExportUnavailable(f"Unknown export format: {fmt}")
