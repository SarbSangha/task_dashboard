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
}


def get_provider(slug: str) -> Optional[ProviderInfo]:
    return PROVIDERS.get(slug)


def list_providers() -> list:
    return list(PROVIDERS.values())
