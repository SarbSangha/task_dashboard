# Freepik / Magnific Generation Capture System

Follows the same modular-provider architecture as `providers/chatgpt/`
(raw capture -> normalization -> projection into the shared `GenerationRecord`
table), combined with the proven ticket-based ownership model from the
legacy Kling capture pipeline (`routers/it_tools_router.py`). See the
approved architecture plan (`glistening-weaving-pie.md` in this repo's
planning history) for the full rationale; this README is the durable,
in-repo summary.

## Why this isn't built like ChatGPT's provider

ChatGPT's capture pipeline authenticates purely off the app session
(`Depends(require_user)`) because ChatGPT conversations are inherently
per-account already visible to whoever is logged into ChatGPT in that tab.
Freepik/Magnific is a **shared company account** - the API response never
identifies which employee is behind a given generation (`owner.user_id` /
`owner.email` is the constant account holder; `creation.user_id` is a
constant internal service id, not a per-employee value - verified against a
50-row sample response spanning multiple days and multiple employees, every
row had the exact same two values). Ownership can only come from **our own**
launch-ticket system, the same mechanism Kling's usage-event endpoint
already uses (`_resolve_usage_event_actor` in `it_tools_router.py`) - so
this provider's `capture.py` calls that function directly rather than
reimplementing identity resolution.

## Why this isn't built like Kling either

Kling's capture lives directly in `models_new.py` / `routers/it_tools_router.py`
/ `routers/generation_*_router.py` - a flat-file layout `providers/registry.py`
itself calls "legacy, not yet migrated." This provider follows the newer,
self-contained package pattern ChatGPT established instead.

## Data flow

```
Browser tab (Freepik/Magnific, launched via our dashboard)
  -> content-freepik-network.js (MAIN world, intercepts fetch/XHR)
       - "my creations" listing responses
       - generation-submit responses
  -> window.postMessage -> content-freepik.js (isolated world)
  -> chrome.runtime.sendMessage({type: 'FREEPIK_CAPTURE_EVENT', event})
  -> background-freepik-capture.js (persistent queue, batched, retried)
  -> POST /api/providers/freepik/capture/events
       - resolve_freepik_actor()  [ticket -> User, see capture.py]
       - resolve_freepik_credential()  [which shared account]
       - ingest_capture_event()  -> FreepikCaptureEvent (raw, lossless)
  -> normalize_capture_events_batch()  [inline, same request]
       -> FreepikGeneration (rich, one row per creation.id)
       -> projected into GenerationRecord (provider="freepik")
```

Reconciliation (Phase 5) is the same interceptor, walking the paginated
listing endpoint using the tab's own authenticated session (there is no
server-side Freepik credential) - see `sync.py` and `CAPTURE_CONTRACT.md`.

## Module map

| File | Responsibility |
|---|---|
| `constants.py` | Provider literals - single source of truth for a rename or a new event type |
| `models.py` | `FreepikCaptureEvent` (raw), `FreepikGeneration` (normalized), `FreepikRecoveryAudit`, `FreepikSyncCursor`, `FreepikCaptureHealth` |
| `schemas.py` | Pydantic request/response contracts |
| `capture.py` | Raw ingest + identity/credential resolution (delegates to `it_tools_router.py`) |
| `normalization.py` | Raw JSON -> `FreepikGeneration`, plus projection into `GenerationRecord` |
| `sync.py` | Reconciliation cursor bookkeeping (extension-driven, see above) |
| `health.py` | Per-install capture health snapshot + derived status |
| `queries.py` | Read-side for the admin Capture Center surface |
| `router.py` | FastAPI endpoints |
| `migrations.py` | Idempotent additive DDL, wired into `db_migrations.py` |

## Status

Backend package (capture/normalization/projection/sync bookkeeping/health/
migrations) and the browser-extension capture layer
(`content-freepik-network.js`, `background-freepik-capture.js`) are in
place. Not yet built: an admin UI for the Capture Center surface (the API
exists at `/api/providers/freepik/*`, admin-gated, no frontend yet), and the
admin-triggered full-reconciliation-audit workflow's UI (the `FreepikRecoveryAudit`
table and `action_type` values exist; the workflow that populates it via a
full page-walk is a follow-up, same status Kling's `generation_recovery_router.py`
equivalent would need built for Freepik specifically).
