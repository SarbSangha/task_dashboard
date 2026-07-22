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

from .providers import PROVIDERS, provider_meta

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
CYCLE_DAYS = 15                 # the "15-day cycle" from the reference report
RAW_ROW_CAP = 20_000            # max rows rendered into each raw-log sheet
CHATGPT = "chatgpt"

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

    @property
    def tools_used(self) -> int:
        return (1 if self.chatgpt_sessions else 0) + (1 if self.kling_videos else 0)

    @property
    def total_usage(self) -> int:
        return self.chatgpt_sessions + self.kling_videos

    @property
    def composite_score(self) -> int:
        return self.chatgpt_sessions + self.kling_videos

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

    @property
    def total(self) -> int:
        return self.chatgpt + self.kling


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
    total_generations: int       # Kling videos
    total_credits: float


@dataclass
class ReportDataset:
    generated_at: datetime
    period: Period
    employees: list[Employee]
    tools: list[ToolInfo]
    chatgpt_events: list[ChatGptEvent]
    kling_events: list[KlingEvent]
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

    employees = _load_employees(db)
    by_uid = {emp.user_id: emp for emp in employees}

    _apply_chatgpt_aggregates(db, cg_start, cg_end, by_uid)
    _apply_kling_aggregates(db, period, kling_tool_ids, by_uid)

    chatgpt_events, cg_trunc = _load_chatgpt_events(db, cg_start, cg_end, by_uid)
    kling_events, kl_trunc = _load_kling_events(db, period, kling_tool_ids, by_uid)
    merged = _merge_events(chatgpt_events, kling_events)

    tools = _load_tools(db)
    tool_usage = _tool_usage(employees)
    dept_adoption = _dept_adoption(employees)
    daily = _daily_trend(period, chatgpt_events, kling_events)
    top = sorted(employees, key=lambda emp: (emp.composite_score, emp.total_usage), reverse=True)[:5]
    kpis = _kpis(employees, tools)
    warnings = _validate(employees, chatgpt_events, kling_events, period)

    return ReportDataset(
        generated_at=datetime.now(),
        period=period,
        employees=employees,
        tools=tools,
        chatgpt_events=chatgpt_events,
        kling_events=kling_events,
        merged_events=merged,
        tool_usage=tool_usage,
        dept_adoption=dept_adoption,
        daily=daily,
        top_employees=top,
        warnings=warnings,
        kpis=kpis,
        raw_truncated=cg_trunc or kl_trunc,
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
         event_type, status) in rows:
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
            )
        )
    return out, truncated


def _merge_events(cg: list[ChatGptEvent], kl: list[KlingEvent]) -> list[Event]:
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
    cg_vol = sum(emp.chatgpt_sessions for emp in employees)
    kl_vol = sum(emp.kling_videos for emp in employees)
    return [
        ToolUsage("ChatGPT", cg_users, cg_vol, cg_users / n),
        ToolUsage("Kling", kl_users, kl_vol, kl_users / n),
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


def _daily_trend(period: Period, cg: list[ChatGptEvent], kl: list[KlingEvent]) -> list[DailyPoint]:
    days = [period.start + timedelta(days=i) for i in range(period.days)]
    cg_counts: dict[date, int] = {}
    kl_counts: dict[date, int] = {}
    for c in cg:
        if c.when:
            cg_counts[c.when] = cg_counts.get(c.when, 0) + 1
    for k in kl:
        if k.when:
            kl_counts[k.when] = kl_counts.get(k.when, 0) + 1
    return [DailyPoint(d, cg_counts.get(d, 0), kl_counts.get(d, 0)) for d in days]


def _kpis(employees: list[Employee], tools: list[ToolInfo]) -> Kpis:
    n = len(employees)
    using = sum(1 for emp in employees if emp.tools_used)
    return Kpis(
        total_employees=n,
        total_tools=len(tools),
        tools_integrated=sum(1 for t in tools if t.integration_status == "Integrated"),
        employees_using_ai=using,
        adoption_pct=(using / n) if n else 0.0,
        total_sessions=sum(emp.chatgpt_sessions for emp in employees),
        total_generations=sum(emp.kling_videos for emp in employees),
        total_credits=sum(emp.kling_credits for emp in employees),
    )


# --------------------------------------------------------------------------- #
# Data-quality validation
# --------------------------------------------------------------------------- #
def _validate(employees, cg, kl, period: Period) -> list[Warning]:
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

    future = sum(1 for k in kl if k.when and k.when > period.end) + sum(1 for c in cg if c.when and c.when > period.end)
    if future:
        warnings.append(Warning("Warning", "Future-dated events", f"{future} event(s) are dated after the report period end."))

    undated = sum(1 for k in kl if not k.when) + sum(1 for c in cg if not c.when)
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
