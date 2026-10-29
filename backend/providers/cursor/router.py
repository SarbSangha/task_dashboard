# providers/cursor/router.py
"""
API surface for the Cursor provider.

  GET  /people               admin: people a computer can be connected for
  POST /setup-codes          admin: one-time setup code for one person
  POST /connect              Cursor extension: trades a setup code for this computer's tracker token
  GET  /devices              admin: connected computers
  POST /devices/{id}/disconnect  admin: that computer's token stops working
  POST /capture/prompts      Cursor extension (Bearer tracker token): upserts prompts
  POST /usage/upload         admin: imports a Cursor usage CSV (raw text/csv body)
  GET  /prompts              admin: prompt cards with matched tokens/cost
  GET  /prompts/{prompt_id}  admin: one prompt
  GET  /view                 admin: the Cursor tab's usage page for a period (all prompts + unassigned)
  GET  /summary              admin: per-person token share for a period
  GET  /accounts             admin: Cursor logins seen so far
  GET  /uploads              admin: recent CSV uploads

Unlike every browser provider, there is no launcher ticket to identify the
person: Cursor is a desktop app nobody opens through the dashboard. Instead an
admin connects each computer once - a setup code for one person, typed into the
extension, becomes a tracker token that only works from that computer. Nobody
can switch a computer to someone else (or reuse its token elsewhere) without a
new code from an admin.
"""
import hashlib
import logging
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ITPortalTool, User
from providers.cursor import queries as cursor_queries
from providers.cursor.constants import (
    MAX_CSV_BYTES,
    MAX_PROMPT_TEXT_CHARS,
    SETUP_CODE_ALPHABET,
    SETUP_CODE_LENGTH,
    SETUP_CODE_PREFIX,
    SETUP_CODE_TTL_SEC,
    TOOL_SLUGS,
)
from providers.cursor.csv_import import UsageCsvError, parse_usage_csv
from providers.cursor.models import (
    CursorDevice,
    CursorPrompt,
    CursorSetupCode,
    CursorUsageEvent,
    CursorUsageUpload,
)
from providers.cursor.queries import PromptFilters
from providers.cursor.schemas import (
    CapturePromptsRequest,
    CapturePromptsResponse,
    ConnectIn,
    ConnectOut,
    ListOut,
    PaginationOut,
    PromptDetailOut,
    PromptListOut,
    SetupCodeIn,
    SetupCodeOut,
    SummaryOut,
    UsageUploadOut,
)
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/cursor", tags=["cursor"])
logger = logging.getLogger("cursor_router")


def resolve_cursor_tool(db: Session) -> Optional[ITPortalTool]:
    return (
        db.query(ITPortalTool)
        .filter(ITPortalTool.slug.in_(TOOL_SLUGS))
        .filter(ITPortalTool.is_active == True)  # noqa: E712
        .first()
    )


def _ms_to_utc(value: Optional[int]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).replace(tzinfo=None)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso(value: datetime) -> str:
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_setup_code(code: str) -> str:
    # "cur-7k3p 92qx", "CUR7K3P92QX" and "7K3P-92QX" are all the same code.
    raw = re.sub(r"[^0-9A-Z]", "", (code or "").upper())
    return raw.removeprefix(SETUP_CODE_PREFIX)


def _active_user(db: Session, user_id: int) -> Optional[User]:
    # Deleted, or deactivated (can't sign in to the dashboard either) - their
    # computers stop being accepted too.
    user = db.query(User).filter(User.id == int(user_id)).first()
    return user if user and not user.is_deleted and user.is_active is not False else None


TRACKER_RECONNECT_HINT = "Ask an admin for a setup code, then run Cursor Tracker: Connect to dashboard."


def _resolve_tracker_device(db: Session, authorization: Optional[str], device_id: Optional[str]) -> tuple[CursorDevice, User]:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail=f"This computer is not connected to the dashboard. {TRACKER_RECONNECT_HINT}")
    device = (
        db.query(CursorDevice)
        .filter(CursorDevice.token_hash == _sha256(token), CursorDevice.revoked_at.is_(None))
        .first()
    )
    if device is None:
        raise HTTPException(
            status_code=401,
            detail=f"This computer is no longer connected to the dashboard (or an admin disconnected it). {TRACKER_RECONNECT_HINT}",
        )
    if (device_id or "").strip() != device.device_id:
        raise HTTPException(status_code=401, detail=f"This tracker token belongs to a different computer. {TRACKER_RECONNECT_HINT}")
    user = _active_user(db, device.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="The dashboard user this computer is connected for no longer exists")
    return device, user


@router.get("/people", response_model=ListOut)
def list_people(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    users = (
        db.query(User)
        .filter(User.is_deleted == False, User.is_active == True)  # noqa: E712
        .order_by(User.name.asc())
        .all()
    )
    return ListOut(data=[
        {"id": u.id, "name": u.name, "email": u.email, "department": u.department}
        for u in users
    ])


@router.post("/setup-codes", response_model=SetupCodeOut)
def create_setup_code(
    payload: SetupCodeIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    user = _active_user(db, payload.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="That person doesn't exist")
    body = "".join(secrets.choice(SETUP_CODE_ALPHABET) for _ in range(SETUP_CODE_LENGTH))
    code = f"{SETUP_CODE_PREFIX}-{body[:4]}-{body[4:]}"
    expires_at = datetime.utcnow() + timedelta(seconds=SETUP_CODE_TTL_SEC)
    db.add(CursorSetupCode(
        code_hash=_sha256(body),
        user_id=user.id,
        created_by_user_id=current_user.id,
        expires_at=expires_at,
    ))
    db.commit()
    return SetupCodeOut(code=code, expiresAt=_iso(expires_at), user={"id": user.id, "name": user.name})


@router.post("/connect", response_model=ConnectOut)
def connect_device(
    payload: ConnectIn,
    db: Session = Depends(get_operational_db),
):
    """Called by the Cursor extension, not the dashboard - the setup code is
    its only credential."""
    device_id = (payload.device.id or "").strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="This Cursor didn't report a device id - update the Cursor Usage Tracker extension.")
    now = datetime.utcnow()
    code_hash = _sha256(_normalize_setup_code(payload.code))
    # Claimed with a conditional UPDATE so two computers racing on one code
    # can't both get through.
    claimed = (
        db.query(CursorSetupCode)
        .filter(
            CursorSetupCode.code_hash == code_hash,
            CursorSetupCode.used_at.is_(None),
            CursorSetupCode.expires_at > now,
        )
        .update({CursorSetupCode.used_at: now}, synchronize_session=False)
    )
    if not claimed:
        db.rollback()
        raise HTTPException(status_code=400, detail="That setup code is wrong, already used or expired - ask an admin for a new one.")
    code = db.query(CursorSetupCode).filter(CursorSetupCode.code_hash == code_hash).one()
    user = _active_user(db, code.user_id)
    if user is None:
        db.rollback()
        raise HTTPException(status_code=400, detail="The person this setup code was made for no longer exists.")

    # A computer reports as exactly one person: connecting it again replaces
    # whoever it was connected for before. If that was someone else, the
    # extension must not re-send the history it already sent as them.
    previous = (
        db.query(CursorDevice)
        .filter(CursorDevice.device_id == device_id)
        .order_by(CursorDevice.created_at.desc(), CursorDevice.id.desc())
        .first()
    )
    send_from_ms = int(now.replace(tzinfo=timezone.utc).timestamp() * 1000) if previous and previous.user_id != user.id else None
    db.query(CursorDevice).filter(
        CursorDevice.device_id == device_id, CursorDevice.revoked_at.is_(None)
    ).update(
        {CursorDevice.revoked_at: now, CursorDevice.revoked_by_user_id: code.created_by_user_id},
        synchronize_session=False,
    )

    token = "cut_" + secrets.token_urlsafe(32)
    device = CursorDevice(
        user_id=user.id,
        device_id=device_id,
        device_name=payload.device.name,
        device_os=payload.device.os,
        token_hash=_sha256(token),
        created_by_user_id=code.created_by_user_id,
        extension_version=payload.extension_version,
    )
    db.add(device)
    db.flush()
    code.used_by_device_row_id = device.id
    db.commit()
    logger.info("cursor device %s connected for user %s", device.id, user.id)
    return ConnectOut(token=token, user={"id": user.id, "name": user.name}, sendFromMs=send_from_ms)


@router.get("/devices", response_model=ListOut)
def list_devices(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    rows = (
        db.query(CursorDevice, User.name)
        .join(User, User.id == CursorDevice.user_id)
        .order_by(CursorDevice.revoked_at.isnot(None), CursorDevice.created_at.desc())
        .limit(300)
        .all()
    )
    return ListOut(data=[{**device.to_dict(), "userName": name} for device, name in rows])


@router.post("/devices/{device_row_id}/disconnect", response_model=ListOut)
def disconnect_device(
    device_row_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    device = db.query(CursorDevice).filter(CursorDevice.id == device_row_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.revoked_at is None:
        device.revoked_at = datetime.utcnow()
        device.revoked_by_user_id = current_user.id
        db.commit()
    return ListOut(data=[device.to_dict()])


@router.post("/capture/prompts", response_model=CapturePromptsResponse)
def capture_prompts(
    payload: CapturePromptsRequest,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_operational_db),
):
    device, user = _resolve_tracker_device(db, authorization, payload.device.id)
    tool = resolve_cursor_tool(db)
    account_email = (payload.account.email or "").strip().lower()
    device.last_seen_at = datetime.utcnow()
    device.last_account_email = account_email or device.last_account_email
    device.device_name = payload.device.name or device.device_name
    device.extension_version = payload.extension_version

    uids = [item.id for item in payload.prompts]
    existing = {
        row.prompt_uid: row
        for row in db.query(CursorPrompt)
        .filter(CursorPrompt.owner_user_id == user.id, CursorPrompt.prompt_uid.in_(uids))
        .all()
    } if uids else {}

    created = updated = skipped = 0
    for item in payload.prompts:
        prompted_at = _ms_to_utc(item.ts)
        if prompted_at is None:
            skipped += 1
            continue
        text = item.text or ""
        values = {
            "tool_id": tool.id if tool else None,
            "cursor_account_email": account_email,
            "cursor_plan": payload.account.plan,
            "device_id": payload.device.id,
            "device_name": payload.device.name,
            "device_os": payload.device.os,
            "extension_version": payload.extension_version,
            "conversation_id": item.conversationId,
            "conversation_name": item.conversationName,
            "prompt_text": text[:MAX_PROMPT_TEXT_CHARS],
            "text_truncated": item.textTruncated or len(text) > MAX_PROMPT_TEXT_CHARS,
            "mode": item.mode,
            "models_json": [m for m in item.models if m][:10],
            "steps": max(0, item.responses),
            "local_input_tokens": max(0, item.inputTokens),
            "local_output_tokens": max(0, item.outputTokens),
            "prompted_at": prompted_at,
            "completed_at": _ms_to_utc(item.endTs),
        }
        row = existing.get(item.id)
        if row is None:
            row = CursorPrompt(owner_user_id=user.id, prompt_uid=item.id, **values)
            db.add(row)
            existing[item.id] = row
            created += 1
        else:
            for key, value in values.items():
                setattr(row, key, value)
            updated += 1

    try:
        db.commit()
    except IntegrityError:
        # Two syncs from the same person racing on a brand-new prompt - the
        # other one already inserted it; the next sync updates it.
        db.rollback()
        logger.warning("cursor capture_prompts race for user %s; batch dropped, next sync retries", user.id)
        raise HTTPException(status_code=409, detail="Concurrent sync - will retry")

    return CapturePromptsResponse(
        created=created,
        updated=updated,
        skipped=skipped,
        user={"id": user.id, "name": user.name},
    )


@router.post("/usage/upload", response_model=UsageUploadOut)
async def upload_usage_csv(
    request: Request,
    account_email: Optional[str] = Query(default=None, max_length=255),
    file_name: Optional[str] = Query(default=None, max_length=255),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    raw = await request.body()
    if len(raw) > MAX_CSV_BYTES:
        raise HTTPException(status_code=413, detail="That file is too large for a Cursor usage export.")
    try:
        parsed = parse_usage_csv(raw.decode("utf-8-sig", errors="replace"))
    except UsageCsvError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not parsed.rows:
        detail = "No usage rows could be read"
        if parsed.skipped:
            detail += f' (unreadable dates such as "{parsed.skipped[0]}")'
        raise HTTPException(status_code=400, detail=detail + ".")

    account = (account_email or "").strip().lower()
    tool = resolve_cursor_tool(db)
    range_start = min(r.occurred_at for r in parsed.rows)
    range_end = max(r.occurred_at for r in parsed.rows)

    upload = CursorUsageUpload(
        uploaded_by_user_id=current_user.id,
        cursor_account_email=account,
        file_name=file_name,
        row_count=len(parsed.rows),
        skipped_count=parsed.skipped_count,
        range_start=range_start,
        range_end=range_end,
        columns_json=parsed.columns,
    )
    db.add(upload)
    db.flush()

    by_uid = {row.event_uid: row for row in parsed.rows}
    existing_uids = {
        uid for (uid,) in db.query(CursorUsageEvent.event_uid)
        .filter(CursorUsageEvent.cursor_account_email == account, CursorUsageEvent.event_uid.in_(list(by_uid)))
        .all()
    }
    added = 0
    for uid, row in by_uid.items():
        if uid in existing_uids:
            continue
        db.add(CursorUsageEvent(
            tool_id=tool.id if tool else None,
            cursor_account_email=account,
            event_uid=uid,
            source_upload_id=upload.id,
            occurred_at=row.occurred_at,
            model=row.model[:120],
            kind=(row.kind or "")[:60] or None,
            max_mode=row.max_mode,
            input_tokens=row.input_tokens,
            output_tokens=row.output_tokens,
            cache_read_tokens=row.cache_read_tokens,
            cache_write_tokens=row.cache_write_tokens,
            cost_cents=row.cost_cents,
            cloud_agent_id=row.cloud_agent_id,
            automation_id=row.automation_id,
        ))
        added += 1
    upload.added_count = added
    db.commit()

    matched, unassigned = cursor_queries.count_unmatched_in_range(db, range_start, range_end, account)
    data = upload.to_dict()
    data.update({"matchedCount": matched, "unassignedCount": unassigned})
    return UsageUploadOut(data=data)


@router.get("/prompts", response_model=PromptListOut)
def list_prompts(
    q: Optional[str] = None,
    owner_user_id: Optional[int] = None,
    account_email: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=cursor_queries.DEFAULT_LIMIT, ge=1, le=cursor_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = PromptFilters(
        q=(q or "").strip() or None,
        owner_user_id=owner_user_id,
        account_email=(account_email or "").strip().lower() or None,
        date_from=date_from,
        date_to=date_to,
    )
    items, total = cursor_queries.list_prompts(db, filters=filters, limit=limit, offset=offset)
    return PromptListOut(data=items, pagination=PaginationOut(limit=limit, offset=offset, total=total))


@router.get("/prompts/{prompt_id}", response_model=PromptDetailOut)
def get_prompt(
    prompt_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    item = cursor_queries.get_prompt(db, prompt_id)
    if not item:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return PromptDetailOut(data=item)


@router.get("/view", response_model=SummaryOut)
def get_view(
    from_ms: int = Query(..., ge=1),
    to_ms: int = Query(..., ge=1),
    account_email: Optional[str] = None,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """The Cursor tab's usage page for [from_ms, to_ms) - exact instants rather
    than dates so "Today" means the viewer's own local day."""
    if to_ms <= from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be after from_ms")
    if to_ms - from_ms > 400 * 24 * 60 * 60 * 1000:
        raise HTTPException(status_code=400, detail="Pick a period of at most about a year")
    data = cursor_queries.build_view(
        db,
        start=_ms_to_utc(from_ms),
        end=_ms_to_utc(to_ms),
        account_email=(account_email or "").strip().lower() or None,
    )
    return SummaryOut(data=data)


@router.get("/summary", response_model=SummaryOut)
def get_summary(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    account_email: Optional[str] = None,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    data = cursor_queries.summarize_period(
        db,
        date_from=date_from,
        date_to=date_to,
        account_email=(account_email or "").strip().lower() or None,
    )
    return SummaryOut(data=data)


@router.get("/accounts", response_model=ListOut)
def list_accounts(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return ListOut(data=cursor_queries.list_accounts(db))


@router.get("/uploads", response_model=ListOut)
def list_uploads(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return ListOut(data=cursor_queries.list_uploads(db))
