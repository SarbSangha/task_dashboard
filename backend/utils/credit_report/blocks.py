"""
Credit Consumption Report - the data behind the By User / By Tool detail
blocks and the Generation Log's order.

Built from facts.load_day_groups (user x tool x client x IST day x charge
status), which uses the log's own scope, so a key's row count here is exactly
how many log rows it gets. That lets the log's layout - and so every link
into and out of it - be decided before a single row is written:

    log order: user (By User order) -> tool (that user's most used first)
               -> day, newest first -> client (By Client order) -> time,
               newest first
    each user starts with a user header row, each (user, tool) with a
    separator row, so every (user), (user, tool) and (user, tool, day,
    client) is one contiguous run of rows.

Definitions used everywhere:
* "Most used" = most Charged credits, ties broken by generations; when
  every candidate has 0 credits (free tools), by generations - and the
  text says so.
* "Mostly works on client" = the client with the most Charged credits,
  ignoring "No client" unless it is the only one, with its share.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from .facts import CHARGED, FAILED, NO_CLIENT, PENDING

WEEKLY_ABOVE_DAYS = 60


def parse_day(day: Optional[str]) -> Optional[date]:
    return datetime.strptime(day, "%Y-%m-%d").date() if day else None


@dataclass
class Agg:
    rows: int = 0                 # log rows, every charge status
    gens: int = 0                 # Charged generations
    credits: float = 0.0          # Charged credits
    pending: int = 0              # Pending rows (in the log, not in any total)
    failed: int = 0               # Failed / refunded rows
    first: Optional[date] = None
    last: Optional[date] = None

    def add(self, rows: int, status: str, credits: float, day: Optional[date]) -> None:
        self.rows += rows
        if status == CHARGED:
            self.gens += rows
            self.credits += credits
        elif status == PENDING:
            self.pending += rows
        elif status == FAILED:
            self.failed += rows
        if day:
            self.first = day if self.first is None else min(self.first, day)
            self.last = day if self.last is None else max(self.last, day)


def usage_key(name: str, agg: Agg):
    """Sort key for "most used": credits, then generations, then rows."""
    return (-round(agg.credits, 4), -agg.gens, -agg.rows, str(name).lower())


@dataclass
class Pick:
    """A "most used" / "mostly works on" answer."""
    name: Optional[str]
    agg: Optional[Agg]
    share: float = 0.0
    by_generations: bool = False

    def text(self) -> str:
        if not self.name:
            return "—"
        basis = "of generations, no credits recorded" if self.by_generations else "of credits"
        return (f"{self.name} ({self.share:.0%} {basis}; {self.agg.credits:,.2f} credits · "
                f"{self.agg.gens:,} gen{'' if self.agg.gens == 1 else 's'})")


def pick_most_used(items: dict, total: Agg, *, skip: str = None) -> Pick:
    candidates = {k: v for k, v in items.items() if k != skip} or dict(items)
    candidates = {k: v for k, v in candidates.items() if v.gens or v.credits}
    if not candidates:
        return Pick(None, None)
    name, agg = min(candidates.items(), key=lambda kv: usage_key(kv[0], kv[1]))
    if total.credits > 0:
        return Pick(name, agg, agg.credits / total.credits)
    return Pick(name, agg, (agg.gens / total.gens) if total.gens else 0.0, by_generations=True)


@dataclass
class DayRow:
    day: date                     # the day, or the Monday of a week when grouped weekly
    credits: dict = field(default_factory=dict)       # key (tool / -) -> Charged credits
    gens: int = 0
    total: float = 0.0
    people: set = field(default_factory=set)
    clients: set = field(default_factory=set)


@dataclass
class UserData:
    total: Agg = field(default_factory=Agg)
    tools: dict = field(default_factory=dict)          # tool -> Agg
    tool_clients: dict = field(default_factory=dict)   # tool -> {client: Agg}
    clients: dict = field(default_factory=dict)        # client -> Agg
    client_tools: dict = field(default_factory=dict)   # client -> set of tools
    days: dict = field(default_factory=dict)           # date -> DayRow (tool credits)
    tdc: dict = field(default_factory=dict)            # (tool, day) -> {client: Agg}
    pair_quads: dict = field(default_factory=dict)     # tool -> {(day or None, client): log rows}

    def tool_order(self) -> list:
        return sorted(self.tools, key=lambda t: usage_key(t, self.tools[t]))

    def most_used_tool(self) -> Pick:
        return pick_most_used(self.tools, self.total)

    def top_client(self) -> Pick:
        return pick_most_used(self.clients, self.total, skip=NO_CLIENT)

    def tool_top_client(self, tool: str) -> Pick:
        return pick_most_used(self.tool_clients.get(tool, {}), self.tools[tool], skip=NO_CLIENT)


@dataclass
class ToolData:
    total: Agg = field(default_factory=Agg)
    users: dict = field(default_factory=dict)          # user id -> Agg
    user_clients: dict = field(default_factory=dict)   # user id -> {client: Agg}
    clients: dict = field(default_factory=dict)        # client -> Agg
    client_users: dict = field(default_factory=dict)   # client -> set of user ids
    days: dict = field(default_factory=dict)           # date -> DayRow
    duc: dict = field(default_factory=dict)            # day -> {(user id, client): Agg}

    def top_client(self) -> Pick:
        return pick_most_used(self.clients, self.total, skip=NO_CLIENT)


@dataclass
class LogPlan:
    """Where everything sits in the Generation Log (rows decided up front)."""
    user_header: dict = field(default_factory=dict)    # user id -> its header row
    pair_row: dict = field(default_factory=dict)       # (user id, tool) -> separator row
    pair_rows: dict = field(default_factory=dict)      # (user id, tool) -> log rows in the run
    quad_row: dict = field(default_factory=dict)       # (user id, tool, day, client) -> first row of that run
    quad: dict = field(default_factory=dict)           # (user id, tool, day, client) -> Agg of the run
    tool_order: dict = field(default_factory=dict)     # (user id, tool) -> position, for stream_log
    client_order: dict = field(default_factory=dict)   # client -> position, for stream_log
    user_rows: dict = field(default_factory=dict)      # user id -> log rows (every status)
    last_row: int = 0


@dataclass
class BlockData:
    users: dict = field(default_factory=dict)          # user id -> UserData
    tools: dict = field(default_factory=dict)          # tool -> ToolData
    log: LogPlan = field(default_factory=LogPlan)


def build_blocks(day_groups, log_user_order: list, first_log_row: int, client_order=()) -> BlockData:
    """client_order: clients in By Client order - the order of clients within
    a day, in the log and in the Tool › Date › Client tables alike."""
    data = BlockData()
    users = defaultdict(UserData)
    tools = defaultdict(ToolData)
    quads = defaultdict(Agg)
    for g in day_groups:
        day = parse_day(g.day)
        charged = g.charge_status == CHARGED
        u, t = users[g.user_id], tools[g.tool]
        for agg in (u.total, u.tools.setdefault(g.tool, Agg()), u.clients.setdefault(g.client, Agg()),
                    u.tool_clients.setdefault(g.tool, {}).setdefault(g.client, Agg()),
                    t.total, t.users.setdefault(g.user_id, Agg()), t.clients.setdefault(g.client, Agg()),
                    t.user_clients.setdefault(g.user_id, {}).setdefault(g.client, Agg()),
                    quads[(g.user_id, g.tool, day, g.client)]):
            agg.add(g.rows, g.charge_status, g.credits, day)
        u.client_tools.setdefault(g.client, set()).add(g.tool)
        t.client_users.setdefault(g.client, set()).add(g.user_id)
        u.pair_quads.setdefault(g.tool, {})
        u.pair_quads[g.tool][(day, g.client)] = u.pair_quads[g.tool].get((day, g.client), 0) + g.rows
        if day:
            u.tdc.setdefault((g.tool, day), {}).setdefault(g.client, Agg()).add(g.rows, g.charge_status, g.credits, day)
            t.duc.setdefault(day, {}).setdefault((g.user_id, g.client), Agg()).add(g.rows, g.charge_status, g.credits,
                                                                                  day)
            for owner, key in ((u, g.tool), (t, None)):
                row = owner.days.setdefault(day, DayRow(day))
                row.clients.add(g.client)
                row.people.add(g.user_id)
                if charged:
                    row.gens += g.rows
                    row.total += g.credits
                    if key is not None:
                        row.credits[key] = row.credits.get(key, 0.0) + g.credits
    data.users, data.tools = dict(users), dict(tools)

    plan, row, pos = data.log, first_log_row, 0
    known = list(client_order) + sorted({c for (_u, _t, _d, c) in quads} - set(client_order), key=str.lower)
    plan.client_order = {c: i for i, c in enumerate(known)}
    plan.quad = dict(quads)
    for uid in log_user_order:
        u = data.users.get(uid)
        if not u:
            continue
        plan.user_header[uid] = row
        row += 1
        for tool in u.tool_order():
            plan.tool_order[(uid, tool)] = pos
            pos += 1
            plan.pair_row[(uid, tool)] = row
            row += 1
            runs = u.pair_quads[tool]
            plan.pair_rows[(uid, tool)] = sum(runs.values())
            # Day newest first (rows without a time last), then By Client order.
            for day, client in sorted(runs, key=lambda k: day_client_key(k[0], k[1], plan.client_order)):
                plan.quad_row[(uid, tool, day, client)] = row
                row += runs[(day, client)]
        plan.user_rows[uid] = u.total.rows
    plan.last_row = row - 1
    return data


def day_client_key(day: Optional[date], client: str, client_order: dict) -> tuple:
    """Day newest first (no day last), then client in By Client order."""
    return (day is None, -(day.toordinal() if day else 0), client_order.get(client, len(client_order)))


def date_rows(days: dict) -> tuple:
    """(rows newest first, grouped weekly?) - weekly (Monday start) above WEEKLY_ABOVE_DAYS dates."""
    ordered = sorted(days.values(), key=lambda r: r.day, reverse=True)
    if len(ordered) <= WEEKLY_ABOVE_DAYS:
        return ordered, False
    weeks = {}
    for r in ordered:
        monday = r.day - timedelta(days=r.day.weekday())
        w = weeks.setdefault(monday, DayRow(monday))
        for k, v in r.credits.items():
            w.credits[k] = w.credits.get(k, 0.0) + v
        w.gens += r.gens
        w.total += r.total
        w.people |= r.people
        w.clients |= r.clients
    return sorted(weeks.values(), key=lambda r: r.day, reverse=True), True
