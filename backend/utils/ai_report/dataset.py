"""
Dataset layer: one DB read pass -> a typed, render-ready snapshot.

Nothing here knows about Excel. The builder issues a small set of *grouped*
queries (never one-query-per-row) so the same code serves 60 or 50,000
employees, then assembles plain dataclasses the sheet modules iterate over.

Grain decisions (reconciled against the live reports API so the workbook agrees
with the dashboard):
  * ChatGPT "session"/event  = one captured prompt (ConversationPrompt), IST-dated
  * Kling event/generation   = one usage event (ITPortalToolUsageEvent), IST event_date
  * Composite score          = ChatGPT sessions + Kling videos
  * A tool is "used" by an employee if they have >=1 event on it in-window.

Raw event rows feeding the log sheets are capped (RAW_ROW_CAP) so a runaway
period cannot bloat the file; per-employee aggregates are always computed from
full grouped counts, so KPIs stay correct even when raw rows are truncated.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolUsageEvent, User
from providers.chatgpt.models import ConversationPrompt, ConversationRecord, ConversationResponse
from providers.freepik.models import FreepikGeneration
from providers.envato.models import EnvatoGeneration
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.flow.models import FlowGeneration

from .providers import PROVIDERS, provider_meta

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
CYCLE_DAYS = 15                 # the "15-day cycle" from the reference report
RAW_ROW_CAP = 20_000            # max rows rendered into each raw-log sheet
CHATGPT = "chatgpt"
FREEPIK = "freepik"
ENVATO = "envato"
HEYGEN = "heygen"
HIGGSFIELD = "higgsfield"
ELEVENLABS = "elevenlabs"
FLOW = "flow"
# The only Freepik tool that produces a video (confirmed against real
# captured payloads) - everything else produces a still image.
FREEPIK_VIDEO_TOOL = "video-generator"

# Kling usage lives in ITPortalToolUsageEvent (the true "generation done on the
# tool" log), NOT GenerationRecord (a deduplicated asset table that undercounts
# because many events are still reconciling). Mirrors reports_router.
KLING_TOOL_SLUGS = ("kling", "kling-ai", "klingai")
MAX_SANE_KLING_CREDITS = 3000   # clamp garbage credit values (matches router)

# Timestamps are stored UTC; the team works in IST (+05:30). Kling usage events
# already carry an IST ``event_date``; ChatGPT is bucketed by shifting UTC.
LOCAL_TZ_OFFSET = timedelta(minutes=330)


# --------------------------------------------------------------------------- #
# Typed snapshot structures
# --------------------------------------------------------------------------- #
@dataclass
class Period:
    start: date
    end: date                   # inclusive
    days: int

    @property
    def start_dt(self) -> datetime:
        return datetime(self.start.year, self.start.month, self.start.day)

    @property
    def end_exclusive(self) -> datetime:
        return datetime(self.end.year, self.end.month, self.end.day) + timedelta(days=1)

    @property
    def label(self) -> str:
        return f"{self.start:%d-%b-%Y} to {self.end:%d-%b-%Y}"


@dataclass
class Employee:
    user_id: int
    employee_id: str
    name: str
    department: str
    # aggregates (filled during assembly)
    chatgpt_sessions: int = 0
    chatgpt_last: Optional[date] = None
    kling_videos: int = 0
    kling_credits: float = 0.0
    kling_last: Optional[date] = None
    freepik_generations: int = 0
    freepik_images: int = 0
    freepik_videos: int = 0
    freepik_credits_charged: float = 0.0
    freepik_credits_estimated: float = 0.0
    freepik_last: Optional[date] = None
    envato_generations: int = 0
    envato_credits: float = 0.0
    envato_last: Optional[date] = None
    heygen_videos: int = 0
    heygen_credits: float = 0.0
    heygen_last: Optional[date] = None
    higgsfield_generations: int = 0
    higgsfield_credits: float = 0.0
    higgsfield_last: Optional[date] = None
    # No credits/numeric field - none confirmed yet for ElevenLabs (see
    # providers/elevenlabs/CAPTURE_CONTRACT.md's known gaps), don't invent one.
    elevenlabs_generations: int = 0
    elevenlabs_last: Optional[date] = None
    # No credits/numeric field either - Flow's flowWorkflows response carries
    # no credit ledger at all (see providers/flow/CAPTURE_CONTRACT.md), same
    # posture as ElevenLabs above.
    flow_generations: int = 0
    flow_last: Optional[date] = None

    @property
    def tools_used(self) -> int:
        return (
            (1 if self.chatgpt_sessions else 0)
            + (1 if self.kling_videos else 0)
            + (1 if self.freepik_generations else 0)
            + (1 if self.envato_generations else 0)
            + (1 if self.heygen_videos else 0)
            + (1 if self.higgsfield_generations else 0)
            + (1 if self.elevenlabs_generations else 0)
            + (1 if self.flow_generations else 0)
        )

    @property
    def total_usage(self) -> int:
        return (
            self.chatgpt_sessions + self.kling_videos + self.freepik_generations
            + self.envato_generations + self.heygen_videos + self.higgsfield_generations
            + self.elevenlabs_generations + self.flow_generations
        )

    @property
    def composite_score(self) -> int:
        return (
            self.chatgpt_sessions + self.kling_videos + self.freepik_generations
            + self.envato_generations + self.heygen_videos + self.higgsfield_generations
            + self.elevenlabs_generations + self.flow_generations
        )

    @property
    def adoption_status(self) -> str:
        t = self.tools_used
        return "Not Used" if t == 0 else "Using 1 Tool" if t == 1 else "Using Multiple Tools"

    @property
    def maturity_level(self) -> str:
        s = self.composite_score
        if s == 0:
            return "Dormant"
        if s <= 5:
            return "Explorer"
        if s <= 15:
            return "Adopter"
        if s <= 40:
            return "Power User"
        return "Champion"

    @property
    def usage_category(self) -> str:
        s = self.composite_score
        if s == 0:
            return "Inactive"
        if s <= 5:
            return "Light"
        if s <= 15:
            return "Moderate"
        return "Heavy"


@dataclass
class ToolInfo:
    name: str
    vendor: str
    integration_status: str      # Integrated | Pending
    category: str
    captured_fields: str
    version: str
    api_status: str
    subscription: str
    owner: str
    last_sync: Optional[date]
    future_expansion: str


@dataclass
class Event:
    """A normalized cross-provider event feeding the merged Overview log."""

    when: date
    tool: str                    # "ChatGPT" | "Kling"
    employee_id: str
    employee_name: str
    department: str
    prompt: str = ""
    response: str = ""
    model: str = ""
    credits: Optional[float] = None
    videos: Optional[int] = None
    gen_time: Optional[float] = None
    status: str = ""
    ref_id: str = ""             # conversation id / generation id
    # "Image" | "Video" - only meaningful for Freepik (a mixed-media tool;
    # Kling is video-only and ChatGPT is text, so both leave this blank).
    kind: str = ""
    # Client Mapping (the admin-curated Client list, see GenerationClient /
    # utils/client_gate.py) - populated for every generation-gated provider
    # (Kling/Freepik/Envato/HeyGen/Higgsfield, each with a pre-generation
    # Task/Client picker). Blank for ChatGPT (grouped under the sheet's "No
    # Client" bucket), same convention `kind` already uses for
    # provider-specific fields.
    client_name: str = ""
    # Task Mapping - independent of Client Mapping above, same
    # populated-for-every-gated-provider / blank-for-ChatGPT convention.
    task_name: str = ""


@dataclass
class ChatGptEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str
    response: str
    conversation_id: str
    tokens: Optional[int]
    status: str


@dataclass
class KlingEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str
    negative_prompt: str
    model: str
    aspect_ratio: str
    duration: str
    credits: Optional[float]
    videos: int
    gen_time: Optional[float]
    kling_id: str
    project: str
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)


@dataclass
class FreepikEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str
    tool: str                    # "image-generator" | "video-generator" | ...
    model: str                   # mode/service, e.g. "pro-1.5"
    resolution: str
    credits_charged: Optional[float]
    credits_estimated: Optional[float]
    family_id: str
    creation_id: str
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)

    @property
    def is_video(self) -> bool:
        # Confirmed against real captured payloads: "video-generator" is the
        # only Freepik tool that produces a clip; everything else (
        # "text-to-image", upscalers, etc.) produces a still image.
        return self.tool == "video-generator"

    @property
    def kind(self) -> str:
        return "Video" if self.is_video else "Image"


@dataclass
class EnvatoEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str
    item_type: str               # "genai-image" | "genai-video" | ... (see providers/envato/constants.py)
    aspect_ratio: str
    style: str
    # Best-effort only - Envato exposes no numeric per-item credit ledger (see
    # EnvatoGeneration's own docstring). This is the "+N" badge scraped off
    # the Generate button at click time, not a confirmed charge.
    credits: Optional[float]
    item_uuid: str
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)

    @property
    def kind(self) -> str:
        # Mirrors FreepikEvent.kind's human label; falls back to the raw
        # item_type for the 5 item types never observed in a real payload.
        return {
            "genai-image": "Image",
            "genai-video": "Video",
            "genai-vector": "Vector",
            "genai-voice": "Voice",
            "genai-music": "Music",
            "genai-sound": "Sound",
        }.get(self.item_type, self.item_type or "—")


@dataclass
class HeygenEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str                  # script_text
    avatar_name: str
    voice_name: str
    resolution: str
    credits: Optional[float]     # credits_used
    ref_id: str                  # video_id/render_id/job_id/workflow_id, whichever is present
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)


@dataclass
class HiggsfieldEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str                  # prompt_text
    kind_raw: str                 # create_video | edit_video | motion_control
    output_type: str              # "video" | "image" (confirmed - Higgsfield is NOT video-only, unlike HeyGen)
    preset_name: str
    credits: Optional[float]     # credits_used
    ref_id: str                  # generation_id/job_id/request_id, whichever is present
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)

    @property
    def kind(self) -> str:
        return "Video" if self.output_type == "video" else "Image" if self.output_type == "image" else (self.output_type or "—")


@dataclass
class ElevenlabsEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str                  # the text fed to TTS/Music/SFX, when present
    source: str                  # ElevenLabs' own "source" string (e.g. "TTS") - plays the role
                                  # HeyGen's output_type plays; see providers/elevenlabs/CAPTURE_CONTRACT.md
    voice_name: str
    ref_id: str                  # provider_creation_id (best-guess identity - see normalization.py)
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)


@dataclass
class FlowEvent:
    when: date
    employee_id: str
    employee_name: str
    department: str
    prompt: str                  # metadata.displayName - Flow's own prompt field
    project_id: str
    batch_id: str                # siblings of one Generate click share this
    ref_id: str                  # provider_creation_id (flowWorkflows.name - the only confirmed identifier)
    status: str
    client_name: str = ""        # "" when not linked to a client (see Event.client_name)
    task_name: str = ""          # "" when not linked to a task (see Event.task_name)


@dataclass
class ToolUsage:
    tool: str
    employees_using: int
    total_volume: int
    pct_workforce: float


@dataclass
class DeptAdoption:
    department: str
    headcount: int
    adopters: int

    @property
    def pct(self) -> float:
        return (self.adopters / self.headcount) if self.headcount else 0.0


@dataclass
class DailyPoint:
    day: date
    chatgpt: int
    kling: int
    freepik: int = 0
    envato: int = 0
    heygen: int = 0
    higgsfield: int = 0
    elevenlabs: int = 0
    flow: int = 0

    @property
    def total(self) -> int:
        return (
            self.chatgpt + self.kling + self.freepik + self.envato + self.heygen
            + self.higgsfield + self.elevenlabs + self.flow
        )


@dataclass
class Warning:
    severity: str                # Info | Warning | Error
    check: str
    detail: str


@dataclass
class Kpis:
    total_employees: int
    total_tools: int
    tools_integrated: int
    employees_using_ai: int
    adoption_pct: float
    total_sessions: int          # ChatGPT prompt events
    total_generations: int       # Kling videos + Freepik generations
    total_credits: float         # Kling credits + Freepik credits charged
    total_freepik_generations: int = 0
    total_freepik_images: int = 0
    total_freepik_videos: int = 0
    total_freepik_credits_charged: float = 0.0
    total_freepik_credits_estimated: float = 0.0
    total_envato_generations: int = 0
    total_envato_credits: float = 0.0
    total_heygen_videos: int = 0
    total_heygen_credits: float = 0.0
    total_higgsfield_generations: int = 0
    total_higgsfield_credits: float = 0.0
    # No credits field - none confirmed yet for ElevenLabs (see
    # providers/elevenlabs/CAPTURE_CONTRACT.md's known gaps).
    total_elevenlabs_generations: int = 0
    # Same for Flow (see providers/flow/CAPTURE_CONTRACT.md) - count only.
    total_flow_generations: int = 0


@dataclass
class ReportDataset:
    generated_at: datetime
    period: Period
    employees: list[Employee]
    tools: list[ToolInfo]
    chatgpt_events: list[ChatGptEvent]
    kling_events: list[KlingEvent]
    freepik_events: list[FreepikEvent]
    envato_events: list[EnvatoEvent]
    heygen_events: list[HeygenEvent]
    higgsfield_events: list[HiggsfieldEvent]
    elevenlabs_events: list[ElevenlabsEvent]
    flow_events: list[FlowEvent]
    merged_events: list[Event]
    tool_usage: list[ToolUsage]
    dept_adoption: list[DeptAdoption]
    daily: list[DailyPoint]
    top_employees: list[Employee]
    warnings: list[Warning]
    kpis: Kpis
    raw_truncated: bool = False
    version: str = "1.0.0"


# --------------------------------------------------------------------------- #
# Period resolution
# --------------------------------------------------------------------------- #
MAX_WINDOW_DAYS = 400  # guard rail against an unbounded custom range


def _resolve_period(start: Optional[date], end: Optional[date], ref_date: Optional[date]) -> Period:
    if start and end:
        if start > end:
            start, end = end, start
        days = (end - start).days + 1
        if days > MAX_WINDOW_DAYS:
            start = end - timedelta(days=MAX_WINDOW_DAYS - 1)
            days = MAX_WINDOW_DAYS
        return Period(start=start, end=end, days=days)
    if start and not end:
        return Period(start=start, end=start + timedelta(days=CYCLE_DAYS - 1), days=CYCLE_DAYS)
    if end and not start:
        return Period(start=end - timedelta(days=CYCLE_DAYS - 1), end=end, days=CYCLE_DAYS)
    ref = ref_date or date.today()
    return Period(start=ref - timedelta(days=CYCLE_DAYS - 1), end=ref, days=CYCLE_DAYS)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _clip(text: Optional[str], n: int = 120) -> str:
    if not text:
        return ""
    t = " ".join(str(text).split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _as_date(value) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


def _meta_get(meta, *keys):
    if not isinstance(meta, dict):
        return None
    for k in keys:
        v = meta.get(k)
        if v not in (None, ""):
            return v
    return None


# --------------------------------------------------------------------------- #
# The one public builder
# --------------------------------------------------------------------------- #
def build_dataset(
    db: Session,
    *,
    start: Optional[date] = None,
    end: Optional[date] = None,
    ref_date: Optional[date] = None,
) -> ReportDataset:
    """
    Build the snapshot for a reporting window.

    Window resolution (first match wins):
      * explicit ``start`` and ``end``  -> that inclusive range
      * ``start`` or ``end`` alone       -> a CYCLE_DAYS window anchored on it
      * neither                          -> rolling CYCLE_DAYS ending on ``ref_date``
                                            (default today)
    """
    period = _resolve_period(start, end, ref_date)
    # ChatGPT is UTC-stored -> shift the window so we bucket by the IST calendar.
    cg_start = period.start_dt - LOCAL_TZ_OFFSET
    cg_end = period.end_exclusive - LOCAL_TZ_OFFSET
    # Kling usage events are filtered on their IST ``event_date`` directly.
    kling_tool_ids = _kling_tool_ids(db)
    # Freepik's provider_created_at is UTC-stored too (same shift as ChatGPT).
    fp_start = period.start_dt - LOCAL_TZ_OFFSET
    fp_end = period.end_exclusive - LOCAL_TZ_OFFSET
    # Envato's provider_created_at is UTC-stored too (same shift as ChatGPT).
    ev_start = period.start_dt - LOCAL_TZ_OFFSET
    ev_end = period.end_exclusive - LOCAL_TZ_OFFSET
    # HeyGen's / Higgsfield's provider_created_at are UTC-stored too (same shift).
    hg_start = period.start_dt - LOCAL_TZ_OFFSET
    hg_end = period.end_exclusive - LOCAL_TZ_OFFSET
    hf_start = period.start_dt - LOCAL_TZ_OFFSET
    hf_end = period.end_exclusive - LOCAL_TZ_OFFSET
    # ElevenLabs' provider_created_at is UTC-stored too (same shift as ChatGPT).
    el_start = period.start_dt - LOCAL_TZ_OFFSET
    el_end = period.end_exclusive - LOCAL_TZ_OFFSET
    # Flow's provider_created_at is UTC-stored too (same shift as ChatGPT).
    fl_start = period.start_dt - LOCAL_TZ_OFFSET
    fl_end = period.end_exclusive - LOCAL_TZ_OFFSET

    employees = _load_employees(db)
    by_uid = {emp.user_id: emp for emp in employees}

    _apply_chatgpt_aggregates(db, cg_start, cg_end, by_uid)
    _apply_kling_aggregates(db, period, kling_tool_ids, by_uid)
    _apply_freepik_aggregates(db, fp_start, fp_end, by_uid)
    _apply_envato_aggregates(db, ev_start, ev_end, by_uid)
    _apply_heygen_aggregates(db, hg_start, hg_end, by_uid)
    _apply_higgsfield_aggregates(db, hf_start, hf_end, by_uid)
    _apply_elevenlabs_aggregates(db, el_start, el_end, by_uid)
    _apply_flow_aggregates(db, fl_start, fl_end, by_uid)

    chatgpt_events, cg_trunc = _load_chatgpt_events(db, cg_start, cg_end, by_uid)
    kling_events, kl_trunc = _load_kling_events(db, period, kling_tool_ids, by_uid)
    freepik_events, fp_trunc = _load_freepik_events(db, fp_start, fp_end, by_uid)
    envato_events, ev_trunc = _load_envato_events(db, ev_start, ev_end, by_uid)
    heygen_events, hg_trunc = _load_heygen_events(db, hg_start, hg_end, by_uid)
    higgsfield_events, hf_trunc = _load_higgsfield_events(db, hf_start, hf_end, by_uid)
    elevenlabs_events, el_trunc = _load_elevenlabs_events(db, el_start, el_end, by_uid)
    flow_events, fl_trunc = _load_flow_events(db, fl_start, fl_end, by_uid)
    merged = _merge_events(
        chatgpt_events, kling_events, freepik_events, envato_events, heygen_events, higgsfield_events,
        elevenlabs_events, flow_events,
    )

    tools = _load_tools(db)
    tool_usage = _tool_usage(employees)
    dept_adoption = _dept_adoption(employees)
    daily = _daily_trend(
        period, chatgpt_events, kling_events, freepik_events, envato_events, heygen_events, higgsfield_events,
        elevenlabs_events, flow_events,
    )
    top = sorted(employees, key=lambda emp: (emp.composite_score, emp.total_usage), reverse=True)[:5]
    kpis = _kpis(employees, tools)
    warnings = _validate(
        employees, chatgpt_events, kling_events, freepik_events, envato_events,
        heygen_events, higgsfield_events, elevenlabs_events, flow_events, period,
    )

    return ReportDataset(
        generated_at=datetime.now(),
        period=period,
        employees=employees,
        tools=tools,
        chatgpt_events=chatgpt_events,
        kling_events=kling_events,
        freepik_events=freepik_events,
        envato_events=envato_events,
        heygen_events=heygen_events,
        higgsfield_events=higgsfield_events,
        elevenlabs_events=elevenlabs_events,
        flow_events=flow_events,
        merged_events=merged,
        tool_usage=tool_usage,
        dept_adoption=dept_adoption,
        daily=daily,
        top_employees=top,
        warnings=warnings,
        kpis=kpis,
        raw_truncated=(
            cg_trunc or kl_trunc or fp_trunc or ev_trunc or hg_trunc or hf_trunc or el_trunc or fl_trunc
        ),
    )


# --------------------------------------------------------------------------- #
# Employees + aggregates
# --------------------------------------------------------------------------- #
def _load_employees(db: Session) -> list[Employee]:
    rows = (
        db.query(User.id, User.employee_id, User.name, User.department)
        .filter(User.is_deleted.is_(False))
        .order_by(User.employee_id.asc())
        .all()
    )
    out = []
    for uid, emp_id, name, dept in rows:
        out.append(
            Employee(
                user_id=uid,
                employee_id=emp_id or f"U{uid}",
                name=name or "Unknown",
                department=dept or "Unassigned",
            )
        )
    return out


def _kling_tool_ids(db: Session) -> list[int]:
    rows = (
        db.query(ITPortalTool.id)
        .filter(func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_TOOL_SLUGS))
        .all()
    )
    return [r[0] for r in rows]


def _sane_credits():
    """Credit value clamped to a sane range; garbage becomes 0 (matches router)."""
    return case(
        (ITPortalToolUsageEvent.credits_burned.between(0, MAX_SANE_KLING_CREDITS),
         ITPortalToolUsageEvent.credits_burned),
        else_=0.0,
    )


def _apply_chatgpt_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    # Count prompts via the denormalized ConversationRecord.prompt_count (same as
    # the live dashboard) rather than counting ConversationPrompt rows: detailed
    # message capture can lag the conversation-level counter, and counting rows
    # would undercount — the same class of bug we just fixed for Kling.
    rows = (
        db.query(
            ConversationRecord.owner_user_id,
            func.coalesce(func.sum(ConversationRecord.prompt_count), 0),
            func.max(ConversationRecord.created_at),
        )
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == CHATGPT,
            ConversationRecord.created_at >= s,
            ConversationRecord.created_at < e,
        )
        .group_by(ConversationRecord.owner_user_id)
        .all()
    )
    for uid, cnt, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.chatgpt_sessions = int(cnt or 0)
            emp.chatgpt_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


def _apply_kling_aggregates(db, period: "Period", tool_ids: list[int], by_uid: dict[int, Employee]) -> None:
    """Kling usage from ITPortalToolUsageEvent, dated by the IST ``event_date``.

    One usage event == one generation done on the tool (the two capture paths,
    generate_click and network_generation, are near-disjoint). Credits are
    clamped so garbage values do not distort totals.
    """
    if not tool_ids:
        return
    rows = (
        db.query(
            ITPortalToolUsageEvent.user_id,
            func.count(ITPortalToolUsageEvent.id),
            func.coalesce(func.sum(_sane_credits()), 0.0),
            func.max(ITPortalToolUsageEvent.event_date),
        )
        .filter(
            ITPortalToolUsageEvent.tool_id.in_(tool_ids),
            ITPortalToolUsageEvent.event_date >= period.start,
            ITPortalToolUsageEvent.event_date <= period.end,
        )
        .group_by(ITPortalToolUsageEvent.user_id)
        .all()
    )
    for uid, cnt, credits, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.kling_videos = int(cnt or 0)
            emp.kling_credits = float(credits or 0.0)
            emp.kling_last = _as_date(last)


def _apply_freepik_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    """Freepik generations from FreepikGeneration directly (not the generic
    GenerationRecord projection, which collapses charged/estimated into one
    ``credits_burned`` column - see providers/freepik/normalization.py). Only
    owner-attributed rows count toward an employee, same as Kling/ChatGPT
    ("unclaimed" rows have no employee to attribute to by design). Freepik is
    a mixed-media tool (unlike Kling, which is video-only), so generations
    are additionally split into images vs. videos via a conditional sum on
    ``tool`` - see FREEPIK_VIDEO_TOOL."""
    video_case = case((FreepikGeneration.tool == FREEPIK_VIDEO_TOOL, 1), else_=0)
    rows = (
        db.query(
            FreepikGeneration.owner_user_id,
            func.count(FreepikGeneration.id),
            func.coalesce(func.sum(video_case), 0),
            func.coalesce(func.sum(FreepikGeneration.credits_charged), 0.0),
            func.coalesce(func.sum(FreepikGeneration.credits_estimated), 0.0),
            func.max(FreepikGeneration.provider_created_at),
        )
        .filter(
            FreepikGeneration.owner_user_id.isnot(None),
            FreepikGeneration.provider_created_at >= s,
            FreepikGeneration.provider_created_at < e,
        )
        .group_by(FreepikGeneration.owner_user_id)
        .all()
    )
    for uid, cnt, videos, charged, estimated, last in rows:
        emp = by_uid.get(uid)
        if emp:
            total = int(cnt or 0)
            video_count = int(videos or 0)
            emp.freepik_generations = total
            emp.freepik_videos = video_count
            emp.freepik_images = total - video_count
            emp.freepik_credits_charged = float(charged or 0.0)
            emp.freepik_credits_estimated = float(estimated or 0.0)
            emp.freepik_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


def _apply_envato_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    """Envato generations from EnvatoGeneration directly. Only owner-attributed
    rows count toward an employee, same rationale as Kling/Freepik/ChatGPT.
    Credits are the best-effort ``credits_badge`` scrape (see EnvatoGeneration's
    own docstring - Envato exposes no numeric per-item credit ledger)."""
    rows = (
        db.query(
            EnvatoGeneration.owner_user_id,
            func.count(EnvatoGeneration.id),
            func.coalesce(func.sum(EnvatoGeneration.credits_badge), 0.0),
            func.max(EnvatoGeneration.provider_created_at),
        )
        .filter(
            EnvatoGeneration.owner_user_id.isnot(None),
            EnvatoGeneration.provider_created_at >= s,
            EnvatoGeneration.provider_created_at < e,
        )
        .group_by(EnvatoGeneration.owner_user_id)
        .all()
    )
    for uid, cnt, credits, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.envato_generations = int(cnt or 0)
            emp.envato_credits = float(credits or 0.0)
            emp.envato_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


def _apply_heygen_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    """HeyGen generations from HeygenGeneration directly. Only owner-attributed
    rows count toward an employee, same rationale as every other provider here.
    HeyGen is a video-only tool (avatar videos), same posture as Kling.
    ``credits_used`` is captured directly (not a badge scrape) - see
    HeygenGeneration's own docstring."""
    rows = (
        db.query(
            HeygenGeneration.owner_user_id,
            func.count(HeygenGeneration.id),
            func.coalesce(func.sum(HeygenGeneration.credits_used), 0.0),
            func.max(HeygenGeneration.provider_created_at),
        )
        .filter(
            HeygenGeneration.owner_user_id.isnot(None),
            HeygenGeneration.provider_created_at >= s,
            HeygenGeneration.provider_created_at < e,
        )
        .group_by(HeygenGeneration.owner_user_id)
        .all()
    )
    for uid, cnt, credits, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.heygen_videos = int(cnt or 0)
            emp.heygen_credits = float(credits or 0.0)
            emp.heygen_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


def _apply_higgsfield_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    """Higgsfield generations from HiggsfieldGeneration directly. Only
    owner-attributed rows count toward an employee, same rationale as every
    other provider here. Higgsfield is mixed-media (confirmed - some job sets
    produce video, others image, see HiggsfieldGeneration.output_type), but
    (like Envato) is not split into images/videos at the aggregate level -
    just a total generation count + best-effort credits_used."""
    rows = (
        db.query(
            HiggsfieldGeneration.owner_user_id,
            func.count(HiggsfieldGeneration.id),
            func.coalesce(func.sum(HiggsfieldGeneration.credits_used), 0.0),
            func.max(HiggsfieldGeneration.provider_created_at),
        )
        .filter(
            HiggsfieldGeneration.owner_user_id.isnot(None),
            HiggsfieldGeneration.provider_created_at >= s,
            HiggsfieldGeneration.provider_created_at < e,
        )
        .group_by(HiggsfieldGeneration.owner_user_id)
        .all()
    )
    for uid, cnt, credits, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.higgsfield_generations = int(cnt or 0)
            emp.higgsfield_credits = float(credits or 0.0)
            emp.higgsfield_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


def _apply_elevenlabs_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    """ElevenLabs generations from ElevenlabsGeneration directly. Only
    owner-attributed rows count toward an employee, same rationale as every
    other provider here. No credits/numeric field is confirmed for
    ElevenLabs yet (see providers/elevenlabs/CAPTURE_CONTRACT.md's known
    gaps) - unlike HeyGen/Higgsfield, this aggregate is a plain count +
    last-used date, nothing more."""
    rows = (
        db.query(
            ElevenlabsGeneration.owner_user_id,
            func.count(ElevenlabsGeneration.id),
            func.max(ElevenlabsGeneration.provider_created_at),
        )
        .filter(
            ElevenlabsGeneration.owner_user_id.isnot(None),
            ElevenlabsGeneration.provider_created_at >= s,
            ElevenlabsGeneration.provider_created_at < e,
        )
        .group_by(ElevenlabsGeneration.owner_user_id)
        .all()
    )
    for uid, cnt, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.elevenlabs_generations = int(cnt or 0)
            emp.elevenlabs_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


def _apply_flow_aggregates(db, s, e, by_uid: dict[int, Employee]) -> None:
    """Flow generations from FlowGeneration directly. Only owner-attributed
    rows count toward an employee, same rationale as every other provider
    here (Flow's flowWorkflows response is scoped to the shared Google
    account, never to an employee - attribution comes from the launch ticket
    at capture time, see FlowGeneration's own docstring). Flow's captured
    payload carries no credit ledger at all, so - like ElevenLabs - this is a
    plain count + last-used date, nothing more."""
    rows = (
        db.query(
            FlowGeneration.owner_user_id,
            func.count(FlowGeneration.id),
            func.max(FlowGeneration.provider_created_at),
        )
        .filter(
            FlowGeneration.owner_user_id.isnot(None),
            FlowGeneration.provider_created_at >= s,
            FlowGeneration.provider_created_at < e,
        )
        .group_by(FlowGeneration.owner_user_id)
        .all()
    )
    for uid, cnt, last in rows:
        emp = by_uid.get(uid)
        if emp:
            emp.flow_generations = int(cnt or 0)
            emp.flow_last = _as_date(last + LOCAL_TZ_OFFSET) if last else None  # UTC -> IST


# --------------------------------------------------------------------------- #
# Raw event rows (capped)
# --------------------------------------------------------------------------- #
def _load_chatgpt_events(db, s, e, by_uid) -> tuple[list[ChatGptEvent], bool]:
    q = (
        db.query(
            func.coalesce(ConversationPrompt.prompt_timestamp, ConversationPrompt.created_at),
            ConversationRecord.owner_user_id,
            ConversationRecord.provider_conversation_id,
            ConversationPrompt.prompt_text,
            ConversationResponse.response_text,
            ConversationResponse.response_length,
            ConversationResponse.response_status,
        )
        .select_from(ConversationPrompt)
        .join(ConversationRecord, ConversationRecord.id == ConversationPrompt.conversation_id)
        .outerjoin(ConversationResponse, ConversationResponse.prompt_id == ConversationPrompt.id)
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == CHATGPT,
            ConversationRecord.created_at >= s,
            ConversationRecord.created_at < e,
        )
        .order_by(func.coalesce(ConversationPrompt.prompt_timestamp, ConversationPrompt.created_at).asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for when, uid, conv_id, prompt, response, resp_len, status in rows:
        emp = by_uid.get(uid)
        out.append(
            ChatGptEvent(
                when=_as_date(when + LOCAL_TZ_OFFSET) if when else None,  # UTC -> IST
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unknown",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt),
                response=_clip(response),
                conversation_id=conv_id or "—",
                tokens=int(resp_len) if resp_len else None,
                status=(status or "completed").title(),
            )
        )
    return out, truncated


def _load_kling_events(db, period: "Period", tool_ids: list[int], by_uid) -> tuple[list[KlingEvent], bool]:
    """One row per Kling usage event (== one generation), dated by IST event_date.

    Selects only the needed columns (never ``metadata_json`` — it is large and,
    for Kling usage events, does not carry negative-prompt / aspect / gen-time),
    so the fetch stays light even at the raw-row cap.
    """
    if not tool_ids:
        return [], False
    UE = ITPortalToolUsageEvent
    q = (
        db.query(
            UE.user_id, UE.event_date, UE.prompt_text, UE.model_label,
            UE.duration_label, UE.resolution_label, UE.credits_burned,
            UE.generation_id, UE.external_event_id, UE.event_type, UE.status,
            UE.linked_client_name, UE.linked_task_name,
        )
        .filter(
            UE.tool_id.in_(tool_ids),
            UE.event_date >= period.start,
            UE.event_date <= period.end,
        )
        .order_by(UE.event_date.asc(), UE.created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, event_date, prompt_text, model_label, duration_label,
         resolution_label, credits_burned, generation_id, external_event_id,
         event_type, status, linked_client_name, linked_task_name) in rows:
        emp = by_uid.get(user_id)
        credits = credits_burned
        if credits is not None and not (0 <= credits <= MAX_SANE_KLING_CREDITS):
            credits = None  # garbage -> blank rather than a misleading number
        out.append(
            KlingEvent(
                when=_as_date(event_date),
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt_text),
                negative_prompt="",
                model=model_label or "—",
                aspect_ratio=resolution_label or "—",
                duration=duration_label or "—",
                credits=float(credits) if credits is not None else None,
                videos=1,
                gen_time=None,
                kling_id=generation_id or external_event_id or "—",
                project=event_type or "—",
                status=(status or "settled").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _load_freepik_events(db, s, e, by_uid) -> tuple[list[FreepikEvent], bool]:
    """One row per Freepik generation, dated by ``provider_created_at`` (the
    actual Freepik render time) shifted to IST. Only owner-attributed rows are
    included, same rationale as ``_apply_freepik_aggregates``."""
    q = (
        db.query(
            FreepikGeneration.owner_user_id, FreepikGeneration.provider_created_at,
            FreepikGeneration.prompt, FreepikGeneration.tool, FreepikGeneration.mode,
            FreepikGeneration.resolution, FreepikGeneration.credits_charged,
            FreepikGeneration.credits_estimated, FreepikGeneration.family_id,
            FreepikGeneration.creation_id, FreepikGeneration.status,
            FreepikGeneration.linked_client_name, FreepikGeneration.linked_task_name,
        )
        .filter(
            FreepikGeneration.owner_user_id.isnot(None),
            FreepikGeneration.provider_created_at >= s,
            FreepikGeneration.provider_created_at < e,
        )
        .order_by(FreepikGeneration.provider_created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, provider_created_at, prompt, tool, mode, resolution, credits_charged,
         credits_estimated, family_id, creation_id, status, linked_client_name, linked_task_name) in rows:
        emp = by_uid.get(user_id)
        out.append(
            FreepikEvent(
                when=_as_date(provider_created_at + LOCAL_TZ_OFFSET) if provider_created_at else None,
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt),
                tool=tool or "—",
                model=mode or "—",
                resolution=resolution or "—",
                credits_charged=float(credits_charged) if credits_charged is not None else None,
                credits_estimated=float(credits_estimated) if credits_estimated is not None else None,
                family_id=family_id or "—",
                creation_id=creation_id or "—",
                status=(status or "completed").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _load_envato_events(db, s, e, by_uid) -> tuple[list[EnvatoEvent], bool]:
    """One row per Envato generation, dated by ``provider_created_at`` (the
    actual Envato render time) shifted to IST. Only owner-attributed rows are
    included, same rationale as ``_apply_envato_aggregates``."""
    q = (
        db.query(
            EnvatoGeneration.owner_user_id, EnvatoGeneration.provider_created_at,
            EnvatoGeneration.prompt, EnvatoGeneration.item_type, EnvatoGeneration.aspect_ratio,
            EnvatoGeneration.style, EnvatoGeneration.credits_badge, EnvatoGeneration.item_uuid,
            EnvatoGeneration.review_status, EnvatoGeneration.linked_client_name,
            EnvatoGeneration.linked_task_name,
        )
        .filter(
            EnvatoGeneration.owner_user_id.isnot(None),
            EnvatoGeneration.provider_created_at >= s,
            EnvatoGeneration.provider_created_at < e,
        )
        .order_by(EnvatoGeneration.provider_created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, provider_created_at, prompt, item_type, aspect_ratio, style, credits_badge,
         item_uuid, review_status, linked_client_name, linked_task_name) in rows:
        emp = by_uid.get(user_id)
        out.append(
            EnvatoEvent(
                when=_as_date(provider_created_at + LOCAL_TZ_OFFSET) if provider_created_at else None,
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt),
                item_type=item_type or "—",
                aspect_ratio=aspect_ratio or "—",
                style=style or "—",
                credits=float(credits_badge) if credits_badge is not None else None,
                item_uuid=item_uuid or "—",
                status=(review_status or "completed").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _load_heygen_events(db, s, e, by_uid) -> tuple[list[HeygenEvent], bool]:
    """One row per HeyGen generation, dated by ``provider_created_at`` shifted
    to IST. Only owner-attributed rows are included, same rationale as
    ``_apply_heygen_aggregates``. HeyGen's identity is spread across several
    candidate columns (see HeygenGeneration's own docstring - its exact field
    naming was never directly observed) - ``ref_id`` picks the first
    non-null one client-side rather than assuming any single column."""
    q = (
        db.query(
            HeygenGeneration.owner_user_id, HeygenGeneration.provider_created_at,
            HeygenGeneration.script_text, HeygenGeneration.avatar_name, HeygenGeneration.voice_name,
            HeygenGeneration.resolution, HeygenGeneration.credits_used,
            HeygenGeneration.video_id, HeygenGeneration.render_id, HeygenGeneration.job_id,
            HeygenGeneration.workflow_id, HeygenGeneration.external_event_id,
            HeygenGeneration.status, HeygenGeneration.linked_client_name,
            HeygenGeneration.linked_task_name,
        )
        .filter(
            HeygenGeneration.owner_user_id.isnot(None),
            HeygenGeneration.provider_created_at >= s,
            HeygenGeneration.provider_created_at < e,
        )
        .order_by(HeygenGeneration.provider_created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, provider_created_at, script_text, avatar_name, voice_name, resolution, credits_used,
         video_id, render_id, job_id, workflow_id, external_event_id, status, linked_client_name,
         linked_task_name) in rows:
        emp = by_uid.get(user_id)
        out.append(
            HeygenEvent(
                when=_as_date(provider_created_at + LOCAL_TZ_OFFSET) if provider_created_at else None,
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(script_text),
                avatar_name=avatar_name or "—",
                voice_name=voice_name or "—",
                resolution=resolution or "—",
                credits=float(credits_used) if credits_used is not None else None,
                ref_id=video_id or render_id or job_id or workflow_id or external_event_id or "—",
                status=(status or "completed").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _load_higgsfield_events(db, s, e, by_uid) -> tuple[list[HiggsfieldEvent], bool]:
    """One row per Higgsfield generation, dated by ``provider_created_at``
    shifted to IST. Only owner-attributed rows are included, same rationale
    as ``_apply_higgsfield_aggregates``. Identity handled the same
    first-non-null way as HeyGen's - see ``_load_heygen_events``."""
    q = (
        db.query(
            HiggsfieldGeneration.owner_user_id, HiggsfieldGeneration.provider_created_at,
            HiggsfieldGeneration.prompt_text, HiggsfieldGeneration.kind, HiggsfieldGeneration.output_type,
            HiggsfieldGeneration.preset_name, HiggsfieldGeneration.credits_used,
            HiggsfieldGeneration.generation_id, HiggsfieldGeneration.job_id, HiggsfieldGeneration.request_id,
            HiggsfieldGeneration.external_event_id, HiggsfieldGeneration.status,
            HiggsfieldGeneration.linked_client_name, HiggsfieldGeneration.linked_task_name,
        )
        .filter(
            HiggsfieldGeneration.owner_user_id.isnot(None),
            HiggsfieldGeneration.provider_created_at >= s,
            HiggsfieldGeneration.provider_created_at < e,
        )
        .order_by(HiggsfieldGeneration.provider_created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, provider_created_at, prompt_text, kind, output_type, preset_name, credits_used,
         generation_id, job_id, request_id, external_event_id, status, linked_client_name,
         linked_task_name) in rows:
        emp = by_uid.get(user_id)
        out.append(
            HiggsfieldEvent(
                when=_as_date(provider_created_at + LOCAL_TZ_OFFSET) if provider_created_at else None,
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt_text),
                kind_raw=kind or "—",
                output_type=output_type or "",
                preset_name=preset_name or "—",
                credits=float(credits_used) if credits_used is not None else None,
                ref_id=generation_id or job_id or request_id or external_event_id or "—",
                status=(status or "completed").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _load_elevenlabs_events(db, s, e, by_uid) -> tuple[list[ElevenlabsEvent], bool]:
    """One row per ElevenLabs generation, dated by ``provider_created_at``
    shifted to IST. Only owner-attributed rows are included, same rationale
    as ``_apply_elevenlabs_aggregates``. Identity is a single best-guess
    column (``provider_creation_id`` - see normalization.py's
    _extract_fields), unlike HeyGen/Higgsfield's several-candidate-column
    approach, because ElevenlabsGeneration only ever stores the one already-
    resolved identity value, not several raw candidates."""
    q = (
        db.query(
            ElevenlabsGeneration.owner_user_id, ElevenlabsGeneration.provider_created_at,
            ElevenlabsGeneration.prompt, ElevenlabsGeneration.source, ElevenlabsGeneration.voice_name,
            ElevenlabsGeneration.provider_creation_id, ElevenlabsGeneration.status,
            ElevenlabsGeneration.linked_client_name, ElevenlabsGeneration.linked_task_name,
        )
        .filter(
            ElevenlabsGeneration.owner_user_id.isnot(None),
            ElevenlabsGeneration.provider_created_at >= s,
            ElevenlabsGeneration.provider_created_at < e,
        )
        .order_by(ElevenlabsGeneration.provider_created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, provider_created_at, prompt, source, voice_name, provider_creation_id, status,
         linked_client_name, linked_task_name) in rows:
        emp = by_uid.get(user_id)
        out.append(
            ElevenlabsEvent(
                when=_as_date(provider_created_at + LOCAL_TZ_OFFSET) if provider_created_at else None,
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt),
                source=source or "—",
                voice_name=voice_name or "—",
                ref_id=provider_creation_id or "—",
                status=(status or "completed").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _load_flow_events(db, s, e, by_uid) -> tuple[list[FlowEvent], bool]:
    """One row per Flow generation, dated by ``provider_created_at`` shifted
    to IST. Only owner-attributed rows are included, same rationale as
    ``_apply_flow_aggregates``. Identity is a single column
    (``provider_creation_id``, i.e. ``flowWorkflows.name``) rather than
    HeyGen/Higgsfield's several-candidate chain - it is the only identifier
    Flow's API has ever been observed to surface (see FlowGeneration's own
    docstring)."""
    q = (
        db.query(
            FlowGeneration.owner_user_id, FlowGeneration.provider_created_at,
            FlowGeneration.prompt, FlowGeneration.project_id, FlowGeneration.batch_id,
            FlowGeneration.provider_creation_id, FlowGeneration.status,
            FlowGeneration.linked_client_name, FlowGeneration.linked_task_name,
        )
        .filter(
            FlowGeneration.owner_user_id.isnot(None),
            FlowGeneration.provider_created_at >= s,
            FlowGeneration.provider_created_at < e,
        )
        .order_by(FlowGeneration.provider_created_at.asc())
        .limit(RAW_ROW_CAP + 1)
    )
    rows = q.all()
    truncated = len(rows) > RAW_ROW_CAP
    rows = rows[:RAW_ROW_CAP]
    out = []
    for (user_id, provider_created_at, prompt, project_id, batch_id, provider_creation_id, status,
         linked_client_name, linked_task_name) in rows:
        emp = by_uid.get(user_id)
        out.append(
            FlowEvent(
                when=_as_date(provider_created_at + LOCAL_TZ_OFFSET) if provider_created_at else None,
                employee_id=emp.employee_id if emp else "—",
                employee_name=emp.name if emp else "Unassigned",
                department=emp.department if emp else "Unassigned",
                prompt=_clip(prompt),
                project_id=project_id or "—",
                batch_id=batch_id or "—",
                ref_id=provider_creation_id or "—",
                # Flow's own payload carries no status field yet (see
                # providers/flow/constants.py) - default to the same
                # "completed" every other provider falls back to.
                status=(status or "completed").title(),
                client_name=linked_client_name or "",
                task_name=linked_task_name or "",
            )
        )
    return out, truncated


def _merge_events(
    cg: list[ChatGptEvent], kl: list[KlingEvent], fp: list[FreepikEvent], ev: list[EnvatoEvent],
    hg: list[HeygenEvent], hf: list[HiggsfieldEvent], el: list[ElevenlabsEvent], fl: list[FlowEvent],
) -> list[Event]:
    merged: list[Event] = []
    for c in cg:
        merged.append(
            Event(
                when=c.when, tool="ChatGPT", employee_id=c.employee_id, employee_name=c.employee_name,
                department=c.department, prompt=c.prompt, response=c.response, status=c.status,
                ref_id=c.conversation_id,
            )
        )
    for k in kl:
        merged.append(
            Event(
                when=k.when, tool="Kling", employee_id=k.employee_id, employee_name=k.employee_name,
                department=k.department, prompt=k.prompt, model=k.model, credits=k.credits,
                videos=k.videos, gen_time=k.gen_time, status=k.status, ref_id=k.kling_id or "—",
                kind="Video",  # Kling only ever produces video clips
                client_name=k.client_name, task_name=k.task_name,
            )
        )
    for f in fp:
        merged.append(
            Event(
                when=f.when, tool="Freepik", employee_id=f.employee_id, employee_name=f.employee_name,
                department=f.department, prompt=f.prompt, model=f.model, credits=f.credits_charged,
                # Freepik is mixed-media (unlike Kling, which is video-only) -
                # only count toward "videos" when this specific row actually
                # is one, and carry the Image/Video label through explicitly
                # so the log doesn't imply every row is a video.
                videos=1 if f.is_video else 0, kind=f.kind,
                status=f.status, ref_id=f.creation_id or "—",
                client_name=f.client_name, task_name=f.task_name,
            )
        )
    for a in ev:
        merged.append(
            Event(
                when=a.when, tool="Envato", employee_id=a.employee_id, employee_name=a.employee_name,
                department=a.department, prompt=a.prompt, credits=a.credits,
                videos=1 if a.item_type == "genai-video" else 0, kind=a.kind,
                status=a.status, ref_id=a.item_uuid or "—",
                client_name=a.client_name, task_name=a.task_name,
            )
        )
    for h in hg:
        merged.append(
            Event(
                when=h.when, tool="HeyGen", employee_id=h.employee_id, employee_name=h.employee_name,
                department=h.department, prompt=h.prompt, model=h.avatar_name, credits=h.credits,
                videos=1, kind="Video",  # HeyGen only ever produces avatar videos
                status=h.status, ref_id=h.ref_id or "—",
                client_name=h.client_name, task_name=h.task_name,
            )
        )
    for s in hf:
        merged.append(
            Event(
                when=s.when, tool="Higgsfield", employee_id=s.employee_id, employee_name=s.employee_name,
                department=s.department, prompt=s.prompt, model=s.preset_name, credits=s.credits,
                # Higgsfield is mixed-media (confirmed - some job sets produce
                # video, others image, see HiggsfieldGeneration.output_type)
                videos=1 if s.output_type == "video" else 0, kind=s.kind,
                status=s.status, ref_id=s.ref_id or "—",
                client_name=s.client_name, task_name=s.task_name,
            )
        )
    for l in el:
        merged.append(
            Event(
                when=l.when, tool="ElevenLabs", employee_id=l.employee_id, employee_name=l.employee_name,
                department=l.department, prompt=l.prompt, model=l.voice_name,
                # No credits/videos-produced concept confirmed yet - see
                # providers/elevenlabs/CAPTURE_CONTRACT.md's known gaps.
                # `kind` carries the raw `source` value (e.g. "TTS") the same
                # way Envato's item_type-derived kind labels media type.
                kind=l.source, status=l.status, ref_id=l.ref_id or "—",
                client_name=l.client_name, task_name=l.task_name,
            )
        )
    for w in fl:
        merged.append(
            Event(
                when=w.when, tool="Flow", employee_id=w.employee_id, employee_name=w.employee_name,
                department=w.department, prompt=w.prompt,
                # No credits concept (see providers/flow/CAPTURE_CONTRACT.md),
                # and `kind` stays blank: Flow generates both stills and clips
                # but its captured payload carries no media-type field, so
                # labelling every row "Image" or "Video" would be a guess.
                status=w.status, ref_id=w.ref_id or "—",
                client_name=w.client_name, task_name=w.task_name,
            )
        )
    merged.sort(key=lambda ev: (ev.when or date.min, ev.tool))
    return merged


# --------------------------------------------------------------------------- #
# Tool Master
# --------------------------------------------------------------------------- #
def _load_tools(db: Session) -> list[ToolInfo]:
    rows = db.query(ITPortalTool).filter(ITPortalTool.is_active.is_(True)).order_by(ITPortalTool.name.asc()).all()
    out = []
    for t in rows:
        meta = t.metadata_json or {}
        pm = provider_meta(t.slug) or provider_meta(t.name)
        integrated = bool(pm and pm.integrated)
        out.append(
            ToolInfo(
                name=t.name,
                vendor=_meta_get(meta, "vendor") or (pm.vendor if pm else "—"),
                integration_status="Integrated" if integrated else "Pending",
                # Prefer the registry's curated category for recognized tools;
                # fall back to whatever the portal recorded.
                category=(pm.category if pm else None) or t.category or "General",
                captured_fields=(pm.captured_fields if pm else "Not yet captured"),
                version=str(_meta_get(meta, "version") or "—"),
                api_status="Live" if integrated else "Planned",
                subscription=str(_meta_get(meta, "subscription", "plan") or "Active"),
                owner=str(_meta_get(meta, "owner") or "IT / AI Governance"),
                last_sync=_as_date(t.updated_at) if integrated else None,
                future_expansion="—" if integrated else "Roadmap",
            )
        )
    return out


# --------------------------------------------------------------------------- #
# Derived aggregates
# --------------------------------------------------------------------------- #
def _tool_usage(employees: list[Employee]) -> list[ToolUsage]:
    n = len(employees) or 1
    cg_users = sum(1 for emp in employees if emp.chatgpt_sessions)
    kl_users = sum(1 for emp in employees if emp.kling_videos)
    fp_users = sum(1 for emp in employees if emp.freepik_generations)
    ev_users = sum(1 for emp in employees if emp.envato_generations)
    hg_users = sum(1 for emp in employees if emp.heygen_videos)
    hf_users = sum(1 for emp in employees if emp.higgsfield_generations)
    el_users = sum(1 for emp in employees if emp.elevenlabs_generations)
    fl_users = sum(1 for emp in employees if emp.flow_generations)
    cg_vol = sum(emp.chatgpt_sessions for emp in employees)
    kl_vol = sum(emp.kling_videos for emp in employees)
    fp_vol = sum(emp.freepik_generations for emp in employees)
    ev_vol = sum(emp.envato_generations for emp in employees)
    hg_vol = sum(emp.heygen_videos for emp in employees)
    hf_vol = sum(emp.higgsfield_generations for emp in employees)
    el_vol = sum(emp.elevenlabs_generations for emp in employees)
    fl_vol = sum(emp.flow_generations for emp in employees)
    return [
        ToolUsage("ChatGPT", cg_users, cg_vol, cg_users / n),
        ToolUsage("Kling", kl_users, kl_vol, kl_users / n),
        ToolUsage("Freepik", fp_users, fp_vol, fp_users / n),
        ToolUsage("Envato", ev_users, ev_vol, ev_users / n),
        ToolUsage("HeyGen", hg_users, hg_vol, hg_users / n),
        ToolUsage("Higgsfield", hf_users, hf_vol, hf_users / n),
        ToolUsage("ElevenLabs", el_users, el_vol, el_users / n),
        ToolUsage("Flow", fl_users, fl_vol, fl_users / n),
    ]


def _dept_adoption(employees: list[Employee]) -> list[DeptAdoption]:
    buckets: dict[str, list[int]] = {}
    for emp in employees:
        head, adopt = buckets.setdefault(emp.department, [0, 0])
        buckets[emp.department][0] += 1
        if emp.tools_used:
            buckets[emp.department][1] += 1
    out = [DeptAdoption(dept, hc, ad) for dept, (hc, ad) in buckets.items()]
    out.sort(key=lambda d: d.pct, reverse=True)
    return out


def _daily_trend(
    period: Period,
    cg: list[ChatGptEvent],
    kl: list[KlingEvent],
    fp: list[FreepikEvent],
    ev: list[EnvatoEvent],
    hg: list[HeygenEvent],
    hf: list[HiggsfieldEvent],
    el: list[ElevenlabsEvent],
    fl: list[FlowEvent],
) -> list[DailyPoint]:
    days = [period.start + timedelta(days=i) for i in range(period.days)]
    cg_counts: dict[date, int] = {}
    kl_counts: dict[date, int] = {}
    fp_counts: dict[date, int] = {}
    ev_counts: dict[date, int] = {}
    hg_counts: dict[date, int] = {}
    hf_counts: dict[date, int] = {}
    el_counts: dict[date, int] = {}
    fl_counts: dict[date, int] = {}
    for c in cg:
        if c.when:
            cg_counts[c.when] = cg_counts.get(c.when, 0) + 1
    for k in kl:
        if k.when:
            kl_counts[k.when] = kl_counts.get(k.when, 0) + 1
    for f in fp:
        if f.when:
            fp_counts[f.when] = fp_counts.get(f.when, 0) + 1
    for a in ev:
        if a.when:
            ev_counts[a.when] = ev_counts.get(a.when, 0) + 1
    for h in hg:
        if h.when:
            hg_counts[h.when] = hg_counts.get(h.when, 0) + 1
    for s in hf:
        if s.when:
            hf_counts[s.when] = hf_counts.get(s.when, 0) + 1
    for l in el:
        if l.when:
            el_counts[l.when] = el_counts.get(l.when, 0) + 1
    for w in fl:
        if w.when:
            fl_counts[w.when] = fl_counts.get(w.when, 0) + 1
    return [
        DailyPoint(
            d, cg_counts.get(d, 0), kl_counts.get(d, 0), fp_counts.get(d, 0),
            ev_counts.get(d, 0), hg_counts.get(d, 0), hf_counts.get(d, 0),
            el_counts.get(d, 0), fl_counts.get(d, 0),
        )
        for d in days
    ]


def _kpis(employees: list[Employee], tools: list[ToolInfo]) -> Kpis:
    n = len(employees)
    using = sum(1 for emp in employees if emp.tools_used)
    fp_generations = sum(emp.freepik_generations for emp in employees)
    fp_images = sum(emp.freepik_images for emp in employees)
    fp_videos = sum(emp.freepik_videos for emp in employees)
    fp_charged = sum(emp.freepik_credits_charged for emp in employees)
    fp_estimated = sum(emp.freepik_credits_estimated for emp in employees)
    ev_generations = sum(emp.envato_generations for emp in employees)
    ev_credits = sum(emp.envato_credits for emp in employees)
    hg_videos = sum(emp.heygen_videos for emp in employees)
    hg_credits = sum(emp.heygen_credits for emp in employees)
    hf_generations = sum(emp.higgsfield_generations for emp in employees)
    hf_credits = sum(emp.higgsfield_credits for emp in employees)
    el_generations = sum(emp.elevenlabs_generations for emp in employees)
    fl_generations = sum(emp.flow_generations for emp in employees)
    return Kpis(
        total_employees=n,
        total_tools=len(tools),
        tools_integrated=sum(1 for t in tools if t.integration_status == "Integrated"),
        employees_using_ai=using,
        adoption_pct=(using / n) if n else 0.0,
        total_sessions=sum(emp.chatgpt_sessions for emp in employees),
        total_generations=(
            sum(emp.kling_videos for emp in employees) + fp_generations + ev_generations + hg_videos
            + hf_generations + el_generations + fl_generations
        ),
        total_credits=(
            sum(emp.kling_credits for emp in employees) + fp_charged + ev_credits + hg_credits + hf_credits
        ),
        total_freepik_generations=fp_generations,
        total_freepik_images=fp_images,
        total_freepik_videos=fp_videos,
        total_freepik_credits_charged=fp_charged,
        total_freepik_credits_estimated=fp_estimated,
        total_envato_generations=ev_generations,
        total_envato_credits=ev_credits,
        total_heygen_videos=hg_videos,
        total_heygen_credits=hg_credits,
        total_higgsfield_generations=hf_generations,
        total_higgsfield_credits=hf_credits,
        total_elevenlabs_generations=el_generations,
        total_flow_generations=fl_generations,
    )


# --------------------------------------------------------------------------- #
# Data-quality validation
# --------------------------------------------------------------------------- #
def _validate(employees, cg, kl, fp, ev, hg, hf, el, fl, period: Period) -> list[Warning]:
    warnings: list[Warning] = []

    missing_dept = sum(1 for emp in employees if emp.department in ("", "Unassigned"))
    if missing_dept:
        warnings.append(Warning("Warning", "Missing department", f"{missing_dept} employee(s) have no department assigned."))

    missing_id = sum(1 for emp in employees if not emp.employee_id or emp.employee_id.startswith("U"))
    if missing_id:
        warnings.append(Warning("Warning", "Missing employee ID", f"{missing_id} employee(s) have no formal employee ID."))

    seen_ids: dict[str, int] = {}
    for emp in employees:
        seen_ids[emp.employee_id] = seen_ids.get(emp.employee_id, 0) + 1
    dupes = [k for k, v in seen_ids.items() if v > 1]
    if dupes:
        warnings.append(Warning("Error", "Duplicate employee ID", f"{len(dupes)} employee ID(s) appear more than once."))

    neg_credits = sum(1 for emp in employees if emp.kling_credits < 0)
    if neg_credits:
        warnings.append(Warning("Error", "Invalid credits", f"{neg_credits} employee(s) show negative credit totals."))

    neg_freepik_credits = sum(
        1 for emp in employees if emp.freepik_credits_charged < 0 or emp.freepik_credits_estimated < 0
    )
    if neg_freepik_credits:
        warnings.append(Warning(
            "Error", "Invalid Freepik credits",
            f"{neg_freepik_credits} employee(s) show negative Freepik credit totals."))

    neg_envato_credits = sum(1 for emp in employees if emp.envato_credits < 0)
    if neg_envato_credits:
        warnings.append(Warning(
            "Error", "Invalid Envato credits",
            f"{neg_envato_credits} employee(s) show negative Envato credit totals."))

    neg_heygen_credits = sum(1 for emp in employees if emp.heygen_credits < 0)
    if neg_heygen_credits:
        warnings.append(Warning(
            "Error", "Invalid HeyGen credits",
            f"{neg_heygen_credits} employee(s) show negative HeyGen credit totals."))

    neg_higgsfield_credits = sum(1 for emp in employees if emp.higgsfield_credits < 0)
    if neg_higgsfield_credits:
        warnings.append(Warning(
            "Error", "Invalid Higgsfield credits",
            f"{neg_higgsfield_credits} employee(s) show negative Higgsfield credit totals."))

    # No credits/numeric field is confirmed for ElevenLabs or Flow yet (see
    # each provider's CAPTURE_CONTRACT.md known gaps) - nothing to
    # negative-value-validate there, unlike every credit-bearing provider above.

    future = (
        sum(1 for k in kl if k.when and k.when > period.end)
        + sum(1 for c in cg if c.when and c.when > period.end)
        + sum(1 for f in fp if f.when and f.when > period.end)
        + sum(1 for a in ev if a.when and a.when > period.end)
        + sum(1 for h in hg if h.when and h.when > period.end)
        + sum(1 for s in hf if s.when and s.when > period.end)
        + sum(1 for l in el if l.when and l.when > period.end)
        + sum(1 for w in fl if w.when and w.when > period.end)
    )
    if future:
        warnings.append(Warning("Warning", "Future-dated events", f"{future} event(s) are dated after the report period end."))

    undated = (
        sum(1 for k in kl if not k.when)
        + sum(1 for c in cg if not c.when)
        + sum(1 for f in fp if not f.when)
        + sum(1 for a in ev if not a.when)
        + sum(1 for h in hg if not h.when)
        + sum(1 for s in hf if not s.when)
        + sum(1 for l in el if not l.when)
        + sum(1 for w in fl if not w.when)
    )
    if undated:
        warnings.append(Warning("Info", "Undated events", f"{undated} event(s) had no resolvable date and were placed at period start."))

    # ChatGPT sessions are counted from the conversation-level prompt_count; the
    # raw log shows detailed prompt rows, which can lag. Flag the gap honestly.
    counted_sessions = sum(emp.chatgpt_sessions for emp in employees)
    if len(cg) < RAW_ROW_CAP and counted_sessions > len(cg):
        warnings.append(Warning(
            "Info", "ChatGPT capture depth",
            f"{counted_sessions:,} ChatGPT prompts counted; {len(cg):,} available as detailed rows "
            f"in the log (detailed message capture lags the conversation counter)."))

    if not warnings:
        warnings.append(Warning("Info", "All checks passed", "No data-quality issues detected for this period."))
    return warnings
