"""
Credit Consumption Report - database layer.

Every tool keeps its own generation table, so the report starts from one
UNION ALL of per-tool SELECTs (the "facts"), each projected onto the same
columns. All totals are GROUP BY queries over that union, and the
Generation Log streams the same union row by row, so the summary sheets and
the detail sheet can never be built from different rules.

Rules:

* Credits come from the same columns the Usage Intelligence report reads,
  plus Suno and Epidemic Sound. Kling values outside 0-3000 count as 0,
  matching that report.
* Every row gets a charge status from its raw provider status (see
  CHARGED_STATUSES / FAILED_STATUSES). Report totals use Charged rows only;
  Pending and Failed / Refunded are reported separately.
* A generation with no owner (history-sync imports land unowned on purpose,
  see providers/*/normalization.py's freshness rule) is reported under the
  user "Unassigned", department "Unassigned".
* A blank department is "Unassigned"; a blank client picker is "No client".
* Test & admin accounts can be excluded (see resolve_excluded_accounts).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterator, Optional

from sqlalchemy import Float, Integer, String, and_, case, cast, func, literal, or_, select, union_all
from sqlalchemy.orm import Session

from models_new import GenerationClient, GenerationRecord, ITPortalTool, ITPortalToolUsageEvent, User, UserRole
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.envato.models import EnvatoGeneration
from providers.epidemicsound.models import EpidemicAdaptation
from providers.flow.models import FlowGeneration
from providers.freepik.models import FreepikGeneration
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.suno.models import SunoGeneration
from utils.usage_intelligence.service import KLING_TOOL_SLUGS, MAX_SANE_KLING_CREDITS, resolve_period

UNASSIGNED = "Unassigned"
UNASSIGNED_DEPARTMENT = UNASSIGNED
UNASSIGNED_USER_ID = 0          # sentinel for "no owner" in the report model and the user filter
NO_CLIENT = "No client"

CHARGED = "Charged"
PENDING = "Pending"
FAILED = "Failed / Refunded"
CHARGE_STATUSES = (CHARGED, PENDING, FAILED)

# Raw status -> charge status. Mirrors the billing code's own vocabulary:
# routers/it_tools_router.py's _canonical_usage_status folds
# completed/complete/success/succeeded/finished/done into "settled" (the
# point Kling credits are booked) and error/cancelled/canceled/rejected into
# "failed"; utils/usage_intelligence/service.py treats "active" and
# "captured" as terminal success. A blank status means the provider sends no
# status at all (Envato, Flow, most ElevenLabs rows) and the capture itself
# is the completion signal, so it counts as Charged. Anything else -
# submitted, queued, pending, processing, running, rendering, reconciling,
# streaming, generating_music, draft, or a value never seen before - is
# still in flight: Pending.
CHARGED_STATUSES = frozenset({
    "", "settled", "completed", "complete", "success", "succeeded", "finished", "done", "active", "captured",
})
FAILED_STATUSES = frozenset({
    "failed", "error", "cancelled", "canceled", "rejected", "timeout", "refunded", "expired",
})

# Tools whose captures carry no per-generation cost at all. Their 0 is
# "not captured", not "free" - see TOOL_COST_NOTES.
CREDITS_NOT_CAPTURED = frozenset({"Flow", "Suno"})
TOOL_COST_NOTES = {
    "Suno": "Not captured: Suno shows only a per-session credit total, never a per-clip cost "
            "(providers/suno/CAPTURE_CONTRACT.md, Known gaps). Suno is not free.",
    "Flow": "Not captured: Flow's capture payload has no cost or credit field.",
}

EXCLUDED_ACCOUNTS_ENV = "CREDIT_REPORT_EXCLUDED_ACCOUNTS"
ADMIN_ROLES = ("admin", "root")
IST_MINUTES = 330


@dataclass(frozen=True)
class ToolSource:
    """How one tool's generation table maps onto the shared fact columns."""

    name: str
    model: type
    credits: Optional[str]          # credit column name, None = no ledger
    prompt: tuple                   # first non-blank wins
    output: tuple                   # provider URL columns, first non-blank wins
    model_label: tuple = ()         # "Model / type" column, first non-blank wins
    mirrored_key: bool = True       # has mirrored_asset_key + asset_mirror_status
    has_provider_created_at: bool = True


# Kling is not listed here: it reads usage events joined to generation
# records, which needs its own SELECT (see _kling_select).
TOOL_SOURCES: tuple = (
    ToolSource("Freepik", FreepikGeneration, "credits_charged", ("prompt", "name_field"),
               ("raw_url", "download_url", "large_preview_url", "preview_url", "thumbnail_url", "web_url"),
               model_label=("tool_name", "tool", "mode")),
    ToolSource("Envato", EnvatoGeneration, "credits_badge", ("prompt", "title"),
               ("canvas_url", "fallback_url", "thumbnail_url"), model_label=("item_type", "style"), mirrored_key=False),
    ToolSource("HeyGen", HeygenGeneration, "credits_used", ("script_text",),
               ("video_url", "download_url", "storage_url", "share_url", "preview_url", "thumbnail_url"),
               model_label=("avatar_name", "motion_engine")),
    ToolSource("Higgsfield", HiggsfieldGeneration, "credits_used", ("prompt_text",),
               ("video_url", "download_url", "preview_url", "thumbnail_url"), mirrored_key=False),
    ToolSource("ElevenLabs", ElevenlabsGeneration, "credits_used", ("prompt",), ("media_url", "thumbnail_url"),
               model_label=("voice_name", "source")),
    ToolSource("Flow", FlowGeneration, None, ("prompt",), ("media_url", "thumbnail_url")),
    ToolSource("Suno", SunoGeneration, "credits_used", ("prompt",), ("media_url", "thumbnail_url"),
               model_label=("model_name",)),
    ToolSource("Epidemic Sound", EpidemicAdaptation, "credits_used", ("prompt",), ("media_url",),
               has_provider_created_at=False),
)
KLING = "Kling"
TOOL_NAMES: tuple = (KLING,) + tuple(s.name for s in TOOL_SOURCES)
SOURCES_BY_NAME = {s.name: s for s in TOOL_SOURCES}


# --------------------------------------------------------------------------- #
# Filters
# --------------------------------------------------------------------------- #
def _clean(value) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@dataclass
class ReportFilters:
    start: date
    end: date
    department: Optional[str] = None
    user_id: Optional[int] = None           # UNASSIGNED_USER_ID selects the owner-less rows
    tool: Optional[str] = None
    client: Optional[str] = None
    exclude_test_accounts: bool = True
    excluded_accounts: list = field(default_factory=list)   # [(user_id, name)], filled by resolve_excluded_accounts
    # Display-only, for the Home sheet.
    user_label: Optional[str] = None
    period: dict = field(default_factory=dict)

    @classmethod
    def build(cls, *, start=None, end=None, department=None, user_id=None, tool=None, client=None,
              exclude_test_accounts: bool = True, today: Optional[date] = None) -> "ReportFilters":
        """The date range defaults to the current month to date."""
        if start or end:
            period = resolve_period(start=start, end=end, today=today)
        else:
            period = resolve_period(preset="current_month", today=today)
        return cls(
            start=period["start"],
            end=period["end"],
            department=_clean(department),
            user_id=int(user_id) if user_id not in (None, "") else None,
            tool=_clean(tool),
            client=_clean(client),
            exclude_test_accounts=bool(exclude_test_accounts),
            period=period,
        )

    @property
    def excluded_ids(self) -> list:
        return [uid for uid, _name in self.excluded_accounts] if self.exclude_test_accounts else []


def configured_test_accounts() -> list:
    """Emails or user ids from CREDIT_REPORT_EXCLUDED_ACCOUNTS (comma separated)."""
    raw = os.getenv(EXCLUDED_ACCOUNTS_ENV, "") or ""
    return [part.strip().lower() for part in raw.split(",") if part.strip()]


def resolve_excluded_accounts(db: Session) -> list:
    """[(user_id, name)] of accounts the "Exclude test & admin accounts"
    option removes: every admin (is_admin flag or an admin/root role row,
    the same signals utils/permissions.resolve_roles reads) plus each entry
    in CREDIT_REPORT_EXCLUDED_ACCOUNTS."""
    configured = configured_test_accounts()
    ids = {int(x) for x in configured if x.isdigit()}
    emails = {x for x in configured if not x.isdigit()}
    admin_role_ids = select(UserRole.user_id).where(func.lower(UserRole.role).in_(ADMIN_ROLES))
    conditions = [User.is_admin.is_(True), User.id.in_(admin_role_ids)]
    if ids:
        conditions.append(User.id.in_(ids))
    if emails:
        conditions.append(func.lower(User.email).in_(emails))
    rows = db.query(User.id, User.name).filter(or_(*conditions)).order_by(User.name).all()
    return [(int(uid), (name or "").strip() or f"User {uid}") for uid, name in rows]


# --------------------------------------------------------------------------- #
# Fact SELECTs
# --------------------------------------------------------------------------- #
def _blank_to_null(col):
    return func.nullif(func.trim(col), "")


def _first_present(model, names: tuple):
    cols = [_blank_to_null(getattr(model, n)) for n in names]
    return cols[0] if len(cols) == 1 else func.coalesce(*cols)


def _null_text():
    return cast(literal(None), String)


def _month_of_timestamp(col, dialect: str):
    """IST calendar month (YYYY-MM) of a UTC timestamp column."""
    if dialect == "sqlite":
        return func.strftime("%Y-%m", col, f"+{IST_MINUTES} minutes")
    return func.to_char(col + timedelta(minutes=IST_MINUTES), "YYYY-MM")


def _month_of_date(col, dialect: str):
    if dialect == "sqlite":
        return func.strftime("%Y-%m", col)
    return func.to_char(col, "YYYY-MM")


def _source_select(src: ToolSource, utc_start, utc_end, dialect: str):
    m = src.model
    when = func.coalesce(m.provider_created_at, m.created_at) if src.has_provider_created_at else m.created_at
    has_output = _first_present(m, src.output).isnot(None)
    if src.mirrored_key:
        has_output = or_(has_output, and_(m.asset_mirror_status == "mirrored", m.mirrored_asset_key.isnot(None)))
    if src.credits:
        credits = cast(func.coalesce(getattr(m, src.credits), 0.0), Float)
    else:
        credits = cast(literal(0.0), Float)
    model_col = _first_present(m, src.model_label) if src.model_label else _null_text()
    return select(
        literal(src.name, String).label("tool"),
        cast(m.id, String).label("record_id"),
        m.owner_user_id.label("user_id"),
        when.label("occurred_at"),
        _month_of_timestamp(when, dialect).label("month"),
        _blank_to_null(m.linked_client_name).label("client"),
        _blank_to_null(m.linked_task_name).label("task"),
        credits.label("credits"),
        _first_present(m, src.prompt).label("prompt"),
        model_col.label("model"),
        (m.status if hasattr(m, "status") else _null_text()).label("status"),
        case((has_output, 1), else_=0).label("has_output"),
    ).where(when >= utc_start, when < utc_end)


def _kling_select(start: date, end: date, dialect: str):
    e, g = ITPortalToolUsageEvent, GenerationRecord
    kling_tool_ids = select(ITPortalTool.id).where(
        func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_TOOL_SLUGS)
    )
    sane = case((e.credits_burned.between(0, MAX_SANE_KLING_CREDITS), e.credits_burned), else_=0.0)
    return (
        select(
            literal(KLING, String).label("tool"),
            cast(e.id, String).label("record_id"),
            e.user_id.label("user_id"),
            e.created_at.label("occurred_at"),
            _month_of_date(e.event_date, dialect).label("month"),
            _blank_to_null(e.linked_client_name).label("client"),
            _blank_to_null(e.linked_task_name).label("task"),
            cast(func.coalesce(sane, 0.0), Float).label("credits"),
            func.coalesce(_blank_to_null(e.prompt_text), _blank_to_null(g.prompt_text)).label("prompt"),
            func.coalesce(_blank_to_null(e.model_label), _blank_to_null(g.model_label)).label("model"),
            e.status.label("status"),
            case((_blank_to_null(g.canonical_asset_url).isnot(None), 1), else_=0).label("has_output"),
        )
        .select_from(e)
        .outerjoin(g, g.source_usage_event_id == e.id)
        # event_date is already an IST calendar day - the same window rule
        # the Usage Intelligence report applies to Kling.
        .where(e.tool_id.in_(kling_tool_ids), e.event_date >= start, e.event_date <= end)
    )


def facts_subquery(filters: ReportFilters, dialect: str = "postgresql"):
    period = filters.period or resolve_period(start=filters.start.isoformat(), end=filters.end.isoformat())
    utc_s, utc_e = period["utc_start"], period["utc_end"]
    selects = []
    if filters.tool in (None, KLING):
        selects.append(_kling_select(filters.start, filters.end, dialect))
    for src in TOOL_SOURCES:
        if filters.tool in (None, src.name):
            selects.append(_source_select(src, utc_s, utc_e, dialect))
    if not selects:  # unknown tool name: empty, but still a valid query
        selects.append(_kling_select(filters.start, filters.end, dialect).where(literal(False)))
    if len(selects) == 1:
        return selects[0].subquery("facts")
    return union_all(*selects).subquery("facts")


def department_expr():
    # An owner-less row has no joined user, so it falls to "Unassigned" too.
    return func.coalesce(_blank_to_null(User.department), UNASSIGNED_DEPARTMENT)


def charge_status_expr(status_col):
    norm = func.lower(func.trim(func.coalesce(status_col, "")))
    return case(
        (norm.in_(tuple(CHARGED_STATUSES)), CHARGED),
        (norm.in_(tuple(FAILED_STATUSES)), FAILED),
        else_=PENDING,
    )


def charge_status(raw: Optional[str]) -> str:
    """Python twin of charge_status_expr (used by tests and the log)."""
    norm = (raw or "").strip().lower()
    if norm in CHARGED_STATUSES:
        return CHARGED
    if norm in FAILED_STATUSES:
        return FAILED
    return PENDING


def _scoped(query, facts, filters: ReportFilters):
    client_expr = func.coalesce(facts.c.client, NO_CLIENT)
    query = query.select_from(facts).outerjoin(User, User.id == facts.c.user_id)
    if filters.department:
        query = query.where(department_expr() == filters.department)
    if filters.user_id == UNASSIGNED_USER_ID:
        query = query.where(User.id.is_(None))
    elif filters.user_id is not None:
        query = query.where(facts.c.user_id == filters.user_id)
    if filters.client:
        query = query.where(client_expr == filters.client)
    if filters.excluded_ids:
        query = query.where(or_(facts.c.user_id.is_(None), facts.c.user_id.notin_(filters.excluded_ids)))
    return query


def _dialect(db: Session) -> str:
    return db.get_bind().dialect.name


# --------------------------------------------------------------------------- #
# Aggregates
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class FactGroup:
    """One GROUP BY row: user x tool x client x charge status x month."""

    user_id: int                    # UNASSIGNED_USER_ID for owner-less rows
    user_name: str
    employee_id: str
    user_deleted: bool
    department: str
    tool: str
    client: str
    charge_status: str
    month: str
    generations: int
    credits: float
    zero_credit: int = 0            # rows in this group with 0 credits
    task_filled: int = 0
    model_filled: int = 0


def load_groups(db: Session, filters: ReportFilters) -> list:
    facts = facts_subquery(filters, _dialect(db))
    dept = department_expr()
    client_expr = func.coalesce(facts.c.client, NO_CLIENT)
    bucket = charge_status_expr(facts.c.status)
    q = _scoped(
        select(
            User.id.label("uid"),
            User.name,
            User.employee_id,
            User.is_deleted,
            dept.label("department"),
            facts.c.tool,
            client_expr.label("client"),
            bucket.label("charge_status"),
            facts.c.month,
            func.count().label("generations"),
            func.coalesce(func.sum(facts.c.credits), 0.0).label("credits"),
            func.coalesce(func.sum(case((facts.c.credits == 0, 1), else_=0)), 0).label("zero_credit"),
            func.coalesce(func.sum(case((facts.c.task.isnot(None), 1), else_=0)), 0).label("task_filled"),
            func.coalesce(func.sum(case((facts.c.model.isnot(None), 1), else_=0)), 0).label("model_filled"),
        ),
        facts,
        filters,
    ).group_by(User.id, User.name, User.employee_id, User.is_deleted, dept, facts.c.tool, client_expr, bucket,
               facts.c.month)
    out = []
    for row in db.execute(q):
        owned = row.uid is not None
        out.append(FactGroup(
            user_id=int(row.uid) if owned else UNASSIGNED_USER_ID,
            user_name=((row.name or "").strip() or f"User {row.uid}") if owned else UNASSIGNED,
            employee_id=((row.employee_id or "").strip() or f"U{row.uid}") if owned else "—",
            user_deleted=bool(row.is_deleted) if owned else False,
            department=row.department,
            tool=row.tool,
            client=row.client,
            charge_status=row.charge_status,
            month=row.month or "",
            generations=int(row.generations or 0),
            credits=float(row.credits or 0.0),
            zero_credit=int(row.zero_credit or 0),
            task_filled=int(row.task_filled or 0),
            model_filled=int(row.model_filled or 0),
        ))
    return out


def load_excluded_summary(db: Session, filters: ReportFilters) -> dict:
    """What the test & admin exclusion removed: generations and Charged credits."""
    ids = filters.excluded_ids
    if not ids:
        return {"accounts": 0, "generations": 0, "credits": 0.0}
    facts = facts_subquery(filters, _dialect(db))
    inverse = ReportFilters(**{**filters.__dict__, "exclude_test_accounts": False})
    charged = case((charge_status_expr(facts.c.status) == CHARGED, facts.c.credits), else_=0.0)
    q = _scoped(select(func.count(), func.coalesce(func.sum(charged), 0.0)), facts, inverse).where(
        facts.c.user_id.in_(ids)
    )
    gens, credits = db.execute(q).one()
    return {"accounts": len(ids), "generations": int(gens or 0), "credits": float(credits or 0.0)}


# --------------------------------------------------------------------------- #
# Generation Log stream
# --------------------------------------------------------------------------- #
def stream_log(db: Session, filters: ReportFilters, user_order: list, batch_size: int = 1000) -> Iterator:
    """Yield every generation (all charge statuses) with users contiguous in
    ``user_order``, oldest first within a user.

    The order is pushed into SQL as a CASE over user ids instead of sorting
    by name in SQL, so the database and Python never disagree on collation
    and each user's row positions in the log stay exact. Owner-less rows use
    UNASSIGNED_USER_ID's position.
    """
    if not user_order:
        return iter(())
    facts = facts_subquery(filters, _dialect(db))
    owner_key = func.coalesce(User.id, UNASSIGNED_USER_ID)
    position = case({uid: i for i, uid in enumerate(user_order)}, value=owner_key, else_=len(user_order))
    q = _scoped(
        select(
            facts.c.tool,
            facts.c.record_id,
            cast(owner_key, Integer).label("user_id"),
            facts.c.occurred_at,
            facts.c.client,
            facts.c.task,
            facts.c.credits,
            facts.c.prompt,
            facts.c.model,
            facts.c.status,
            charge_status_expr(facts.c.status).label("charge_status"),
            facts.c.has_output,
        ),
        facts,
        filters,
    ).order_by(position, facts.c.occurred_at, facts.c.tool, facts.c.record_id)
    result = db.execute(q.execution_options(stream_results=True, yield_per=batch_size))
    return iter(result)


# --------------------------------------------------------------------------- #
# Filter options and output links
# --------------------------------------------------------------------------- #
def load_options(db: Session) -> dict:
    users = (
        db.query(User.id, User.name, User.department)
        .filter(User.is_deleted.is_(False))
        .order_by(User.name)
        .all()
    )
    departments = {(d or "").strip() for _i, _n, d in users if (d or "").strip()}
    departments.add(UNASSIGNED_DEPARTMENT)
    clients = [n for (n,) in db.query(GenerationClient.name).order_by(GenerationClient.name).all() if (n or "").strip()]
    user_rows = [{"id": UNASSIGNED_USER_ID, "name": f"{UNASSIGNED} (no owner)", "department": UNASSIGNED_DEPARTMENT}]
    user_rows += [
        {"id": i, "name": n, "department": (d or "").strip() or UNASSIGNED_DEPARTMENT}
        for i, n, d in users
    ]
    return {
        "departments": sorted(departments, key=str.lower),
        "users": user_rows,
        "tools": list(TOOL_NAMES),
        "clients": clients + [NO_CLIENT],
        "excludedAccounts": [{"id": uid, "name": name} for uid, name in resolve_excluded_accounts(db)],
    }


def resolve_output_url(db: Session, tool: str, record_id: int) -> Optional[str]:
    """Where a Generation Log "Open output" link ends up.

    A mirrored copy sits in the private R2 bucket, so it is signed at click
    time (signed URLs expire within minutes and cannot be stored in a file).
    Otherwise the provider's own URL is used.
    """
    if tool == KLING:
        url = (
            db.query(GenerationRecord.canonical_asset_url)
            .filter(GenerationRecord.source_usage_event_id == record_id)
            .scalar()
        )
        return (url or "").strip() or None
    src = SOURCES_BY_NAME.get(tool)
    if not src:
        return None
    row = db.query(src.model).filter(src.model.id == record_id).first()
    if row is None:
        return None
    if src.mirrored_key and getattr(row, "asset_mirror_status", None) == "mirrored" and getattr(row, "mirrored_asset_key", None):
        try:
            from utils import r2_storage

            if r2_storage.is_configured():
                return r2_storage.generate_presigned_url(row.mirrored_asset_key)
        except Exception:  # fall through to the provider URL
            pass
    for name in src.output:
        value = (getattr(row, name, None) or "").strip()
        if value:
            return value
    return None
