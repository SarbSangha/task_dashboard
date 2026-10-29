# providers/cursor/matching.py
"""
Ties each request in Cursor's usage CSV to the prompt it came from.

Cursor's export is account-wide and says nothing about which person/computer
made a request, while each CursorPrompt knows who sent it and when. A request
goes to whoever had a prompt running at that moment:

  1. Only one person had a prompt running -> theirs.
  2. Several people did -> if only some of them were on the request's model,
     it's theirs (a prompt with an unknown model can't be ruled out).
  3. Still several -> split between them by their own local token counts, or
     by agent steps when those are 0 (always, on Cursor 3); marked "shared".

Cursor bills one request per prompt but can log it up to ~15s before the
prompt appears locally (EARLY_EVENT_MS) - so when the running prompt already
has its request and the same person sends another prompt moments later, the
request belongs to that next prompt. That only ever moves a request between
two prompts of the SAME person, so it never changes the per-person split.

Pure functions over plain values (epoch ms), no DB access - see queries.py.
"""
from dataclasses import dataclass, field
from typing import Optional

from providers.cursor.constants import EARLY_EVENT_MS, MATCH_GRACE_MS, MAX_PROMPT_SPAN_MS

LOOKBACK_PROMPTS = 60


@dataclass
class PromptSlot:
    id: int
    person: int
    ts: int
    end_ts: Optional[int]
    models: list[str]
    steps: int = 0
    local_tokens: int = 0
    matches: list = field(default_factory=list)  # [(UsageSlot, weight, shared)]


@dataclass
class UsageSlot:
    id: int
    ts: int
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_cents: Optional[float]

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens


def _model_matches(prompt_models: list[str], event_model: str) -> bool:
    if not prompt_models:
        return True
    em = (event_model or "").lower()
    for model in prompt_models:
        lm = str(model).lower()
        if lm == em or lm in em or em in lm:
            return True
    return False


def match_usage(prompts: list[PromptSlot], events: list[UsageSlot]) -> list[UsageSlot]:
    """Fills each prompt's .matches and returns the requests no prompt claimed."""
    rows = sorted(prompts, key=lambda p: p.ts)
    unmatched: list[UsageSlot] = []
    j = 0
    for e in sorted(events, key=lambda ev: ev.ts):
        while j + 1 < len(rows) and rows[j + 1].ts <= e.ts:
            j += 1

        running: dict[int, PromptSlot] = {}
        k = j
        while rows and k >= 0 and k > j - LOOKBACK_PROMPTS:
            r = rows[k]
            k -= 1
            if r.ts > e.ts or r.person in running:
                continue
            end = min(max(r.end_ts or r.ts, r.ts) + MATCH_GRACE_MS, r.ts + MAX_PROMPT_SPAN_MS)
            if e.ts <= end:
                running[r.person] = r

        upcoming: dict[int, PromptSlot] = {}
        k = j
        while k < len(rows) and rows[k].ts <= e.ts + EARLY_EVENT_MS:
            r = rows[k]
            if r.ts > e.ts and r.person not in upcoming:
                upcoming[r.person] = r
            k += 1

        hits = [upcoming[r.person] if r.matches and r.person in upcoming else r for r in running.values()]
        if not hits:
            hits = list(upcoming.values())

        if len(hits) > 1:
            by_model = [r for r in hits if _model_matches(r.models, e.model)]
            if by_model:
                hits = by_model

        if len(hits) == 1:
            hits[0].matches.append((e, 1.0, False))
        elif hits:
            weights = [r.local_tokens for r in hits]
            if not any(weights):
                weights = [r.steps or 1 for r in hits]
            total = sum(weights)
            for r, weight in zip(hits, weights):
                r.matches.append((e, weight / total, True))
        else:
            unmatched.append(e)
    return unmatched


def summarize_prompt(slot: PromptSlot) -> dict:
    """Per-prompt usage once matched. tokens/cost are None (unknown, not zero)
    when no CSV request was tied to the prompt."""
    if not slot.matches:
        return {
            "requests": 0,
            "shared": False,
            "models": slot.models,
            "tokens": None,
            "costCents": None,
            "costKnown": False,
        }
    tokens = {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0}
    cost = 0.0
    cost_known = True
    models: list[str] = []
    shared = False
    for event, weight, is_shared in slot.matches:
        shared = shared or is_shared
        tokens["input"] += event.input_tokens * weight
        tokens["output"] += event.output_tokens * weight
        tokens["cacheRead"] += event.cache_read_tokens * weight
        tokens["cacheWrite"] += event.cache_write_tokens * weight
        if event.cost_cents is None:
            cost_known = False
        else:
            cost += event.cost_cents * weight
        if event.model and event.model not in models:
            models.append(event.model)
    rounded = {key: int(round(value)) for key, value in tokens.items()}
    rounded["total"] = sum(rounded.values())
    return {
        "requests": len(slot.matches),
        "shared": shared,
        "models": models,
        "tokens": rounded,
        "costCents": round(cost, 4),
        "costKnown": cost_known,
    }
