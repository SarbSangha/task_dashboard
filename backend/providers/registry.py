# providers/registry.py
"""
Declarative metadata for every AI tool/provider the Capture Center supports.

This is metadata only - adding an entry here does not, by itself, mount a
router or run migrations. Nothing currently imports this module; it exists
so that when the Capture Center dashboard, admin health checks, and
analytics are built out (a later phase), a new provider can be onboarded by
adding one PROVIDERS entry instead of hardcoding it into each of those
surfaces separately.

Kling is listed here even though its code has not been moved into
backend/providers/kling/ (see the Phase 1 addendum in the ChatGPT plan for
why that migration is deferred) - the registry describes where a provider's
code currently lives, it doesn't require that location to be providers/<name>/.
"""
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ProviderInfo:
    slug: str
    display_name: str
    tool_slugs: frozenset
    status: str  # "active" (fully built) | "in_development" | "planned"
    models_module: Optional[str] = None
    migrations_module: Optional[str] = None
    notes: str = ""


PROVIDERS: dict[str, ProviderInfo] = {
    "kling": ProviderInfo(
        slug="kling",
        display_name="Kling",
        tool_slugs=frozenset({"kling", "kling-ai", "klingai"}),
        status="active",
        models_module="models_new",
        migrations_module="db_migrations",
        notes="Legacy flat-file layout (models_new.py, routers/generation_*_router.py); not yet migrated into providers/kling/.",
    ),
    "chatgpt": ProviderInfo(
        slug="chatgpt",
        display_name="ChatGPT",
        tool_slugs=frozenset({"chatgpt", "chat-gpt"}),
        status="in_development",
        models_module="providers.chatgpt.models",
        migrations_module="providers.chatgpt.migrations",
        notes="Phase 1 (data model & migrations) complete. Capture/router/recovery/analytics pending.",
    ),
    "freepik": ProviderInfo(
        slug="freepik",
        display_name="Freepik / Magnific",
        tool_slugs=frozenset({"freepik", "magnific"}),
        status="in_development",
        models_module="providers.freepik.models",
        migrations_module="providers.freepik.migrations",
        notes=(
            "Ticket-based ownership attribution (Kling pattern, not ChatGPT's plain-session one) - "
            "Freepik's own API never identifies the employee, only the shared account. Reconciliation "
            "sync is extension-driven (no server-side Freepik credential exists) - see CAPTURE_CONTRACT.md."
        ),
    ),
    "heygen": ProviderInfo(
        slug="heygen",
        display_name="HeyGen",
        tool_slugs=frozenset({"heygen"}),
        status="in_development",
        models_module="providers.heygen.models",
        migrations_module="providers.heygen.migrations",
        notes=(
            "Ticket-based ownership attribution, same pattern as Freepik. Built from a single UI "
            "screenshot rather than observed HeyGen API traffic, so the network interceptor is "
            "shape-based (not endpoint-specific) and normalization.py's payload envelope is one this "
            "codebase defines itself (content-heygen.js), not HeyGen's own response shape. Expect a "
            "short follow-up fix pass once real capture data lands, same as Freepik needed. No "
            "confirmed history/listing endpoint yet, so reconciliation sync (sync.py) is scaffolded "
            "but not extension-driven in this pass. Capture Center dashboard/Reports/AI-report "
            "integration are a deferred follow-up, not part of the initial rollout."
        ),
    ),
    "higgsfield": ProviderInfo(
        slug="higgsfield",
        display_name="Higgsfield",
        tool_slugs=frozenset({"higgsfield"}),
        status="in_development",
        models_module="providers.higgsfield.models",
        migrations_module="providers.higgsfield.migrations",
        notes=(
            "Ticket-based ownership attribution, same pattern as Freepik/HeyGen. Built from a single "
            "UI screenshot (Create Video tab: preset picker, Multi-shot toggle, Prompt textarea, "
            "Generate button with inline credit cost) rather than observed Higgsfield API traffic, so "
            "the network interceptor is shape-based (not endpoint-specific) and normalization.py's "
            "payload envelope is one this codebase defines itself (content-higgsfield.js), not "
            "Higgsfield's own response shape. Expect a short follow-up fix pass once real capture data "
            "lands, same as Freepik/HeyGen needed. No confirmed history/listing endpoint yet, so "
            "reconciliation sync (sync.py) is scaffolded but not extension-driven in this pass. Asset "
            "mirroring, Capture Center dashboard, and Reports/AI-report integration are a deferred "
            "follow-up, not part of the initial rollout."
        ),
    ),
    "envato": ProviderInfo(
        slug="envato",
        display_name="Envato",
        tool_slugs=frozenset({"envato"}),
        status="in_development",
        models_module="providers.envato.models",
        migrations_module="providers.envato.migrations",
        notes=(
            "Ticket-based ownership attribution, same pattern as Freepik/HeyGen/Higgsfield. Envato "
            "(app.envato.com) is a React Router 7 app - its `.data` route-loader responses use React "
            "Router's compact array-reference 'turbo-stream' wire format, not plain JSON; the extension "
            "decodes this client-side (content-envato-turbo-stream.js) before ever posting a payload. "
            "Built from a real captured HAR of the generation-history.data listing endpoint (confirmed "
            "field shapes for the genai-image item type only - the other five item types are inferred "
            "from filter-chip i18n labels, not yet observed). No numeric per-item credit ledger exists "
            "in Envato's API (unlike Freepik) - credits are DOM-scraped best-effort (Generate button's "
            "'+N' badge, sidebar quota-remaining delta). The live Generate submission request was never "
            "captured, so capture is reconciliation-first (walks generation-history.data) with "
            "click-time arming for live attribution, not true request/response interception."
        ),
    ),
    "flow": ProviderInfo(
        slug="flow",
        display_name="Google Flow",
        tool_slugs=frozenset({"flow"}),
        status="in_development",
        models_module="providers.flow.models",
        migrations_module=None,
        notes=(
            "Ticket-based ownership attribution, same pattern as Freepik/HeyGen/Higgsfield/Envato. "
            "Built from real captured network traffic (not a single screenshot, unlike HeyGen/"
            "Higgsfield) - confirmed one flowWorkflows/{uuid} PATCH response shape for image "
            "generation, on a separate API host (aisandbox-pa.googleapis.com) from the labs.google "
            "page itself. Video generation's shape is unconfirmed. No migrations_module: a brand-new "
            "table gets its full current schema from Base.metadata.create_all() alone, no additive-DDL "
            "file needed the way Freepik's (evolved-in-production) schema requires. No reconciliation "
            "sync, search/download event types, health-ping endpoint, asset mirroring, or Capture "
            "Center dashboard UI in this pass - see providers/flow/CAPTURE_CONTRACT.md's known-gaps "
            "section."
        ),
    ),
    "elevenlabs": ProviderInfo(
        slug="elevenlabs",
        display_name="ElevenLabs",
        tool_slugs=frozenset({"elevenlabs"}),
        status="in_development",
        models_module="providers.elevenlabs.models",
        migrations_module=None,
        notes=(
            "Ticket-based ownership attribution, same pattern as Flow/Freepik/HeyGen/Higgsfield/Envato. "
            "Built from a single DevTools screenshot of one request "
            "(GET /v1/history?page_size=20&source=TTS&sort_direction=desc) - unlike Flow, even the "
            "confirmed traffic has no observed response body, so normalization.py's field extraction is "
            "multi-candidate-key defensive rather than shaped to one confirmed payload. No confirmed "
            "generate-submission endpoint, no confirmed source enum beyond TTS (Music/Sound-Effects/"
            "Dubbing/Voice-Changer unconfirmed), and unconfirmed whether the audio asset is embedded in "
            "the history row or needs a second authenticated fetch (asset_mirror.py may not be able to "
            "mirror anything real until that's resolved - see CAPTURE_CONTRACT.md's known-gaps section). "
            "No migrations_module: a brand-new table gets its full current schema from "
            "Base.metadata.create_all() alone."
        ),
    ),
    "suno": ProviderInfo(
        slug="suno",
        display_name="Suno",
        tool_slugs=frozenset({"suno"}),
        status="in_development",
        models_module="providers.suno.models",
        migrations_module=None,
        notes=(
            "Ticket-based ownership attribution, same pattern as Flow/Freepik/HeyGen/Higgsfield/Envato/"
            "ElevenLabs. Built from a live DevTools capture of a real response "
            "(POST /api/feed/v3, studio-api-prod.suno.com) - unlike ElevenLabs, the response body IS "
            "confirmed, so normalization.py's field extraction reads single confirmed keys rather than "
            "guessing at candidate lists. Suno only makes music - no source/voice_id/voice_name columns, "
            "unlike ElevenLabs' TTS/Music split. No confirmed generate-submission endpoint, no confirmed "
            "credits formula (SunoGeneration.credits_used stays permanently null), and the request BODY "
            "for /api/feed/v3 was never captured (response only) - see CAPTURE_CONTRACT.md's known-gaps "
            "section. Readiness is gated on action_config.actions[].disabled for the download_song action, "
            "not on status (only 'streaming' observed) or audio_url/media_urls presence (populated even "
            "mid-generation). No migrations_module: a brand-new table gets its full current schema from "
            "Base.metadata.create_all() alone. No asset_mirror.py / periodic mirror dispatch in this pass."
        ),
    ),
    "epidemic-sound": ProviderInfo(
        slug="epidemic-sound",
        display_name="Epidemic Sound",
        tool_slugs=frozenset({"epidemic-sound"}),
        status="in_development",
        models_module="providers.epidemicsound.models",
        migrations_module=None,
        notes=(
            "NOT a generation-shaped provider - Epidemic Sound (epidemicsound.com) is a stock "
            "music/sound-effects licensing library, no Generate action, no prompt, no generation "
            "identity. Mirrors Envato Elements' own download-capture pattern (EnvatoDownload / "
            "_normalize_download_click_event), not Envato's/Freepik's/Suno's generation-capture "
            "pattern - only a download_click event type exists, no /generations route. Built from a "
            "real live DevTools capture of a real request/response pair (2026-08-18): "
            "GET /download/?...&downloadId=...&sound_id=...&is_sfx=...&qualityType=...&stemType=... -> "
            "{assetUrl, remainingDownloads}. downloadId (per-click) is a reference field, never a dedup "
            "key - every download inserts a new EpidemicDownload row, same as EnvatoDownload. "
            "asset_title is parsed from assetUrl's response-content-disposition filename param "
            "(defensive, falls back to null on any failure) - see CAPTURE_CONTRACT.md. No credits "
            "column at all (remainingDownloads has no confirmed per-download cost formula). "
            "Python package directory is 'epidemicsound' (no hyphen) even though PROVIDER/tool_slugs "
            "are the hyphenated 'epidemic-sound' - the real seeded it_portal_tools.slug. No "
            "migrations_module: a brand-new table gets its full current schema from "
            "Base.metadata.create_all() alone. No reconciliation sync (no confirmed history/listing "
            "endpoint), no asset_mirror.py periodic dispatch (browser-push model only, same as "
            "Envato's own downloads)."
        ),
    ),
    "splice": ProviderInfo(
        slug="splice",
        display_name="Splice",
        tool_slugs=frozenset({"splice"}),
        status="in_development",
        models_module="providers.splice.models",
        migrations_module=None,
        notes=(
            "NOT a generation-shaped provider - Splice (splice.com) is a sample/loop licensing "
            "library, no Generate action, no prompt, no generation identity. Mirrors Epidemic Sound's "
            "own download-capture pattern (EpidemicDownload / _normalize_download_click_event), not a "
            "generation-capture pattern - only a download_click event type exists. Built from a real "
            "live capture of a real request/response pair (2026-08-19): "
            "POST https://surfaces-graphql.splice.com/graphql -> data.asset.files[] (preview_mp3, "
            "waveform, source entries), followed by a direct GET of the 'source' file's signed URL "
            "(119-second expiry, the shortest of any provider built this session). No explicit sample "
            "id/uuid exists in the response - sample_hash is parsed out of the source URL's path "
            "instead (reference field only, never a dedup key - every download inserts a new "
            "SpliceDownload row). No credits/quota field exists anywhere (no remainingDownloads "
            "equivalent). No migrations_module: a brand-new table gets its full current schema from "
            "Base.metadata.create_all() alone. No reconciliation sync (no confirmed history/listing "
            "endpoint), no asset_mirror.py periodic dispatch (browser-push model only, same as "
            "Epidemic Sound's own downloads). Bulk/pack downloads and non-wav download variants are "
            "out of scope - see CAPTURE_CONTRACT.md."
        ),
    ),
    "grammarly": ProviderInfo(
        slug="grammarly",
        display_name="Grammarly (Docs)",
        tool_slugs=frozenset({"grammarly"}),
        status="in_development",
        models_module="providers.grammarly_docs.models",
        migrations_module=None,
        notes=(
            "SESSION-shaped, not generation- or download-shaped like every other provider here - "
            "coda.grammarly.com (formerly Coda, now under Grammarly) is a document/writing surface, "
            "not a Generate-and-get-a-credit-cost tool. Reuses the SAME seeded 'grammarly' "
            "it_portal_tools row content-grammarly.js's login autofill already targets - this is a "
            "second capture surface on an already-registered tool. Confirmed from live traffic/DOM "
            "(2026-08-27): GET coda.grammarly.com/d/<docId> returns a full HTML page (not JSON) whose "
            "inline bootstrap carries docId/title/author, and app.grammarly.com's 'New doc' button "
            "(data-name=new-ai-doc-add-btn, a React Aria usePress component - fires on pointerdown/"
            "pointerup, BEFORE native click). 'Session ended' is a client-side tab-lifecycle signal "
            "(visibilitychange/pagehide), never observed in Coda's own network traffic. Document "
            "CONTENT is captured too, deliberately breaking this codebase's usual usage-only posture on "
            "direct request - not via Coda's undocumented codacontent.io shard format, but a best-effort "
            "DOM read ([contenteditable] regions, falling back to body.innerText), capped at 200k chars, "
            "excluded from the list endpoint's response to avoid bloating it. A Client Mapping gate "
            "blocks doc creation until a client is picked (chrome.storage.local handoff across the "
            "app.grammarly.com -> coda.grammarly.com origin jump). Extension side (content-grammarly-"
            "docs.js, content-grammarly-new-doc-gate.js, content-grammarly-docs-task-modal.js, "
            "background-grammarly-docs-capture.js) and a 'Grammarly Docs' Capture Center workspace tab "
            "(by-person session browser with a click-through detail drawer) are both built. Still no "
            "capture-health ping, no asset mirroring, no reconciliation sync, no doc-COUNT metric, no "
            "Reports/AI-report integration, and the 'New doc' dropdown's other creation options aren't "
            "gated (no confirmed selector for its menu items) - see CAPTURE_CONTRACT.md's known-gaps "
            "section. No migrations_module: a brand-new set of tables gets its full current schema from "
            "Base.metadata.create_all() alone."
        ),
    ),
}


def get_provider(slug: str) -> Optional[ProviderInfo]:
    return PROVIDERS.get(slug)


def list_providers() -> list:
    return list(PROVIDERS.values())
