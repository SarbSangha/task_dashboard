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
from urllib.parse import urlparse


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


class _HtmlLinkExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._links: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if (tag or "").lower() != "a":
            return
        for attr_name, attr_value in attrs or []:
            if (attr_name or "").lower() == "href" and attr_value:
                self._links.append(attr_value)

    def get_links(self) -> list[str]:
        return self._links


def _html_to_text(value: str) -> str:
    stripper = _HtmlStripper()
    try:
        stripper.feed(value)
        stripper.close()
        return stripper.get_text()
    except Exception:
        return re.sub(r"<[^>]+>", " ", value or "")


def _extract_links_from_html(value: str) -> list[str]:
    extractor = _HtmlLinkExtractor()
    try:
        extractor.feed(value or "")
        extractor.close()
        return extractor.get_links()
    except Exception:
        return []


def _extract_links_from_text(value: str) -> list[str]:
    return re.findall(r"https?://[^\s<>'\"\)\]]+", value or "", flags=re.IGNORECASE)


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


def _extract_links(message: Message) -> list[str]:
    links: list[str] = []

    def add_link_candidates(candidates: list[str]) -> None:
        for candidate in candidates:
            normalized = (candidate or "").strip()
            if not normalized or normalized in links:
                continue
            links.append(normalized)

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
            if content_type == "text/html":
                add_link_candidates(_extract_links_from_html(text))
                add_link_candidates(_extract_links_from_text(_html_to_text(text)))
            elif content_type == "text/plain":
                add_link_candidates(_extract_links_from_text(text))
    else:
        payload = message.get_payload(decode=True)
        if payload:
            charset = message.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="ignore")
            if message.get_content_type() == "text/html":
                add_link_candidates(_extract_links_from_html(text))
                add_link_candidates(_extract_links_from_text(_html_to_text(text)))
            else:
                add_link_candidates(_extract_links_from_text(text))

    return links


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


def _normalize_host(value: str) -> str:
    raw = (value or "").strip().lower()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
        hostname = (parsed.hostname or "").strip().lower()
    except Exception:
        hostname = raw.split("/")[0]
    return hostname[4:] if hostname.startswith("www.") else hostname


def _link_host_matches(candidate_url: str, allowed_host: Optional[str]) -> bool:
    normalized_allowed_host = _normalize_host(allowed_host or "")
    if not normalized_allowed_host:
        return True
    try:
        candidate_host = _normalize_host(urlparse(candidate_url).hostname or "")
    except Exception:
        return False
    return bool(
        candidate_host
        and (
            candidate_host == normalized_allowed_host
            or candidate_host.endswith(f".{normalized_allowed_host}")
        )
    )


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


def fetch_auth_link_from_gmail(
    email_address: str,
    app_password: str,
    auth_link_pattern: Optional[str] = None,
    auth_link_host: Optional[str] = None,
    otp_sender_filter: Optional[str] = None,
    otp_subject_pattern: Optional[str] = None,
    max_age_seconds: int = 300,
) -> Optional[str]:
    cutoff_dt = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
    since_dt = cutoff_dt - timedelta(days=1)
    compiled_pattern = re.compile(auth_link_pattern, re.IGNORECASE) if (auth_link_pattern or "").strip() else None

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
        logger.debug("[AUTH LINK IMAP] search=%s", criteria)

        status, data = mail.search(None, criteria)
        if status != "OK" or not data or not data[0]:
            logger.info("[AUTH LINK IMAP] No matching emails found for %s", email_address)
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

            links = _extract_links(message)
            logger.debug("[AUTH LINK IMAP] found %s link candidates for %s", len(links), email_address)

            for link in links:
                if not _link_host_matches(link, auth_link_host):
                    continue
                if compiled_pattern:
                    match = compiled_pattern.search(link)
                    if not match:
                        continue
                    if match.groups():
                        candidate = (match.group(1) or "").strip()
                        if candidate.startswith("http://") or candidate.startswith("https://"):
                            logger.info("[AUTH LINK IMAP] Auth link extracted for %s", email_address)
                            return candidate
                    logger.info("[AUTH LINK IMAP] Auth link extracted for %s", email_address)
                    return link
                logger.info("[AUTH LINK IMAP] Auth link extracted for %s", email_address)
                return link

        logger.info("[AUTH LINK IMAP] Emails found but no auth link matched for %s", email_address)
        return None
    except imaplib.IMAP4.error:
        logger.exception("[AUTH LINK IMAP] IMAP authentication/protocol error for %s", email_address)
        raise
    except Exception:
        logger.exception("[AUTH LINK IMAP] Unexpected error while reading mailbox for %s", email_address)
        raise
    finally:
        if mail is not None:
            try:
                mail.logout()
            except Exception:
                pass
