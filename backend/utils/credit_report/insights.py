"""
Credit Consumption Report - the Summary's sentences.

Each "Key point" and "Needs attention" item is one function that returns a
sentence only when its condition holds, worked out in rupees from the
management view (never from credits: tools count in different credits).
key_points() keeps the first MAX_KEY_POINTS that apply, in the order below;
attention_items() always keeps the subscription warnings (accounts not used,
or costing more than the low-use limit per item) and fills the rest by
rupees at stake, MAX_ATTENTION in all.

Thresholds are module constants so the tests can state exactly when a
sentence must and must not appear.
"""

from __future__ import annotations

from typing import Optional

from .facts import NO_CLIENT, UNASSIGNED_USER_ID
from .management import NOT_USED, NO_FEE, RENEWAL_PASSED, Attention, ManagementView, inr, pct

MAX_KEY_POINTS = 6
MAX_ATTENTION = 4

CHANGE_MIN_PCT = 15            # total spend moved at least this much vs the previous period
TOOL_DOMINANT_PCT = 50         # one tool takes at least this share of total spend
PEOPLE_MIN = 4                 # concentration needs at least this many named people
PEOPLE_TOP = 2
PEOPLE_SHARE_PCT = 35          # top 2 people take at least this share of item spend
NOT_USED_PCT = 10              # unused subscriptions are at least this share of total spend
CLIENT_TOP = 2
CLIENT_SHARE_PCT = 40          # top 2 clients take at least this share of client-work spend
INTERNAL_PCT = 15              # internal work is at least this share of item spend
DEPENDENCE_PCT = 80            # one tool is more than this share of a department's spend
DEPT_MIN_PCT = 5               # ...for departments with at least this share of item spend
SPIKE_MIN_DAYS = 5
SPIKE_MIN_PCT = 15             # one day takes at least this share of the period's item spend
SPIKE_FACTOR = 2.0             # ...and at least twice an average day
NO_CLIENT_MIN_PCT = 3          # untagged spend worth raising


def _names(items: list) -> str:
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _day(d) -> str:
    return f"{d.day} {d:%b}"


# --------------------------------------------------------------------------- #
# Key points
# --------------------------------------------------------------------------- #
def change_vs_previous(v: ManagementView) -> Optional[str]:
    cur, prev = v.cur.total_spend, v.prev.total_spend
    if prev <= 0 or abs(pct(cur - prev, prev)) < CHANGE_MIN_PCT:
        return None
    up = cur > prev
    deltas = {t: v.cur.tool_spend(t) - v.prev.tool_spend(t) for t in set(v.cur.tools) | set(v.prev.tools)}
    driver = max(deltas, key=lambda t: (deltas[t] if up else -deltas[t], t)) if deltas else None
    text = (f"Total spend {'rose' if up else 'fell'} {abs(pct(cur - prev, prev))}% compared with "
            f"{v.prev.label} ({inr(prev)} → {inr(cur)})")
    if driver and ((deltas[driver] > 0) == up) and deltas[driver]:
        text += f"; the biggest {'rise' if up else 'drop'} was {driver} ({'+' if up else '−'}{inr(abs(deltas[driver]))})"
    return text + "."


def dominant_tool(v: ManagementView) -> Optional[str]:
    total = v.cur.total_spend
    if total <= 0 or not v.cur.tools:
        return None
    top = v.cur.tools[0]
    share = pct(v.cur.tool_spend(top), total)
    if share < TOOL_DOMINANT_PCT:
        return None
    return f"{top} is {share}% of total spend ({inr(v.cur.tool_spend(top))})."


def people_concentration(v: ManagementView) -> Optional[str]:
    people = v.cur.people
    items = v.cur.total.rupees
    if len(people) < PEOPLE_MIN or items <= 0:
        return None
    top = people[:PEOPLE_TOP]
    share = pct(sum(v.cur.by_user[u].rupees for u in top), items)
    if share < PEOPLE_SHARE_PCT:
        return None
    names = _names([v.cur.user_name[u] for u in top])
    return f"{len(top)} people ({names}) account for {share}% of spend on generated items."


def unused_subscriptions(v: ManagementView) -> Optional[str]:
    if v.cur.filtered:
        return None
    total, unused = v.cur.total_spend, v.cur.not_used
    if total <= 0 or pct(unused, total) < NOT_USED_PCT:
        return None
    idle = [s for s in v.cur.subscriptions if s.status == NOT_USED and s.period_fee > 0]
    names = _names([s.label for s in sorted(idle, key=lambda s: -s.period_fee)][:3])
    tail = f": {names}" if idle else ""
    return f"{inr(unused)} ({pct(unused, total)}% of total spend) went to subscriptions with no use in this period{tail}."


def client_concentration(v: ManagementView) -> Optional[str]:
    split = v.split()
    work = split["client"]
    clients = sorted(((a.rupees, c) for c, a in v.cur.by_client.items()
                      if c != NO_CLIENT and not v.display.is_internal(c) and a.rupees > 0), key=lambda x: (-x[0], x[1]))
    if work <= 0 or len(clients) <= CLIENT_TOP:
        return None
    top = clients[:CLIENT_TOP]
    share = pct(sum(r for r, _c in top), work)
    if share < CLIENT_SHARE_PCT:
        return None
    return f"{_names([c for _r, c in top])} together take {share}% of client-work spend."


def internal_share(v: ManagementView) -> Optional[str]:
    split = v.split()
    items = v.cur.total.rupees
    if items <= 0 or pct(split["internal"], items) < INTERNAL_PCT:
        return None
    return (f"Internal work is {pct(split['internal'], items)}% of spend on generated items "
            f"({inr(split['internal'])}); client work is {pct(split['client'], items)}%.")


def department_dependence(v: ManagementView) -> Optional[str]:
    items = v.cur.total.rupees
    found = []
    for dept, a in sorted(v.cur.by_dept.items(), key=lambda kv: -kv[1].rupees):
        if a.rupees <= 0 or pct(a.rupees, items) < DEPT_MIN_PCT:
            continue
        tool = a.main(a.by_tool)
        if tool and 100.0 * a.by_tool[tool] / a.rupees > DEPENDENCE_PCT:
            found.append((dept, tool, pct(a.by_tool[tool], a.rupees)))
    if not found:
        return None
    parts = [f"{d} {s}% {t}" for d, t, s in found[:3]]
    lead = "One department relies on a single tool" if len(found) == 1 else "Departments rely on a single tool"
    return f"{lead}: {'; '.join(parts)}."


def spike_day(v: ManagementView) -> Optional[str]:
    days = {d: r for d, r in v.cur.by_day.items() if r > 0}
    total = sum(days.values())
    if len(days) < SPIKE_MIN_DAYS or total <= 0:
        return None
    day, top = max(days.items(), key=lambda kv: (kv[1], kv[0]))
    share = 100.0 * top / total
    average = 100.0 / v.cur.days
    if share < SPIKE_MIN_PCT or share < SPIKE_FACTOR * average:
        return None
    return f"Spend on {_day(day)} was {round(share)}% of the period's item spend ({inr(top)})."


KEY_POINT_RULES = (change_vs_previous, dominant_tool, people_concentration, unused_subscriptions,
                   client_concentration, internal_share, department_dependence, spike_day)


def key_points(v: ManagementView) -> list:
    out = []
    for rule in KEY_POINT_RULES:
        text = rule(v)
        if text:
            out.append(text)
        if len(out) == MAX_KEY_POINTS:
            break
    return out


# --------------------------------------------------------------------------- #
# Needs attention
# --------------------------------------------------------------------------- #
def idle_subscriptions(v: ManagementView) -> Optional[Attention]:
    if v.cur.filtered:
        return None
    idle = sorted((s for s in v.cur.subscriptions if s.status == NOT_USED and s.period_fee > 0),
                  key=lambda s: -s.period_fee)
    if not idle:
        return None
    total = sum(s.period_fee for s in idle)
    listed = ", ".join(f"{s.label} {inr(s.period_fee)}" for s in idle[:4])
    more = f" and {len(idle) - 4} more" if len(idle) > 4 else ""
    return Attention(f"{inr(total)} paid for subscriptions not used in this period ({listed}{more})",
                     "review or cancel them", total)


def costly_per_item(v: ManagementView) -> Optional[Attention]:
    limit = v.display.low_use_rupees_per_item
    costly = sorted((s for s in v.cur.subscriptions if s.items and s.per_item and s.per_item > limit),
                    key=lambda s: -s.per_item)
    if not costly:
        return None
    listed = ", ".join(f"{s.label} {inr(s.per_item)} per item ({s.items} items)" for s in costly[:3])
    return Attention(f"Subscriptions costing over {inr(limit)} per item: {listed}",
                     "check whether a smaller plan would do", sum(s.period_fee for s in costly))


def assumed_rates(v: ManagementView) -> Optional[Attention]:
    rows, rupees = v.cur.issues.get("rate_assumed", (0, 0.0))
    if not rows or rupees <= 0:
        return None
    accounts = [f"{t} #{a}" if a is not None else f"{t} (no account)" for t, a in v.cur.accounts_without_rate]
    which = f" ({_names(accounts[:4])})" if accounts else ""
    return Attention(f"{inr(rupees)} of pay-per-use cost uses an assumed rate: these accounts have no rate of their "
                     f"own{which}", "enter their rates in Reports → Credit Rates", rupees)


def untagged_client(v: ManagementView) -> Optional[Attention]:
    a = v.cur.by_client.get(NO_CLIENT)
    if not a or a.rupees <= 0 or pct(a.rupees, v.cur.total.rupees) < NO_CLIENT_MIN_PCT:
        return None
    return Attention(f"{inr(a.rupees)} of spend has no client tagged ({a.items} items)",
                     "make the client field mandatory before generating", a.rupees)


def untracked_cost(v: ManagementView) -> Optional[Attention]:
    tools = [t for t in ("Suno", "Higgsfield", "Flow") if t in v.cur.by_tool and v.cur.by_tool[t].items]
    if not tools:
        return None
    rupees = sum(v.cur.by_tool[t].rupees for t in tools)
    return Attention(f"Cost not tracked per item for {_names(tools)} ({inr(rupees)} est.)",
                     "set a price per item in Reports → Credit Rates", rupees)


def missing_fees(v: ManagementView) -> Optional[Attention]:
    rows = [s for s in v.cur.subscriptions if s.status == NO_FEE]
    if not rows:
        return None
    items = sum(s.items for s in rows)
    return Attention(f"{len(rows)} subscription account(s) have no fee entered ({_names([s.label for s in rows])}: "
                     f"{items} items counted at ₹0)", "add the monthly fee in IT Tools", float(items))


def renewals_passed(v: ManagementView) -> Optional[Attention]:
    rows = [s for s in v.cur.subscriptions + v.cur.other_subscriptions if s.status == RENEWAL_PASSED]
    if not rows:
        return None
    held = sum(s.to_confirm for s in rows)
    tail = f" ({inr(held)} of unused fees left out until confirmed)" if held else ""
    return Attention(f"Renewal date passed for {_names([s.label for s in rows])}{tail}",
                     "confirm they are still billed and update the renewal date in IT Tools",
                     sum(s.period_fee for s in rows))


def double_charges(v: ManagementView) -> Optional[Attention]:
    if not v.duplicates:
        return None
    return Attention(f"{inr(v.duplicate_rupees)} in possible double charges ({v.duplicates} items)",
                     "raise them with the vendor", v.duplicate_rupees)


ALWAYS = (idle_subscriptions, costly_per_item)
BY_IMPACT = (assumed_rates, untagged_client, untracked_cost, missing_fees, renewals_passed, double_charges)


def attention_items(v: ManagementView) -> list:
    must = [a for a in (rule(v) for rule in ALWAYS) if a]
    rest = sorted((a for a in (rule(v) for rule in BY_IMPACT) if a), key=lambda a: -a.rupees)
    return (must + rest)[:MAX_ATTENTION]


__all__ = ["key_points", "attention_items", "KEY_POINT_RULES", "ALWAYS", "BY_IMPACT", "UNASSIGNED_USER_ID"]
