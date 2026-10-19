"""Play and download a generation's output from inside the dashboard.

resolve_output_url gives the output's URL (a provider URL or a freshly
signed R2 link). The browser can play that directly, but it cannot save a
cross-origin file under a name of our choosing, so downloads stream through
the backend (stream_output) with Content-Disposition: attachment.

The URLs come from captured provider data, so the proxy only fetches public
http(s) hosts - never loopback, private or link-local addresses - and checks
every redirect hop the same way.
"""

from __future__ import annotations

import ipaddress
import mimetypes
import os
import re
import socket
from typing import Iterator, Optional
from urllib.parse import urljoin, urlparse

import httpx

VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".mkv"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac", ".opus"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg"}
PDF_EXT = {".pdf"}

# What a tool produces when the URL itself does not say (no file extension).
TOOL_KIND = {
    "Kling": "video",
    "HeyGen": "video",
    "Flow": "video",
    "Higgsfield": "video",
    "Suno": "audio",
    "ElevenLabs": "audio",
    "Epidemic Sound": "audio",
    "Splice": "audio",
    "Freepik": "image",
    "Grammarly": "page",
    "ChatGPT": "chat",
    "Claude": "chat",
}

MAX_REDIRECTS = 5
CHUNK = 256 * 1024


def _ext(url: str) -> str:
    return os.path.splitext(urlparse(url).path)[1].lower()


def kind_from_type(content_type: Optional[str]) -> Optional[str]:
    ct = (content_type or "").split(";")[0].strip().lower()
    for prefix in ("video", "audio", "image"):
        if ct.startswith(prefix + "/"):
            return prefix
    return "pdf" if ct == "application/pdf" else None


def output_kind(url: str, tool: str) -> str:
    """video | audio | image | pdf | page | chat, from the URL's extension,
    else from what the tool makes."""
    ext = _ext(url)
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in IMAGE_EXT:
        return "image"
    if ext in PDF_EXT:
        return "pdf"
    return TOOL_KIND.get(tool, "page")


def output_filename(url: str, tool: str, record_id, content_type: Optional[str] = None) -> str:
    ext = _ext(url)
    if not ext or len(ext) > 6:
        ext = mimetypes.guess_extension((content_type or "").split(";")[0].strip()) or ""
    stem = re.sub(r"[^A-Za-z0-9]+", "-", f"{tool}-{record_id}").strip("-")
    return f"{stem}{ext}"


def _public_host(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


class OutputFetchError(Exception):
    pass


def open_output_stream(url: str) -> tuple[httpx.Response, httpx.Client]:
    """GET the output, following redirects only to public hosts. The caller
    iterates the response and closes both when done."""
    client = httpx.Client(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=False)
    try:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            if not _public_host(current):
                raise OutputFetchError("Output host is not allowed")
            resp = client.send(client.build_request("GET", current), stream=True)
            if resp.is_redirect and resp.headers.get("location"):
                current = urljoin(current, resp.headers["location"])
                resp.close()
                continue
            if resp.status_code >= 400:
                resp.close()
                raise OutputFetchError(f"Output source answered {resp.status_code}")
            return resp, client
        raise OutputFetchError("Too many redirects")
    except Exception:
        client.close()
        raise


def iter_and_close(resp: httpx.Response, client: httpx.Client) -> Iterator[bytes]:
    try:
        yield from resp.iter_bytes(CHUNK)
    finally:
        resp.close()
        client.close()


# --------------------------------------------------------------------------- #
# Chat transcripts (Claude / ChatGPT): the conversation is the output.

CHAT_PROVIDERS = {"Claude": "claude", "ChatGPT": "chatgpt"}
MAX_TRANSCRIPT_MESSAGES = 400


def chat_transcript(db, tool: str, prompt_id: int) -> Optional[dict]:
    """The whole captured conversation a Generation Log prompt belongs to,
    prompts and responses in order, with that prompt marked."""
    from models_new import User
    from providers.chatgpt.models import ConversationPrompt, ConversationRecord, ConversationResponse
    from providers.conversation_links import chat_web_url

    provider = CHAT_PROVIDERS.get(tool)
    if not provider:
        return None
    record = (
        db.query(ConversationRecord)
        .join(ConversationPrompt, ConversationPrompt.conversation_id == ConversationRecord.id)
        .filter(ConversationPrompt.id == prompt_id, ConversationRecord.provider == provider)
        .first()
    )
    if record is None:
        return None

    def when(primary, fallback):
        moment = primary or fallback
        return moment.isoformat() + "Z" if moment else None

    messages = [
        {
            "id": f"p{p.id}",
            "role": "user",
            "text": p.prompt_text or "",
            "at": when(p.prompt_timestamp, p.created_at),
            "files": len(p.attachments_json or []) + len(p.files_json or []) + len(p.images_json or []),
            "target": p.id == prompt_id,
            "seq": p.sequence_index or 0,
        }
        for p in db.query(ConversationPrompt).filter(ConversationPrompt.conversation_id == record.id)
    ] + [
        {
            "id": f"r{r.id}",
            "role": "assistant",
            "text": r.response_text or "",
            "at": when(r.response_timestamp, r.created_at),
            "files": len(r.files_json or []) + len(r.images_json or []),
            "target": False,
            "seq": r.sequence_index or 0,
            "status": r.response_status,
        }
        for r in db.query(ConversationResponse).filter(ConversationResponse.conversation_id == record.id)
    ]
    # Time first; on a tie the prompt comes before its answer.
    messages.sort(key=lambda m: (m["at"] or "", m["seq"], 0 if m["role"] == "user" else 1))
    truncated = len(messages) > MAX_TRANSCRIPT_MESSAGES
    if truncated:
        target = next((i for i, m in enumerate(messages) if m["target"]), 0)
        start = max(0, min(target - MAX_TRANSCRIPT_MESSAGES // 2, len(messages) - MAX_TRANSCRIPT_MESSAGES))
        messages = messages[start:start + MAX_TRANSCRIPT_MESSAGES]
    owner = db.get(User, record.owner_user_id) if record.owner_user_id else None
    return {
        "tool": tool,
        "title": (record.title or "").strip() or "Untitled chat",
        "model": record.model_label,
        "owner": (owner.name or "").strip() if owner else None,
        "webUrl": chat_web_url(provider, record.provider_conversation_id, record.conversation_url),
        "promptCount": record.prompt_count,
        "truncated": truncated,
        "messages": messages,
    }
