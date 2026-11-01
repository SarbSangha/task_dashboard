# providers/claude_code/constants.py
"""
Central place for Claude Code provider literals.

Claude Code (Anthropic's coding agent, in a terminal or the VS Code extension)
reports its own usage through OpenTelemetry: once telemetry is switched on in
~/.claude/settings.json it posts an api_request event per model call (model,
tokens, cost_usd) and a user_prompt event per typed prompt, as OTLP/HTTP JSON.
This provider is the receiver.

Identity reuses the Cursor provider's computer connection: the Cursor Usage
Tracker extension, already connected for one person through an admin's setup
code, asks /connect for a Claude Code token for that same computer and writes
it into Claude Code's settings. The person is always the one the computer is
connected for - nothing Claude Code sends can change that. See
CAPTURE_CONTRACT.md.
"""

PROVIDER = "claude_code"
PROVIDER_DISPLAY = "Claude Code"

TOKEN_PREFIX = "cct_"

# Claude Code appends /v1/logs to OTEL_EXPORTER_OTLP_ENDPOINT, so the
# extension points it at this path under the dashboard address.
OTLP_PATH = "/api/providers/claude-code/otlp"

# A batch holds a few seconds of events, but one prompt can carry a pasted file.
MAX_OTLP_BODY_BYTES = 10 * 1024 * 1024
MAX_PROMPT_TEXT_CHARS = 20000

# Claude Code redacts the prompt unless OTEL_LOG_USER_PROMPTS=1.
REDACTED_PROMPT = "<REDACTED>"

# Older Claude Code without prompt.id: a request belongs to the latest prompt
# in its session that started before it, looking back at most this far.
SESSION_FALLBACK_MS = 6 * 60 * 60 * 1000

VIEW_MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000
VIEW_DEFAULT_LIMIT = 200
VIEW_MAX_LIMIT = 1000
