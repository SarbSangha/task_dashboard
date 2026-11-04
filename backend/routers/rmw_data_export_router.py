"""Excel exports for the RMW Data tool tabs (Kling, Freepik, HeyGen, ...).

One endpoint, one workbook per tool: a Summary sheet (totals, top people,
departments, statuses) followed by one sheet per record type the tab shows
(generations, downloads, prompts, ...). The column lists are curated rather
than reflected from the models: the tables carry dozens of internal columns
(capture ids, mirror bookkeeping, raw JSON) that mean nothing in a
spreadsheet, so each SheetSpec names what a person reading the export needs.

Access mirrors the tabs themselves: Kling is visible to anyone with RMW Data
access, every other tool's capture API is admin-only, so its export is too.
"""

from __future__ import annotations

import io
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from sqlalchemy import Text, cast, func, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationProject, GenerationRecord, User
from routers.generation_records_router import KlingFilterParams, apply_kling_filters
from providers.claude_code.models import ClaudeCodePrompt, ClaudeCodeRequest
from providers.cursor.models import CursorPrompt, CursorUsageEvent
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.envato.models import EnvatoDownload, EnvatoGeneration
from providers.epidemicsound.models import EpidemicAdaptation, EpidemicDownload
from providers.figma.models import FigmaPrompt
from providers.flow.models import FlowGeneration
from providers.freepik.models import FreepikDownload, FreepikGeneration, FreepikSearchQuery
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.splice.models import SpliceDownload
from providers.suno.models import SunoGeneration
from utils import r2_storage
from utils.datetime_utils import serialize_utc_datetime
from utils.permissions import has_any_role, require_admin, require_rmw_data_access
from utils.xlsx_compat import excel_safe

router = APIRouter(prefix="/api/rmw-data/export", tags=["RMW Data Export"])

IST = timezone(timedelta(hours=5, minutes=30))
IST_OFFSET = timedelta(hours=5, minutes=30)
# A sheet stops here; the Summary says so when it happens. Keeps one request
# from building a workbook too big to open comfortably.
MAX_ROWS_PER_SHEET = 50_000
MAX_CELL_CHARS = 32_000  # Excel's hard limit is 32,767

BRAND_FILL = PatternFill("solid", fgColor="0F9F6E")
SUBTLE_FILL = PatternFill("solid", fgColor="EEF7F3")
HEADER_FONT = Font(bold=True, color="FFFFFF")
TITLE_FONT = Font(bold=True, size=15)
SECTION_FONT = Font(bold=True, size=11, color="0F7A55")
_ILLEGAL_XML_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


# ── Sheet specs ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Col:
    header: str
    # Attribute name(s) on the model; "a|b" means the first non-empty one.
    attr: str = ""
    kind: str = "text"  # text | long | number | datetime | bool | url
    width: int = 18
    getter: Optional[Callable[[Any], Any]] = None


@dataclass(frozen=True)
class SheetSpec:
    title: str
    model: Any
    time_attrs: tuple[str, ...]
    owner_attr: Optional[str] = "owner_user_id"
    columns: tuple[Col, ...] = ()
    search_attrs: tuple[str, ...] = ()
    status_attr: Optional[str] = None
    credits_attr: Optional[str] = None  # attr name or callable via Col getter
    credits_getter: Optional[Callable[[Any], Any]] = None
    archived_attr: Optional[str] = "archived_at"
    base_filter: Optional[Callable[[Any], Any]] = None
    # Extra Summary tables: (title, key getter(record, owner)) -> records + credits per key.
    breakdowns: tuple = ()


@dataclass(frozen=True)
class ToolSpec:
    key: str
    label: str
    admin_only: bool
    sheets: tuple[SheetSpec, ...] = field(default_factory=tuple)


def _kling_credits(record):
    return record.admin_credits if record.admin_credits is not None else record.credits_burned


def _kling_meta(record) -> dict:
    return record.metadata_json if isinstance(record.metadata_json, dict) else {}


def _kling_account(record):
    return _kling_meta(record).get("klingAccountLabel")


def _kling_output(record):
    kinds = {
        asset.get("assetType")
        for asset in (_kling_meta(record).get("mediaAssets") or [])
        if isinstance(asset, dict)
    }
    if "video" in kinds:
        return "Video"
    if kinds & {"image", "media"}:
        return "Image"
    return "None captured"


def _kling_capture(record):
    return "History import" if _kling_meta(record).get("source") == "asset_history_discovered" else "Live capture"


def _kling_issues(record):
    issues = []
    if _kling_credits(record) is None:
        issues.append("No credits")
    if not (record.prompt_text or "").strip():
        issues.append("No prompt")
    if not record.canonical_asset_url:
        issues.append("No file")
    return ", ".join(issues) or None


def _ist_month_of(record, spec):
    value = None
    for name in spec.time_attrs:
        value = getattr(record, name, None)
        if value:
            break
    if not value:
        return "Unknown"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(IST).strftime("%Y-%m (%b)")


def _ist_month(record):
    value = record.created_at
    if not value:
        return "Unknown"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(IST).strftime("%Y-%m (%b)")


_OWNERSHIP = Col("Ownership", "ownership_status", width=13)
_TASK = Col("Linked task", "linked_task_name", width=26)
_CLIENT = Col("Client", "linked_client_name", width=20)

TOOLS: dict[str, ToolSpec] = {
    "kling": ToolSpec("kling", "Kling", admin_only=False, sheets=(
        SheetSpec(
            # Filtering (including provider/archived) comes from the shared
            # KlingFilterParams, so archived_attr/base_filter stay unset.
            "Generations", GenerationRecord, ("created_at",), archived_attr=None,
            columns=(
                Col("Prompt", "prompt_text", "long", 60),
                Col("Kling account", width=28, getter=_kling_account),
                Col("Output", width=12, getter=_kling_output),
                Col("Credits", kind="number", width=10, getter=_kling_credits),
                Col("Model", "model_label", width=18),
                Col("Duration", "duration_label", width=10),
                Col("Resolution", "resolution_label", width=11),
                Col("Project", "_project_name", width=20),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Capture", width=15, getter=_kling_capture),
                Col("Duplicate", width=10, getter=lambda r: "Yes" if _kling_meta(r).get("crossUserDuplicate") else None),
                Col("Data issues", width=22, getter=_kling_issues),
                Col("Favourite", "is_favorite", "bool", 10),
                Col("Kling task ID", "provider_task_id", width=20),
                Col("Asset", "canonical_asset_url", "url", 40),
            ),
            search_attrs=("prompt_text", "model_label", "provider_task_id"),
            status_attr="ownership_status",
            credits_getter=_kling_credits,
            breakdowns=(
                ("By Kling account", lambda r, o: _kling_account(r) or "Unknown"),
                ("By month", lambda r, o: _ist_month(r)),
                ("By output", lambda r, o: _kling_output(r)),
                ("By linked client", lambda r, o: r.linked_client_name or "No client"),
                ("Data issues", lambda r, o: _kling_issues(r) or "Complete"),
            ),
        ),
    )),
    "freepik": ToolSpec("freepik", "Freepik", admin_only=True, sheets=(
        SheetSpec(
            "Generations", FreepikGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Prompt", "prompt|input_prompt|name_field", "long", 60),
                Col("Tool", "tool_name|tool", width=18),
                Col("Mode", "mode", width=12),
                Col("Status", "status", width=12),
                Col("Resolution", "resolution", width=12),
                Col("Aspect ratio", "aspect_ratio", width=12),
                Col("Credits", "credits_charged", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Asset", "mirrored_asset_url|download_url|preview_url|web_url", "url", 40),
            ),
            search_attrs=("prompt", "input_prompt", "tool_name", "linked_task_name", "linked_client_name"),
            status_attr="status", credits_attr="credits_charged",
        ),
        SheetSpec(
            "Downloads", FreepikDownload, ("downloaded_at", "created_at"), archived_attr=None,
            columns=(
                Col("Title", "asset_title", "long", 44),
                Col("Search term", "search_term", width=22),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Source", "asset_source_url|page_url", "url", 40),
            ),
            search_attrs=("asset_title", "search_term", "linked_task_name"),
        ),
        SheetSpec(
            "Searches", FreepikSearchQuery, ("searched_at", "created_at"), archived_attr=None,
            columns=(
                Col("Search term", "search_term", "long", 40),
                Col("Results", "result_count_label", width=14),
                Col("Site", "source_host", width=20),
                Col("Page", "page_url", "url", 40),
            ),
            search_attrs=("search_term",),
        ),
    )),
    "heygen": ToolSpec("heygen", "HeyGen", admin_only=True, sheets=(
        SheetSpec(
            "Generations", HeygenGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Script", "script_text", "long", 60),
                Col("Avatar", "avatar_name", width=18),
                Col("Voice", "voice_name", width=18),
                Col("Language", "voice_language", width=12),
                Col("Duration (s)", "duration_seconds", "number", 12),
                Col("Resolution", "resolution", width=12),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Video", "mirrored_asset_url|video_url|download_url|share_url", "url", 40),
            ),
            search_attrs=("script_text", "avatar_name", "voice_name", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
    "higgsfield": ToolSpec("higgsfield", "Higgsfield", admin_only=True, sheets=(
        SheetSpec(
            "Generations", HiggsfieldGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Prompt", "prompt_text", "long", 60),
                Col("Kind", "kind", width=12),
                Col("Preset", "preset_name", width=20),
                Col("Duration (s)", "duration_seconds", "number", 12),
                Col("Resolution", "resolution", width=12),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                Col("Refunded", "credits_refunded", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("File", "video_url|download_url|preview_url", "url", 40),
            ),
            search_attrs=("prompt_text", "preset_name", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
    "envato": ToolSpec("envato", "Envato", admin_only=True, sheets=(
        SheetSpec(
            "Generations", EnvatoGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Prompt", "prompt|title", "long", 60),
                Col("Type", "item_type", width=14),
                Col("Style", "style", width=16),
                Col("Aspect ratio", "aspect_ratio", width=12),
                Col("Downloaded", "is_downloaded", "bool", 11),
                Col("Credits", "credits_badge", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Asset", "canvas_url|fallback_url|thumbnail_url", "url", 40),
            ),
            search_attrs=("prompt", "title", "linked_task_name"),
            status_attr="review_status", credits_attr="credits_badge",
        ),
        SheetSpec(
            "Downloads", EnvatoDownload, ("downloaded_at", "created_at"), archived_attr=None,
            columns=(
                Col("Title", "asset_title", "long", 44),
                Col("Type", "item_type", width=14),
                Col("Search term", "search_term", width=22),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Source", "asset_source_url|page_url", "url", 40),
            ),
            search_attrs=("asset_title", "search_term", "linked_task_name"),
        ),
    )),
    "flow": ToolSpec("flow", "Flow", admin_only=True, sheets=(
        SheetSpec(
            "Generations", FlowGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Prompt", "prompt", "long", 60),
                Col("Model", "model_name", width=18),
                Col("Media", "media_type", width=10),
                Col("Duration (s)", "duration_seconds", "number", 12),
                Col("Resolution", "resolution", width=12),
                Col("Outputs", "output_count", "number", 9),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Media URL", "media_url", "url", 40),
            ),
            search_attrs=("prompt", "model_name", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
    "elevenlabs": ToolSpec("elevenlabs", "ElevenLabs", admin_only=True, sheets=(
        SheetSpec(
            "Generations", ElevenlabsGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Text", "prompt", "long", 60),
                Col("Voice", "voice_name", width=18),
                Col("Source", "source", width=14),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Audio", "media_url", "url", 40),
            ),
            search_attrs=("prompt", "voice_name", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
    "suno": ToolSpec("suno", "Suno", admin_only=True, sheets=(
        SheetSpec(
            "Generations", SunoGeneration, ("provider_created_at", "created_at"),
            columns=(
                Col("Prompt", "prompt", "long", 60),
                Col("Model", "model_name", width=16),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Audio", "media_url", "url", 40),
            ),
            search_attrs=("prompt", "model_name", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
    "epidemicsound": ToolSpec("epidemicsound", "Epidemic Sound", admin_only=True, sheets=(
        SheetSpec(
            "Downloads", EpidemicDownload, ("downloaded_at", "created_at"), archived_attr=None,
            columns=(
                Col("Title", "asset_title", "long", 44),
                Col("Sound effect", "is_sfx", "bool", 12),
                Col("Quality", "quality_type", width=12),
                Col("Stem", "stem_type", width=12),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Source", "asset_source_url|page_url", "url", 40),
            ),
            search_attrs=("asset_title", "linked_task_name"),
        ),
        SheetSpec(
            "Adaptations", EpidemicAdaptation, ("created_at",), archived_attr=None,
            columns=(
                Col("Original track", "original_track_title", "long", 36),
                Col("Prompt", "prompt", "long", 48),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Audio", "media_url", "url", 40),
            ),
            search_attrs=("original_track_title", "prompt", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
    "splice": ToolSpec("splice", "Splice", admin_only=True, sheets=(
        SheetSpec(
            "Downloads", SpliceDownload, ("downloaded_at", "created_at"), archived_attr=None,
            columns=(
                Col("Sample", "asset_title", "long", 44),
                _TASK, _CLIENT, _OWNERSHIP,
                Col("Source", "asset_source_url|page_url", "url", 40),
            ),
            search_attrs=("asset_title", "linked_task_name"),
        ),
    )),
    "cursor": ToolSpec("cursor", "Cursor", admin_only=True, sheets=(
        SheetSpec(
            "Prompts", CursorPrompt, ("prompted_at", "created_at"), archived_attr=None,
            columns=(
                Col("Prompt", "prompt_text", "long", 60),
                Col("Chat", "conversation_name", width=26),
                Col("Mode", "mode", width=10),
                Col("Cursor account", "cursor_account_email", width=26),
                Col("Plan", "cursor_plan", width=10),
                Col("Device", "device_name", width=18),
                Col("Input tokens", "local_input_tokens", "number", 12),
                Col("Output tokens", "local_output_tokens", "number", 12),
            ),
            search_attrs=("prompt_text", "conversation_name", "cursor_account_email"),
        ),
        SheetSpec(
            "Usage", CursorUsageEvent, ("occurred_at", "created_at"), owner_attr=None, archived_attr=None,
            columns=(
                Col("Cursor account", "cursor_account_email", width=28),
                Col("Model", "model", width=22),
                Col("Kind", "kind", width=16),
                Col("Max mode", "max_mode", "bool", 10),
                Col("Input tokens", "input_tokens", "number", 12),
                Col("Output tokens", "output_tokens", "number", 12),
                Col("Cache read", "cache_read_tokens", "number", 12),
                Col("Cache write", "cache_write_tokens", "number", 12),
                Col("Cost (USD)", kind="number", width=11,
                    getter=lambda r: round(r.cost_cents / 100, 4) if r.cost_cents is not None else None),
            ),
            search_attrs=("cursor_account_email", "model", "kind"),
            status_attr="model",
            credits_getter=lambda r: round(r.cost_cents / 100, 4) if r.cost_cents is not None else None,
        ),
    )),
    "claudecode": ToolSpec("claudecode", "Claude Code", admin_only=True, sheets=(
        SheetSpec(
            "Prompts", ClaudeCodePrompt, ("prompted_at", "created_at"), archived_attr=None,
            columns=(
                Col("Prompt", "prompt_text", "long", 60),
                Col("Command", "command_name", width=16),
                Col("Session", "session_id", width=20),
                Col("Account", "account_email", width=26),
                Col("Terminal", "terminal_type", width=14),
                Col("Version", "claude_version", width=10),
            ),
            search_attrs=("prompt_text", "account_email", "command_name"),
        ),
        SheetSpec(
            "Requests", ClaudeCodeRequest, ("occurred_at", "created_at"), archived_attr=None,
            columns=(
                Col("Model", "model", width=24),
                Col("Cost (USD)", "cost_usd", "number", 11),
                Col("Input tokens", "input_tokens", "number", 12),
                Col("Output tokens", "output_tokens", "number", 12),
                Col("Cache read", "cache_read_tokens", "number", 12),
                Col("Cache write", "cache_write_tokens", "number", 12),
                Col("Duration (ms)", "duration_ms", "number", 12),
                Col("Session", "session_id", width=20),
                Col("Account", "account_email", width=26),
            ),
            search_attrs=("model", "account_email"),
            status_attr="model", credits_attr="cost_usd",
        ),
    )),
    "figma": ToolSpec("figma", "Figma", admin_only=True, sheets=(
        SheetSpec(
            "Prompts", FigmaPrompt, ("prompted_at", "created_at"), archived_attr=None,
            columns=(
                Col("Prompt", "prompt_text", "long", 60),
                Col("File", "file_name", width=26),
                Col("Status", "status", width=12),
                Col("Credits", "credits_used", "number", 10),
                Col("Plan", "plan_tier", width=12),
                Col("Figma account", "figma_email", width=26),
                _TASK, _CLIENT,
                Col("File link", "file_url", "url", 40),
            ),
            search_attrs=("prompt_text", "file_name", "figma_email", "linked_task_name"),
            status_attr="status", credits_attr="credits_used",
        ),
    )),
}


# Envato is used mostly to download stock: list Downloads first.
TOOLS["envato"] = replace(TOOLS["envato"], sheets=tuple(reversed(TOOLS["envato"].sheets)))


# ── Per-tool export filters ──────────────────────────────────────────────────
#
# Picked from each tool's captured data (see the RMW Data export notes):
# only fields that actually vary, e.g. Freepik's tool/model, ElevenLabs'
# TTS vs music, Envato's downloaded-or-not. Keyed by sheet model.

@dataclass(frozen=True)
class FilterDef:
    key: str
    label: str
    attr: str
    kind: str = "select"  # select | bool | range
    labels: tuple = ()  # ((stored value, display label), ...)
    breakdown: bool = True  # also add a "By <label>" table to the Summary


def _f(key, label, attr, **kwargs):
    return FilterDef(key, label, attr, **kwargs)


_CAPTURE = _f("capture", "Captured by", "generation_source",
              labels=(("live_capture", "Live capture"), ("reconciliation", "History import")))
_SAVED = _f("saved", "Saved copy", "asset_mirror_status",
            labels=(("mirrored", "Saved"), ("failed", "Copy failed"), ("pending", "Copy pending"), ("skipped", "Not copied")))


def _credits(attr, label="Credits"):
    return _f("credits", label, attr, kind="range", breakdown=False)


SHEET_FILTERS: dict = {
    FreepikGeneration: (
        _f("tool", "Tool", "tool_name"), _f("model", "Model", "mode"), _f("resolution", "Resolution", "resolution"),
        _f("aspect", "Aspect ratio", "aspect_ratio"), _CAPTURE, _SAVED, _credits("credits_charged"),
    ),
    FreepikDownload: (_f("term", "Search term", "search_term"),),
    FreepikSearchQuery: (_f("term", "Search term", "search_term"),),
    HeygenGeneration: (
        _f("status", "Status", "status"), _f("resolution", "Resolution", "resolution"),
        _f("aspect", "Aspect ratio", "aspect_ratio"), _f("engine", "Motion engine", "motion_engine"),
        _CAPTURE, _SAVED, _credits("credits_used"),
    ),
    HiggsfieldGeneration: (
        _f("output", "Output", "output_type"), _f("model", "Model", "preset_category"), _f("quality", "Quality", "quality"),
        _f("resolution", "Resolution", "resolution"), _f("aspect", "Aspect ratio", "aspect_ratio"), _credits("credits_used"),
    ),
    EnvatoDownload: (_f("type", "Item type", "item_type"), _f("term", "Search term", "search_term")),
    EnvatoGeneration: (_f("downloaded", "Downloaded", "is_downloaded", kind="bool"), _credits("credits_badge")),
    FlowGeneration: (_f("model", "Model", "model_name"), _SAVED),
    ElevenlabsGeneration: (
        _f("type", "Type", "source"), _f("voice", "Voice", "voice_name"), _f("status", "Status", "status"),
        _CAPTURE, _SAVED, _credits("credits_used"),
    ),
    SunoGeneration: (
        _f("model", "Model", "model_name"), _f("version", "Version", "major_model_version"),
        _f("status", "Status", "status"), _CAPTURE, _SAVED, _credits("credits_used"),
    ),
    EpidemicDownload: (_f("sfx", "Sound effect", "is_sfx", kind="bool"), _f("quality", "Quality", "quality_type")),
    EpidemicAdaptation: (_f("status", "Status", "status"), _credits("credits_used")),
    SpliceDownload: (),
    CursorPrompt: (_f("chat", "Chat", "conversation_name"), _f("mode", "Mode", "mode"),
                   _f("account", "Cursor account", "cursor_account_email")),
    CursorUsageEvent: (
        _f("model", "Model", "model"), _f("kind", "Kind", "kind"), _f("account", "Cursor account", "cursor_account_email"),
        _f("max", "Max mode", "max_mode", kind="bool"), _credits("cost_cents", "Cost (cents)"),
    ),
    ClaudeCodePrompt: (_f("terminal", "Terminal", "terminal_type"), _f("account", "Account", "account_email"),
                       _f("version", "Version", "claude_version")),
    ClaudeCodeRequest: (_f("model", "Model", "model"), _f("terminal", "Terminal", "terminal_type"),
                        _f("account", "Account", "account_email"), _credits("cost_usd", "Cost (USD)")),
    FigmaPrompt: (_f("origin", "Origin", "origin"), _f("status", "Status", "status"), _f("plan", "Plan", "plan_tier"),
                  _credits("credits_used")),
}

LINKED_LABELS = {
    "task": "Linked to a task", "no_task": "No linked task", "client": "Linked to a client",
    "no_client": "No linked client", "unlinked": "No task or client",
}
OWNERSHIP_LABELS = {"resolved": "Owner known", "unknown": "Owner unknown"}


def sheet_key(spec: SheetSpec) -> str:
    return spec.title.lower().replace(" ", "_")


def _sheet_filters(spec: SheetSpec) -> tuple:
    return SHEET_FILTERS.get(spec.model, ())


def _value_label(fd: FilterDef, value) -> str:
    if fd.kind == "bool":
        return "Yes" if value in (True, "yes") else "No"
    mapping = dict(fd.labels)
    text = f"{value}"
    return mapping.get(text, text)


@dataclass
class ToolFilters:
    q: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    owner_user_id: Optional[int] = None
    unassigned: bool = False  # owner_user_id=none: records nobody owns yet
    department: Optional[str] = None
    linked: Optional[str] = None
    client: Optional[str] = None
    ownership: Optional[str] = None
    sheets: Optional[set] = None  # None = every sheet
    per_sheet: dict = field(default_factory=dict)  # sheet key -> {filter key: value}

    def includes(self, spec: SheetSpec) -> bool:
        return self.sheets is None or sheet_key(spec) in self.sheets

    def describe(self, db: Session, tool: ToolSpec) -> list[str]:
        fmt = "%d %b %Y"
        parts = []
        if self.q:
            parts.append(f'Search: "{self.q}"')
        if self.date_from or self.date_to:
            start = self.date_from.strftime(fmt) if self.date_from else "start"
            end = self.date_to.strftime(fmt) if self.date_to else "today"
            parts.append(f"Dates: {start} – {end}")
        if self.unassigned:
            parts.append("Person: Unassigned")
        elif self.owner_user_id is not None:
            name = db.query(User.name).filter(User.id == self.owner_user_id).scalar()
            parts.append(f"Person: {name or self.owner_user_id}")
        if self.department:
            parts.append(f"Department: {self.department}")
        if self.linked:
            parts.append(LINKED_LABELS[self.linked])
        if self.client:
            parts.append(f"Client: {self.client}")
        if self.ownership:
            parts.append(OWNERSHIP_LABELS[self.ownership])
        if self.sheets is not None:
            parts.append("Sheets: " + ", ".join(s.title for s in tool.sheets if self.includes(s)))
        for spec in tool.sheets:
            values = self.per_sheet.get(sheet_key(spec), {})
            for fd in _sheet_filters(spec):
                if fd.kind == "range":
                    low, high = values.get(f"{fd.key}_min"), values.get(f"{fd.key}_max")
                    if low is not None or high is not None:
                        parts.append(f"{spec.title} · {fd.label}: {low if low is not None else 0:g} – "
                                     f"{'any' if high is None else f'{high:g}'}")
                elif values.get(fd.key) is not None:
                    parts.append(f"{spec.title} · {fd.label}: {_value_label(fd, values[fd.key])}")
        return parts


def _parse_date(value: Optional[str], name: str) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {name}: use YYYY-MM-DD")


def _parse_number(value: Optional[str], name: str) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid number for {name}")


def parse_tool_filters(request: Request, tool: ToolSpec) -> ToolFilters:
    """Common filters as plain params; sheet filters as `<sheet>.<key>`
    (e.g. `generations.tool=text-to-image`, `generations.credits_min=10`)."""
    qp = request.query_params
    f = ToolFilters(
        q=(qp.get("q") or "").strip()[:200] or None,
        date_from=_parse_date(qp.get("date_from"), "date_from"),
        date_to=_parse_date(qp.get("date_to"), "date_to"),
        department=(qp.get("department") or "").strip() or None,
        linked=qp.get("linked") or None,
        client=(qp.get("client") or "").strip() or None,
        ownership=qp.get("ownership") or None,
    )
    if qp.get("owner_user_id") == "none":
        f.unassigned = True
    elif qp.get("owner_user_id"):
        try:
            f.owner_user_id = int(qp["owner_user_id"])
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid owner_user_id")
    if f.date_from and f.date_to and f.date_from > f.date_to:
        raise HTTPException(status_code=400, detail="The start date is after the end date")
    if f.linked and f.linked not in LINKED_LABELS:
        raise HTTPException(status_code=400, detail=f"Invalid linked. Expected one of {sorted(LINKED_LABELS)}")
    if f.ownership and f.ownership not in OWNERSHIP_LABELS:
        raise HTTPException(status_code=400, detail="Invalid ownership")
    if qp.get("sheets"):
        known = {sheet_key(spec) for spec in tool.sheets}
        chosen = {part.strip() for part in qp["sheets"].split(",") if part.strip()}
        if not chosen or not chosen <= known:
            raise HTTPException(status_code=400, detail=f"Unknown sheet. Expected some of {sorted(known)}")
        f.sheets = chosen
    for spec in tool.sheets:
        sk = sheet_key(spec)
        values = {}
        for fd in _sheet_filters(spec):
            if fd.kind == "range":
                low = _parse_number(qp.get(f"{sk}.{fd.key}_min"), fd.label)
                high = _parse_number(qp.get(f"{sk}.{fd.key}_max"), fd.label)
                if low is not None and high is not None and low > high:
                    raise HTTPException(status_code=400, detail=f"{fd.label}: minimum is above maximum")
                if low is not None:
                    values[f"{fd.key}_min"] = low
                if high is not None:
                    values[f"{fd.key}_max"] = high
            else:
                raw = qp.get(f"{sk}.{fd.key}")
                if raw not in (None, ""):
                    if fd.kind == "bool" and raw not in ("yes", "no"):
                        raise HTTPException(status_code=400, detail=f"{fd.label}: use yes or no")
                    values[fd.key] = raw
        if values:
            f.per_sheet[sk] = values
    return f


def apply_tool_filters(query, spec: SheetSpec, f: ToolFilters):
    """Everything except q/date (which _query_rows applies). Query must have
    User outer-joined when the sheet has an owner."""
    model = spec.model
    if spec.owner_attr:
        if f.unassigned:
            query = query.filter(getattr(model, spec.owner_attr).is_(None))
        elif f.owner_user_id is not None:
            query = query.filter(getattr(model, spec.owner_attr) == f.owner_user_id)
        if f.department:
            query = query.filter(func.lower(User.department) == f.department.lower())
    if hasattr(model, "linked_task_id") and f.linked:
        task, client = model.linked_task_id, model.linked_client_id
        query = query.filter({
            "task": task.isnot(None), "no_task": task.is_(None), "client": client.isnot(None),
            "no_client": client.is_(None),
        }.get(f.linked, (task.is_(None)) & (client.is_(None))))
    if hasattr(model, "linked_client_name") and f.client:
        query = query.filter(model.linked_client_name == f.client)
    if hasattr(model, "ownership_status") and f.ownership:
        query = query.filter(model.ownership_status == f.ownership)
    values = f.per_sheet.get(sheet_key(spec), {})
    for fd in _sheet_filters(spec):
        col = getattr(model, fd.attr)
        if fd.kind == "range":
            if values.get(f"{fd.key}_min") is not None:
                query = query.filter(col >= values[f"{fd.key}_min"])
            if values.get(f"{fd.key}_max") is not None:
                query = query.filter(col <= values[f"{fd.key}_max"])
        elif fd.key in values:
            if fd.kind == "bool":
                query = query.filter(col.is_(True) if values[fd.key] == "yes" else or_(col.is_(False), col.is_(None)))
            else:
                query = query.filter(cast(col, Text) == values[fd.key])
    return query


def _sheet_base_query(db: Session, spec: SheetSpec, *entities):
    model = spec.model
    query = db.query(*(entities or (model,)))
    if spec.owner_attr:
        query = query.outerjoin(User, getattr(model, spec.owner_attr) == User.id)
    if spec.base_filter:
        query = spec.base_filter(query)
    if spec.archived_attr and hasattr(model, spec.archived_attr):
        query = query.filter(getattr(model, spec.archived_attr).is_(None))
    return query


def _sheet_breakdowns(spec: SheetSpec) -> tuple:
    """Summary tables: the sheet's own, else one per categorical filter + month + client."""
    if spec.breakdowns:
        return spec.breakdowns
    tables = [("By month", lambda r, o, s=spec: _ist_month_of(r, s))]
    for fd in _sheet_filters(spec):
        if not fd.breakdown or fd.attr == spec.status_attr:
            continue
        tables.append((
            f"By {fd.label.lower()}",
            lambda r, o, fd=fd: _value_label(fd, getattr(r, fd.attr)) if getattr(r, fd.attr) is not None else "Not set",
        ))
    if hasattr(spec.model, "linked_client_name"):
        tables.append(("By client", lambda r, o: r.linked_client_name or "No client"))
    return tuple(tables)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _first_value(record, attr_spec: str):
    for name in attr_spec.split("|"):
        value = getattr(record, name, None)
        if value not in (None, ""):
            return value
    return None


def _to_ist_naive(value):
    """Stored timestamps are naive UTC (or tz-aware); Excel wants naive IST."""
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(IST).replace(tzinfo=None)


def _clean(value):
    if isinstance(value, str):
        value = _ILLEGAL_XML_CHARS.sub("", value)
        if len(value) > MAX_CELL_CHARS:
            value = value[:MAX_CELL_CHARS] + "…"
    return value


def _time_expr(spec: SheetSpec):
    cols = [getattr(spec.model, name) for name in spec.time_attrs]
    return cols[0] if len(cols) == 1 else func.coalesce(*cols)


def _query_rows(db: Session, spec: SheetSpec, q: Optional[str], date_from: Optional[date], date_to: Optional[date],
                extra_filter: Optional[Callable[[Any], Any]] = None):
    model = spec.model
    owner_col = getattr(model, spec.owner_attr) if spec.owner_attr else None
    entities = [model]
    if owner_col is not None:
        entities.append(User)
    query = db.query(*entities)
    if owner_col is not None:
        query = query.outerjoin(User, owner_col == User.id)
    if spec.base_filter:
        query = spec.base_filter(query)
    if spec.archived_attr and hasattr(model, spec.archived_attr):
        query = query.filter(getattr(model, spec.archived_attr).is_(None))

    time_col = _time_expr(spec)
    if extra_filter is not None:
        query = extra_filter(query)
    # date_from/date_to are India calendar days; stored times are UTC.
    if date_from:
        query = query.filter(time_col >= datetime.combine(date_from, datetime.min.time()) - IST_OFFSET)
    if date_to:
        query = query.filter(time_col < datetime.combine(date_to + timedelta(days=1), datetime.min.time()) - IST_OFFSET)
    if q and q.strip():
        like = f"%{q.strip()}%"
        clauses = [getattr(model, name).ilike(like) for name in spec.search_attrs if hasattr(model, name)]
        if owner_col is not None:
            clauses += [User.name.ilike(like), User.email.ilike(like), User.department.ilike(like)]
        if clauses:
            query = query.filter(or_(*clauses))

    query = query.order_by(time_col.desc().nullslast(), model.id.desc())
    rows = query.limit(MAX_ROWS_PER_SHEET + 1).all()
    truncated = len(rows) > MAX_ROWS_PER_SHEET
    rows = rows[:MAX_ROWS_PER_SHEET]
    if owner_col is None:
        rows = [(row, None) for row in rows]
    return rows, truncated


def _style_header(ws, row: int, count: int):
    for col in range(1, count + 1):
        cell = ws.cell(row=row, column=col)
        cell.fill = BRAND_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 22


def _write_data_sheet(ws, spec: SheetSpec, rows, project_names: dict[int, str]):
    owner_headers = [] if spec.owner_attr is None else [
        Col("Person", width=22), Col("Email", width=28), Col("Department", width=18),
    ]
    # Every filter the export offers also gets a column, so a filtered
    # workbook always shows the value it was filtered by.
    covered = {name for col in spec.columns for name in (col.attr or "").split("|")}
    filter_cols = [
        Col(fd.label, fd.attr, "bool" if fd.kind == "bool" else "number" if fd.kind == "range" else "text", 16)
        for fd in _sheet_filters(spec)
        if fd.attr not in covered
    ]
    data_cols = list(spec.columns) + filter_cols
    columns = [Col("Date (IST)", kind="datetime", width=19)] + owner_headers + data_cols + [Col("Record ID", "id", "number", 10)]
    ws.append([c.header for c in columns])
    _style_header(ws, 1, len(columns))

    for record, owner in rows:
        values = [_to_ist_naive(_first_value(record, "|".join(spec.time_attrs)))]
        if spec.owner_attr is not None:
            values += [
                owner.name if owner else "Unassigned",
                owner.email if owner else None,
                owner.department if owner else None,
            ]
        for col in data_cols:
            if col.getter:
                value = col.getter(record)
            elif col.attr == "_project_name":
                value = project_names.get(getattr(record, "project_id", None))
            else:
                value = _first_value(record, col.attr)
            if col.kind == "bool" and value is not None:
                value = "Yes" if value else "No"
            values.append(_clean(_to_ist_naive(value)))
        values.append(record.id)
        ws.append(values)

    for index, col in enumerate(columns, start=1):
        letter = get_column_letter(index)
        ws.column_dimensions[letter].width = col.width
        if col.kind == "datetime":
            for cell in ws[letter][1:]:
                cell.number_format = "dd mmm yyyy, hh:mm"
        elif col.kind == "long":
            for cell in ws[letter][1:]:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
        elif col.kind == "number":
            for cell in ws[letter][1:]:
                cell.number_format = _number_format(cell.value)
        elif col.kind == "url":
            for cell in ws[letter][1:]:
                if isinstance(cell.value, str) and cell.value.startswith(("http://", "https://")):
                    cell.hyperlink = cell.value
                    cell.style = "Hyperlink"

    ws.freeze_panes = "B2"
    if rows:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{len(rows) + 1}"


def _number_format(value) -> str:
    """2,530 for a whole number, 86.25 otherwise: "#,##0.##" alone leaves a
    trailing dot on whole numbers ("2,530.")."""
    try:
        whole = round(float(value), 2).is_integer()
    except (TypeError, ValueError):
        return "General"
    return "#,##0" if whole else "#,##0.##"


def _write_table(ws, start_row: int, title: str, headers: list[str], rows: list[list]) -> int:
    ws.cell(row=start_row, column=1, value=title).font = SECTION_FONT
    header_row = start_row + 1
    for index, header in enumerate(headers, start=1):
        ws.cell(row=header_row, column=index, value=header)
    _style_header(ws, header_row, len(headers))
    for offset, values in enumerate(rows, start=1):
        for index, value in enumerate(values, start=1):
            cell = ws.cell(row=header_row + offset, column=index, value=value)
            if isinstance(value, (int, float)):
                cell.number_format = _number_format(value)
            if offset % 2 == 0:
                cell.fill = SUBTLE_FILL
    if not rows:
        ws.cell(row=header_row + 1, column=1, value="No data")
        return header_row + 3
    return header_row + len(rows) + 2


def _write_breakdown(ws, row: int, spec: SheetSpec, rows, title: str, key_fn) -> int:
    getter = spec.credits_getter or (
        (lambda r, a=spec.credits_attr: getattr(r, a, None)) if spec.credits_attr else None
    )
    buckets: dict[str, list] = defaultdict(lambda: [0, 0.0])
    for record, owner in rows:
        key = key_fn(record, owner)
        buckets[key][0] += 1
        buckets[key][1] += float(getter(record) or 0) if getter else 0.0
    total = sum(count for count, _ in buckets.values()) or 1
    ordered = sorted(buckets.items(), key=lambda item: item[0]) if title.endswith("By month") else \
        sorted(buckets.items(), key=lambda item: (-item[1][0], item[0]))
    return _write_table(
        ws, row, title, [title.split("By ")[-1].capitalize(), "Records", "Share", "Credits / cost"],
        [[key, count, f"{count / total:.0%}", round(credit, 2)] for key, (count, credit) in ordered[:40]],
    )


def _write_summary(ws, tool: ToolSpec, sheet_results, *, generated_by: User, filters: dict):
    ws.title = "Summary"
    ws["A1"] = f"{tool.label} — RMW Data export"
    ws["A1"].font = TITLE_FONT
    now_ist = datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST")
    meta = [
        ("Generated", now_ist),
        ("Generated by", f"{generated_by.name} ({generated_by.email})"),
    ]
    if filters.get("applied") is not None:
        meta.append(("Filters", "; ".join(filters["applied"]) or "None (everything)"))
    else:
        meta += [("Date range", filters["range_label"]), ("Search", filters["q"] or "—")]
    for offset, (label, value) in enumerate(meta, start=3):
        ws.cell(row=offset, column=1, value=label).font = Font(bold=True)
        cell = ws.cell(row=offset, column=2, value=value)
        cell.alignment = Alignment(wrap_text=True, vertical="top")

    row = 4 + len(meta)
    totals = []
    for spec, rows, truncated in sheet_results:
        credits = None
        if spec.credits_getter or spec.credits_attr:
            getter = spec.credits_getter or (lambda r, a=spec.credits_attr: getattr(r, a, None))
            credits = round(sum(float(getter(record) or 0) for record, _ in rows), 2)
        note = f"Capped at {MAX_ROWS_PER_SHEET:,} rows" if truncated else ""
        totals.append([spec.title, len(rows), credits if credits is not None else "—", note])
    row = _write_table(ws, row, "Totals", ["Sheet", "Records", "Credits / cost", "Note"], totals)

    # People and departments across every owned sheet.
    people: dict[str, list] = defaultdict(lambda: [0, 0.0, ""])
    departments: Counter = Counter()
    statuses: Counter = Counter()
    for spec, rows, _ in sheet_results:
        getter = spec.credits_getter or (
            (lambda r, a=spec.credits_attr: getattr(r, a, None)) if spec.credits_attr else None
        )
        for record, owner in rows:
            if spec.owner_attr is not None:
                key = owner.name if owner else "Unassigned"
                people[key][0] += 1
                people[key][1] += float(getter(record) or 0) if getter else 0.0
                people[key][2] = (owner.department if owner else "") or people[key][2]
                departments[(owner.department if owner else None) or "Unassigned"] += 1
            if spec.status_attr:
                statuses[f"{getattr(record, spec.status_attr, None) or 'Unknown'}"] += 1

    if people:
        top = sorted(people.items(), key=lambda item: (-item[1][0], item[0]))[:25]
        row = _write_table(
            ws, row, "Top people",
            ["Person", "Department", "Records", "Credits / cost"],
            [[name, dept or "—", count, round(credit, 2)] for name, (count, credit, dept) in top],
        )
    if departments:
        row = _write_table(
            ws, row, "By department", ["Department", "Records"],
            [[name, count] for name, count in departments.most_common(25)],
        )
    if statuses:
        row = _write_table(
            ws, row, "By status", ["Status", "Records"],
            [[name, count] for name, count in statuses.most_common(25)],
        )
    multi = len(sheet_results) > 1
    for spec, rows, _ in sheet_results:
        for title, key_fn in _sheet_breakdowns(spec):
            heading = f"{spec.title} · {title}" if multi else title
            row = _write_breakdown(ws, row, spec, rows, heading, key_fn)

    for letter, width in zip("ABCD", (34, 60, 16, 18)):
        ws.column_dimensions[letter].width = width


EMPLOYEE_CLIENTS_SHOWN = 8


def _credits_getter(spec: SheetSpec):
    if spec.credits_getter:
        return spec.credits_getter
    if spec.credits_attr:
        return lambda record, attr=spec.credits_attr: getattr(record, attr, None)
    return None


def _write_employee_sheet(ws, tool: ToolSpec, sheet_results):
    """One table per owned sheet: each person's records, credits and the
    clients they used the tool for most - so every generation can be traced
    to the client it was made for. Records with no linked client count as
    "Unallocated"."""
    ws.title = "By employee"
    ws["A1"] = f"{tool.label} — usage by employee"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = "Client Heavy Use lists each person's clients by number of records, most used first."
    ws["A2"].font = Font(italic=True, color="64748B")

    row = 4
    first_table = True
    for spec, rows, truncated in sheet_results:
        if spec.owner_attr is None:
            continue
        getter = _credits_getter(spec)
        has_clients = hasattr(spec.model, "linked_client_name")
        people: dict = {}
        for record, owner in rows:
            key = owner.id if owner else None
            person = people.setdefault(key, {
                "name": owner.name if owner else "Unassigned",
                "department": (owner.department if owner else None) or "—",
                "records": 0,
                "credits": 0.0,
                "clients": Counter(),
            })
            person["records"] += 1
            if getter:
                person["credits"] += float(getter(record) or 0)
            if has_clients:
                person["clients"][(getattr(record, "linked_client_name", None) or "").strip() or "Unallocated"] += 1

        cost_label = "Cost (USD)" if spec.credits_attr == "cost_usd" else f"{tool.label} Credits Used"
        headers = ["Employee Name", "Department", f"{tool.label} {spec.title}"]
        if getter:
            headers.append(cost_label)
        if has_clients:
            headers.append("Client Heavy Use")

        ordered = sorted(people.values(), key=lambda p: (-p["records"], -p["credits"], p["name"]))
        table = []
        for person in ordered:
            values = [person["name"], person["department"], person["records"]]
            if getter:
                values.append(round(person["credits"], 2))
            if has_clients:
                names = [name for name, _ in person["clients"].most_common()]
                shown = ", ".join(names[:EMPLOYEE_CLIENTS_SHOWN])
                extra = len(names) - EMPLOYEE_CLIENTS_SHOWN
                values.append(f"{shown} (+{extra} more)" if extra > 0 else shown)
            table.append(values)

        title = spec.title if len(sheet_results) > 1 else f"{tool.label} {spec.title.lower()} by employee"
        if truncated:
            title += f" (first {MAX_ROWS_PER_SHEET:,} records)"
        header_row = row + 1
        end_row = _write_table(ws, row, title, headers, table)

        if table:
            total_row = header_row + len(table) + 1
            totals = ["Total", "", sum(p["records"] for p in ordered)]
            if getter:
                totals.append(round(sum(p["credits"] for p in ordered), 2))
            for index, value in enumerate(totals, start=1):
                cell = ws.cell(row=total_row, column=index, value=value)
                cell.font = Font(bold=True)
                cell.border = Border(top=Side(style="thin", color="94A3B8"))
                if isinstance(value, (int, float)):
                    cell.number_format = _number_format(value)
            for offset in range(1, len(table) + 1):
                ws.cell(row=header_row + offset, column=3).number_format = "#,##0"
                if has_clients:
                    ws.cell(row=header_row + offset, column=len(headers)).alignment = Alignment(wrap_text=True, vertical="top")
            if first_table:
                # Excel allows one autofilter per sheet: the first table gets it.
                ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(headers))}{header_row + len(table)}"
                ws.freeze_panes = f"A{header_row + 1}" if len([s for s in sheet_results if s[0].owner_attr]) == 1 else None
            first_table = False
            end_row = total_row + 2
        row = end_row

    if first_table:
        ws.cell(row=row, column=1, value="This tool's records are not linked to people.")
    for letter, width in zip("ABCDE", (26, 20, 18, 22, 70)):
        ws.column_dimensions[letter].width = width


def _range_label(date_from: Optional[date], date_to: Optional[date]) -> str:
    fmt = "%d %b %Y"
    if date_from and date_to:
        return f"{date_from.strftime(fmt)} – {date_to.strftime(fmt)}"
    if date_from:
        return f"From {date_from.strftime(fmt)}"
    if date_to:
        return f"Up to {date_to.strftime(fmt)}"
    return "All time"


def _build_workbook(db: Session, tool: ToolSpec, current_user: User, q, date_from, date_to,
                    extra_filter=None, applied_filters: Optional[list[str]] = None,
                    include=None) -> bytes:
    """extra_filter(query, spec) narrows each sheet; include(spec) picks sheets."""
    workbook = Workbook()
    summary = workbook.active
    sheet_results = []
    for spec in tool.sheets:
        if include is not None and not include(spec):
            continue
        sheet_filter = (lambda query, spec=spec: extra_filter(query, spec)) if extra_filter else None
        rows, truncated = _query_rows(db, spec, q, date_from, date_to, sheet_filter)
        project_names = {}
        if spec.model is GenerationRecord:
            ids = {getattr(record, "project_id", None) for record, _ in rows} - {None}
            if ids:
                project_names = dict(
                    db.query(GenerationProject.id, GenerationProject.name).filter(GenerationProject.id.in_(ids)).all()
                )
        _write_data_sheet(workbook.create_sheet(spec.title), spec, rows, project_names)
        sheet_results.append((spec, rows, truncated))

    _write_summary(
        summary, tool, sheet_results, generated_by=current_user,
        filters={"q": (q or "").strip(), "range_label": _range_label(date_from, date_to), "applied": applied_filters},
    )
    if any(spec.owner_attr is not None for spec, _, _ in sheet_results):
        _write_employee_sheet(workbook.create_sheet("By employee", 1), tool, sheet_results)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return excel_safe(buffer.getvalue())


def _export_response(content: bytes, tool: ToolSpec, date_from, date_to) -> StreamingResponse:
    stamp = datetime.now(IST).strftime("%Y-%m-%d")
    slug = re.sub(r"[^a-z0-9]+", "-", tool.label.lower()).strip("-")
    parts = ["rmw-data", slug]
    if date_from or date_to:
        parts.append(f"{date_from or 'start'}_to_{date_to or 'today'}")
    filename = "_".join(parts + [stamp]) + ".xlsx"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
            "Cache-Control": "no-store",
        },
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

def _validate_range(date_from: Optional[date], date_to: Optional[date]):
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=400, detail="The start date is after the end date")


@router.get("/tools")
def list_exportable_tools(current_user: User = Depends(require_rmw_data_access)):
    """Which tool tabs can be exported, and the sheets each workbook has."""
    is_admin = has_any_role(current_user, {"admin"})
    return {
        "success": True,
        "tools": [
            {"key": tool.key, "label": tool.label, "sheets": [s.title for s in tool.sheets]}
            for tool in TOOLS.values()
            if is_admin or not tool.admin_only
        ],
    }


@router.get("/kling")
def export_kling(
    filters: KlingFilterParams = Depends(),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_rmw_data_access),
):
    """Takes exactly the Kling tab's filters (KlingFilterParams), so an export
    matches what the tab shows."""
    tool = TOOLS["kling"]

    def kling_filter(query, _spec=None):
        query = query.outerjoin(GenerationProject, GenerationRecord.project_id == GenerationProject.id)
        return apply_kling_filters(query, filters)

    content = _build_workbook(
        db, tool, current_user, None, None, None,
        extra_filter=kling_filter, applied_filters=filters.describe(db),
    )
    return _export_response(content, tool, filters.date_from, filters.date_to)


def _admin_tool(tool_key: str) -> ToolSpec:
    tool = TOOLS.get(tool_key)
    if not tool or not tool.admin_only:
        raise HTTPException(status_code=404, detail="Unknown export")
    return tool


def _option_rows(query, col, limit: int = 60):
    return (
        query.with_entities(col, func.count()).filter(col.isnot(None))
        .group_by(col).order_by(func.count().desc()).limit(limit).all()
    )


@router.get("/{tool_key}/options")
def export_tool_options(
    tool_key: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Every filter the tool's export offers, with values and record counts."""
    tool = _admin_tool(tool_key)
    owners: Counter = Counter()
    owner_names: dict = {}
    unassigned = 0
    departments: Counter = Counter()
    clients: Counter = Counter()
    linked: Counter = Counter()
    ownership: Counter = Counter()
    first = last = None
    sheets = []
    has_owner = has_linked = has_ownership = False

    for spec in tool.sheets:
        model = spec.model
        base = _sheet_base_query(db, spec)
        total = base.count()
        time_col = _time_expr(spec)
        low, high = base.with_entities(func.min(time_col), func.max(time_col)).one()
        first = low if first is None or (low and low < first) else first
        last = high if last is None or (high and high > last) else last
        credit_sum = None
        if spec.credits_attr:
            credit_sum = float(base.with_entities(func.sum(getattr(model, spec.credits_attr))).scalar() or 0)

        filters = []
        for fd in _sheet_filters(spec):
            col = getattr(model, fd.attr)
            entry = {"key": fd.key, "label": fd.label, "kind": fd.kind}
            if fd.kind == "range":
                lo, hi = base.with_entities(func.min(col), func.max(col)).one()
                if lo is None or lo == hi:
                    continue  # nothing to narrow down when every value is the same
                entry.update(min=float(lo), max=float(hi))
            elif fd.kind == "bool":
                yes = base.filter(col.is_(True)).count()
                entry["options"] = [{"value": "yes", "label": "Yes", "count": yes},
                                    {"value": "no", "label": "No", "count": total - yes}]
            else:
                rows = _option_rows(base, cast(col, Text))
                if len(rows) < 2 and total - sum(n for _, n in rows) == 0:
                    continue  # every row has the same value: nothing to filter
                if not rows:
                    continue
                entry["options"] = [{"value": v, "label": _value_label(fd, v), "count": int(n)} for v, n in rows]
            filters.append(entry)

        if spec.owner_attr:
            has_owner = True
            for owner_id, name, n in (base.with_entities(getattr(model, spec.owner_attr), User.name, func.count())
                                      .filter(getattr(model, spec.owner_attr).isnot(None))
                                      .group_by(getattr(model, spec.owner_attr), User.name).all()):
                owners[owner_id] += n
                owner_names[owner_id] = name
            for dept, n in _option_rows(base, User.department):
                departments[dept] += n
            unassigned += base.filter(getattr(model, spec.owner_attr).is_(None)).count()
        if hasattr(model, "linked_task_id"):
            has_linked = True
            task_n = base.filter(model.linked_task_id.isnot(None)).count()
            client_n = base.filter(model.linked_client_id.isnot(None)).count()
            none_n = base.filter(model.linked_task_id.is_(None), model.linked_client_id.is_(None)).count()
            linked.update({"task": task_n, "no_task": total - task_n, "client": client_n,
                           "no_client": total - client_n, "unlinked": none_n})
            for name, n in _option_rows(base, model.linked_client_name):
                clients[name] += n
        if hasattr(model, "ownership_status"):
            has_ownership = True
            for value, n in _option_rows(base, model.ownership_status):
                ownership[value] += n

        sheets.append({
            "key": sheet_key(spec), "title": spec.title, "count": total, "credits": credit_sum,
            "hasOwner": bool(spec.owner_attr), "filters": filters,
            # Which standard filters mean anything for this record type.
            "hasLinked": hasattr(model, "linked_task_id"),
            "hasOwnership": hasattr(model, "ownership_status"),
        })

    def ist_day(value):
        if not value:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(IST).date().isoformat()

    return {
        "success": True,
        "tool": {"key": tool.key, "label": tool.label},
        "dateRange": {"from": ist_day(first), "to": ist_day(last)},
        "sheets": sheets,
        "common": {
            "owners": ([{"value": str(k), "label": owner_names.get(k) or f"User {k}", "count": int(n)}
                        for k, n in owners.most_common()]
                       + ([{"value": "none", "label": "Unassigned", "count": int(unassigned)}] if unassigned else [])
                       ) if has_owner else None,
            "departments": [{"value": k, "label": k, "count": int(n)} for k, n in departments.most_common()] if has_owner else None,
            "linked": [{"value": k, "label": LINKED_LABELS[k], "count": int(linked[k])} for k in LINKED_LABELS] if has_linked else None,
            "clients": [{"value": k, "label": k, "count": int(n)} for k, n in clients.most_common()] if has_linked else None,
            "ownership": [{"value": k, "label": OWNERSHIP_LABELS.get(k, k), "count": int(n)}
                          for k, n in ownership.most_common()] if has_ownership else None,
        },
    }


def _filtered_sheet_query(db: Session, spec: SheetSpec, f: ToolFilters, *entities):
    model = spec.model
    query = apply_tool_filters(_sheet_base_query(db, spec, *entities), spec, f)
    time_col = _time_expr(spec)
    if f.date_from:
        query = query.filter(time_col >= datetime.combine(f.date_from, datetime.min.time()) - IST_OFFSET)
    if f.date_to:
        query = query.filter(time_col < datetime.combine(f.date_to + timedelta(days=1), datetime.min.time()) - IST_OFFSET)
    if f.q:
        like = f"%{f.q}%"
        clauses = [getattr(model, name).ilike(like) for name in spec.search_attrs if hasattr(model, name)]
        if spec.owner_attr:
            clauses += [User.name.ilike(like), User.email.ilike(like), User.department.ilike(like)]
        if clauses:
            query = query.filter(or_(*clauses))
    return query


# ── Records view (tool tabs) ─────────────────────────────────────────────────

# Where a playable/viewable file lives, best first. Saved copies are private,
# so their key is turned into a short-lived signed link.
_MEDIA_ATTRS = ("mirrored_asset_url", "media_url", "video_url", "preview_mp3_url", "download_url",
                "raw_url", "canvas_url", "fallback_url", "large_preview_url", "preview_url")
_THUMB_ATTRS = ("mirrored_thumbnail_url", "thumbnail_url", "asset_thumbnail_url", "large_preview_url", "preview_url")
_AUDIO_TOOLS = {"suno", "elevenlabs", "epidemicsound", "splice"}
_VIDEO_TOOLS = {"heygen", "flow"}
_TEXT_TOOLS = {"cursor", "claudecode", "figma"}
_EXT_KIND = {
    "mp4": "video", "webm": "video", "mov": "video", "m3u8": "video",
    "mp3": "audio", "wav": "audio", "m4a": "audio", "ogg": "audio", "aac": "audio",
    "jpg": "image", "jpeg": "image", "png": "image", "webp": "image", "gif": "image", "avif": "image",
}


def _signed(key):
    if not key:
        return None
    try:
        if not r2_storage.is_configured():
            return None
        return r2_storage.generate_presigned_url(key, client=r2_storage.shared_client())
    except Exception:
        return None


def _media_kind(tool_key: str, spec: SheetSpec, record, url: Optional[str]) -> str:
    if tool_key in _TEXT_TOOLS:
        return "text"
    ext = (url or "").split("?")[0].rsplit(".", 1)[-1].lower() if url and "." in (url or "") else ""
    if ext in _EXT_KIND:
        return _EXT_KIND[ext]
    output = getattr(record, "output_type", None) or getattr(record, "media_type", None)
    if output in ("video", "image", "audio"):
        return output
    if tool_key in _AUDIO_TOOLS:
        return "audio"
    if tool_key in _VIDEO_TOOLS or getattr(record, "file_type_id", None) == 4:
        return "video"
    return "image" if url else "text"


def _row_payload(tool_key: str, spec: SheetSpec, record, owner) -> dict:
    long_col = next((c for c in spec.columns if c.kind == "long"), None)
    link_col = next((c for c in spec.columns if c.kind == "url"), None)
    title = None
    if long_col is not None:
        title = long_col.getter(record) if long_col.getter else _first_value(record, long_col.attr)

    media = None
    if getattr(record, "asset_mirror_status", None) == "mirrored":
        media = _signed(getattr(record, "mirrored_asset_key", None))
    if not media:
        media = next((getattr(record, a) for a in _MEDIA_ATTRS if getattr(record, a, None)), None)
    thumb = _signed(getattr(record, "mirrored_thumbnail_key", None)) or \
        next((getattr(record, a) for a in _THUMB_ATTRS if getattr(record, a, None)), None)
    link = _first_value(record, link_col.attr) if link_col is not None and link_col.attr else None

    facts = []
    for fd in _sheet_filters(spec):
        if fd.kind == "range":
            continue
        value = getattr(record, fd.attr, None)
        if value is None or value == "":
            continue
        if fd.kind == "bool" and not value:
            continue
        facts.append({"label": fd.label, "value": fd.label if fd.kind == "bool" else _value_label(fd, value)})
    getter = spec.credits_getter or ((lambda r: getattr(r, spec.credits_attr, None)) if spec.credits_attr else None)
    credits = getter(record) if getter else None
    when = _first_value(record, "|".join(spec.time_attrs))
    return {
        "id": record.id,
        "time": serialize_utc_datetime(when) if isinstance(when, datetime) else None,
        # No prompt/script captured: fall back to the most telling fact.
        "title": (title or "").strip()[:600] or (facts[0]["value"] if facts else None),
        "kind": _media_kind(tool_key, spec, record, media),
        "mediaUrl": media,
        "thumbnailUrl": thumb,
        "link": link if link and link != media else None,
        "facts": facts[:5],
        "credits": float(credits) if isinstance(credits, (int, float)) else None,
        "person": {"id": owner.id, "name": owner.name, "department": owner.department} if owner else None,
        "linkedTask": getattr(record, "linked_task_name", None),
        "client": getattr(record, "linked_client_name", None),
        "ownership": getattr(record, "ownership_status", None),
    }


def _native_serializers() -> dict:
    """Each tool's own list serialization (to_dict + owner summary), so the
    Records view can render the tool's existing cards and detail drawers.
    Imported lazily: the provider routers import heavy capture modules."""
    from providers.elevenlabs import router as elevenlabs_router
    from providers.envato import queries as envato_queries
    from providers.epidemicsound import queries as epidemic_queries
    from providers.flow import router as flow_router
    from providers.freepik import queries as freepik_queries
    from providers.heygen import queries as heygen_queries
    from providers.higgsfield import queries as higgsfield_queries
    from providers.splice import queries as splice_queries
    from providers.suno import router as suno_router

    return {
        FreepikGeneration: freepik_queries.attach_owner_summaries,
        FreepikDownload: freepik_queries.attach_owner_summaries,
        HeygenGeneration: heygen_queries.attach_owner_summaries,
        HiggsfieldGeneration: higgsfield_queries.attach_owner_summaries,
        EnvatoGeneration: envato_queries.attach_owner_summaries,
        EnvatoDownload: envato_queries.attach_owner_summaries,
        FlowGeneration: flow_router._attach_owner_names,
        ElevenlabsGeneration: elevenlabs_router._attach_owner_names,
        SunoGeneration: suno_router._attach_owner_names,
        EpidemicDownload: epidemic_queries.attach_owner_summaries,
        EpidemicAdaptation: epidemic_queries.attach_owner_summaries,
        SpliceDownload: splice_queries.attach_owner_summaries,
    }


@router.get("/{tool_key}/rows")
def tool_rows(
    tool_key: str,
    request: Request,
    sheet: str = Query(...),
    sort: str = Query("latest"),
    format: str = Query("summary"),
    limit: int = Query(48, ge=1, le=120),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """One sheet's records with the export filters applied: backs the tool
    tabs' Records view, so what the tab shows is what the Excel contains."""
    tool = _admin_tool(tool_key)
    spec = next((s for s in tool.sheets if sheet_key(s) == sheet), None)
    if spec is None:
        raise HTTPException(status_code=404, detail="Unknown sheet")
    if sort not in {"latest", "oldest", "credits"}:
        raise HTTPException(status_code=400, detail="Invalid sort")
    f = parse_tool_filters(request, tool)
    model = spec.model
    entities = (model, User) if spec.owner_attr else (model,)
    query = _filtered_sheet_query(db, spec, f, *entities)

    summary = None
    if offset == 0:
        credit_expr = getattr(model, spec.credits_attr) if spec.credits_attr else None
        count, credit_sum = query.with_entities(
            func.count(func.distinct(model.id)),
            func.sum(credit_expr) if credit_expr is not None else func.sum(0),
        ).one()
        summary = {"count": int(count or 0),
                   "credits": float(credit_sum) if credit_expr is not None and credit_sum is not None else None}

    time_col = _time_expr(spec)
    if sort == "oldest":
        query = query.order_by(time_col.asc().nullslast(), model.id.asc())
    elif sort == "credits" and spec.credits_attr:
        query = query.order_by(getattr(model, spec.credits_attr).desc().nullslast(), time_col.desc())
    else:
        query = query.order_by(time_col.desc().nullslast(), model.id.desc())

    rows = query.offset(offset).limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    if not spec.owner_attr:
        rows = [(row, None) for row in rows]
    native = _native_serializers().get(model) if format == "native" else None
    if native is not None:
        payload = native(db, [record.to_dict() for record, _ in rows])
    else:
        payload = [_row_payload(tool.key, spec, record, owner) for record, owner in rows]
    return {
        "success": True,
        "format": "native" if native is not None else "summary",
        "rows": payload,
        "summary": summary,
        "canSortByCredits": bool(spec.credits_attr),
        "hasMore": has_more,
        "nextOffset": offset + limit if has_more else None,
    }


@router.get("/{tool_key}/preview")
def export_tool_preview(
    tool_key: str,
    request: Request,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Rows (and credits) each sheet would get with these filters."""
    tool = _admin_tool(tool_key)
    f = parse_tool_filters(request, tool)
    out = []
    for spec in tool.sheets:
        if not f.includes(spec):
            continue
        model = spec.model
        query = _filtered_sheet_query(db, spec, f)
        credit_expr = getattr(model, spec.credits_attr) if spec.credits_attr else None
        count, credit_sum = query.with_entities(
            func.count(func.distinct(model.id)), func.sum(credit_expr) if credit_expr is not None else func.sum(0)
        ).one()
        out.append({"key": sheet_key(spec), "title": spec.title, "count": int(count or 0),
                    "credits": float(credit_sum) if credit_expr is not None and credit_sum is not None else None})
    return {"success": True, "sheets": out, "total": sum(item["count"] for item in out)}


@router.get("/{tool_key}")
def export_tool(
    tool_key: str,
    request: Request,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    tool = _admin_tool(tool_key)
    f = parse_tool_filters(request, tool)
    content = _build_workbook(
        db, tool, current_user, f.q, f.date_from, f.date_to,
        extra_filter=lambda query, spec: apply_tool_filters(query, spec, f),
        applied_filters=f.describe(db, tool),
        include=f.includes,
    )
    return _export_response(content, tool, f.date_from, f.date_to)
