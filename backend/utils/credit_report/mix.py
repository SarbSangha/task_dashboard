"""
Credit Consumption Report - "tool mix" rules: most / least used, whole
percentages and the sentences that say them.

One rule everywhere: "most used" = most items generated (Charged rows, the
same scope as every total: Kling recorded-twice removed, uploads and test
accounts left out). Credits are never compared: a Kling credit is not a
Freepik credit. Rupees are shown next to every count but do not rank.

* Ties are reported together ("Kling and Freepik (40% each)").
* One tool on its own is the "only tool used" - it has no "least used".
* Percentages are whole numbers that add up to exactly 100
  (largest-remainder rounding), so a split never reads 99% or 101%. A
  share that was used but rounds to 0 reads "<1%", never "0%".

Pure functions only (no openpyxl), so the wording is unit-tested directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Optional

ONLY_TOOL = "only tool used"


def whole_percents(counts: dict) -> dict:
    """{key: whole %} adding up to 100 (largest remainder; ties to the
    bigger count, then the key's order in ``counts``). Zero counts get 0."""
    total = sum(v for v in counts.values() if v > 0)
    if total <= 0:
        return {k: 0 for k in counts}
    exact = {k: (v * 100 / total if v > 0 else 0.0) for k, v in counts.items()}
    out = {k: int(x) for k, x in exact.items()}
    short = 100 - sum(out.values())
    pos = {k: i for i, k in enumerate(counts)}
    for k in sorted((k for k in counts if counts[k] > 0),
                    key=lambda k: (-(exact[k] - out[k]), -counts[k], pos[k]))[:short]:
        out[k] += 1
    return out


def pct_text(pct: int, value: float = 1) -> str:
    """'60%'; a used share that rounds to 0 is '<1%'; nothing at all is '0%'."""
    return "<1%" if pct == 0 and value > 0 else f"{pct}%"


@dataclass(frozen=True)
class Share:
    """One entry of a split: its items, ₹ and whole %."""
    key: object
    name: str
    items: int
    rupees: float
    pct: int

    @property
    def pct_text(self) -> str:
        return pct_text(self.pct, self.items)


def split(items: dict, rupees: Optional[dict] = None, name_of: Callable = str) -> list:
    """[Share], most items first (then ₹, then name); zero-item keys left out."""
    rupees = rupees or {}
    kept = {k: v for k, v in items.items() if v > 0}
    order = sorted(kept, key=lambda k: (-kept[k], -round(rupees.get(k, 0.0), 2), str(name_of(k)).lower()))
    pcts = whole_percents({k: kept[k] for k in order})
    return [Share(k, str(name_of(k)), kept[k], float(rupees.get(k, 0.0)), pcts[k]) for k in order]


def most(shares: list) -> list:
    """Every share tied for the most items."""
    return [s for s in shares if shares and s.items == shares[0].items]


def least(shares: list) -> list:
    """Every share tied for the fewest items - empty when everything is tied
    for the most (one tool, or all equal: nothing is 'least')."""
    if not shares:
        return []
    low = shares[-1].items
    if low == shares[0].items:
        return []
    return [s for s in shares if s.items == low]


def names(shares: Iterable) -> str:
    """'Kling', 'Kling and Freepik', 'Kling, Freepik and HeyGen'."""
    xs = [s.name for s in shares]
    if len(xs) <= 1:
        return "".join(xs)
    return ", ".join(xs[:-1]) + " and " + xs[-1]


def with_pct(shares: list) -> str:
    """'Kling (60%)' or, for a tie, 'Kling and Freepik (40% each)'."""
    if not shares:
        return "—"
    pct = shares[0].pct_text
    if len(shares) == 1:
        return f"{shares[0].name} ({pct})"
    if all(s.pct_text == pct for s in shares):
        return f"{names(shares)} ({pct} each)"
    return names(shares) + " (" + ", ".join(s.pct_text for s in shares) + ")"


def label(share: Share, shares: list) -> str:
    """'Most used' / 'Least used' / 'Only tool used' / '' for one row of a split."""
    if len(shares) == 1:
        return "Only tool used"
    if share in most(shares):
        return "Most used" if len(most(shares)) == 1 else "Most used (tie)"
    lows = least(shares)
    if share in lows:
        return "Least used" if len(lows) == 1 else "Least used (tie)"
    return ""


def most_least(shares: list, noun: str = "tool") -> str:
    """'Most used tool: Kling (60%); least used: HeyGen (1%)', ties together,
    'Only tool used: Kling (100%)' for one, '' for none."""
    if not shares:
        return ""
    if len(shares) == 1:
        return f"Only {noun} used: {with_pct(shares)}"
    top = most(shares)
    lows = least(shares)
    text = f"Most used {noun}: {with_pct(top)}"
    return text + (f"; least used: {with_pct(lows)}" if lows else f" (all {len(shares)} tied)")


def chain(shares: list, *, limit: int = 0) -> str:
    """'Kling 95% · Freepik 3% · HeyGen 2%' (most first; limit=0 shows all)."""
    shown = shares if not limit or len(shares) <= limit else shares[:limit]
    text = " · ".join(f"{s.name} {s.pct_text}" for s in shown)
    return text + (f" · +{len(shares) - len(shown)} more" if len(shown) < len(shares) else "")


def used_most_then(shares: list) -> str:
    """'Used Kling most (95%), then Freepik (3%) and HeyGen (2%). Least used: HeyGen.'"""
    if not shares:
        return "Nothing generated."
    if len(shares) == 1:
        return f"Used only {shares[0].name} (100%)."
    top = most(shares)
    rest = [s for s in shares if s not in top]
    text = f"Used {names(top)} most ({top[0].pct_text}{' each' if len(top) > 1 else ''})"
    if rest:
        text += ", then " + names([Share(s.key, f"{s.name} ({s.pct_text})", s.items, s.rupees, s.pct) for s in rest])
    text += "."
    lows = least(shares)
    return text + (f" Least used: {names(lows)}." if lows else "")


def main_of(shares: list) -> str:
    """'Kling (95%)' - the most used, ties together; '—' when empty."""
    return with_pct(most(shares)) if shares else "—"


def rupees_text(value: float) -> str:
    return f"₹{value:,.0f}"


def items_text(n: int) -> str:
    return f"{n:,} item{'' if n == 1 else 's'}"


def people_text(n: int) -> str:
    return f"{n:,} {'person' if n == 1 else 'people'}"


__all__ = ["ONLY_TOOL", "Share", "pct_text", "whole_percents", "split", "most", "least", "names", "with_pct", "label",
           "most_least", "chain", "used_most_then", "main_of", "rupees_text", "items_text", "people_text"]
