import asyncio
from utils.cache import purge_edge_cache


def _normalize_patterns(patterns):
    normalized = []
    for pattern in patterns or []:
        value = f"{pattern or ''}".strip()
        if value and value not in normalized:
            normalized.append(value)
    return normalized


def queue_edge_cache_purge(patterns):
    normalized_patterns = _normalize_patterns(patterns)
    if not normalized_patterns:
        return

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    async def _runner():
        await purge_edge_cache(normalized_patterns)

    loop.create_task(_runner())
