# utils/r2_storage.py
"""
Minimal, provider-agnostic R2 (Cloudflare's S3-compatible object storage)
helpers for writing bytes we fetched from somewhere else and reading them
back - the pattern asset-mirroring jobs need (see
providers/freepik/asset_mirror.py, the first caller).

The bucket is PRIVATE (confirmed 2026-08-05 by hitting build_public_url's
own output directly and getting a raw S3 "access denied"-style XML error,
not an image) - same bucket routers/upload.py already uses for task
attachments, which never hands the browser a permanent public link either;
it always mints a short-lived presigned GET URL per request (see its
/api/files/open, ExpiresIn=600). generate_presigned_url below is that same
pattern, so a mirrored asset's "public" URL is always freshly signed at
serialization time (see FreepikGeneration.to_dict()/HeygenGeneration.
to_dict()) rather than a permanently-stored link that would have quietly
been broken from the moment it was written. build_public_url is kept for
whichever future bucket genuinely IS public (R2_PUBLIC_BASE_URL set) - it's
just not what THIS bucket is.

This deliberately does NOT import from routers/upload.py, which already has
its own inline R2 client/env helpers for task attachments: routers/ sits
above providers/ and utils/ in this codebase's dependency direction (routers
call into providers and utils, never the other way around), so a
provider-layer module importing a router module would invert that. Both
modules read the exact same R2_* env vars and bucket, so they stay two
implementations of the same config, not two different storage backends -
the small duplication here is the deliberate tradeoff for keeping the layers
one-directional. If a third caller shows up, promote this module (or extract
routers/upload.py's helpers into it) to be the single shared implementation.
"""
import os
from typing import Optional

import boto3

DEFAULT_PRESIGNED_URL_TTL_SECONDS = 600  # matches routers/upload.py's own file-serving presigned URLs


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name, default)
    if value is None:
        return None
    value = value.strip()
    return value or default


def is_configured() -> bool:
    return all([_env("R2_ENDPOINT"), _env("R2_ACCESS_KEY"), _env("R2_SECRET_KEY"), _env("R2_BUCKET")])


def build_client():
    return boto3.client(
        "s3",
        endpoint_url=_env("R2_ENDPOINT"),
        aws_access_key_id=_env("R2_ACCESS_KEY"),
        aws_secret_access_key=_env("R2_SECRET_KEY"),
        region_name=_env("R2_REGION", "auto"),
    )


def build_public_url(key: str) -> str:
    """Only correct for a bucket actually configured for public reads
    (R2_PUBLIC_BASE_URL set to a public custom domain/R2.dev URL). Without
    that, this falls back to the private S3 API endpoint, which will 400/403
    an anonymous browser request - see generate_presigned_url for the
    private-bucket case, which is what this app's bucket actually is today."""
    public_base = _env("R2_PUBLIC_BASE_URL")
    if public_base:
        return f"{public_base.rstrip('/')}/{key}"
    endpoint = _env("R2_ENDPOINT", "") or ""
    bucket = _env("R2_BUCKET", "") or ""
    return f"{endpoint.rstrip('/')}/{bucket}/{key}"


def put_object(key: str, data: bytes, *, content_type: str = "application/octet-stream", client=None) -> None:
    """Uploads `data` to `key`. Raises whatever botocore raises on failure -
    callers own deciding how to handle that (e.g. asset_mirror.py records it
    per-row instead of letting one bad upload take down a whole sweep)."""
    active_client = client or build_client()
    active_client.put_object(
        Bucket=_env("R2_BUCKET"),
        Key=key,
        Body=data,
        ContentType=content_type or "application/octet-stream",
    )


def upload_bytes(key: str, data: bytes, *, content_type: str = "application/octet-stream", client=None) -> str:
    """Uploads `data` to `key` and returns build_public_url(key) - only ever
    actually browser-loadable if the bucket is genuinely public (see that
    function's docstring). Prefer put_object() + generate_presigned_url()
    for a private bucket, which is what R2 buckets in this codebase default
    to unless proven otherwise."""
    put_object(key, data, content_type=content_type, client=client)
    return build_public_url(key)


def generate_presigned_url(key: str, *, expires_in: int = DEFAULT_PRESIGNED_URL_TTL_SECONDS, client=None) -> str:
    """Mints a short-lived, browser-loadable GET URL for a private-bucket
    object - the correct way to serve a permanently-stored R2 key back to
    the browser (mirrors routers/upload.py's own /api/files/open). Callers
    should generate this fresh at serialization time, never persist it: it
    expires in `expires_in` seconds regardless of how long the underlying
    object itself lives."""
    active_client = client or build_client()
    return active_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": _env("R2_BUCKET"), "Key": key},
        ExpiresIn=expires_in,
    )
