# providers/claude/__init__.py
"""
Claude (claude.ai) Capture & Conversation Intelligence.

Deliberately has NO models.py of its own. providers/chatgpt/models.py's
conversation_* tables (ConversationCaptureEvent, ConversationRecord,
ConversationPrompt, ConversationResponse, ConversationGeneratedAsset,
ConversationCaptureHealth, ...) were built provider-agnostic on purpose -
every row carries a `provider` discriminator column (indexed, part of every
uniqueness constraint) and nothing in that schema, capture.py, or health.py
actually hardcodes "chatgpt" outside of a Column default - see
providers/chatgpt/models.py's own module docstring and PROVIDER usage
throughout providers/chatgpt/capture.py/normalization.py/health.py. Claude
reuses that exact table set with provider="claude" (see
providers/claude/constants.py) instead of standing up a parallel
claude_conversation_records/claude_conversation_prompts/... schema that
would only ever differ by table name.

This means: no providers/claude/models.py, no providers/claude/migrations.py
- Base.metadata already has these tables registered the moment
providers.chatgpt is imported anywhere in the app (see main.py), which it
always is. Importing this package is still worthwhile for the same reason
providers/chatgpt/__init__.py exists - a stable single import site for
anything Claude-specific added here later.
"""
