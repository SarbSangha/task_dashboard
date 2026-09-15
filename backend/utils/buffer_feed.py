"""Cross-tool "Buffer" client feed.

"Buffer" is an ordinary GenerationClient (see models_new.py) selectable from
the same Task/Client picker every provider's capture flow already gates
Generate/Download behind (see utils/client_gate.py). Tagging a generation or
download with the Buffer client marks it as speculative/stock content not
tied to a real customer.

Unlike every other client-scoped view in this codebase (always single-
provider - see reports_router.py's per-provider client breakdowns), the
Buffer tab needs to show activity from EVERY tool in one place. No single
table covers that: GenerationRecord is a cross-provider projection but only
for 7 providers' generations, and it silently drops Envato/Freepik's
"download of an existing asset" events by design (see EnvatoDownload's and
FreepikDownload's own docstrings) and has no rows at all for epidemicsound,
splice, or grammarly_docs.

So this module fans out to every source table that carries linked_client_id,
normalizes each into one common row shape (including a best-effort media
type - image/video/audio/other - since only Envato has a real per-row type
column; everything else is classified by provider/tool-name heuristics, see
_classify_* below), and merges/sorts/paginates them in Python rather than
one SQL UNION across ~9 structurally different tables. Each per-table fetch
is capped (SOURCE_FETCH_CAP) and filtered on an indexed linked_client_id
column, so this stays cheap as long as one client's activity stays well
under that cap; if Buffer's own volume ever grows past it, revisit with real
cross-table keyset pagination instead of the in-Python merge.

One source is not tool-captured at all: BufferSelfUpload holds files a user
uploads directly (see routers/buffer_router.py's /self-uploads endpoints and
that model's own docstring for why it has no linked_client_id to filter on).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from models_new import BufferSelfUpload, GenerationRecord, User
from providers.envato.models import EnvatoGeneration, EnvatoDownload
from providers.freepik.models import FreepikGeneration, FreepikDownload
from providers.epidemicsound.models import EpidemicDownload, EpidemicAdaptation
from providers.splice.models import SpliceDownload
from providers.grammarly_docs.models import GrammarlyDocSession

MEDIA_IMAGE = "image"
MEDIA_VIDEO = "video"
MEDIA_AUDIO = "audio"
MEDIA_OTHER = "other"
ALL_MEDIA_TYPES = frozenset({MEDIA_IMAGE, MEDIA_VIDEO, MEDIA_AUDIO, MEDIA_OTHER})

# GenerationRecord has no per-row media-type column of its own (see this
# module's docstring) - these providers are single-medium enough in practice
# that a per-provider default is accurate without inspecting each row's
# metadata_json.
GENERATION_RECORD_PROVIDER_MEDIA_TYPE = {
    "heygen": MEDIA_VIDEO,
    "flow": MEDIA_VIDEO,
    "kling": MEDIA_VIDEO,
    "higgsfield": MEDIA_VIDEO,
    "suno": MEDIA_AUDIO,
    "elevenlabs": MEDIA_AUDIO,
}
# GenerationRecord also carries envato/freepik projections (see those
# providers' normalization.py), but those two providers' OWN richer tables
# (EnvatoGeneration/FreepikGeneration, queried separately below) are the
# source of truth here instead, since only those carry real per-row item
# type/tool fields. Excluding them from the GenerationRecord fetch avoids
# double-counting the same generation from two different tables.
GENERATION_RECORD_EXCLUDED_PROVIDERS = frozenset({"envato", "freepik"})

SOURCE_FETCH_CAP = 300


def _classify_envato_item_type(item_type: Optional[str]) -> str:
    text = (item_type or "").lower()
    if "video" in text:
        return MEDIA_VIDEO
    if "image" in text or "vector" in text:
        return MEDIA_IMAGE
    if "voice" in text or "music" in text or "sound" in text:
        return MEDIA_AUDIO
    return MEDIA_OTHER


def _classify_freepik(tool, tool_name, mode, service, slug) -> str:
    combined = " ".join(filter(None, [tool, tool_name, mode, service, slug])).lower()
    if any(key in combined for key in ("video", "clip", "animate", "motion")):
        return MEDIA_VIDEO
    if any(key in combined for key in ("voice", "speech", "music", "sound", "audio")):
        return MEDIA_AUDIO
    if any(key in combined for key in ("image", "photo", "art", "upscale", "expand", "relight", "style", "background")):
        return MEDIA_IMAGE
    # Freepik's catalog skews overwhelmingly image/photo - an unrecognized
    # tool name is far more likely a new image feature than genuinely "other".
    return MEDIA_IMAGE


@dataclass
class BufferFeedItem:
    id: str
    provider: str
    kind: str  # "generation" | "download"
    media_type: str
    title: str
    asset_url: Optional[str]
    owner_user_id: Optional[int]
    created_at: Optional[datetime]
    # Only meaningful for provider == "self-upload" (the row's real
    # buffer_self_uploads.id, for the self-upload-only rename/tag/download
    # endpoints in routers/buffer_router.py) - every other source leaves
    # this None, since their own capture rows have no such per-item actions
    # from this feed view.
    raw_id: Optional[int] = None
    file_path: Optional[str] = None
    tags: Optional[list] = None
    # Filled in by _resolve_owner_names below, after pagination - every
    # source only carries owner_user_id (a bare FK) on its own row, and
    # resolving every fetched item's name (rather than just the returned
    # page's) would mean N extra User lookups nobody ever sees.
    owner_name: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "rawId": self.raw_id,
            "provider": self.provider,
            "kind": self.kind,
            "mediaType": self.media_type,
            "title": self.title,
            "assetUrl": self.asset_url,
            "filePath": self.file_path,
            "tags": self.tags or [],
            "ownerUserId": self.owner_user_id,
            "ownerName": self.owner_name,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


def _fetch_envato(db: Session, client_id: int) -> list[BufferFeedItem]:
    items: list[BufferFeedItem] = []

    generations = (
        db.query(EnvatoGeneration)
        .filter(EnvatoGeneration.linked_client_id == client_id)
        .order_by(EnvatoGeneration.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    for row in generations:
        items.append(BufferFeedItem(
            id=f"envato-generation-{row.id}",
            provider="envato",
            kind="generation",
            media_type=_classify_envato_item_type(row.item_type),
            title=row.title or row.prompt or "Envato generation",
            asset_url=row.thumbnail_url or row.canvas_url or row.fallback_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))

    downloads = (
        db.query(EnvatoDownload)
        .filter(EnvatoDownload.linked_client_id == client_id)
        .order_by(EnvatoDownload.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    for row in downloads:
        items.append(BufferFeedItem(
            id=f"envato-download-{row.id}",
            provider="envato",
            kind="download",
            media_type=_classify_envato_item_type(row.item_type),
            title=row.asset_title or "Envato download",
            asset_url=row.asset_thumbnail_url or row.asset_source_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))
    return items


def _fetch_freepik(db: Session, client_id: int) -> list[BufferFeedItem]:
    items: list[BufferFeedItem] = []

    generations = (
        db.query(FreepikGeneration)
        .filter(FreepikGeneration.linked_client_id == client_id)
        .order_by(FreepikGeneration.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    for row in generations:
        items.append(BufferFeedItem(
            id=f"freepik-generation-{row.id}",
            provider="freepik",
            kind="generation",
            media_type=_classify_freepik(row.tool, row.tool_name, row.mode, row.service, row.slug),
            title=row.prompt or row.input_prompt or row.name_field or "Freepik generation",
            asset_url=row.thumbnail_url or row.preview_url or row.large_preview_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))

    downloads = (
        db.query(FreepikDownload)
        .filter(FreepikDownload.linked_client_id == client_id)
        .order_by(FreepikDownload.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    for row in downloads:
        items.append(BufferFeedItem(
            id=f"freepik-download-{row.id}",
            provider="freepik",
            kind="download",
            media_type=MEDIA_IMAGE,
            title=row.asset_title or "Freepik download",
            asset_url=row.asset_thumbnail_url or row.asset_source_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))
    return items


def _fetch_generation_record_providers(db: Session, client_id: int) -> list[BufferFeedItem]:
    rows = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.linked_client_id == client_id,
            GenerationRecord.provider.notin_(GENERATION_RECORD_EXCLUDED_PROVIDERS),
        )
        .order_by(GenerationRecord.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    items: list[BufferFeedItem] = []
    for row in rows:
        provider = (row.provider or "unknown").lower()
        items.append(BufferFeedItem(
            id=f"{provider}-generation-{row.id}",
            provider=provider,
            kind="generation",
            media_type=GENERATION_RECORD_PROVIDER_MEDIA_TYPE.get(provider, MEDIA_OTHER),
            title=row.prompt_text or f"{provider.title()} generation",
            asset_url=row.canonical_asset_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))
    return items


def _fetch_epidemicsound(db: Session, client_id: int) -> list[BufferFeedItem]:
    items: list[BufferFeedItem] = []

    downloads = (
        db.query(EpidemicDownload)
        .filter(EpidemicDownload.linked_client_id == client_id)
        .order_by(EpidemicDownload.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    for row in downloads:
        items.append(BufferFeedItem(
            id=f"epidemicsound-download-{row.id}",
            provider="epidemic-sound",
            kind="download",
            media_type=MEDIA_AUDIO,
            title=row.asset_title or "Epidemic Sound download",
            asset_url=row.asset_source_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))

    adaptations = (
        db.query(EpidemicAdaptation)
        .filter(EpidemicAdaptation.linked_client_id == client_id)
        .order_by(EpidemicAdaptation.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    for row in adaptations:
        items.append(BufferFeedItem(
            id=f"epidemicsound-adaptation-{row.id}",
            provider="epidemic-sound",
            kind="generation",
            media_type=MEDIA_AUDIO,
            title=row.original_track_title or row.prompt or "Epidemic Sound adaptation",
            asset_url=row.media_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        ))
    return items


def _fetch_splice(db: Session, client_id: int) -> list[BufferFeedItem]:
    downloads = (
        db.query(SpliceDownload)
        .filter(SpliceDownload.linked_client_id == client_id)
        .order_by(SpliceDownload.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    return [
        BufferFeedItem(
            id=f"splice-download-{row.id}",
            provider="splice",
            kind="download",
            media_type=MEDIA_AUDIO,
            title=row.asset_title or "Splice download",
            asset_url=row.preview_mp3_url or row.asset_source_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        )
        for row in downloads
    ]


def _fetch_grammarly_docs(db: Session, client_id: int) -> list[BufferFeedItem]:
    sessions = (
        db.query(GrammarlyDocSession)
        .filter(GrammarlyDocSession.linked_client_id == client_id)
        .order_by(GrammarlyDocSession.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    return [
        BufferFeedItem(
            id=f"grammarly-docs-{row.id}",
            provider="grammarly",
            kind="generation",
            media_type=MEDIA_OTHER,
            title=row.doc_title or "Grammarly document",
            asset_url=row.doc_url or row.page_url,
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        )
        for row in sessions
    ]


def _fetch_self_uploads(db: Session) -> list[BufferFeedItem]:
    # No linked_client_id filter here - see BufferSelfUpload's own docstring
    # for why every row in this table is unconditionally Buffer content.
    rows = (
        db.query(BufferSelfUpload)
        .order_by(BufferSelfUpload.created_at.desc())
        .limit(SOURCE_FETCH_CAP)
        .all()
    )
    return [
        BufferFeedItem(
            id=f"self-upload-{row.id}",
            raw_id=row.id,
            provider="self-upload",
            kind="upload",
            media_type=row.media_type or MEDIA_OTHER,
            title=row.title or row.original_filename or "Self upload",
            asset_url=row.asset_url,
            file_path=row.file_path,
            tags=[tag.strip() for tag in (row.tags or "").split(",") if tag.strip()],
            owner_user_id=row.owner_user_id,
            created_at=row.created_at,
        )
        for row in rows
    ]


def _fetch_all(db: Session, client_id: int) -> list[BufferFeedItem]:
    items: list[BufferFeedItem] = []
    items.extend(_fetch_envato(db, client_id))
    items.extend(_fetch_freepik(db, client_id))
    items.extend(_fetch_generation_record_providers(db, client_id))
    items.extend(_fetch_epidemicsound(db, client_id))
    items.extend(_fetch_splice(db, client_id))
    items.extend(_fetch_grammarly_docs(db, client_id))
    items.extend(_fetch_self_uploads(db))
    return items


def _resolve_owner_names(db: Session, items: list[BufferFeedItem]) -> None:
    """Sets .owner_name on each item in place - one batched User query for
    every distinct owner on the page, instead of a per-item lookup (or,
    worse, leaving the frontend to show the bare ownerUserId as "User #N",
    which is what it fell back to before this existed)."""
    owner_ids = {item.owner_user_id for item in items if item.owner_user_id}
    if not owner_ids:
        return

    names_by_id = {
        user_id: name
        for user_id, name in db.query(User.id, User.name).filter(User.id.in_(owner_ids)).all()
    }
    for item in items:
        if item.owner_user_id:
            item.owner_name = names_by_id.get(item.owner_user_id)


def get_buffer_feed(
    db: Session,
    *,
    client_id: int,
    media_type: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 24,
    offset: int = 0,
) -> dict:
    """Merged, filtered, paginated Buffer feed, plus per-media-type counts for
    the filter chip badges - both computed from the same single fetch so a
    page load only does one round of DB queries, not two."""
    all_items = _fetch_all(db, client_id)

    counts = {media: 0 for media in ALL_MEDIA_TYPES}
    for item in all_items:
        counts[item.media_type] = counts.get(item.media_type, 0) + 1
    counts["all"] = len(all_items)

    filtered = all_items
    if media_type and media_type in ALL_MEDIA_TYPES:
        filtered = [item for item in filtered if item.media_type == media_type]

    normalized_q = (q or "").strip().lower()
    if normalized_q:
        filtered = [item for item in filtered if normalized_q in (item.title or "").lower()]

    filtered.sort(key=lambda item: item.created_at or datetime.min, reverse=True)

    total = len(filtered)
    page = filtered[offset:offset + limit]
    _resolve_owner_names(db, page)
    return {
        "items": [item.to_dict() for item in page],
        "total": total,
        "counts": counts,
    }
