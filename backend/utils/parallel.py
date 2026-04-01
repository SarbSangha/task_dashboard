import asyncio
from concurrent.futures import ThreadPoolExecutor


executor = ThreadPoolExecutor(max_workers=10)


async def run_parallel(*fns):
    """Run multiple sync functions in parallel using a shared thread pool."""
    loop = asyncio.get_running_loop()
    tasks = [loop.run_in_executor(executor, fn) for fn in fns]
    return await asyncio.gather(*tasks)
