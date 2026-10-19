"""
Credit Consumption Report - make Excel apply every cell format.

openpyxl writes each cell style (<xf> in styles.xml's <cellXfs>) with its
number format, font, fill and border ids but never the applyNumberFormat /
applyFont / applyFill / applyBorder flags (CellStyle.__attrs__ leaves them
out). Some Excel versions then ignore the format: dates show as 46294 and
₹ amounts as plain 1.52. After saving, set each flag on every xf whose id is
not the default 0. Nothing else in the file changes.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import zipfile

STYLES = "xl/styles.xml"
FLAGS = (("numFmtId", "applyNumberFormat"), ("fontId", "applyFont"), ("fillId", "applyFill"),
         ("borderId", "applyBorder"))
_CELL_XFS = re.compile(r"(<cellXfs\b[^>]*>)(.*?)(</cellXfs>)", re.S)
_XF = re.compile(r"<xf\b([^>]*?)(/?)>")


def _flag(match: re.Match) -> str:
    attrs, close = match.group(1), match.group(2)
    for id_attr, flag in FLAGS:
        m = re.search(rf'\b{id_attr}="(\d+)"', attrs)
        if m and m.group(1) != "0" and not re.search(rf"\b{flag}=", attrs):
            attrs += f' {flag}="1"'
    return f"<xf{attrs}{close}>"


def flag_styles(xml: str) -> str:
    m = _CELL_XFS.search(xml)
    if not m:
        return xml
    body = _XF.sub(_flag, m.group(2))
    return xml[: m.start()] + m.group(1) + body + m.group(3) + xml[m.end():]


def apply_style_flags(path: str) -> None:
    """Rewrite styles.xml inside the saved workbook at ``path`` (in place)."""
    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=os.path.dirname(os.path.abspath(path)) or None)
    os.close(fd)
    try:
        with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
            for item in src.infolist():
                data = src.read(item.filename)
                if item.filename == STYLES:
                    data = flag_styles(data.decode("utf-8")).encode("utf-8")
                dst.writestr(item, data)
        shutil.move(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


__all__ = ["apply_style_flags", "flag_styles"]
