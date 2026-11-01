# providers/figma/capture.py
"""
Capture ingestion: turns the extension's "prompt" and "balance" events into
FigmaPrompt / FigmaBalanceSnapshot rows. No raw-event table: a prompt event
already is the finished fact (Figma's own id, text and credits), and it is
upserted on that id.

The actor/credential resolvers wrap routers.it_tools_router's, imported late
for the same import cycle providers/splice/capture.py documents.
"""
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolCredential, User
from providers.figma.constants import (
    ALL_EVENT_TYPES,
    EVENT_BALANCE,
    MAX_PROMPT_TEXT_CHARS,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    TOOL_SLUGS,
)
from providers.figma.models import FigmaBalanceSnapshot, FigmaPrompt
from utils.client_gate import validate_client_for_generation
from utils.task_gate import validate_task_for_generation

logger = logging.getLogger("figma_capture")

FAILED_OUTCOMES = frozenset({"error", "failed", "aborted", "stopped", "cancelled", "canceled"})


@dataclass
class IngestResult:
    status: str  # "created" | "updated" | "duplicate" | "rejected"
    id: Optional[int] = None
    reason: Optional[str] = None


def resolve_figma_tool(db: Session) -> Optional[ITPortalTool]:
    return (
        db.query(ITPortalTool)
        .filter(ITPortalTool.slug.in_(TOOL_SLUGS))
        .filter(ITPortalTool.is_active == True)  # noqa: E712
        .first()
    )


def resolve_figma_actor(*, request: Request, db: Session, tool: ITPortalTool,
                        usage_ticket: Optional[str], extension_ticket: Optional[str]) -> User:
    from routers.it_tools_router import _resolve_usage_event_actor

    return _resolve_usage_event_actor(
        request=request, db=db, tool=tool,
        usage_ticket=usage_ticket or "", extension_ticket=extension_ticket or "",
    )


def resolve_figma_credential(db: Session, *, tool_id: int, user_id: int,
                             explicit_credential_id: Optional[int] = None) -> Optional[ITPortalToolCredential]:
    from routers.it_tools_router import _resolve_usage_event_credential

    return _resolve_usage_event_credential(
        db, tool_id=tool_id, user_id=user_id, explicit_credential_id=explicit_credential_id,
    )


# --------------------------------------------------------------------------- #
# Payload readers
# --------------------------------------------------------------------------- #
def _str(value: Any, limit: int) -> Optional[str]:
    if value is None or value == "":
        return None
    return str(value).strip()[:limit] or None


def _float(value: Any) -> Optional[float]:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _int(value: Any) -> Optional[int]:
    number = _float(value)
    return int(number) if number is not None else None


def _ms(value: Any) -> Optional[datetime]:
    number = _float(value)
    if not number:
        return None
    return datetime.fromtimestamp(number / 1000, tz=timezone.utc).replace(tzinfo=None)


def _iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed


def prompt_status(credits: Optional[float], outcome: Optional[str]) -> str:
    if credits is not None:
        return STATUS_COMPLETED
    if (outcome or "").lower() in FAILED_OUTCOMES:
        return STATUS_FAILED
    return STATUS_PENDING


_TOOL_RESULT_RE = re.compile(r"^\s*<tool_result\b[^>]*>(.*?)</tool_result>\s*$", re.S)


def readable_prompt(text: Optional[str]) -> Optional[str]:
    """The person's answer to a question the agent asked goes back to Figma as
    a <tool_result> block (userMessageOrigin "mcp-client-side-tool-resume"),
    billed as its own action. Extension 0.1.80+ sends it already readable;
    this covers rows captured before that."""
    match = _TOOL_RESULT_RE.match(text or "")
    if not match:
        return text
    try:
        result = json.loads(match.group(1).strip())
    except ValueError:
        return "Answered the agent's question"
    picked = result.get("selectedOptions") if isinstance(result, dict) else None
    answer = ", ".join(map(str, picked)) if isinstance(picked, list) and picked else (
        result.get("message") if isinstance(result, dict) else None)
    return f"Answered the agent's question: {answer}" if answer else "Answered the agent's question"


def file_url_for(file_key: Optional[str]) -> Optional[str]:
    return f"https://www.figma.com/design/{file_key}" if file_key else None


# --------------------------------------------------------------------------- #
# Ingest
# --------------------------------------------------------------------------- #
def _attribution(db: Session, user: User, task_id: Optional[int], client_id: Optional[int]) -> dict:
    out = {"linked_task_id": None, "linked_task_name": None, "linked_client_id": None, "linked_client_name": None}
    if task_id is not None:
        task = validate_task_for_generation(db, task_id, user.id)
        if task:
            out.update(linked_task_id=task.id, linked_task_name=task.title)
    if client_id is not None:
        client = validate_client_for_generation(db, client_id)
        if client:
            out.update(linked_client_id=client.id, linked_client_name=client.name)
    return out


def ingest_prompt(db: Session, *, tool: ITPortalTool, credential_id: Optional[int], user: User,
                  client_event_id: str, payload: dict, extension_version: Optional[str],
                  tab_id: Optional[int], task_id: Optional[int] = None,
                  client_id: Optional[int] = None) -> IngestResult:
    uuid = _str(payload.get("userActionUuid") or client_event_id, 64)
    if not uuid:
        return IngestResult("rejected", reason="userActionUuid is required")

    credits = _float(payload.get("credits"))
    credit_cost = _float(payload.get("creditCost"))
    outcome = _str(payload.get("outcome"), 40)
    status = prompt_status(credits, outcome)
    now = datetime.utcnow()

    existing = db.query(FigmaPrompt).filter(FigmaPrompt.user_action_uuid == uuid).first()
    if existing:
        # A prompt reported again: only Figma's number can change - a pending
        # prompt gets its credits, or a recheck returned a newer figure. The
        # first report's person, file and text stay.
        if credits is None or credits == existing.credits_used:
            return IngestResult("duplicate", id=existing.id)
        existing.credits_used = credits
        existing.credit_cost = credit_cost if credit_cost is not None else credits
        existing.status = STATUS_COMPLETED
        existing.costed_at = now
        db.flush()
        return IngestResult("updated", id=existing.id)

    text = payload.get("promptText") if isinstance(payload.get("promptText"), str) else ""
    file_key = _str(payload.get("fileKey"), 64)
    meta = {k: payload[k] for k in ("outcome", "outcomeDetail", "numLlmCalls", "costAttempts") if k in payload}
    row = FigmaPrompt(
        tool_id=tool.id,
        credential_id=credential_id,
        owner_user_id=user.id,
        **_attribution(db, user, task_id, client_id),
        user_action_uuid=uuid,
        request_uuid=_str(payload.get("requestUuid"), 64),
        thread_id=_str(payload.get("threadId"), 80),
        file_key=file_key,
        file_name=_str(payload.get("fileName"), 255),
        file_url=file_url_for(file_key),
        origin=_str(payload.get("origin"), 60),
        prompt_text=text[:MAX_PROMPT_TEXT_CHARS],
        prompt_length=_int(payload.get("promptLength")) or len(text),
        status=status,
        credits_used=credits,
        credit_cost=credit_cost if credit_cost is not None else credits,
        tool_calls=_int(payload.get("toolCalls")),
        work_ms=_int(payload.get("workMs")),
        figma_user_id=_str(payload.get("figmaUserId"), 40),
        figma_email=_str(payload.get("figmaEmail"), 255),
        plan_id=_str(payload.get("planId"), 64),
        plan_tier=_str(payload.get("planTier"), 40),
        prompted_at=_ms(payload.get("promptedAtMs")) or now,
        finished_at=_ms(payload.get("finishedAtMs")),
        costed_at=now if credits is not None else None,
        extension_version=_str(extension_version, 40),
        tab_id=tab_id,
        page_url=_str(payload.get("pageUrl"), 2000),
        metadata_json=meta or None,
    )
    savepoint = db.begin_nested()
    try:
        db.add(row)
        db.flush()
        savepoint.commit()
    except IntegrityError:
        # The same prompt from two uploads at once: the other one won.
        savepoint.rollback()
        other = db.query(FigmaPrompt).filter(FigmaPrompt.user_action_uuid == uuid).first()
        if other is None:
            raise
        return IngestResult("duplicate", id=other.id)
    return IngestResult("created", id=row.id)


def ingest_balance(db: Session, *, tool: ITPortalTool, credential_id: Optional[int], user: User,
                   payload: dict) -> IngestResult:
    figma_user_id = _str(payload.get("figmaUserId"), 40)
    consumed = _float(payload.get("monthlyConsumed"))
    if consumed is None:
        return IngestResult("rejected", reason="monthlyConsumed is required")
    period_start = _iso(payload.get("periodStart"))
    daily_consumed = _float(payload.get("dailyConsumed"))

    latest = (
        db.query(FigmaBalanceSnapshot)
        .filter(FigmaBalanceSnapshot.figma_user_id == figma_user_id)
        .order_by(FigmaBalanceSnapshot.captured_at.desc())
        .first()
    )
    # Every finished prompt reports the balance; keep only changes.
    if latest and latest.period_start == period_start and latest.monthly_consumed == consumed \
            and latest.daily_consumed == daily_consumed:
        return IngestResult("duplicate", id=latest.id)

    row = FigmaBalanceSnapshot(
        tool_id=tool.id,
        credential_id=credential_id,
        owner_user_id=user.id,
        figma_user_id=figma_user_id,
        figma_email=_str(payload.get("figmaEmail"), 255),
        plan_id=_str(payload.get("planId"), 64),
        plan_tier=_str(payload.get("planTier"), 40),
        period_start=period_start,
        period_end=_iso(payload.get("periodEnd")),
        monthly_total=_float(payload.get("monthlyTotal")),
        monthly_consumed=consumed,
        monthly_remaining=_float(payload.get("monthlyRemaining")),
        daily_total=_float(payload.get("dailyTotal")),
        daily_consumed=daily_consumed,
        captured_at=_ms(payload.get("capturedAtMs")) or datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    return IngestResult("created", id=row.id)


def ingest_event(db: Session, *, event_type: str, **kwargs) -> IngestResult:
    kind = (event_type or "").strip().lower()
    if kind not in ALL_EVENT_TYPES:
        return IngestResult("rejected", reason=f"unknown event_type: {event_type!r}")
    if kind == EVENT_BALANCE:
        return ingest_balance(db, tool=kwargs["tool"], credential_id=kwargs["credential_id"],
                              user=kwargs["user"], payload=kwargs["payload"])
    return ingest_prompt(db, **kwargs)
