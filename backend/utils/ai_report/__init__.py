"""
AI Tool Usage Workbook generator.

A purpose-built, multi-sheet Excel report (Read Me / Dashboard / Overview /
Tool Master / Employee Summary / per-provider usage logs) rendered from a live
snapshot of the AI-usage database. Deliberately separate from
``utils.report_exports`` (the generic Report-Builder flattener): this package
owns one specific, executive-grade workbook layout.

Public entry point::

    from utils.ai_report import build_ai_workbook
    data, mimetype, filename = build_ai_workbook(db)

The build is a single DB read pass -> a typed ``ReportDataset`` -> openpyxl
rendering. Adding a new AI provider (Claude, Gemini, ...) means registering one
mapper in ``providers.py``; no existing sheet code changes.
"""

from .workbook import build_ai_workbook, XLSX_MIMETYPE  # noqa: F401

__all__ = ["build_ai_workbook", "XLSX_MIMETYPE"]
