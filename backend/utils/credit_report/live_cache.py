"""One live-sheet build per distinct request, shared by every caller.

The Home page and the Usage & Spend report ask for the same period at the
same time, and a request the browser cancels keeps running on the server.
Each full build reads every tool's table twice (current and previous
period), so two at once slowed both and held the browser's few connections
to the API, queueing every other call behind them.

A caller asking for a report that is already being built waits for that
build instead of starting another, and a finished report is reused for
TTL_SECONDS. The payload does not depend on who asks (the endpoint checks
access first), so it is shared across users. `fresh` skips a finished
report (the Refresh button) but still joins one being built.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Hashable

TTL_SECONDS = 30
MAX_ENTRIES = 16


class _Flight:
    def __init__(self):
        self.done = threading.Event()
        self.result = None
        self.error = None


_lock = threading.Lock()
_running: dict = {}
_finished: dict = {}       # key -> (finished at, payload)


def shared_build(key: Hashable, build: Callable[[], dict], fresh: bool = False) -> dict:
    """The payload for `key`: a recent one, the one being built, or a new
    build. The returned dict is shared - callers must not modify it."""
    with _lock:
        now = time.monotonic()
        hit = _finished.get(key)
        if hit and not fresh and now - hit[0] < TTL_SECONDS:
            return hit[1]
        flight = _running.get(key)
        owner = flight is None
        if owner:
            flight = _running[key] = _Flight()
    if not owner:
        flight.done.wait()
        if flight.error is not None:
            raise flight.error
        return flight.result
    try:
        flight.result = build()
        return flight.result
    except BaseException as exc:
        flight.error = exc
        raise
    finally:
        with _lock:
            _running.pop(key, None)
            if flight.error is None:
                _finished[key] = (time.monotonic(), flight.result)
                # Drop expired entries, then the oldest beyond the cap.
                cutoff = time.monotonic() - TTL_SECONDS
                for k in [k for k, (at, _p) in _finished.items() if at < cutoff]:
                    del _finished[k]
                while len(_finished) > MAX_ENTRIES:
                    del _finished[min(_finished, key=lambda k: _finished[k][0])]
        flight.done.set()
