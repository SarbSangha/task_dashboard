"""
ChatGPT Account Usage workbook: for each ChatGPT login (tool credential), who
used it in a period and how much.

ChatGPT logins are shared, so "which account" and "which person" are separate
questions. A conversation knows its account through the capture events it was
uploaded with (``ConversationCaptureEvent.credential_id``) and its person
through ``ConversationRecord.owner_user_id`` - the same pairing the reports'
Account and User filters use (reports_router._scope_chats).

Dates follow the AI workbook: prompts are stored in UTC and bucketed by the IST
calendar day, so "16 Oct" means 16 Oct in India.

Sheets: Summary (per account -> per person), Daily (date x account x person)
and Chats (one row per prompt, with the answer and a link to the chat).
"""

from __future__ import annotations

import io
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import ITPortalToolCredential, User
from providers.chatgpt.models import ConversationCaptureEvent, ConversationPrompt, ConversationRecord, ConversationResponse
from utils.credential_crypto import decrypt_secret
from utils.xlsx_compat import excel_safe

from . import components as C
from . import theme as T
from .dataset import LOCAL_TZ_OFFSET
from .workbook import XLSX_MIMETYPE

PROVIDER = "chatgpt"
UNKNOWN_ACCOUNT = "Unknown account"
ROW_CAP = 50000           # Chats sheet; Summary/Daily always cover everything
RESPONSE_CLIP = 5000      # answers can be very long; the link opens the full chat
CELL_CLIP = 32000         # Excel's per-cell limit is 32,767 characters
CHUNK = 1000              # IN (...) batch size


@dataclass
class ChatRow:
    at: datetime              # IST
    account: str
    user_id: Optional[int]
    user_name: str
    department: str
    conversation_key: str
    title: str
    model: str
    url: str
    prompt: str
    response: str
    status: str
    approx_tokens: int


@dataclass
class PersonUsage:
    account: str
    user_name: str
    department: str
    conversations: set = field(default_factory=set)
    prompts: int = 0
    answered: int = 0
    approx_tokens: int = 0
    first: Optional[datetime] = None
    last: Optional[datetime] = None


@dataclass
class AccountUsageData:
    start: date
    end: date
    account_filter_label: str
    rows: list[ChatRow]
    people: list[PersonUsage]
    daily: list[dict]
    truncated: bool


def _approx_tokens(*lengths: Optional[int]) -> int:
    # ~4 characters per token for English text; ChatGPT doesn't expose billed usage.
    return int(round(sum(int(n or 0) for n in lengths) / 4))


def _clean(text_value: Optional[str], limit: int) -> str:
    """Text Excel can store: control characters (pasted from PDFs and the
    like) make openpyxl refuse the whole workbook."""
    return ILLEGAL_CHARACTERS_RE.sub("", text_value or "")[:limit]


def _chunks(values, size=CHUNK):
    values = list(values)
    for i in range(0, len(values), size):
        yield values[i:i + size]


def _account_labels(db: Session, credential_ids) -> dict[int, str]:
    labels = {}
    for cid, login in (
        db.query(ITPortalToolCredential.id, ITPortalToolCredential.login_identifier_encrypted)
        .filter(ITPortalToolCredential.id.in_(list(credential_ids) or [0]))
        .all()
    ):
        try:
            text_value = (decrypt_secret(login) or "").strip()
        except Exception:
            text_value = ""
        labels[cid] = text_value or f"Account #{cid}"
    return labels


def _conversation_accounts(db: Session, conversation_keys) -> dict[str, int]:
    """provider_conversation_id -> the credential most of its captures came from."""
    counts: dict[str, Counter] = defaultdict(Counter)
    for keys in _chunks(conversation_keys):
        for key, cid, n in (
            db.query(ConversationCaptureEvent.provider_conversation_id, ConversationCaptureEvent.credential_id, func.count())
            .filter(
                ConversationCaptureEvent.provider == PROVIDER,
                ConversationCaptureEvent.provider_conversation_id.in_(keys),
                ConversationCaptureEvent.credential_id.isnot(None),
            )
            .group_by(ConversationCaptureEvent.provider_conversation_id, ConversationCaptureEvent.credential_id)
            .all()
        ):
            counts[key][cid] += int(n or 0)
    return {key: c.most_common(1)[0][0] for key, c in counts.items() if c}


def _latest_responses(db: Session, prompt_ids) -> dict[int, tuple]:
    """prompt_id -> (text, length, status) of its latest response."""
    out: dict[int, tuple] = {}
    for ids in _chunks(prompt_ids):
        for pid, text_value, length, status, _rid in (
            db.query(
                ConversationResponse.prompt_id, ConversationResponse.response_text,
                ConversationResponse.response_length, ConversationResponse.response_status, ConversationResponse.id,
            )
            .filter(ConversationResponse.prompt_id.in_(ids))
            .order_by(ConversationResponse.id.asc())
            .all()
        ):
            out[pid] = (text_value, length, status)
    return out


def build_account_usage(
    db: Session,
    *,
    start: date,
    end: date,
    account_id: Optional[int] = None,
    department: Optional[str] = None,
    user_id: Optional[int] = None,
) -> AccountUsageData:
    if start > end:
        start, end = end, start
    # IST calendar days -> the UTC window they cover.
    s = datetime(start.year, start.month, start.day) - LOCAL_TZ_OFFSET
    e = datetime(end.year, end.month, end.day) + timedelta(days=1) - LOCAL_TZ_OFFSET
    at = func.coalesce(ConversationPrompt.prompt_timestamp, ConversationPrompt.created_at)

    q = (
        db.query(
            ConversationPrompt.id, at, ConversationPrompt.prompt_text, ConversationPrompt.prompt_length,
            ConversationRecord.provider_conversation_id, ConversationRecord.title, ConversationRecord.model_label,
            ConversationRecord.conversation_url, ConversationRecord.owner_user_id,
        )
        .join(ConversationRecord, ConversationRecord.id == ConversationPrompt.conversation_id)
        .filter(
            ConversationRecord.provider == PROVIDER,
            ConversationRecord.archived_at.is_(None),
            at >= s,
            at < e,
            ConversationPrompt.prompt_text.isnot(None),
            ConversationPrompt.prompt_text != "",
        )
    )
    if user_id:
        q = q.filter(ConversationRecord.owner_user_id == user_id)
    if department and department != "all":
        q = q.join(User, User.id == ConversationRecord.owner_user_id).filter(User.department == department)
    prompts = q.order_by(at.asc()).all()

    account_of = _conversation_accounts(db, {p[4] for p in prompts if p[4]})
    if account_id:
        prompts = [p for p in prompts if account_of.get(p[4]) == account_id]
    labels = _account_labels(db, set(account_of.values()) | ({account_id} if account_id else set()))
    users = {
        uid: (name or f"User #{uid}", dept or "Unassigned")
        for uid, name, dept in db.query(User.id, User.name, User.department)
        .filter(User.id.in_({p[8] for p in prompts if p[8]} or {0}))
        .all()
    }
    responses = _latest_responses(db, [p[0] for p in prompts])

    rows: list[ChatRow] = []
    people: dict[tuple, PersonUsage] = {}
    daily: dict[tuple, dict] = {}
    for pid, when, text_value, length, conv_key, title, model, url, owner in prompts:
        when_ist = (when + LOCAL_TZ_OFFSET) if when else None
        cid = account_of.get(conv_key)
        account = labels.get(cid, UNKNOWN_ACCOUNT) if cid else UNKNOWN_ACCOUNT
        name, dept = users.get(owner, ("Unassigned", "—")) if owner else ("Unassigned", "—")
        r_text, r_len, r_status = responses.get(pid, (None, None, None))
        answered = (r_status or "").lower() == "completed" and int(r_len or 0) > 0
        tokens = _approx_tokens(length or len(text_value or ""), r_len)
        rows.append(ChatRow(
            at=when_ist, account=account, user_id=owner, user_name=name, department=dept,
            conversation_key=conv_key or "", title=_clean(title, 500) or "Untitled chat", model=model or "—",
            url=url or (f"https://chatgpt.com/c/{conv_key}" if conv_key else ""),
            prompt=_clean(text_value, CELL_CLIP), response=_clean(r_text, RESPONSE_CLIP),
            status="Answered" if answered else ((r_status or "No answer captured").title()),
            approx_tokens=tokens,
        ))

        person = people.setdefault((account, owner), PersonUsage(account=account, user_name=name, department=dept))
        person.conversations.add(conv_key)
        person.prompts += 1
        person.answered += 1 if answered else 0
        person.approx_tokens += tokens
        if when_ist:
            person.first = min(person.first or when_ist, when_ist)
            person.last = max(person.last or when_ist, when_ist)

        day = when_ist.date() if when_ist else None
        d = daily.setdefault((day, account, owner), {
            "date": day, "account": account, "user_name": name, "department": dept,
            "conversations": set(), "prompts": 0, "approx_tokens": 0,
        })
        d["conversations"].add(conv_key)
        d["prompts"] += 1
        d["approx_tokens"] += tokens

    daily_rows = sorted(daily.values(), key=lambda d: (d["date"] or date.min, d["account"], -d["prompts"]))
    for d in daily_rows:
        d["conversations"] = len(d["conversations"])

    return AccountUsageData(
        start=start, end=end,
        account_filter_label=labels.get(account_id, f"Account #{account_id}") if account_id else "All ChatGPT accounts",
        rows=rows[:ROW_CAP],
        people=sorted(people.values(), key=lambda p: (p.account, -p.prompts)),
        daily=daily_rows,
        truncated=len(rows) > ROW_CAP,
    )


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
FMT_DATETIME = "DD-Mmm-YYYY HH:MM"
FMT_TIME = "HH:MM"


def _period_label(data: AccountUsageData) -> str:
    fmt = "%d %b %Y"
    if data.start == data.end:
        return data.start.strftime(fmt)
    return f"{data.start.strftime(fmt)} – {data.end.strftime(fmt)}"


def _render_summary(ws, data: AccountUsageData) -> None:
    C.hide_gridlines(ws)
    last_col = 8
    row = C.title_band(
        ws, "ChatGPT Account Usage",
        f"{_period_label(data)} (IST) · {data.account_filter_label} · who used each ChatGPT login, and how much",
        last_col=last_col,
    )
    accounts = sorted({p.account for p in data.people})
    row = C.kpi_cards(ws, [
        C.Kpi("Accounts used", len(accounts), T.FMT_INT),
        C.Kpi("People", len({(p.user_name, p.department) for p in data.people}), T.FMT_INT),
        C.Kpi("Conversations", len({r.conversation_key for r in data.rows}), T.FMT_INT),
        C.Kpi("Prompts", sum(p.prompts for p in data.people), T.FMT_INT),
    ], row=row, span=2)

    if not data.people:
        C.callout(ws, "No ChatGPT usage was captured for this account and period.", row=row, last_col=last_col)
        return

    cols = [
        C.Col("Person", 24, "left", key="user_name"),
        C.Col("Department", 20, "left", key="department"),
        C.Col("Conversations", 14, "right", fmt=T.FMT_INT, get=lambda p: len(p.conversations)),
        C.Col("Prompts", 12, "right", fmt=T.FMT_INT, key="prompts"),
        C.Col("Answered", 12, "right", fmt=T.FMT_INT, key="answered"),
        C.Col("Approx. tokens", 15, "right", fmt=T.FMT_INT, key="approx_tokens"),
        C.Col("First prompt (IST)", 19, "center", fmt=FMT_DATETIME, key="first"),
        C.Col("Last prompt (IST)", 19, "center", fmt=FMT_DATETIME, key="last"),
    ]
    for account in accounts:
        members = [p for p in data.people if p.account == account]
        row = C.section_header(
            ws,
            f"{account} — {len(members)} {'person' if len(members) == 1 else 'people'} · "
            f"{sum(p.prompts for p in members):,} prompts",
            row=row, last_col=last_col,
        )
        row = C.data_table(ws, cols, members, start_row=row, autofilter=False)
    row = C.callout(
        ws,
        "Approx. tokens = (prompt + answer characters) ÷ 4. ChatGPT does not report billed usage to the capture layer.",
        row=row, last_col=last_col,
    )
    C.freeze_below(ws, 4)


def _render_daily(ws, data: AccountUsageData) -> None:
    C.hide_gridlines(ws)
    row = C.title_band(ws, "Daily usage by person", f"{_period_label(data)} (IST) · {data.account_filter_label}", last_col=7)
    cols = [
        C.Col("Date", 14, "center", fmt=T.FMT_DATE, key="date"),
        C.Col("ChatGPT account", 32, "left", key="account"),
        C.Col("Person", 24, "left", key="user_name"),
        C.Col("Department", 20, "left", key="department"),
        C.Col("Conversations", 14, "right", fmt=T.FMT_INT, key="conversations"),
        C.Col("Prompts", 12, "right", fmt=T.FMT_INT, key="prompts"),
        C.Col("Approx. tokens", 15, "right", fmt=T.FMT_INT, key="approx_tokens"),
    ]
    C.data_table(ws, cols, data.daily, start_row=row, table_name="ChatGPTDaily")
    C.freeze_below(ws, row + 1, col=2)


def _render_chats(ws, data: AccountUsageData) -> None:
    C.hide_gridlines(ws)
    subtitle = f"{_period_label(data)} (IST) · one row per prompt · the link opens the full chat"
    if data.truncated:
        subtitle += f" · first {ROW_CAP:,} prompts only - narrow the dates for the rest"
    row = C.title_band(ws, "ChatGPT chats", subtitle, last_col=11)
    cols = [
        C.Col("Date & time (IST)", 18, "center", fmt=FMT_DATETIME, key="at"),
        C.Col("ChatGPT account", 30, "left", key="account"),
        C.Col("Person", 22, "left", key="user_name"),
        C.Col("Department", 18, "left", key="department"),
        C.Col("Chat title", 28, "left", key="title"),
        C.Col("Prompt", 60, "left", key="prompt"),
        C.Col(f"Answer (first {RESPONSE_CLIP:,} chars)", 60, "left", key="response"),
        C.Col("Model", 14, "center", key="model"),
        C.Col("Status", 14, "center", key="status"),
        C.Col("Approx. tokens", 13, "right", fmt=T.FMT_INT, key="approx_tokens"),
        C.Col("Open chat", 12, "center", get=lambda r: "Open" if r.url else "—"),
    ]
    C.data_table(ws, cols, data.rows, start_row=row, table_name="ChatGPTChats")
    # Real hyperlinks on the "Open chat" column.
    link_col = len(cols)
    for i, chat in enumerate(data.rows):
        if chat.url:
            cell = ws.cell(row=row + 1 + i, column=link_col)
            cell.hyperlink = chat.url
            cell.font = T.FONT_LINK
    for i in range(len(data.rows)):
        ws.row_dimensions[row + 1 + i].height = 45
    C.freeze_below(ws, row + 1, col=2)


def render_account_usage(data: AccountUsageData) -> tuple[bytes, str, str]:
    wb = Workbook()
    _render_summary(wb.active, data)
    wb.active.title = "Summary"
    _render_daily(wb.create_sheet("Daily"), data)
    _render_chats(wb.create_sheet("Chats"), data)
    out = io.BytesIO()
    wb.save(out)
    account_part = "".join(ch if ch.isalnum() else "-" for ch in data.account_filter_label.split("@")[0]).strip("-") or "all"
    span = data.start.isoformat() if data.start == data.end else f"{data.start.isoformat()}_to_{data.end.isoformat()}"
    return excel_safe(out.getvalue()), XLSX_MIMETYPE, f"ChatGPT-Account-Usage_{account_part}_{span}.xlsx"
