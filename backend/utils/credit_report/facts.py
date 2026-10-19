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
* Every Charged row also gets a rupee cost (costing.py): credits x rate for
  pay-per-use tools, a share of the account's subscription otherwise.
* A Kling job recorded twice counts once (dedupe.py); Freepik uploads are
  not generations and are left out.
* A generation with no owner (history-sync imports land unowned on purpose,
  see providers/*/normalization.py's freshness rule) is reported under the
  user "Unknown user (imported history)", department "No department".
* A blank department is "No department"; a blank client picker is
  "No client". Names are shown cleaned (display.py).
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
from providers.chatgpt.models import ConversationPrompt, ConversationRecord
from providers.conversation_links import chat_web_url
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.envato.models import EnvatoGeneration
from providers.epidemicsound.models import EpidemicAdaptation
from providers.flow.models import FlowGeneration
from providers.freepik.models import FreepikGeneration
from providers.grammarly_docs.models import GrammarlyDocSession
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.splice.models import SpliceDownload
from providers.suno.models import SunoGeneration
from utils.usage_intelligence.service import KLING_TOOL_SLUGS, MAX_SANE_KLING_CREDITS, resolve_period

from .costing import PAY_PER_USE, PAY_PER_USE_TOOLS, SUBSCRIPTION, CostSetup, load_cost_setup
from .dedupe import KlingDedup, find_recorded_twice
from .display import DisplayConfig

UNASSIGNED = "Unknown user (imported history)"
UNASSIGNED_DEPARTMENT = "No department"
UNASSIGNED_USER_ID = 0          # sentinel for "no owner" in the report model and the user filter
NO_CLIENT = "No client"
FREEPIK_UPLOAD_TOOLS = ("upload", "upload-reference")   # reference images people upload: not generations

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
CREDITS_NOT_CAPTURED = frozenset({"Flow", "Suno", "Higgsfield", "ChatGPT", "Claude", "Grammarly"})
TOOL_COST_NOTES = {
    "ChatGPT": "One row per prompt sent. ChatGPT has no per-prompt cost: ₹ is an equal share of the "
               "subscription (est.).",
    "Claude": "One row per prompt sent. Claude has no per-prompt cost: ₹ is an equal share of the "
              "subscription (est.).",
    "Grammarly": "One row per document worked on. ₹ is an equal share of the subscription (est.).",
    "Splice": "One row per sample downloaded, 1 Splice credit each, × the account's credit rate.",
    "Suno": "Fixed price per song, set by an admin (Reports → Credit Rates): Suno shows no per-song cost "
            "of its own. Songs from before the first price show 0. ₹ is an equal share of the subscription (est.).",
    "Flow": "Not captured: Flow's capture payload has no cost or credit field.",
    "Higgsfield": "Not captured: Higgsfield's captures carry no credits (empty credit history). "
                  "₹ is an equal share of the subscription (est.).",
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
    # metadata_json key holding the provider's own state when the status
    # column is blank (display only - the charge status still reads `status`).
    raw_status_key: Optional[str] = None
    # Credits per row when the table has no credit column but the tool's
    # price per item is fixed (a Splice sample download is always 1 credit).
    fixed_credits: Optional[float] = None
    # True when `status` is not a billing state (a Grammarly session is
    # "open"/"closed"): the row is Charged once it exists.
    status_is_lifecycle: bool = False
    # Column holding when the usage happened, when not created_at.
    occurred_at: Optional[str] = None


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
    # TTS captures leave `status` blank; the history item's state ("created")
    # is in metadata_json.
    ToolSource("ElevenLabs", ElevenlabsGeneration, "credits_used", ("prompt",), ("media_url", "thumbnail_url"),
               model_label=("voice_name", "source"), raw_status_key="state"),
    ToolSource("Flow", FlowGeneration, None, ("prompt",), ("media_url", "thumbnail_url")),
    ToolSource("Suno", SunoGeneration, "credits_used", ("prompt",), ("media_url", "thumbnail_url"),
               model_label=("model_name",)),
    ToolSource("Epidemic Sound", EpidemicAdaptation, "credits_used", ("prompt",), ("media_url",),
               has_provider_created_at=False),
    # Pay-per-use: every sample download costs 1 Splice credit.
    ToolSource("Splice", SpliceDownload, None, ("asset_title",), ("asset_source_url", "preview_mp3_url"),
               has_provider_created_at=False, fixed_credits=1.0, occurred_at="downloaded_at"),
    ToolSource("Grammarly", GrammarlyDocSession, None, ("doc_title", "page_name"), ("doc_url", "page_url"),
               mirrored_key=False, has_provider_created_at=False, status_is_lifecycle=True,
               occurred_at="started_at"),
)
KLING = "Kling"
# ChatGPT and Claude share the conversation tables, one row per prompt sent
# (see _conversation_select).
CONVERSATION_TOOLS = (("ChatGPT", "chatgpt"), ("Claude", "claude"))
TOOL_NAMES: tuple = (KLING,) + tuple(s.name for s in TOOL_SOURCES) + tuple(n for n, _p in CONVERSATION_TOOLS)
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
    exclude_test_accounts: bool = False     # opt-in: by default every account with usage is reported
    excluded_accounts: list = field(default_factory=list)   # [(user_id, name)], filled by resolve_excluded_accounts
    # Display-only, for the Home sheet.
    user_label: Optional[str] = None
    period: dict = field(default_factory=dict)
    # Report context, loaded once by prepare() (defaults keep a bare filter usable).
    display: DisplayConfig = field(default_factory=DisplayConfig)
    cost: Optional[CostSetup] = None
    kling: KlingDedup = field(default_factory=KlingDedup)
    department_raws: list = field(default_factory=list)     # departments as stored, for the display CASE
    prepared: bool = False

    @classmethod
    def build(cls, *, start=None, end=None, department=None, user_id=None, tool=None, client=None,
              exclude_test_accounts: bool = False, today: Optional[date] = None) -> "ReportFilters":
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
            display=DisplayConfig.load(),
        )

    @property
    def excluded_ids(self) -> list:
        return [uid for uid, _name in self.excluded_accounts] if self.exclude_test_accounts else []

    def shifted(self, start: date, end: date) -> "ReportFilters":
        """The same filters over another period (its own costs and Kling check)."""
        period = resolve_period(start=start.isoformat(), end=end.isoformat())
        return ReportFilters(start=period["start"], end=period["end"], department=self.department,
                             user_id=self.user_id, tool=self.tool, client=self.client,
                             exclude_test_accounts=self.exclude_test_accounts,
                             excluded_accounts=list(self.excluded_accounts), user_label=self.user_label,
                             period=period, display=self.display)


def prepare(db: Session, filters: ReportFilters) -> ReportFilters:
    """Load what the queries need once: display names, the period's costs,
    the Kling jobs recorded twice, and (when asked) the excluded accounts."""
    if filters.prepared:
        return filters
    if filters.exclude_test_accounts and not filters.excluded_accounts:
        filters.excluded_accounts = resolve_excluded_accounts(db, filters.display)
    filters.department_raws = [d for (d,) in db.query(User.department).distinct().all() if (d or "").strip()]
    filters.cost = load_cost_setup(db, filters.start, filters.end, filters.display)
    filters.kling = find_recorded_twice(db, filters.start, filters.end, kling_slugs=KLING_TOOL_SLUGS,
                                        sane_max=MAX_SANE_KLING_CREDITS,
                                        is_charged=lambda s: charge_status(s) == CHARGED,
                                        name_of=filters.display.person_name, ignore_users=filters.excluded_ids)
    filters.prepared = True
    return filters


def configured_test_accounts() -> list:
    """Emails or user ids from CREDIT_REPORT_EXCLUDED_ACCOUNTS (comma separated)."""
    raw = os.getenv(EXCLUDED_ACCOUNTS_ENV, "") or ""
    return [part.strip().lower() for part in raw.split(",") if part.strip()]


def resolve_excluded_accounts(db: Session, display: Optional[DisplayConfig] = None) -> list:
    """[(user_id, name)] of accounts the "Exclude test & admin accounts"
    option removes: every admin (is_admin flag or an admin/root role row,
    the same signals utils/permissions.resolve_roles reads), each entry in
    CREDIT_REPORT_EXCLUDED_ACCOUNTS, and the test accounts, emails and
    departments listed in config/credit_report_display.json."""
    display = display or DisplayConfig.load()
    configured = configured_test_accounts()
    ids = {int(x) for x in configured if x.isdigit()} | set(display.exclude_user_ids)
    emails = {x for x in configured if not x.isdigit()} | set(display.exclude_emails)
    admin_role_ids = select(UserRole.user_id).where(func.lower(UserRole.role).in_(ADMIN_ROLES))
    conditions = [User.is_admin.is_(True), User.id.in_(admin_role_ids)]
    if ids:
        conditions.append(User.id.in_(ids))
    if emails:
        conditions.append(func.lower(User.email).in_(emails))
    if display.exclude_departments:
        conditions.append(func.lower(func.trim(User.department)).in_(display.exclude_departments))
    rows = db.query(User.id, User.name).filter(or_(*conditions)).order_by(User.name).all()
    return [(int(uid), display.person_name(uid, name) or f"User {uid}") for uid, name in rows]


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


def _day_of_timestamp(col, dialect: str):
    """IST calendar day (YYYY-MM-DD) of a UTC timestamp - the log's Date column."""
    if dialect == "sqlite":
        return func.strftime("%Y-%m-%d", col, f"+{IST_MINUTES} minutes")
    return func.to_char(col + timedelta(minutes=IST_MINUTES), "YYYY-MM-DD")


def _month_of_date(col, dialect: str):
    if dialect == "sqlite":
        return func.strftime("%Y-%m", col)
    return func.to_char(col, "YYYY-MM")


def _num(col):
    return func.coalesce(col, 0.0)


def _size(src: ToolSource, m, display: DisplayConfig) -> tuple:
    """(size, size estimated 0/1, free preview 0/1): how a subscription's fee
    is shared across the account's generations (see costing.py)."""
    zero, one = literal(0.0, Float), literal(1.0, Float)
    if src.name == "Freepik":
        # 0 charged on an unlimited-plan generation; Freepik still records its cost estimate.
        size = case((_num(m.credits_charged) > 0, m.credits_charged),
                    (_num(m.credits_estimated) > 0, m.credits_estimated), else_=zero)
        return cast(size, Float), literal(0, Integer), literal(0, Integer)
    if src.name == "ElevenLabs":
        previews = display.free_preview_models.get(src.name) or []
        model_id = m.metadata_json["model_id"].as_string()
        preview = case((model_id.in_(previews), 1), else_=0) if previews else literal(0, Integer)
        counted = _num(m.credits_used) > 0
        # The counter did not move: 1 credit per character (what it charges when it does move).
        size = case((preview == 1, zero), (counted, cast(m.credits_used, Float)),
                    else_=cast(func.coalesce(m.prompt_length, func.length(m.prompt), 0), Float))
        return size, case((preview == 1, 0), (counted, 0), else_=1), preview
    if src.name in ("Suno", "Higgsfield"):
        # No per-item cost of their own (Suno only once a fixed price is set).
        return one, case((_num(getattr(m, src.credits)) > 0, 0), else_=1), literal(0, Integer)
    if src.credits is None:                      # Flow: nothing captured at all
        return one, literal(1, Integer), literal(0, Integer)
    if src.name == "HeyGen":                     # pay-per-use: size unused
        return cast(_num(getattr(m, src.credits)), Float), literal(0, Integer), literal(0, Integer)
    return one, literal(0, Integer), literal(0, Integer)


def _source_when(src: ToolSource):
    """When the usage happened (UTC)."""
    m = src.model
    if src.occurred_at:
        return func.coalesce(getattr(m, src.occurred_at), m.created_at)
    if src.has_provider_created_at:
        return func.coalesce(m.provider_created_at, m.created_at)
    return m.created_at


def _source_select(src: ToolSource, utc_start, utc_end, dialect: str, display: DisplayConfig):
    m = src.model
    when = _source_when(src)
    output_key = _first_present(m, src.output)
    has_output = output_key.isnot(None)
    if src.mirrored_key:
        has_output = or_(has_output, and_(m.asset_mirror_status == "mirrored", m.mirrored_asset_key.isnot(None)))
    if src.credits:
        credits = cast(func.coalesce(getattr(m, src.credits), 0.0), Float)
    else:
        credits = cast(literal(float(src.fixed_credits or 0.0)), Float)
    model_col = _first_present(m, src.model_label) if src.model_label else _null_text()
    status = m.status if hasattr(m, "status") and not src.status_is_lifecycle else _null_text()
    raw_status = status
    if src.raw_status_key:
        raw_status = func.coalesce(_blank_to_null(status), _blank_to_null(m.metadata_json[src.raw_status_key].as_string()))
    size, size_est, preview = _size(src, m, display)
    q = select(
        literal(src.name, String).label("tool"),
        cast(m.id, String).label("record_id"),
        m.owner_user_id.label("user_id"),
        when.label("occurred_at"),
        _month_of_timestamp(when, dialect).label("month"),
        display.client_sql(m.linked_client_name).label("client"),
        _blank_to_null(m.linked_task_name).label("task"),
        credits.label("credits"),
        _first_present(m, src.prompt).label("prompt"),
        model_col.label("model"),
        status.label("status"),
        case((has_output, 1), else_=0).label("has_output"),
        cast(raw_status, String).label("raw_status"),
        cast(m.credential_id, Integer).label("account"),
        size.label("size"),
        cast(size_est, Integer).label("size_est"),
        cast(preview, Integer).label("preview"),
        cast(output_key, String).label("output_key"),
    ).where(when >= utc_start, when < utc_end)
    if src.name == "Freepik":
        q = q.where(func.lower(func.coalesce(m.tool_name, m.tool, "")).notin_(FREEPIK_UPLOAD_TOOLS))
    return q


def _conversation_select(tool: str, provider: str, utc_start, utc_end, dialect: str, display: DisplayConfig):
    """ChatGPT / Claude: one row per prompt the person sent, from the shared
    conversation tables. No per-prompt cost and no client picker exist, so
    each prompt takes an equal share of the subscription (see costing.py)
    and has no client. Account is left blank: costing.account_sql gives the
    row the tool's only company account."""
    p, r = ConversationPrompt, ConversationRecord
    when = func.coalesce(p.prompt_timestamp, p.created_at)
    return (
        select(
            literal(tool, String).label("tool"),
            cast(p.id, String).label("record_id"),
            r.owner_user_id.label("user_id"),
            when.label("occurred_at"),
            _month_of_timestamp(when, dialect).label("month"),
            display.client_sql(_null_text()).label("client"),
            _null_text().label("task"),
            cast(literal(0.0), Float).label("credits"),
            func.coalesce(_blank_to_null(p.prompt_text), _blank_to_null(r.title)).label("prompt"),
            _blank_to_null(r.model_label).label("model"),
            _null_text().label("status"),
            # The chat itself is the output; its page is addressable by its id.
            case((or_(_blank_to_null(r.conversation_url).isnot(None),
                      _blank_to_null(r.provider_conversation_id).isnot(None)), 1), else_=0).label("has_output"),
            _null_text().label("raw_status"),
            cast(literal(None), Integer).label("account"),
            literal(1.0, Float).label("size"),
            literal(1, Integer).label("size_est"),
            literal(0, Integer).label("preview"),
            _null_text().label("output_key"),
        )
        .select_from(p)
        .join(r, r.id == p.conversation_id)
        .where(r.provider == provider, when >= utc_start, when < utc_end)
    )


def _kling_select(start: date, end: date, dialect: str, display: DisplayConfig, kling: KlingDedup):
    e, g = ITPortalToolUsageEvent, GenerationRecord
    kling_tool_ids = select(ITPortalTool.id).where(
        func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_TOOL_SLUGS)
    )
    sane = case((e.credits_burned.between(0, MAX_SANE_KLING_CREDITS), e.credits_burned), else_=0.0)
    # A job recorded twice keeps one row, credited to the person who started it (dedupe.py).
    overrides = kling.owner_override
    owner = (case(*[(e.id == kept, literal(uid, Integer) if uid is not None else cast(literal(None), Integer))
                    for kept, uid in sorted(overrides.items())], else_=e.user_id) if overrides else e.user_id)
    q = (
        select(
            literal(KLING, String).label("tool"),
            cast(e.id, String).label("record_id"),
            cast(owner, Integer).label("user_id"),
            e.created_at.label("occurred_at"),
            _month_of_date(e.event_date, dialect).label("month"),
            display.client_sql(e.linked_client_name).label("client"),
            _blank_to_null(e.linked_task_name).label("task"),
            cast(func.coalesce(sane, 0.0), Float).label("credits"),
            func.coalesce(_blank_to_null(e.prompt_text), _blank_to_null(g.prompt_text)).label("prompt"),
            func.coalesce(_blank_to_null(e.model_label), _blank_to_null(g.model_label)).label("model"),
            e.status.label("status"),
            case((_blank_to_null(g.canonical_asset_url).isnot(None), 1), else_=0).label("has_output"),
            cast(e.status, String).label("raw_status"),
            cast(e.credential_id, Integer).label("account"),
            cast(func.coalesce(sane, 0.0), Float).label("size"),
            literal(0, Integer).label("size_est"),
            literal(0, Integer).label("preview"),
            cast(_blank_to_null(g.canonical_asset_url), String).label("output_key"),
        )
        .select_from(e)
        .outerjoin(g, g.source_usage_event_id == e.id)
        # event_date is already an IST calendar day - the same window rule
        # the Usage Intelligence report applies to Kling.
        .where(e.tool_id.in_(kling_tool_ids), e.event_date >= start, e.event_date <= end)
    )
    drop = kling.drop_ids
    if drop:
        q = q.where(e.id.notin_(sorted(drop)))
    return q


def _costed(raw, filters: ReportFilters, dialect: str):
    """Add the rupee columns (see costing.py) on top of the raw union.

    Layer 1 settles each row's account and its share weight, and sums the
    weights per subscription account over the period (a window, so a
    department or user filter applied later never changes a share). Layer 2
    turns that into rupees."""
    cost = filters.cost or CostSetup(start=filters.start, end=filters.end)
    charged = charge_status_expr(raw.c.status) == CHARGED
    pay_per_use = raw.c.tool.in_(PAY_PER_USE_TOOLS)
    account = cost.account_sql(raw.c.tool, raw.c.account)
    counted = and_(charged, ~pay_per_use)
    if filters.excluded_ids:
        # Test & admin accounts take no share: the fee is shared among the people reported.
        counted = and_(counted, or_(raw.c.user_id.is_(None), raw.c.user_id.notin_(filters.excluded_ids)))
    weight = case((counted, raw.c.size), else_=literal(0.0, Float))
    keep = [c for c in raw.c if c.name != "account"]
    l1 = select(
        *keep,
        cast(account, Integer).label("account"),
        weight.label("weight"),
        func.sum(weight).over(partition_by=[raw.c.tool, account]).label("weight_total"),
        _day_of_timestamp(raw.c.occurred_at, dialect).label("day"),
    ).subquery("costing")
    rate, assumed = cost.rate_sql(l1.c.tool, l1.c.account, l1.c.day)
    l1_charged = charge_status_expr(l1.c.status) == CHARGED
    l1_ppu = l1.c.tool.in_(PAY_PER_USE_TOOLS)
    rupees = case(
        (~l1_charged, literal(0.0, Float)),
        (l1_ppu, l1.c.credits * rate),
        (l1.c.weight_total > 0, cost.fee_sql(l1.c.account) * l1.c.weight / l1.c.weight_total),
        else_=literal(0.0, Float),
    )
    rate_assumed = case((and_(l1_charged, l1_ppu), assumed), else_=0)
    estimated = case((rate_assumed == 1, 1), (and_(l1_charged, ~l1_ppu, l1.c.size_est == 1), 1), else_=0)
    out = [c for c in l1.c if c.name not in ("weight", "weight_total")]
    return select(
        *out,
        cast(rupees, Float).label("rupees"),
        cast(estimated, Integer).label("estimated"),
        cast(rate_assumed, Integer).label("rate_assumed"),
        case((l1_ppu, PAY_PER_USE), else_=SUBSCRIPTION).label("basis"),
    ).subquery("facts")


def facts_subquery(filters: ReportFilters, dialect: str = "postgresql"):
    period = filters.period or resolve_period(start=filters.start.isoformat(), end=filters.end.isoformat())
    utc_s, utc_e = period["utc_start"], period["utc_end"]
    display, kling = filters.display, filters.kling
    selects = []
    if filters.tool in (None, KLING):
        selects.append(_kling_select(filters.start, filters.end, dialect, display, kling))
    for src in TOOL_SOURCES:
        if filters.tool in (None, src.name):
            selects.append(_source_select(src, utc_s, utc_e, dialect, display))
    for tool_name, provider in CONVERSATION_TOOLS:
        if filters.tool in (None, tool_name):
            selects.append(_conversation_select(tool_name, provider, utc_s, utc_e, dialect, display))
    if not selects:  # unknown tool name: empty, but still a valid query
        selects.append(_kling_select(filters.start, filters.end, dialect, display, kling).where(literal(False)))
    raw = selects[0].subquery("raw") if len(selects) == 1 else union_all(*selects).subquery("raw")
    return _costed(raw, filters, dialect)


def department_expr(filters: Optional[ReportFilters] = None):
    # An owner-less row has no joined user, so it falls to "No department" too.
    display = filters.display if filters else DisplayConfig()
    raws = filters.department_raws if filters else []
    return display.department_sql(User.department, raws, blank=UNASSIGNED_DEPARTMENT)


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
        query = query.where(department_expr(filters) == filters.department)
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
    rupees: float = 0.0             # ₹ of the group (Charged rows only carry rupees)
    rupees_est: float = 0.0         # part of `rupees` that is an estimate


def _rupee_sums(facts) -> list:
    return [func.coalesce(func.sum(facts.c.rupees), 0.0).label("rupees"),
            func.coalesce(func.sum(case((facts.c.estimated == 1, facts.c.rupees), else_=0.0)), 0.0).label("rupees_est")]


def load_groups(db: Session, filters: ReportFilters) -> list:
    prepare(db, filters)
    facts = facts_subquery(filters, _dialect(db))
    dept = department_expr(filters)
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
            *_rupee_sums(facts),
        ),
        facts,
        filters,
    ).group_by(User.id, User.name, User.employee_id, User.is_deleted, dept, facts.c.tool, client_expr, bucket,
               facts.c.month)
    out = []
    person = filters.display.person_name
    for row in db.execute(q):
        owned = row.uid is not None
        out.append(FactGroup(
            user_id=int(row.uid) if owned else UNASSIGNED_USER_ID,
            user_name=(person(row.uid, row.name) or f"User {row.uid}") if owned else UNASSIGNED,
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
            rupees=float(row.rupees or 0.0),
            rupees_est=float(row.rupees_est or 0.0),
        ))
    return out


@dataclass(frozen=True)
class AccountGroup:
    """Charged generations of one tool account in the period (Subscriptions table)."""

    tool: str
    account: Optional[int]
    items: int
    credits: float
    rupees: float
    rupees_est: float
    last_at: object                 # latest generation time (UTC) in the period


def load_account_groups(db: Session, filters: ReportFilters) -> list:
    prepare(db, filters)
    facts = facts_subquery(filters, _dialect(db))
    q = _scoped(
        select(facts.c.tool, facts.c.account, func.count().label("items"),
               func.coalesce(func.sum(facts.c.credits), 0.0).label("credits"), *_rupee_sums(facts),
               func.max(facts.c.occurred_at).label("last_at")),
        facts, filters,
    ).where(charge_status_expr(facts.c.status) == CHARGED).group_by(facts.c.tool, facts.c.account)
    return [AccountGroup(tool=r.tool, account=int(r.account) if r.account is not None else None,
                         items=int(r.items or 0), credits=float(r.credits or 0.0), rupees=float(r.rupees or 0.0),
                         rupees_est=float(r.rupees_est or 0.0), last_at=r.last_at)
            for r in db.execute(q)]


def load_issue_counts(db: Session, filters: ReportFilters) -> dict:
    """Charged rows and rupees behind the cost notes: {issue: (rows, rupees)}
    for "rate assumed", "estimated" and "free preview model"."""
    prepare(db, filters)
    facts = facts_subquery(filters, _dialect(db))
    charged = charge_status_expr(facts.c.status) == CHARGED

    def pair(cond):
        return (func.coalesce(func.sum(case((and_(charged, cond), 1), else_=0)), 0),
                func.coalesce(func.sum(case((and_(charged, cond), facts.c.rupees), else_=0.0)), 0.0))

    cols = [*pair(facts.c.rate_assumed == 1), *pair(facts.c.estimated == 1), *pair(facts.c.preview == 1)]
    r = db.execute(_scoped(select(*cols), facts, filters)).one()
    return {"rate_assumed": (int(r[0]), float(r[1])), "estimated": (int(r[2]), float(r[3])),
            "free_preview": (int(r[4]), float(r[5]))}


def load_upload_count(db: Session, filters: ReportFilters) -> int:
    """Freepik uploads in the period (left out of every count; Data Quality shows how many)."""
    if filters.tool not in (None, "Freepik"):
        return 0
    period = filters.period or resolve_period(start=filters.start.isoformat(), end=filters.end.isoformat())
    m = FreepikGeneration
    when = func.coalesce(m.provider_created_at, m.created_at)
    q = db.query(func.count(m.id)).filter(when >= period["utc_start"], when < period["utc_end"],
                                         func.lower(func.coalesce(m.tool_name, m.tool, "")).in_(FREEPIK_UPLOAD_TOOLS))
    if filters.excluded_ids:
        q = q.filter(or_(m.owner_user_id.is_(None), m.owner_user_id.notin_(filters.excluded_ids)))
    return int(q.scalar() or 0)


def load_last_used(db: Session, cost: CostSetup) -> dict:
    """Latest generation time ever (UTC) per subscription account, any status."""
    out = {}

    def note(acc, last):
        if acc is not None and last is not None:
            key = int(acc)
            out[key] = max(out.get(key, last), last)

    for src in TOOL_SOURCES:
        m = src.model
        when = _source_when(src)
        account = cost.account_sql(literal(src.name, String), m.credential_id)
        for acc, last in db.query(account, func.max(when)).group_by(account).all():
            note(acc, last)
    # Conversation prompts carry no account: they belong to the tool's only one.
    for tool_name, provider in CONVERSATION_TOOLS:
        acc = cost.default_account.get(tool_name)
        if acc is None:
            continue
        last = (db.query(func.max(func.coalesce(ConversationPrompt.prompt_timestamp, ConversationPrompt.created_at)))
                .join(ConversationRecord, ConversationRecord.id == ConversationPrompt.conversation_id)
                .filter(ConversationRecord.provider == provider).scalar())
        note(acc, last)
    return out


@dataclass(frozen=True)
class DayGroup:
    """One GROUP BY row: user x tool x client x IST day x charge status.

    Same scope and user mapping as the Generation Log, so a key's row count
    here is exactly how many log rows it gets (By User / By Tool blocks and
    the log's back links are planned from these before the log is written).
    """

    user_id: int                    # UNASSIGNED_USER_ID for owner-less rows
    tool: str
    client: str
    day: Optional[str]              # "YYYY-MM-DD" (IST), None if the row has no time
    charge_status: str
    rows: int
    credits: float
    rupees: float = 0.0
    rupees_est: float = 0.0


def load_day_groups(db: Session, filters: ReportFilters) -> list:
    prepare(db, filters)
    dialect = _dialect(db)
    facts = facts_subquery(filters, dialect)
    owner_key = func.coalesce(User.id, UNASSIGNED_USER_ID)
    client_expr = func.coalesce(facts.c.client, NO_CLIENT)
    bucket = charge_status_expr(facts.c.status)
    day = _day_of_timestamp(facts.c.occurred_at, dialect)
    q = _scoped(
        select(cast(owner_key, Integer).label("uid"), facts.c.tool, client_expr.label("client"), day.label("day"),
               bucket.label("charge_status"), func.count().label("rows"),
               func.coalesce(func.sum(facts.c.credits), 0.0).label("credits"), *_rupee_sums(facts)),
        facts,
        filters,
    ).group_by(owner_key, facts.c.tool, client_expr, day, bucket)
    return [DayGroup(user_id=int(r.uid), tool=r.tool, client=r.client, day=r.day or None,
                     charge_status=r.charge_status, rows=int(r.rows or 0), credits=float(r.credits or 0.0),
                     rupees=float(r.rupees or 0.0), rupees_est=float(r.rupees_est or 0.0))
            for r in db.execute(q)]


def load_excluded_summary(db: Session, filters: ReportFilters) -> dict:
    """What the test & admin exclusion removed: generations and Charged credits."""
    prepare(db, filters)
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
def stream_log(db: Session, filters: ReportFilters, user_order: list, batch_size: int = 1000,
               tool_order: Optional[dict] = None, client_order: Optional[dict] = None) -> Iterator:
    """Yield every generation (all charge statuses) with users contiguous in
    ``user_order``. With ``tool_order`` ({(user id, tool): position}) and
    ``client_order`` ({client: position}) each user's rows are grouped by
    tool in that order, then IST day (newest first), then client, then time
    (newest first) - so every (user, tool) and (user, tool, day, client) is
    one contiguous run; without them, oldest first within a user.

    The order is pushed into SQL as a CASE over user ids instead of sorting
    by name in SQL, so the database and Python never disagree on collation
    and each user's row positions in the log stay exact. Owner-less rows use
    UNASSIGNED_USER_ID's position.
    """
    if not user_order:
        return iter(())
    prepare(db, filters)
    facts = facts_subquery(filters, _dialect(db))
    owner_key = func.coalesce(User.id, UNASSIGNED_USER_ID)
    position = case({uid: i for i, uid in enumerate(user_order)}, value=owner_key, else_=len(user_order))
    if tool_order:
        pair = case(*[(and_(owner_key == uid, facts.c.tool == tool), i) for (uid, tool), i in tool_order.items()],
                    else_=len(tool_order))
        client_pos = case({c: i for i, c in enumerate(client_order or {})},
                          value=func.coalesce(facts.c.client, NO_CLIENT), else_=len(client_order or {}))
        day = _day_of_timestamp(facts.c.occurred_at, _dialect(db))
        ordering = (position, pair, day.desc().nulls_last(), client_pos, facts.c.occurred_at.desc().nulls_last(),
                    facts.c.tool, facts.c.record_id)
    else:
        ordering = (position, facts.c.occurred_at, facts.c.tool, facts.c.record_id)
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
            facts.c.raw_status,
            charge_status_expr(facts.c.status).label("charge_status"),
            facts.c.has_output,
            facts.c.rupees,
            facts.c.estimated,
            facts.c.rate_assumed,
            facts.c.preview,
            facts.c.size_est,
            facts.c.basis,
            facts.c.output_key,
        ),
        facts,
        filters,
    ).order_by(*ordering)
    result = db.execute(q.execution_options(stream_results=True, yield_per=batch_size))
    return iter(result)


def cost_note(row) -> str:
    """Why a log row's ₹ is what it is, in plain words (blank = exact)."""
    if row.charge_status != CHARGED:
        return ""
    if getattr(row, "preview", 0):
        return "Free preview model"
    if getattr(row, "rate_assumed", 0):
        return "est. · rate assumed"
    if getattr(row, "size_est", 0):
        return "est. · no per-item cost recorded" if row.tool != "ElevenLabs" else "est. · from text length"
    return ""


# --------------------------------------------------------------------------- #
# Filter options and output links
# --------------------------------------------------------------------------- #
def load_options(db: Session) -> dict:
    display = DisplayConfig.load()
    users = (
        db.query(User.id, User.name, User.department)
        .filter(User.is_deleted.is_(False))
        .order_by(User.name)
        .all()
    )
    departments = {display.department_name(d) for _i, _n, d in users if (d or "").strip()}
    departments.add(UNASSIGNED_DEPARTMENT)
    clients = []
    for (n,) in db.query(GenerationClient.name).order_by(GenerationClient.name).all():
        shown = display.client_name(n)
        if shown and shown not in clients:
            clients.append(shown)
    user_rows = [{"id": UNASSIGNED_USER_ID, "name": UNASSIGNED, "department": UNASSIGNED_DEPARTMENT}]
    user_rows += sorted(
        ({"id": i, "name": display.person_name(i, n), "department": display.department_name(d) or UNASSIGNED_DEPARTMENT}
         for i, n, d in users),
        key=lambda u: u["name"].lower(),
    )
    return {
        "departments": sorted(departments, key=str.lower),
        "users": user_rows,
        "tools": list(TOOL_NAMES),
        "clients": sorted(clients, key=str.lower) + [NO_CLIENT],
        "excludedAccounts": [{"id": uid, "name": name} for uid, name in resolve_excluded_accounts(db, display)],
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
    if tool in dict(CONVERSATION_TOOLS):
        row = (
            db.query(ConversationRecord.provider, ConversationRecord.provider_conversation_id,
                     ConversationRecord.conversation_url)
            .join(ConversationPrompt, ConversationPrompt.conversation_id == ConversationRecord.id)
            .filter(ConversationPrompt.id == record_id)
            .first()
        )
        return chat_web_url(*row) if row else None
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
