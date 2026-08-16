# Flow provider

Generation-capture backend for Flow (`labs.google/fx/tools/flow`, Google's AI
image/video tool). Self-contained package, same pattern `providers/freepik`,
`providers/heygen`, etc. already established - see
`backend/providers/registry.py`'s own docstring for why this is a copied
convention rather than a shared base class.

## Why ticket-based ownership (not session-based, like ChatGPT)

Flow is accessed through a shared Google account via a dashboard-issued
launch ticket (`DIRECT_TICKET_ONLY_TOOLS` in `background-main.js`), the same
way Freepik/Kling/HeyGen/Higgsfield/Envato are. The generation API itself
(`aisandbox-pa.googleapis.com`) never identifies which employee is behind the
shared account's OAuth token - ownership can only be resolved from our own
launch-ticket system at the moment of capture, not from anything Flow's API
returns. See `capture.py::resolve_flow_actor` and `CAPTURE_CONTRACT.md`'s
ownership decision table.

## Module map

| File | Role |
|---|---|
| `constants.py` | Provider literals - event types, ownership/status enums, reliability class |
| `models.py` | `FlowCaptureEvent` (raw, append-only) + `FlowGeneration` (normalized) |
| `schemas.py` | Pydantic request/response payloads |
| `capture.py` | Raw ingestion - dedup, actor/credential resolution, task/client revalidation |
| `normalization.py` | `FlowCaptureEvent` -> `FlowGeneration` -> projects into `GenerationRecord` |
| `router.py` | `POST /capture/events` + a minimal admin read surface (`/generations`, `/events`) |
| `CAPTURE_CONTRACT.md` | The wire contract + confirmed field mapping - read this first |

## What this pass deliberately does not include

No dashboard viewer UI (`flow-capture` tab), no reconciliation/sync-cursor
walker, no search-query/download event types, no health-ping endpoint, no
asset mirroring. Freepik's package has all of these; Flow doesn't need them
yet and each is real, non-trivial work - see `CAPTURE_CONTRACT.md`'s "known
gaps" section and this repo's plan history for the reasoning behind deferring
them rather than building unused surface area up front.

## Status

Backend package + extension capture layer are built. No admin dashboard UI
yet. Capture shape confirmed for image generation only - video generation's
`flowWorkflows` shape has not been captured live yet (see
`CAPTURE_CONTRACT.md`).
