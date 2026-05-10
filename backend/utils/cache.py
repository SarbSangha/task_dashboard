import hashlib
import json
import logging
import os
from functools import wraps

from fastapi import Request

try:
    import redis.asyncio as redis
except ImportError:  # pragma: no cover - graceful fallback when dependency is absent
    redis = None

try:
    import httpx
except ImportError:  # pragma: no cover - graceful fallback when dependency is absent
    httpx = None


logger = logging.getLogger(__name__)
redis_client = None


def _normalize_namespace(value: str | None) -> str:
    raw = (value or "").strip().lower()
    if not raw:
        return "default"
    normalized = "".join(ch if ch.isalnum() else "_" for ch in raw)
    return normalized.strip("_") or "default"


def _resolve_request(args, kwargs):
    request = kwargs.get("request")
    if isinstance(request, Request):
        return request

    for arg in args:
        if isinstance(arg, Request):
            return arg
    return None


def _build_cache_key(
    request: Request,
    vary_by_user: bool,
    namespace: str | None = None,
) -> str:
    key_parts = [request.url.path, str(sorted(request.query_params.items()))]
    if vary_by_user:
        session_token = (
            request.cookies.get("session_id")
            or request.headers.get("X-Session-Id")
            or "anon"
        )
        key_parts.append(session_token)
    digest = hashlib.sha256(":".join(key_parts).encode("utf-8")).hexdigest()[:20]
    resolved_namespace = _normalize_namespace(namespace or request.url.path)
    return f"cache:{resolved_namespace}:{digest}"


async def init_redis(url: str | None = None):
    global redis_client

    configured_url = os.getenv("REDIS_URL")
    if url is not None:
        redis_url = url.strip()
    elif configured_url is not None:
        redis_url = configured_url.strip()
    else:
        redis_url = "redis://localhost:6379"
    if not redis_url or redis is None:
        if redis is None:
            logger.warning("Redis dependency is not installed; response caching is disabled.")
        redis_client = None
        return None

    try:
        client = redis.from_url(redis_url, decode_responses=True)
        await client.ping()
        redis_client = client
        logger.info("Redis cache connected.")
        return redis_client
    except Exception as exc:  # pragma: no cover - depends on runtime infra
        logger.warning("Redis unavailable; response caching disabled: %s", exc)
        redis_client = None
        return None


async def close_redis():
    global redis_client

    if redis_client is None:
        return

    try:
        await redis_client.aclose()
    except Exception as exc:  # pragma: no cover - depends on runtime infra
        logger.warning("Error while closing Redis client: %s", exc)
    finally:
        redis_client = None


async def invalidate_pattern(pattern: str):
    """Delete all Redis cache keys matching a pattern."""
    if redis_client is None:
        return

    keys = []
    try:
        async for key in redis_client.scan_iter(match=pattern):
            keys.append(key)
        if keys:
            await redis_client.delete(*keys)
    except Exception as exc:  # pragma: no cover - depends on runtime infra
        logger.warning("Redis invalidation failed for %s: %s", pattern, exc)


async def purge_edge_cache(
    patterns: list[str],
    worker_purge_url: str | None = None,
    secret: str | None = None,
):
    """Call a purge endpoint on the Cloudflare Worker."""
    normalized_patterns = []
    for pattern in patterns or []:
        value = f"{pattern or ''}".strip()
        if value and value not in normalized_patterns:
            normalized_patterns.append(value)

    resolved_url = (worker_purge_url or os.getenv("EDGE_CACHE_PURGE_URL") or "").strip()
    resolved_secret = (secret or os.getenv("EDGE_CACHE_PURGE_SECRET") or "").strip()

    if httpx is None or not resolved_url or not resolved_secret or not normalized_patterns:
        return False

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.post(
                resolved_url,
                json={"patterns": normalized_patterns},
                headers={"X-Purge-Secret": resolved_secret},
            )
            response.raise_for_status()
        return True
    except Exception as exc:  # pragma: no cover - depends on runtime infra
        logger.warning("Edge cache purge failed: %s", exc)
        return False


def cache_response(
    ttl: int = 120,
    vary_by_user: bool = True,
    namespace: str | None = None,
):
    """Cache FastAPI GET endpoint responses in Redis when available."""

    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            request = _resolve_request(args, kwargs)
            if request is None:
                return await func(*args, **kwargs)

            key = _build_cache_key(request, vary_by_user, namespace=namespace)

            if redis_client is not None:
                try:
                    cached = await redis_client.get(key)
                    if cached:
                        return json.loads(cached)
                except Exception as exc:  # pragma: no cover - depends on runtime infra
                    logger.warning("Redis read failed for %s: %s", key, exc)

            result = await func(*args, **kwargs)

            if redis_client is not None:
                try:
                    await redis_client.setex(key, ttl, json.dumps(result, default=str))
                except Exception as exc:  # pragma: no cover - depends on runtime infra
                    logger.warning("Redis write failed for %s: %s", key, exc)

            return result

        return wrapper

    return decorator
