"""Admin card edits for the per-provider Capture Center generation cards
(Freepik, Higgsfield, HeyGen, Suno, ElevenLabs, Envato, Flow) - the same
"replace the media / delete the card" admin tools Kling's cards have (see
routers/generation_records_router.py), generalized across providers.

State lives in each generations table's own admin_edit_json/archived_at
columns rather than metadata_json (Kling's choice), because every one of
these providers' normalization rewrites metadata_json wholesale on each
capture, which would silently drop an admin's uploaded media."""
from typing import Optional

from utils import r2_storage

ADMIN_MEDIA_URL_TTL_SECONDS = 6 * 60 * 60

# extension -> (content type, media kind)
ADMIN_MEDIA_EXTENSIONS = {
    ".mp4": ("video/mp4", "video"),
    ".webm": ("video/webm", "video"),
    ".mov": ("video/quicktime", "video"),
    ".jpg": ("image/jpeg", "image"),
    ".jpeg": ("image/jpeg", "image"),
    ".png": ("image/png", "image"),
    ".webp": ("image/webp", "image"),
    ".gif": ("image/gif", "image"),
    ".mp3": ("audio/mpeg", "audio"),
    ".wav": ("audio/wav", "audio"),
    ".m4a": ("audio/mp4", "audio"),
    ".ogg": ("audio/ogg", "audio"),
}


def admin_media_payload(admin_edit_json) -> Optional[dict]:
    """The card's admin-uploaded media with a freshly minted URL, or None.
    The bucket is private, so the URL is minted per response, never stored."""
    media = admin_edit_json.get("media") if isinstance(admin_edit_json, dict) else None
    key = media.get("key") if isinstance(media, dict) else None
    if not key:
        return None
    try:
        if not r2_storage.is_configured():
            return None
        url = r2_storage.generate_presigned_url(
            key, expires_in=ADMIN_MEDIA_URL_TTL_SECONDS, client=r2_storage.shared_client(), inline=True,
        )
    except Exception:
        return None
    return {
        "url": url,
        "kind": media.get("kind"),
        "fileName": media.get("fileName"),
        "contentType": media.get("contentType"),
        "sizeBytes": media.get("sizeBytes"),
        "uploadedAt": media.get("uploadedAt"),
    }
