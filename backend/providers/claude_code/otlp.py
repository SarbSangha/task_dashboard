# providers/claude_code/otlp.py
"""
Turns an OTLP/HTTP JSON ExportLogsServiceRequest from Claude Code into the
prompt and request rows this provider stores. Pure functions - no database.

Shape (only what's read here):

  {"resourceLogs": [{
     "resource": {"attributes": [{"key": "service.version", "value": {"stringValue": "2.1.290"}}]},
     "scopeLogs": [{"logRecords": [{
        "timeUnixNano": "1793251538187000000",
        "body": {"stringValue": "claude_code.api_request"},
        "attributes": [{"key": "event.name", "value": {"stringValue": "api_request"}},
                       {"key": "prompt.id", "value": {"stringValue": "..."}},
                       {"key": "input_tokens", "value": {"intValue": "1234"}}, ...]}]}]}]}

Attribute names follow Claude Code's monitoring docs (code.claude.com/docs/en/monitoring-usage).
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from providers.claude_code.constants import MAX_PROMPT_TEXT_CHARS, REDACTED_PROMPT


@dataclass
class ParsedPrompt:
    uid: str
    session_id: Optional[str]
    occurred_at: datetime
    text: str
    length: int
    command_name: Optional[str]
    terminal_type: Optional[str]
    account_email: Optional[str]
    claude_version: Optional[str]


@dataclass
class ParsedRequest:
    uid: str
    prompt_uid: Optional[str]
    session_id: Optional[str]
    occurred_at: datetime
    model: Optional[str]
    cost_usd: Optional[float]
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    duration_ms: Optional[int]
    terminal_type: Optional[str]
    account_email: Optional[str]
    claude_version: Optional[str]


@dataclass
class ParsedBatch:
    prompts: list[ParsedPrompt] = field(default_factory=list)
    requests: list[ParsedRequest] = field(default_factory=list)
    ignored: int = 0


def _any_value(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    if "stringValue" in value:
        return value["stringValue"]
    if "intValue" in value:
        return value["intValue"]  # int64 arrives as a string in OTLP JSON
    if "doubleValue" in value:
        return value["doubleValue"]
    if "boolValue" in value:
        return bool(value["boolValue"])
    if "arrayValue" in value:
        return [_any_value(v) for v in (value["arrayValue"] or {}).get("values") or []]
    if "kvlistValue" in value:
        return _attrs((value["kvlistValue"] or {}).get("values"))
    return None


def _attrs(items: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kv in items or []:
        if isinstance(kv, dict) and kv.get("key"):
            out[kv["key"]] = _any_value(kv.get("value"))
    return out


def _int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def _float_or_none(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _str(value: Any, limit: int) -> Optional[str]:
    if value is None or value == "":
        return None
    return str(value)[:limit]


def _nanos_to_utc(value: Any) -> Optional[datetime]:
    try:
        nanos = int(value)
    except (TypeError, ValueError):
        return None
    if nanos <= 0:
        return None
    return datetime.fromtimestamp(nanos / 1e9, tz=timezone.utc).replace(tzinfo=None)


def _iso_to_utc(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _where(a: dict[str, Any], resource: dict[str, Any]) -> Optional[str]:
    """Where Claude Code ran, kept in the terminal_type column.

    terminal.type names the terminal, but Claude Code in the VS Code chat panel
    (and the SDKs) runs without one and reports "non-interactive" - confirmed on
    2.1.312. app.entrypoint ("claude-vscode", "sdk-ts", ...; sent when
    OTEL_METRICS_INCLUDE_ENTRYPOINT=true, which extension 1.5.1+ writes) says
    which app launched it, so it wins there. A CLI run keeps its terminal
    ("vscode" for VS Code's integrated terminal, "windows-terminal", ...).
    A classic CMD/PowerShell window on Windows 10 matches none of Claude Code's
    terminal checks, so it sends no terminal.type - its "cli" entrypoint still
    says it ran in a terminal.
    """
    terminal = a.get("terminal.type") or resource.get("terminal.type")
    entrypoint = a.get("app.entrypoint") or resource.get("app.entrypoint")
    if entrypoint and entrypoint != "cli" and (not terminal or terminal == "non-interactive"):
        return entrypoint
    return terminal or entrypoint


def _epoch_ms(value: datetime) -> int:
    return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000)


def parse_logs(body: dict[str, Any], now: Optional[datetime] = None) -> ParsedBatch:
    batch = ParsedBatch()
    now = now or datetime.utcnow()
    for resource_logs in body.get("resourceLogs") or []:
        resource = _attrs((resource_logs.get("resource") or {}).get("attributes"))
        for scope_logs in resource_logs.get("scopeLogs") or []:
            for record in scope_logs.get("logRecords") or []:
                a = _attrs(record.get("attributes"))
                body_value = _any_value(record.get("body"))
                name = str(a.get("event.name") or body_value or "").removeprefix("claude_code.")
                occurred_at = (
                    _iso_to_utc(a.get("event.timestamp"))
                    or _nanos_to_utc(record.get("timeUnixNano"))
                    or _nanos_to_utc(record.get("observedTimeUnixNano"))
                    or now
                )
                session_id = _str(a.get("session.id") or resource.get("session.id"), 160)
                common = {
                    "session_id": session_id,
                    "occurred_at": occurred_at,
                    "terminal_type": _str(_where(a, resource), 80),
                    "account_email": _str(a.get("user.email") or resource.get("user.email"), 255),
                    "claude_version": _str(resource.get("service.version") or a.get("app.version"), 40),
                }
                prompt_uid = _str(a.get("prompt.id"), 200)

                if name == "user_prompt":
                    # Newer Claude Code also sends prompt_text; either is redacted
                    # unless OTEL_LOG_USER_PROMPTS=1.
                    text = ""
                    for key in ("prompt_text", "prompt"):
                        candidate = a.get(key)
                        if isinstance(candidate, str) and candidate and candidate != REDACTED_PROMPT:
                            text = candidate
                            break
                    batch.prompts.append(ParsedPrompt(
                        uid=prompt_uid or f"{session_id}:{_epoch_ms(occurred_at)}"[:200],
                        text=text[:MAX_PROMPT_TEXT_CHARS],
                        length=_int(a.get("prompt_length")) or len(text),
                        command_name=_str(a.get("command_name"), 120),
                        **common,
                    ))
                elif name == "api_request":
                    model = _str(a.get("model"), 120)
                    tokens = {
                        "input_tokens": _int(a.get("input_tokens")),
                        "output_tokens": _int(a.get("output_tokens")),
                        "cache_read_tokens": _int(a.get("cache_read_tokens")),
                        "cache_write_tokens": _int(a.get("cache_creation_tokens")),
                    }
                    uid = _str(a.get("request_id"), 255) or (
                        f"{session_id}:{_epoch_ms(occurred_at)}:{model}:"
                        f"{tokens['input_tokens']}:{tokens['output_tokens']}:{tokens['cache_read_tokens']}"
                    )[:255]
                    cost = _float_or_none(a.get("cost_usd"))
                    if cost is None and a.get("cost_usd_micros") is not None:
                        micros = _float_or_none(a.get("cost_usd_micros"))
                        cost = micros / 1e6 if micros is not None else None
                    duration = _float_or_none(a.get("duration_ms"))
                    batch.requests.append(ParsedRequest(
                        uid=uid,
                        prompt_uid=prompt_uid,
                        model=model,
                        cost_usd=cost,
                        duration_ms=int(duration) if duration is not None else None,
                        **tokens,
                        **common,
                    ))
                else:
                    batch.ignored += 1
    return batch
