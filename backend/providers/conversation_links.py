"""The browser link for a captured Claude / ChatGPT conversation.

The Claude capture reports the URL of the API request it intercepted
(https://claude.ai/api/organizations/{org}/chat_conversations/{id}?...), which
returns raw JSON when opened. ChatGPT captures store no URL at all. Both chat
pages are addressable by the conversation id alone, so the page link is built
from that id; Claude-in-Chrome task pages (/cic/task/...) are already page
links and are kept.
"""

from __future__ import annotations

import re
from typing import Optional

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_CLAUDE_API = re.compile(rf"/chat_conversations/({_UUID})")


def chat_web_url(provider: str, conversation_id: Optional[str], stored_url: Optional[str] = None) -> Optional[str]:
    stored = (stored_url or "").strip()
    cid = (conversation_id or "").strip()
    if provider == "claude":
        if stored and "/api/" not in stored and stored.startswith("https://claude.ai/"):
            return stored
        m = _CLAUDE_API.search(stored)
        if m:
            return f"https://claude.ai/chat/{m.group(1)}"
        return f"https://claude.ai/chat/{cid}" if re.fullmatch(_UUID, cid) else None
    if provider == "chatgpt":
        if stored and "/backend-api/" not in stored and re.match(r"https://(chatgpt\.com|chat\.openai\.com)/", stored):
            return stored
        return f"https://chatgpt.com/c/{cid}" if cid else None
    return stored or None
