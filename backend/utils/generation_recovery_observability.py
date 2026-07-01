from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, SQLAlchemyError


LOGGER = logging.getLogger("generation_recovery")

RECONCILIATION_DURATION_METRIC = "reconciliation_duration_ms"
IMPORT_DURATION_METRIC = "import_duration_ms"
PREVIEW_DURATION_METRIC = "missing_preview_duration_ms"


class _DurationSummary:
    def __init__(self) -> None:
        self.count = 0
        self.total_ms = 0
        self.min_ms: int | None = None
        self.max_ms = 0

    def observe(self, duration_ms: int) -> None:
        normalized = max(int(duration_ms), 0)
        self.count += 1
        self.total_ms += normalized
        self.max_ms = max(self.max_ms, normalized)
        self.min_ms = normalized if self.min_ms is None else min(self.min_ms, normalized)

    def snapshot(self) -> dict[str, int | float]:
        average_ms = round(self.total_ms / self.count, 2) if self.count else 0.0
        return {
            "count": self.count,
            "total_ms": self.total_ms,
            "min_ms": self.min_ms or 0,
            "max_ms": self.max_ms,
            "avg_ms": average_ms,
        }


class _RecoveryMetricsRegistry:
    def __init__(self) -> None:
        self._lock = Lock()
        self._counters = defaultdict(int)
        self._durations = defaultdict(_DurationSummary)

    def increment(self, metric_name: str, value: int = 1) -> None:
        with self._lock:
            self._counters[metric_name] += int(value)

    def observe_duration(self, metric_name: str, duration_ms: int) -> None:
        with self._lock:
            self._durations[metric_name].observe(duration_ms)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            counters = dict(sorted(self._counters.items()))
            durations = {
                name: summary.snapshot()
                for name, summary in sorted(self._durations.items())
            }
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "counters": counters,
            "durations": durations,
        }

    def reset(self) -> None:
        with self._lock:
            self._counters.clear()
            self._durations.clear()


_METRICS = _RecoveryMetricsRegistry()


def reset_generation_recovery_metrics() -> None:
    _METRICS.reset()


def get_generation_recovery_metrics_snapshot() -> dict[str, Any]:
    return _METRICS.snapshot()


def increment_metric(metric_name: str, value: int = 1) -> None:
    _METRICS.increment(metric_name, value)


def observe_duration(metric_name: str, duration_ms: int) -> None:
    _METRICS.observe_duration(metric_name, duration_ms)


def classify_generation_recovery_error(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        if exc.status_code in {401, 403}:
            return "authorization_error"
        detail = f"{exc.detail}".lower()
        if "identity" in detail:
            return "identity_missing"
        if "duplicate" in detail:
            return "duplicate"
        if exc.status_code < 500:
            return "validation_error"
        return "unexpected_error"
    if isinstance(exc, IntegrityError):
        return "duplicate"
    if isinstance(exc, SQLAlchemyError):
        return "database_error"
    if isinstance(exc, (LookupError, ValueError)):
        detail = f"{exc}".lower()
        if "identity" in detail:
            return "identity_missing"
        if "duplicate" in detail:
            return "duplicate"
        return "validation_error"
    return "unexpected_error"


def emit_recovery_log(event: str, **payload: Any) -> None:
    message = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **payload,
    }
    LOGGER.info(json.dumps(message, sort_keys=True, default=str))
