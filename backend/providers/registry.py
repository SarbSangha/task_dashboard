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
}


def get_provider(slug: str) -> Optional[ProviderInfo]:
    return PROVIDERS.get(slug)


def list_providers() -> list:
    return list(PROVIDERS.values())
