# providers/figma/constants.py
"""
Central place for Figma provider literals.

Figma's AI (the agent in Figma Design, Figma Make) spends AI credits from the
signed-in account's monthly seat bucket (500/month and 150/day on a Starter
full seat, 2026-10). Figma itself prices every prompt: the credits icon under
a finished reply calls

  GET /api/files/{fileKey}/ai_credits/plan_user_action_credit_usage?user_action_uuid=...
  -> {"meta": {"total_credit_usage": 24, "total_credit_cost": 24, "policy_totals": []}}

and user_action_uuid is the message.clientId the browser sends with the prompt
to POST /api/cortex/assistant/chat (confirmed live 2026-10-30: three prompts
24 + 8 + 4 = 36 = the batch POST of the same uuids, and the account's monthly
"consumed" moved by exactly the two new ones). The same prompt text does not
cost the same twice ("hi" cost 8, then 4), so nothing here estimates.

The extension (content-figma-network.js) reads the uuid when the prompt is
sent, waits for the reply, asks Figma what it cost, and reports one "prompt"
event; it also reports the account's balance ("balance" events). The person
is the one whose dashboard launch ticket opened the tab, since the Figma login
itself is a shared company account. See CAPTURE_CONTRACT.md.
"""

PROVIDER = "figma"
PROVIDER_DISPLAY = "Figma"

# it_portal_tools.slug values that map to this provider.
TOOL_SLUGS = ("figma",)

EVENT_PROMPT = "prompt"
EVENT_BALANCE = "balance"
ALL_EVENT_TYPES = (EVENT_PROMPT, EVENT_BALANCE)

# FigmaPrompt.status
STATUS_COMPLETED = "completed"  # Figma returned the prompt's credits
STATUS_PENDING = "pending"      # the reply finished but Figma had no credits for it yet
STATUS_FAILED = "failed"        # the agent errored or the prompt was stopped
STATUSES = (STATUS_COMPLETED, STATUS_PENDING, STATUS_FAILED)

MAX_PROMPT_TEXT_CHARS = 20000

VIEW_MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000
VIEW_DEFAULT_LIMIT = 200
VIEW_MAX_LIMIT = 1000
