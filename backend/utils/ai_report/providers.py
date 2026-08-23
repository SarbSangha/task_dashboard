"""
Provider registry -- the extensibility seam of the workbook.

Every AI tool the report can describe is declared here once. Today ChatGPT,
Kling, Freepik, Envato, HeyGen, Higgsfield, ElevenLabs and Flow are
*integrated* (live data flows in); the rest are declared as *pending* so they
already appear
correctly in Tool Master and are ready to light up the moment their capture
pipeline lands.

Adding a new integrated provider is a two-step, no-touch-elsewhere change:
  1. Add / flip its entry here (``integrated=True`` + captured fields).
  2. Add its aggregate + raw-event queries in ``dataset.py``.
The sheet-rendering code never changes -- Tool Master, the KPI counts and the
merged log all iterate this registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ProviderMeta:
    slug: str
    display_name: str
    vendor: str
    category: str
    captured_fields: str
    integrated: bool = False


# The 18 subscribed tools from the reference Tool Master. ``integrated`` marks
# the two with a live capture pipeline; the rest are on the roadmap.
PROVIDERS: tuple[ProviderMeta, ...] = (
    ProviderMeta("chatgpt", "ChatGPT", "OpenAI", "Text / Content Generation",
                 "Input, Output, User, Date", integrated=True),
    ProviderMeta("kling", "Kling", "Kuaishou", "AI Video Generation",
                 "Credits Used, Prompts, Videos Made, Generation Time, Person, Date, Model",
                 integrated=True),
    ProviderMeta("freepik", "Freepik / Magnific", "Freepik", "AI Image Generation",
                 "Credits Charged/Estimated, Prompts, Model/Service, Person, Date, Family/Batch",
                 integrated=True),
    ProviderMeta("envato", "Envato", "Envato", "AI Image/Video/Audio Generation",
                 "Prompts, Item Type, Credit Badge (best-effort), Person, Date, Task/Client",
                 integrated=True),
    ProviderMeta("heygen", "HeyGen", "HeyGen", "AI Avatar / Video",
                 "Credits Used, Scripts, Avatar/Voice, Videos Made, Person, Date, Task/Client",
                 integrated=True),
    ProviderMeta("higgsfield", "Higgsfield", "Higgsfield", "AI Image/Video Generation",
                 "Credits Used, Prompts, Preset, Generations Made, Person, Date, Task/Client",
                 integrated=True),
    # Google's own name for the product is "Flow" (labs.google/fx/tools/flow);
    # the portal + extension both key it on the bare "flow" slug, and the
    # dashboard UI labels it "Flow" - keep all three agreeing.
    ProviderMeta("flow", "Flow", "Google", "AI Image/Video Generation",
                 "Prompts, Project/Batch, Person, Date, Task/Client",
                 integrated=True),
    ProviderMeta("midjourney", "Midjourney", "Midjourney Inc.", "AI Image Generation", "Not yet captured"),
    ProviderMeta("runway", "Runway ML", "Runway", "AI Video Generation", "Not yet captured"),
    ProviderMeta("claude", "Claude", "Anthropic", "Text / Content Generation", "Not yet captured"),
    ProviderMeta("gemini", "Gemini", "Google", "Text / Content Generation", "Not yet captured"),
    ProviderMeta("dalle", "DALL-E", "OpenAI", "AI Image Generation", "Not yet captured"),
    ProviderMeta("firefly", "Adobe Firefly", "Adobe", "AI Image / Design", "Not yet captured"),
    ProviderMeta("elevenlabs", "ElevenLabs", "ElevenLabs", "AI Voice Generation",
                 "Prompt/Text Input, Voice, Source Type, Person, Date, Task/Client",
                 integrated=True),
    ProviderMeta("suno", "Suno", "Suno", "AI Music Generation",
                 "Prompt/Song Description, Model, Person, Date, Task/Client",
                 integrated=True),
    # Not a generator - a stock music/sound-effects licensing library. Only
    # download events are captured (no prompts/models), same shape as
    # Envato Elements' own stock-asset downloads.
    ProviderMeta("epidemic-sound", "Epidemic Sound", "Epidemic Sound", "Stock Music / Sound Effects",
                 "Track/Sound Title, Sound ID, SFX Flag, Quality, Person, Date, Task/Client",
                 integrated=True),
    # Not a generator - a sample/loop licensing library. Only download events
    # are captured (no prompts/models), same shape as Epidemic Sound's own
    # stock-asset downloads.
    ProviderMeta("splice", "Splice", "Splice", "Sample Library",
                 "Sample Title, Sample Hash, Person, Date, Task/Client",
                 integrated=True),
    ProviderMeta("pika", "Pika", "Pika Labs", "AI Video Generation", "Not yet captured"),
    ProviderMeta("leonardo", "Leonardo AI", "Leonardo.Ai", "AI Image Generation", "Not yet captured"),
    ProviderMeta("synthesia", "Synthesia", "Synthesia", "AI Avatar / Video", "Not yet captured"),
    ProviderMeta("descript", "Descript", "Descript", "AI Video/Audio Editing", "Not yet captured"),
    ProviderMeta("perplexity", "Perplexity", "Perplexity AI", "AI Search / Research", "Not yet captured"),
    ProviderMeta("jasper", "Jasper", "Jasper AI", "Text / Copywriting", "Not yet captured"),
    ProviderMeta("copyai", "Copy.ai", "Copy.ai", "Text / Copywriting", "Not yet captured"),
)

def _norm(value: Optional[str]) -> str:
    """Alphanumeric-only, lowercased — so 'CHAT GPT', 'chat-gpt' and 'ChatGPT'
    all collapse to the same key ('chatgpt')."""
    return "".join(ch for ch in (value or "").lower() if ch.isalnum())


# Fast lookup keyed by the normalized slug AND normalized display name, plus a
# few well-known aliases for tools whose portal name differs from the vendor's.
_ALIASES = {
    "chatgpt": ("gpt", "openai"),
    "dalle": ("dalle2", "dalle3"),
    "copyai": ("copy",),
    "runway": ("runwayml",),
    "freepik": ("magnific",),
    # providers/flow/constants.py's PROVIDER_DISPLAY is "Google Flow", so a
    # portal row named that must still resolve to this entry.
    "flow": ("googleflow", "googlelabsflow"),
}
_LOOKUP: dict[str, ProviderMeta] = {}
for _p in PROVIDERS:
    for _k in (_p.slug, _p.display_name, *(a for a in _ALIASES.get(_p.slug, ()))):
        _LOOKUP.setdefault(_norm(_k), _p)


def provider_meta(key: Optional[str]) -> Optional[ProviderMeta]:
    """Resolve a provider by slug or display name (punctuation/space-insensitive)."""
    k = _norm(key)
    return _LOOKUP.get(k) if k else None


def integrated_providers() -> tuple[ProviderMeta, ...]:
    return tuple(p for p in PROVIDERS if p.integrated)
