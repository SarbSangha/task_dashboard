"""One live-sheet build per distinct request (utils/credit_report/live_cache.py).

Run from backend/:  python tests/live_cache_smoke.py

Checks:
  * concurrent callers with the same key share one build;
  * a finished build is reused within the TTL, rebuilt after it or on `fresh`;
  * different keys build separately;
  * a failed build reaches every waiter and is not kept.
"""

import sys
import threading
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import utils.credit_report.live_cache as C  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


calls = []


def slow_build(value, delay=0.3):
    def build():
        calls.append(value)
        time.sleep(delay)
        return {"value": value}
    return build


results = []
threads = [threading.Thread(target=lambda: results.append(C.shared_build("k1", slow_build("a")))) for _ in range(5)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check(calls == ["a"] and len(results) == 5 and all(r is results[0] for r in results),
      "5 concurrent callers share one build")

check(C.shared_build("k1", slow_build("b")) is results[0] and calls == ["a"], "a finished build is reused")
check(C.shared_build("k1", slow_build("c"), fresh=True)["value"] == "c" and calls == ["a", "c"], "fresh rebuilds")
check(C.shared_build("k2", slow_build("d"))["value"] == "d" and calls[-1] == "d", "another key builds separately")

C.TTL_SECONDS = 0.2
time.sleep(0.25)
check(C.shared_build("k1", slow_build("e"))["value"] == "e", "rebuilt once the TTL has passed")


def failing():
    calls.append("boom")
    time.sleep(0.2)
    raise RuntimeError("db down")


errors = []


def call_failing():
    try:
        C.shared_build("k3", failing)
    except RuntimeError as exc:
        errors.append(str(exc))


threads = [threading.Thread(target=call_failing) for _ in range(3)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check(errors == ["db down"] * 3 and calls.count("boom") == 1, "a failed build reaches every waiter")
check(C.shared_build("k3", slow_build("f"))["value"] == "f", "a failure is not kept")
print("\nALL LIVE CACHE CHECKS PASSED")
