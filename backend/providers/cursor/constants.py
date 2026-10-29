# providers/cursor/constants.py
"""
Central place for Cursor provider literals.

Cursor (cursor.com) is an AI code editor - a DESKTOP app, not a website opened
through the dashboard launcher like every other provider here. So capture
doesn't come from the browser extension: a small Cursor (VS Code-style)
extension reads each prompt from Cursor's own local chat history and posts it
here, authenticated with a tracker token tied to that one computer. Only an
admin can connect a computer: they create a one-time setup code for a person,
and the extension trades it for the token (see router.py's /setup-codes and
/connect).

Cursor 3 stores 0 tokens locally for every message and encrypts the session
the extension would need to read usage from cursor.com, so tokens/cost come
from Cursor's own usage export instead (cursor.com -> Dashboard -> Usage ->
Export CSV), uploaded by an admin. matching.py ties each CSV row to the prompt
that was running at that moment. See CAPTURE_CONTRACT.md.
"""

PROVIDER = "cursor"
PROVIDER_DISPLAY = "Cursor"

TOOL_SLUGS = frozenset({"cursor"})

# ---- Connecting a computer ----
# A setup code works once, for this long after the admin creates it.
SETUP_CODE_TTL_SEC = 15 * 60
# No 0/O, 1/I/L or U, so a code read aloud or off a screen is typed right.
SETUP_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
SETUP_CODE_PREFIX = "CUR"
SETUP_CODE_LENGTH = 8  # shown as CUR-XXXX-XXXX

MAX_PROMPTS_PER_BATCH = 500
MAX_PROMPT_TEXT_CHARS = 20000
MAX_CSV_BYTES = 25 * 1024 * 1024

# ---- Matching CSV usage rows to prompts (see matching.py) ----
# A request this long after a prompt's last response still belongs to it.
MATCH_GRACE_MS = 2 * 60 * 1000
# No prompt is treated as running for longer than this.
MAX_PROMPT_SPAN_MS = 60 * 60 * 1000
# Cursor bills one request per prompt but can log it up to ~15s BEFORE the
# prompt appears in the local history (confirmed on real data, 2026-10-29:
# 10s and 14s early) - so a request may belong to a prompt starting this soon after it.
EARLY_EVENT_MS = 30 * 1000
