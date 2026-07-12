# ChatGPT Capture & Conversation Intelligence

Provider module for capturing, normalizing, and analyzing ChatGPT conversations
through the browser extension. Follows the same architecture as the Kling
Generation Capture & Recovery System (`models_new.py` / `routers/generation_*`),
but lives in its own package per the modular provider architecture (see
`backend/providers/__init__.py`).

## Status

| Phase | Area | Status |
|---|---|---|
| 1 | Data model & migrations (`models.py`, `migrations.py`) | Done |
| 2A | Backend raw capture ingestion (`capture.py`, `router.py` - `POST /api/providers/chatgpt/capture/events`) | Done |
| 2A.5 | Browser capture architecture review | In review |
| 2B | Browser extension capture (`content-chatgpt-network.js` + isolated-world adapter) | Pending |
| 3 | Normalization (`ConversationCaptureEvent` -> `ConversationRecord`/`Prompt`/`Response`/`Asset`) + query router | Pending |
| 4 | Recovery (`recovery.py`) | Pending |
| 5 | Capture Center frontend integration | Pending |
| 6 | Analytics (`analytics.py`) | Pending |

## Capture flow (raw-first, same philosophy as Kling)

```
Browser Extension (content-chatgpt-network.js + content-chatgpt.js)
        |
        v
Raw capture event  ->  ConversationCaptureEvent  (append-only, one row per signal)
        |
        v
Normalization step  ->  ConversationRecord / ConversationPrompt /
                         ConversationResponse / ConversationGeneratedAsset
        |
        v
Recovery (gap detection, reconciliation)  ->  ConversationRecoveryAudit
        |
        v
Analytics / Capture Center dashboard
```

The extension's only job is to never lose an event (retry queue, exponential
backoff - mirrors `background-main.js`'s existing Kling usage-event retry
logic). It captures raw signals as-is; it does not normalize or deduplicate.
All identity resolution and normalization happens server-side in the
capture -> normalization step, exactly like Kling's
`sync_generation_record_from_usage_event`. This is deliberate: two known
Kling production bugs (cross-user duplicate attribution via shared
credentials, and normalization drift between live capture and recovery
import) were both caused by skipping this separation, not by the raw layer
itself.

## Identity & dedupe

`ConversationCaptureEvent` dedupes on `(provider, credential_id,
provider_message_id)` - credential-scoped, not portal-session-scoped, per the
fix already proven in `routers/it_tools_router.py`'s
`report_extension_usage_event`. `ConversationRecord` requires at least one of
`provider_conversation_id` / `canonical_conversation_key` (enforced by a
`CHECK` constraint), never a single fragile ID field.

See `CAPTURE_CONTRACT.md` for the exact wire contract (envelope fields +
per-`event_type` `payload_json` shape) the extension and backend must agree
on - this is the API contract that has to keep working across extension
upgrades.

## Files

- `models.py` - SQLAlchemy models (10 tables: capture events, capture health,
  conversations, prompts, responses, generated assets, projects, project
  events, tags, recovery audits).
- `migrations.py` - idempotent additive DDL (Postgres + SQLite), called from
  the shared `backend/db_migrations.py` entry point.
- `constants.py` - provider slug, supported models, event-type/reliability-class
  string literals shared across this package.
- `schemas.py` - Pydantic request/response payloads.
- `capture.py` / `router.py` - Phase 2A raw capture ingestion, `POST /api/providers/chatgpt/capture/events`.
- `health.py` - Capture Health: upserts a per-install queue snapshot
  (`POST .../capture/health`) and serves it back (`GET .../capture/health`)
  for the future Capture Center "is capture healthy right now" indicator.
  Also derives a `status` (`healthy`/`degraded`/`backlogged`/`offline`) at
  read time from the raw metrics, per fixed priority rules
  (`compute_capture_health_status`), so every consumer doesn't reimplement
  that logic. `last_capture_event_at` (extension observed an event) is kept
  distinct from `last_successful_upload_at` (backend confirmed receiving
  one) specifically so "idle user, empty queue" and "active user, nothing
  arriving" don't look identical.
- `CAPTURE_CONTRACT.md` - the extension<->backend wire contract + compatibility matrix.
- `EXTENSION_CAPTURE_DESIGN.md` - Phase 2A.5 browser-capture architecture review.
- `__init__.py` - imports `.models` so tables register on `Base.metadata`.

## Ownership model

Conversation Projects are strict same-owner (like Kling's Generation
Projects, not Generation Collections) - a conversation can only be filed into
a project owned by the same user. See the plan file's Phase 1 addendum for
the reasoning.
