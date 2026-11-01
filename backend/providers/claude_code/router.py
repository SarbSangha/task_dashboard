# providers/claude_code/router.py
"""
API surface for the Claude Code provider.

  POST /connect                Cursor Usage Tracker extension (Bearer its Cursor tracker token):
                               issues this computer's Claude Code token
  POST /disconnect             same extension: that computer's Claude Code token stops working
  POST /otlp/v1/logs           Claude Code itself (Bearer Claude Code token): OTLP/HTTP JSON events
  POST /otlp/v1/metrics|traces accepted and dropped, in case a computer has those exporters on
  GET  /connections            admin: computers reporting Claude Code
  GET  /view                   admin: prompts with their requests' tokens/cost, per person, for a period

The Claude Code token is a second credential for an already-connected
computer, not a new identity: it is only accepted while that computer's
Cursor connection is active and its person can still sign in. It has to sit in
plain text in ~/.claude/settings.json (Claude Code reads its exporter headers
from there), which is why it is separate from the Cursor tracker token kept in
the OS credential store, and why it can only add Claude Code events for its
own person - it can't read anything.
"""
import gzip
import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.claude_code import queries as claude_code_queries
from providers.claude_code.constants import (
    MAX_OTLP_BODY_BYTES,
    OTLP_PATH,
    TOKEN_PREFIX,
    VIEW_DEFAULT_LIMIT,
    VIEW_MAX_LIMIT,
    VIEW_MAX_RANGE_MS,
)
from providers.claude_code.models import ClaudeCodePrompt, ClaudeCodeRequest, ClaudeCodeToken
from providers.claude_code.otlp import ParsedBatch, parse_logs
from providers.claude_code.schemas import ClaudeConnectIn, ClaudeConnectOut, ClaudeDisconnectOut, ListOut, ViewOut
from providers.cursor.models import CursorDevice
from providers.cursor.router import _active_user, _resolve_tracker_device
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/claude-code", tags=["claude-code"])
logger = logging.getLogger("claude_code_router")


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _ms_to_utc(value: int) -> datetime:
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).replace(tzinfo=None)


def _revoke_device_tokens(db: Session, device: CursorDevice, now: datetime) -> int:
    return (
        db.query(ClaudeCodeToken)
        .filter(ClaudeCodeToken.cursor_device_row_id == device.id, ClaudeCodeToken.revoked_at.is_(None))
        .update({ClaudeCodeToken.revoked_at: now}, synchronize_session=False)
    )


@router.post("/connect", response_model=ClaudeConnectOut)
def connect_claude_code(
    payload: ClaudeConnectIn,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_operational_db),
):
    """Called by the Cursor Usage Tracker extension on a computer that is
    already connected; the person is whoever that computer is connected for."""
    device, user = _resolve_tracker_device(db, authorization, payload.device.id)
    now = datetime.utcnow()
    # One live Claude Code token per computer: a new one replaces the old.
    _revoke_device_tokens(db, device, now)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    db.add(ClaudeCodeToken(
        cursor_device_row_id=device.id,
        user_id=user.id,
        token_hash=_sha256(token),
        extension_version=payload.extension_version,
    ))
    db.commit()
    logger.info("claude code token issued for cursor device %s (user %s)", device.id, user.id)
    return ClaudeConnectOut(token=token, otlpPath=OTLP_PATH, user={"id": user.id, "name": user.name})


@router.post("/disconnect", response_model=ClaudeDisconnectOut)
def disconnect_claude_code(
    payload: ClaudeConnectIn,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_operational_db),
):
    device, _user = _resolve_tracker_device(db, authorization, payload.device.id)
    revoked = _revoke_device_tokens(db, device, datetime.utcnow())
    db.commit()
    return ClaudeDisconnectOut(revoked=revoked)


def _resolve_claude_token(db: Session, authorization: Optional[str]) -> tuple[ClaudeCodeToken, User]:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token.startswith(TOKEN_PREFIX):
        raise HTTPException(status_code=401, detail="Missing Claude Code token")
    row = (
        db.query(ClaudeCodeToken)
        .join(CursorDevice, CursorDevice.id == ClaudeCodeToken.cursor_device_row_id)
        .filter(
            ClaudeCodeToken.token_hash == _sha256(token),
            ClaudeCodeToken.revoked_at.is_(None),
            CursorDevice.revoked_at.is_(None),
        )
        .first()
    )
    if row is None:
        raise HTTPException(
            status_code=401,
            detail="This computer's Claude Code connection was turned off. Run Cursor Tracker: Connect Claude Code on this computer.",
        )
    user = _active_user(db, row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="The dashboard user this computer is connected for no longer exists")
    return row, user


async def _read_json_body(request: Request) -> dict:
    content_type = (request.headers.get("content-type") or "").lower()
    if "protobuf" in content_type:
        raise HTTPException(status_code=415, detail="Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json")
    raw = await request.body()
    if len(raw) > MAX_OTLP_BODY_BYTES:
        raise HTTPException(status_code=413, detail="OTLP batch too large")
    if "gzip" in (request.headers.get("content-encoding") or "").lower():
        try:
            raw = gzip.decompress(raw)
        except OSError as error:
            raise HTTPException(status_code=400, detail="Body is not valid gzip") from error
        if len(raw) > MAX_OTLP_BODY_BYTES:
            raise HTTPException(status_code=413, detail="OTLP batch too large")
    try:
        body = json.loads(raw or b"{}")
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Body is not valid JSON") from error
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected an OTLP ExportLogsServiceRequest object")
    return body


def _store_batch(db: Session, token_row: ClaudeCodeToken, user: User, batch: ParsedBatch) -> tuple[int, int]:
    """Inserts the batch's prompts and requests that aren't stored yet.
    Returns (prompts added, requests added)."""
    prompts = {p.uid: p for p in batch.prompts}
    requests = {r.uid: r for r in batch.requests}
    known_prompts = {
        uid for (uid,) in db.query(ClaudeCodePrompt.prompt_uid)
        .filter(ClaudeCodePrompt.owner_user_id == user.id, ClaudeCodePrompt.prompt_uid.in_(list(prompts)))
        .all()
    } if prompts else set()
    known_requests = {
        uid for (uid,) in db.query(ClaudeCodeRequest.request_uid)
        .filter(ClaudeCodeRequest.owner_user_id == user.id, ClaudeCodeRequest.request_uid.in_(list(requests)))
        .all()
    } if requests else set()

    added_prompts = added_requests = 0
    for uid, p in prompts.items():
        if uid in known_prompts:
            continue
        db.add(ClaudeCodePrompt(
            owner_user_id=user.id, token_row_id=token_row.id, prompt_uid=uid, session_id=p.session_id,
            prompt_text=p.text or None, prompt_length=p.length, command_name=p.command_name,
            terminal_type=p.terminal_type, account_email=p.account_email, claude_version=p.claude_version,
            prompted_at=p.occurred_at,
        ))
        added_prompts += 1
    for uid, r in requests.items():
        if uid in known_requests:
            continue
        db.add(ClaudeCodeRequest(
            owner_user_id=user.id, token_row_id=token_row.id, request_uid=uid, prompt_uid=r.prompt_uid,
            session_id=r.session_id, model=r.model, cost_usd=r.cost_usd,
            input_tokens=r.input_tokens, output_tokens=r.output_tokens,
            cache_read_tokens=r.cache_read_tokens, cache_write_tokens=r.cache_write_tokens,
            duration_ms=r.duration_ms, terminal_type=r.terminal_type, account_email=r.account_email,
            claude_version=r.claude_version, occurred_at=r.occurred_at,
        ))
        added_requests += 1
    return added_prompts, added_requests


@router.post("/otlp/v1/logs")
async def receive_logs(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_operational_db),
):
    token_row, user = _resolve_claude_token(db, authorization)
    batch = parse_logs(await _read_json_body(request))
    if not batch.prompts and not batch.requests:
        return {}

    latest = max([*batch.prompts, *batch.requests], key=lambda e: e.occurred_at)
    token_row.last_seen_at = datetime.utcnow()
    token_row.last_account_email = latest.account_email or token_row.last_account_email
    token_row.last_terminal_type = latest.terminal_type or token_row.last_terminal_type
    token_row.last_claude_version = latest.claude_version or token_row.last_claude_version

    for attempt in (1, 2):
        added = _store_batch(db, token_row, user, batch)
        try:
            db.commit()
            break
        except IntegrityError:
            # The same events arriving twice at once (an exporter retry racing
            # the original). The second pass sees the first's rows and skips them.
            db.rollback()
            token_row, user = _resolve_claude_token(db, authorization)
            if attempt == 2:
                raise HTTPException(status_code=503, detail="Concurrent export - retry")
    logger.debug("claude code batch for user %s: +%s prompts, +%s requests", user.id, *added)
    return {}


@router.post("/otlp/v1/metrics")
@router.post("/otlp/v1/traces")
async def receive_unused_signal(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_operational_db),
):
    _resolve_claude_token(db, authorization)
    return {}


@router.get("/connections", response_model=ListOut)
def list_connections(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    rows = (
        db.query(ClaudeCodeToken, CursorDevice, User.name)
        .join(CursorDevice, CursorDevice.id == ClaudeCodeToken.cursor_device_row_id)
        .join(User, User.id == ClaudeCodeToken.user_id)
        .order_by(ClaudeCodeToken.revoked_at.isnot(None), ClaudeCodeToken.created_at.desc())
        .limit(300)
        .all()
    )
    data = []
    for token, device, name in rows:
        item = token.to_dict()
        item.update({
            "userName": name,
            "deviceName": device.device_name,
            "deviceOs": device.device_os,
            # Disconnecting the computer in People & devices also stops Claude Code.
            "active": token.revoked_at is None and device.revoked_at is None,
        })
        data.append(item)
    return ListOut(data=data)


@router.get("/view", response_model=ViewOut)
def get_view(
    from_ms: int = Query(..., ge=1),
    to_ms: int = Query(..., ge=1),
    owner_user_id: Optional[int] = None,
    q: Optional[str] = Query(default=None, max_length=200),
    sort: str = Query(default="ts", pattern="^(ts|cost|tokens|requests|person|model)$"),
    direction: str = Query(default="desc", pattern="^(asc|desc)$"),
    tz_offset_min: int = Query(default=0, ge=-14 * 60, le=14 * 60),
    limit: int = Query(default=VIEW_DEFAULT_LIMIT, ge=1, le=VIEW_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """The Claude Code tab for [from_ms, to_ms) - exact instants so "Today" is
    the viewer's own local day; tz_offset_min (JS getTimezoneOffset) puts the
    daily buckets on local days too."""
    if to_ms <= from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be after from_ms")
    if to_ms - from_ms > VIEW_MAX_RANGE_MS:
        raise HTTPException(status_code=400, detail="Pick a period of at most about a year")
    data = claude_code_queries.build_view(
        db, start=_ms_to_utc(from_ms), end=_ms_to_utc(to_ms),
        owner_user_id=owner_user_id, q=q, sort=sort, descending=direction == "desc",
        limit=limit, offset=offset, tz_offset_min=tz_offset_min,
    )
    return ViewOut(data=data)
