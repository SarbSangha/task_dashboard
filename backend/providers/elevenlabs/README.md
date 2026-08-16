# ElevenLabs provider

Generation-capture backend for ElevenLabs (`elevenlabs.io`, AI voice/audio
tool covering Text-to-Speech, Music, Sound Effects, Dubbing, Voice Changer,
and Speech-to-Text). Self-contained package, same pattern
`providers/flow`, `providers/freepik`, `providers/heygen`, etc. already
established - see `backend/providers/registry.py`'s own docstring for why
this is a copied convention rather than a shared base class.

## Why ticket-based ownership (not session-based, like ChatGPT)

ElevenLabs is accessed through a shared account via a dashboard-issued
launch ticket (`DIRECT_TICKET_ONLY_TOOLS` in `background-main.js`), the same
way Flow/Freepik/Kling/HeyGen/Higgsfield/Envato are. The `history` listing
API itself never identifies which employee is behind the shared account -
ownership can only be resolved from our own launch-ticket system at the
moment of capture, not from anything ElevenLabs' API returns. See
`capture.py::resolve_elevenlabs_actor` and `CAPTURE_CONTRACT.md`'s ownership
decision table.

## Module map

| File | Role |
|---|---|
| `constants.py` | Provider literals - event types, ownership/status enums, reliability class, the diagnostic-only known-`source`-values allow-list |
| `models.py` | `ElevenlabsCaptureEvent` (raw, append-only) + `ElevenlabsGeneration` (normalized, includes the asset-mirror column set) |
| `schemas.py` | Pydantic request/response payloads |
| `capture.py` | Raw ingestion - dedup, actor/credential resolution, task/client revalidation |
| `normalization.py` | `ElevenlabsCaptureEvent` -> `ElevenlabsGeneration` -> projects into `GenerationRecord`. Field extraction is defensive/multi-candidate (see its own docstring) because the real `history` row shape is unconfirmed |
| `router.py` | `POST /capture/events` + a minimal admin read surface (`/generations`, `/events`) |
| `asset_mirror.py` | Periodic sweep mirroring the row's audio asset into R2 - see its own docstring for why it may never actually succeed until the real asset-location question (CAPTURE_CONTRACT.md known-gap #5) is resolved |
| `CAPTURE_CONTRACT.md` | The wire contract + confirmed (and, mostly, *unconfirmed*) field mapping - read this first |

## Why this is honest about being built on one screenshot, not a HAR

Every other provider in this codebase that started from thin evidence
(HeyGen, Higgsfield) was built from at least a full UI screenshot of the
generate flow. ElevenLabs so far has less than that: one DevTools screenshot
of a `GET /v1/history?...&source=TTS...` *request* - no response body, no
generate-submission traffic, no confirmed `source` values beyond `TTS`. This
package follows this codebase's own established practice for that situation
(Envato shipped in an identical position - confirmed listing endpoint,
unconfirmed generate endpoint - on a reconciliation-walker-first design, not
a network-gate-first one) rather than waiting for more evidence or guessing
at a shape that doesn't exist yet. See `CAPTURE_CONTRACT.md`'s "known gaps"
section for the full, current list of what still needs to be confirmed.

## What this pass deliberately excludes

No dashboard viewer UI (Capture Center tab), no confirmed `source` enum
beyond `TTS`, no confirmed generate-endpoint capture, and no reconciliation
handling tailored to Music/Sound-Effects/Dubbing/Voice-Changer until their
`source` values are actually confirmed (they likely ride the same `history`
pipeline once observed, needing no code change beyond extending
`constants.KNOWN_SOURCE_VALUES`, but that's a claim to verify, not assume).

## Status

Backend package (capture, normalization, asset mirroring, reporting
integration) is built. No admin dashboard UI yet. No capture shape is
confirmed for any surface - see `CAPTURE_CONTRACT.md`.
