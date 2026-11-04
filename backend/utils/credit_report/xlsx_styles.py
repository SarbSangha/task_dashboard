"""
Credit Consumption Report - make Excel apply every cell format.

openpyxl writes each cell style (<xf> in styles.xml's <cellXfs>) with its
number format, font, fill and border ids but never the applyNumberFormat /
applyFont / applyFill / applyBorder flags (CellStyle.__attrs__ leaves them
out). Some Excel versions then ignore the format: dates show as 46294 and
₹ amounts as plain 1.52. After saving, set each flag on every xf whose id is
not the default 0. Nothing else in the file changes.

apply_merges adds merged ranges to a saved sheet: openpyxl's write-only
sheets (the big report workbooks) cannot merge cells themselves.
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


def _rewrite(path: str, edit, add: dict | None = None) -> None:
    """Rewrite the saved workbook at ``path`` in place, passing each part's
    name and text through edit(name, xml) -> xml (None = leave it as is);
    ``add``: new parts, name -> bytes."""
    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=os.path.dirname(os.path.abspath(path)) or None)
    os.close(fd)
    try:
        with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
            for item in src.infolist():
                data = src.read(item.filename)
                if item.filename.endswith(".xml") or item.filename.endswith(".rels"):
                    changed = edit(item.filename, data.decode("utf-8"))
                    if changed is not None:
                        data = changed.encode("utf-8")
                dst.writestr(item, data)
            for name, data in (add or {}).items():
                dst.writestr(name, data)
        shutil.move(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def apply_style_flags(path: str) -> None:
    """Rewrite styles.xml inside the saved workbook at ``path`` (in place)."""
    _rewrite(path, lambda name, xml: flag_styles(xml) if name == STYLES else None)


def _sheet_part(path: str, sheet: str) -> str:
    """The zip part holding the sheet named ``sheet``, e.g. xl/worksheets/sheet1.xml."""
    with zipfile.ZipFile(path) as z:
        book = z.read("xl/workbook.xml").decode("utf-8")
        rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    for tag in re.findall(r"<sheet\b[^>]*>", book):
        name = re.search(r'\bname="([^"]*)"', tag)
        if name and name.group(1) == sheet:
            rid = re.search(r'\br:id="([^"]*)"', tag).group(1)
            for rel in re.findall(r"<Relationship\b[^>]*>", rels):
                if re.search(rf'\bId="{re.escape(rid)}"', rel):
                    target = re.search(r'\bTarget="([^"]*)"', rel).group(1)
                    return target.lstrip("/") if target.startswith("/") else "xl/" + target
    raise KeyError(f"no sheet named {sheet!r}")


# Elements the schema allows between </sheetData> and <mergeCells>.
_BEFORE_MERGES = ("sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState",
                  "dataConsolidate", "customSheetViews")


def merge_cells(xml: str, refs: list) -> str:
    """Sheet xml with each ref (e.g. "B12:C12") merged."""
    cells = "".join(f'<mergeCell ref="{ref}"/>' for ref in refs)
    existing = re.search(r"<mergeCells\b[^>]*>(.*?)</mergeCells>", xml, re.S)
    if existing:
        merged = existing.group(1) + cells
        return (xml[: existing.start()] + f'<mergeCells count="{merged.count("<mergeCell ")}">{merged}</mergeCells>'
                + xml[existing.end():])
    at = xml.index("</sheetData>") + len("</sheetData>")
    while True:
        m = re.match(r"\s*<(\w+)\b[^>]*?(?:/>|>.*?</\1>)", xml[at:], re.S)
        if not m or m.group(1) not in _BEFORE_MERGES:
            break
        at += m.end()
    return xml[:at] + f'<mergeCells count="{len(refs)}">{cells}</mergeCells>' + xml[at:]


def apply_merges(path: str, sheet: str, refs: list) -> None:
    """Merge each ref on ``sheet`` of the saved workbook at ``path`` (in place)."""
    if not refs:
        return
    part = _sheet_part(path, sheet)
    _rewrite(path, lambda name, xml: merge_cells(xml, refs) if name == part else None)


XLSM_MIMETYPE = "application/vnd.ms-excel.sheet.macroEnabled.12"
_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
_MACRO_MAIN = "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
_VBA = "application/vnd.ms-office.vbaProject"
_VBA_REL = "http://schemas.microsoft.com/office/2006/relationships/vbaProject"


def add_vba_project(path: str, vba: bytes) -> None:
    """Make the saved workbook at ``path`` macro-enabled (save it as .xlsm)
    with ``vba``, a vbaProject.bin whose ThisWorkbook module becomes the
    workbook's (its codeName is set to ThisWorkbook)."""
    def edit(name: str, xml: str):
        if name == "[Content_Types].xml":
            xml = xml.replace(_MAIN, _MACRO_MAIN)
            return xml.replace("<Default ", f'<Default Extension="bin" ContentType="{_VBA}"/><Default ', 1)
        if name == "xl/_rels/workbook.xml.rels":
            return xml.replace("</Relationships>",
                               f'<Relationship Type="{_VBA_REL}" Target="/xl/vbaProject.bin" Id="rIdVba"/>'
                               "</Relationships>")
        if name == "xl/workbook.xml":
            if re.search(r"<workbookPr\b[^>]*\bcodeName=", xml):
                return xml
            if re.search(r"<workbookPr\b", xml):
                return re.sub(r"<workbookPr\b", '<workbookPr codeName="ThisWorkbook"', xml, count=1)
            return re.sub(r"(<workbook\b[^>]*>(?:<fileVersion\b[^>]*/>)?)", r'\1<workbookPr codeName="ThisWorkbook"/>',
                          xml, count=1)
        return None
    _rewrite(path, edit, add={"xl/vbaProject.bin": vba})


__all__ = ["XLSM_MIMETYPE", "add_vba_project", "apply_merges", "apply_style_flags", "flag_styles", "merge_cells"]
