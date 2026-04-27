import email
import imaplib
import logging
import re
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from email.message import Message
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Optional


logger = logging.getLogger(__name__)

_GMAIL_IMAP_HOST = "imap.gmail.com"
_GMAIL_IMAP_PORT = 993


def _decode_mime_header(value: str) -> str:
    parts = decode_header(value or "")
    decoded: list[str] = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            decoded.append(chunk.decode(charset or "utf-8", errors="ignore"))
        else:
            decoded.append(chunk)
    return "".join(decoded)


class _HtmlStripper(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self._parts.append(data)

    def get_text(self) -> str:
        return " ".join(self._parts)


def _html_to_text(value: str) -> str:
    stripper = _HtmlStripper()
    try:
        stripper.feed(value)
        stripper.close()
        return stripper.get_text()
    except Exception:
        return re.sub(r"<[^>]+>", " ", value or "")


def _extract_body(message: Message) -> str:
    plain_parts: list[str] = []
    html_parts: list[str] = []

    if message.is_multipart():
        for part in message.walk():
            content_type = part.get_content_type()
            disposition = str(part.get("Content-Disposition", ""))
            if "attachment" in disposition.lower():
                continue

            payload = part.get_payload(decode=True)
            if payload is None:
                continue

            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="ignore")
            if content_type == "text/plain":
                plain_parts.append(text)
            elif content_type == "text/html":
                html_parts.append(_html_to_text(text))
    else:
        payload = message.get_payload(decode=True)
        if payload:
            charset = message.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="ignore")
            if message.get_content_type() == "text/html":
                html_parts.append(_html_to_text(text))
            else:
                plain_parts.append(text)

    return "\n".join(plain_parts) if plain_parts else "\n".join(html_parts)


def _build_search_criteria(
    *,
    sender_filter: Optional[str],
    subject_pattern: Optional[str],
    since_dt: datetime,
) -> str:
    since_str = since_dt.strftime("%d-%b-%Y")
    criteria = [f'SINCE "{since_str}"']
    if sender_filter:
        criteria.append(f'FROM "{sender_filter}"')
    if subject_pattern:
        criteria.append(f'SUBJECT "{subject_pattern}"')
    return "(" + " ".join(criteria) + ")"


def _message_datetime(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except Exception:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_otp_from_gmail(
    email_address: str,
    app_password: str,
    otp_regex: str,
    otp_sender_filter: Optional[str] = None,
    otp_subject_pattern: Optional[str] = None,
    max_age_seconds: int = 120,
) -> Optional[str]:
    cutoff_dt = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
    since_dt = cutoff_dt - timedelta(days=1)
    pattern = otp_regex or r"\b(\d{4,8})\b"

    mail = None
    try:
        mail = imaplib.IMAP4_SSL(_GMAIL_IMAP_HOST, _GMAIL_IMAP_PORT)
        mail.login(email_address, app_password)
        mail.select("INBOX")

        criteria = _build_search_criteria(
            sender_filter=otp_sender_filter,
            subject_pattern=otp_subject_pattern,
            since_dt=since_dt,
        )
        logger.debug("[OTP IMAP] search=%s", criteria)

        status, data = mail.search(None, criteria)
        if status != "OK" or not data or not data[0]:
            logger.info("[OTP IMAP] No matching emails found for %s", email_address)
            return None

        message_ids = data[0].split()
        for msg_id in reversed(message_ids):
            fetch_status, raw = mail.fetch(msg_id, "(RFC822)")
            if fetch_status != "OK" or not raw or not raw[0]:
                continue

            message = email.message_from_bytes(raw[0][1])
            message_dt = _message_datetime(message.get("Date", ""))
            if message_dt and message_dt < cutoff_dt:
                continue

            subject = _decode_mime_header(message.get("Subject", ""))
            body = _extract_body(message)
            searchable_text = "\n".join(part for part in [subject, body] if part)
            logger.debug("[OTP IMAP] checking subject=%r", subject[:60])

            match = re.search(pattern, searchable_text)
            if match:
                otp = match.group(1)
                logger.info("[OTP IMAP] OTP extracted for %s", email_address)
                return otp

        logger.info("[OTP IMAP] Emails found but no OTP matched for %s", email_address)
        return None
    except imaplib.IMAP4.error:
        logger.exception("[OTP IMAP] IMAP authentication/protocol error for %s", email_address)
        raise
    except Exception:
        logger.exception("[OTP IMAP] Unexpected error while reading mailbox for %s", email_address)
        raise
    finally:
        if mail is not None:
            try:
                mail.logout()
            except Exception:
                pass
