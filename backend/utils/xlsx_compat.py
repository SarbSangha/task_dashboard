"""
Make openpyxl output render the same in every Excel build.

openpyxl 3.1 writes each cell format (``<xf>`` in xl/styles.xml) with its
fill / number-format / font / border ids but without the matching
``applyFill`` / ``applyNumberFormat`` / ``applyFont`` / ``applyBorder`` flags.
Many Excel builds apply the ids anyway; some honour the flags strictly and
silently drop the fill and number format - which is how reports showed white
title bars, white-on-white headers and dates as raw serials like 46311.42326.
Excel itself always writes the flags, so this adds them after saving.
"""

from __future__ import annotations

import io
import re
import zipfile

_CELL_XFS = re.compile(r"<cellXfs\b[^>]*>.*?</cellXfs>", re.S)
_XF = re.compile(r"<xf\b([^>]*?)(/?)>")
_FLAGS = (
    ("numFmtId", "applyNumberFormat"),
    ("fontId", "applyFont"),
    ("fillId", "applyFill"),
    ("borderId", "applyBorder"),
)


def _flag_xf(match: re.Match) -> str:
    attrs, closing = match.group(1), match.group(2)
    for id_attr, flag in _FLAGS:
        id_match = re.search(rf'\b{id_attr}="(\d+)"', attrs)
        if id_match and id_match.group(1) != "0" and f"{flag}=" not in attrs:
            attrs += f' {flag}="1"'
    return f"<xf{attrs}{closing}>"


def add_apply_flags(styles_xml: str) -> str:
    return _CELL_XFS.sub(lambda m: _XF.sub(_flag_xf, m.group(0)), styles_xml)


def excel_safe(xlsx_bytes: bytes) -> bytes:
    """Return the workbook with explicit apply* flags on every cell format."""
    src = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "xl/styles.xml":
                data = add_apply_flags(data.decode("utf-8")).encode("utf-8")
            dst.writestr(item, data)
    return out.getvalue()
