"""
Credit Consumption Report - summaries built from the GROUP BY rows.

The database returns one row per user x tool x client x charge status x
month (see facts.load_groups). Every sheet total is a re-summing of those
same rows, which is what makes By Department, By User, By Tool, By Client,
the trend sheet and the Generation Log reconcile exactly.

* "Credits" and "Generations" everywhere mean Charged rows only. Pending
  credits are a separate figure; Failed / Refunded only appear in Data
  Quality and the log.
* "Top" answers rank by credits, then generations. Anything still level on
  both is a tie and every tied name is reported.
* The owner-less "Unassigned" user is a bucket, not a person: it is listed
  and counted everywhere but never ranked or named as a "top user".
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from .facts import CHARGED, CREDITS_NOT_CAPTURED, FAILED, NO_CLIENT, PENDING, TOOL_COST_NOTES, UNASSIGNED_USER_ID, FactGroup


def _key(credits: float, generations: int) -> tuple:
    # Rounded so float noise from summing never splits a real tie.
    return (round(credits, 4), generations)


@dataclass(frozen=True)
class Top:
    """A "top/most used" answer: every tied key plus the winning figures."""

    keys: tuple
    credits: float = 0.0
    generations: int = 0

    def __bool__(self) -> bool:
        return bool(self.keys)

    @property
    def first(self):
        return self.keys[0] if self.keys else None


def top_of(stats: dict, name_of=lambda k: str(k)) -> Top:
    """Keys tied for the highest (credits, generations), sorted by name."""
    stats = {k: v for k, v in stats.items() if v[0] or v[1]}
    if not stats:
        return Top(())
    best = max(_key(*v) for v in stats.values())
    keys = sorted((k for k, v in stats.items() if _key(*v) == best), key=lambda k: name_of(k).lower())
    credits, gens = stats[keys[0]]
    return Top(tuple(keys), credits, gens)


def top_keys(stats: dict, name_of=lambda k: str(k)) -> list:
    return list(top_of(stats, name_of).keys)


def competition_ranks(values: dict) -> dict:
    """{key: rank} by credits, highest first; equal credits share a rank (1, 2, 2, 4)."""
    ordered = sorted(values.items(), key=lambda kv: -round(kv[1], 4))
    ranks, prev, rank = {}, None, 0
    for i, (k, v) in enumerate(ordered, start=1):
        rounded = round(v, 4)
        if rounded != prev:
            rank, prev = i, rounded
        ranks[k] = rank
    return ranks


@dataclass
class Totals:
    credits: float = 0.0            # Charged
    generations: int = 0            # Charged
    pending_credits: float = 0.0
    pending_generations: int = 0
    failed_credits: float = 0.0
    failed_generations: int = 0
    zero_credit: int = 0            # Charged rows with 0 credits
    all_generations: int = 0
    users: set = field(default_factory=set)
    with_client: int = 0            # Charged generations with a real client

    def add(self, g: FactGroup) -> None:
        self.all_generations += g.generations
        if g.charge_status == CHARGED:
            self.credits += g.credits
            self.generations += g.generations
            self.zero_credit += g.zero_credit
            self.users.add(g.user_id)
            if g.client != NO_CLIENT:
                self.with_client += g.generations
        elif g.charge_status == PENDING:
            self.pending_credits += g.credits
            self.pending_generations += g.generations
        else:
            self.failed_credits += g.credits
            self.failed_generations += g.generations

    @property
    def credits_per_generation(self) -> float:
        return self.credits / self.generations if self.generations else 0.0


@dataclass
class UserRow:
    user_id: int
    name: str
    employee_id: str
    department: str
    deleted: bool
    totals: Totals
    share: float
    company_rank: object            # int, or "—" for Unassigned
    department_rank: object
    top_tool: Top
    top_client: Top

    @property
    def is_unassigned(self) -> bool:
        return self.user_id == UNASSIGNED_USER_ID

    @property
    def label(self) -> str:
        return f"{self.name} (deleted)" if self.deleted else self.name

    @property
    def client_rate(self) -> float:
        t = self.totals
        return t.with_client / t.generations if t.generations else 0.0


@dataclass
class SummaryRow:
    """A department, tool or client line."""

    name: str
    totals: Totals
    share: float
    # Top user = every user, Unassigned included, by Charged credits then
    # generations; top_named_user is the same without Unassigned (shown
    # beside it when Unassigned comes out on top).
    top_user: Top = Top(())
    top_named_user: Top = Top(())
    top_tool: Top = Top(())
    top_department: Top = Top(())
    cost_note: str = ""

    @property
    def users(self) -> int:
        return len(self.totals.users)


@dataclass
class ReportModel:
    totals: Totals
    users: list                     # By User order: rank, Unassigned last
    departments: list               # by credits desc
    tools: list                     # by credits desc
    clients: list                   # by credits desc, "No client" last
    months: list                    # "YYYY-MM", ascending
    dept_tool: dict                 # {(department, tool): Charged credits}
    user_tool: dict                 # {(user_id, tool): Charged credits}
    month_tool: dict                # {(month, tool): (credits, generations)}
    month_dept: dict                # {(month, department): (credits, generations)}
    month_user: dict                # {(month, user_id): (credits, generations)}
    month_client: dict              # {(month, client): (credits, generations)}
    month_totals: dict              # {month: Totals} - every charge status, per IST month
    user_client_rows: list          # [(user_id, department, client, tool, Totals)], ordered by client
    user_tool_order: list           # user ids, User x Tool order (department, then rank)
    log_user_order: list            # user ids, Generation Log order (name; Unassigned last)
    log_counts: dict                # {user_id: rows in the log, every charge status}
    task_fill: float = 0.0          # share of all rows with a task
    model_fill: float = 0.0
    excluded: dict = field(default_factory=dict)
    top_user: Top = Top(())          # company-wide, Unassigned included (see SummaryRow)
    top_named_user: Top = Top(())

    @property
    def is_empty(self) -> bool:
        return not self.log_counts

    @property
    def total_credits(self) -> float:
        return self.totals.credits

    @property
    def total_generations(self) -> int:
        return self.totals.generations

    def user(self, user_id: int) -> UserRow:
        return self._users_by_id[user_id]

    def __post_init__(self) -> None:
        self._users_by_id = {u.user_id: u for u in self.users}


def _share(part: float, total: float) -> float:
    return (part / total) if total else 0.0


def build_model(groups: Iterable[FactGroup], excluded: dict = None) -> ReportModel:
    groups = list(groups)
    totals = Totals()
    meta: dict = {}
    by_user: dict = defaultdict(Totals)
    by_dept: dict = defaultdict(Totals)
    by_tool: dict = defaultdict(Totals)
    by_client: dict = defaultdict(Totals)
    pair: dict = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))   # pair[kind][(a, b)] = [credits, gens]
    month_tool: dict = defaultdict(lambda: [0.0, 0])
    month_dept: dict = defaultdict(lambda: [0.0, 0])
    month_user: dict = defaultdict(lambda: [0.0, 0])
    month_client: dict = defaultdict(lambda: [0.0, 0])
    month_totals: dict = defaultdict(Totals)
    user_client: dict = defaultdict(Totals)
    task_filled = model_filled = 0

    for g in groups:
        meta[g.user_id] = g
        totals.add(g)
        by_user[g.user_id].add(g)
        by_dept[g.department].add(g)
        by_tool[g.tool].add(g)
        by_client[g.client].add(g)
        user_client[(g.user_id, g.department, g.client, g.tool)].add(g)
        if g.month:
            month_totals[g.month].add(g)
        task_filled += g.task_filled
        model_filled += g.model_filled
        if g.charge_status != CHARGED:
            continue
        for kind, key in (
            ("user_tool", (g.user_id, g.tool)), ("user_client", (g.user_id, g.client)),
            ("dept_user", (g.department, g.user_id)), ("dept_tool", (g.department, g.tool)),
            ("tool_user", (g.tool, g.user_id)), ("tool_dept", (g.tool, g.department)),
            ("client_user", (g.client, g.user_id)), ("client_tool", (g.client, g.tool)),
        ):
            pair[kind][key][0] += g.credits
            pair[kind][key][1] += g.generations
        month_tool[(g.month, g.tool)][0] += g.credits
        month_tool[(g.month, g.tool)][1] += g.generations
        month_dept[(g.month, g.department)][0] += g.credits
        month_dept[(g.month, g.department)][1] += g.generations
        month_user[(g.month, g.user_id)][0] += g.credits
        month_user[(g.month, g.user_id)][1] += g.generations
        month_client[(g.month, g.client)][0] += g.credits
        month_client[(g.month, g.client)][1] += g.generations

    def name_of_user(uid):
        return meta[uid].user_name

    def slice_(kind, first, *, people_only=False):
        out = {k[1]: tuple(v) for k, v in pair[kind].items() if k[0] == first}
        if people_only:
            out.pop(UNASSIGNED_USER_ID, None)
        return out

    people = {uid: t.credits for uid, t in by_user.items() if uid != UNASSIGNED_USER_ID}
    company_ranks = competition_ranks(people)
    dept_ranks: dict = {}
    for dept in by_dept:
        dept_ranks.update(competition_ranks({uid: c for uid, c in people.items() if meta[uid].department == dept}))

    users = []
    for uid, t in by_user.items():
        m = meta[uid]
        clients = slice_("user_client", uid)
        named = {c: v for c, v in clients.items() if c != NO_CLIENT}
        users.append(UserRow(
            user_id=uid,
            name=m.user_name,
            employee_id=m.employee_id,
            department=m.department,
            deleted=m.user_deleted,
            totals=t,
            share=0.0,
            company_rank=company_ranks.get(uid, "—"),
            department_rank=dept_ranks.get(uid, "—"),
            top_tool=top_of(slice_("user_tool", uid)),
            top_client=top_of(named) or top_of(clients),
        ))
    for u in users:
        u.share = _share(u.totals.credits, totals.credits)
    users.sort(key=lambda u: (u.is_unassigned, u.company_rank if isinstance(u.company_rank, int) else 0,
                              u.name.lower(), u.user_id))

    def summary(store, extra: dict, *, user_kind) -> list:
        rows = []
        for name, t in store.items():
            row = SummaryRow(name=name, totals=t, share=_share(t.credits, totals.credits),
                             top_user=top_of(slice_(user_kind, name), name_of_user),
                             top_named_user=top_of(slice_(user_kind, name, people_only=True), name_of_user))
            for attr, kind in extra.items():
                setattr(row, attr, top_of(slice_(kind, name)))
            rows.append(row)
        rows.sort(key=lambda r: (-round(r.totals.credits, 4), -r.totals.generations, r.name.lower()))
        return rows

    departments = summary(by_dept, {"top_tool": "dept_tool"}, user_kind="dept_user")
    tools = summary(by_tool, {"top_department": "tool_dept"}, user_kind="tool_user")
    for t in tools:
        t.cost_note = TOOL_COST_NOTES.get(t.name, "") if t.name in CREDITS_NOT_CAPTURED else ""
    clients = summary(by_client, {"top_tool": "client_tool"}, user_kind="client_user")
    clients.sort(key=lambda r: r.name == NO_CLIENT)  # stable: keeps credit order otherwise

    rank_pos = {u.user_id: i for i, u in enumerate(users)}
    client_pos = {c.name: i for i, c in enumerate(clients)}
    user_client_rows = sorted(
        ((uid, dept, client, tool, t) for (uid, dept, client, tool), t in user_client.items()),
        key=lambda r: (client_pos[r[2]], rank_pos[r[0]], -r[4].credits, r[3]),
    )
    dept_pos = {d.name: i for i, d in enumerate(departments)}
    user_tool_order = sorted(by_user, key=lambda uid: (dept_pos[meta[uid].department], rank_pos[uid]))
    log_user_order = sorted(by_user, key=lambda uid: (uid == UNASSIGNED_USER_ID, name_of_user(uid).lower(), uid))
    all_rows = totals.all_generations

    return ReportModel(
        totals=totals,
        users=users,
        departments=departments,
        tools=tools,
        clients=clients,
        months=sorted({g.month for g in groups if g.month}),
        dept_tool={k: v[0] for k, v in pair["dept_tool"].items()},
        user_tool={k: v[0] for k, v in pair["user_tool"].items()},
        month_tool={k: tuple(v) for k, v in month_tool.items()},
        month_dept={k: tuple(v) for k, v in month_dept.items()},
        month_user={k: tuple(v) for k, v in month_user.items()},
        month_client={k: tuple(v) for k, v in month_client.items()},
        month_totals=dict(month_totals),
        user_client_rows=user_client_rows,
        user_tool_order=user_tool_order,
        log_user_order=log_user_order,
        log_counts={uid: t.all_generations for uid, t in by_user.items()},
        task_fill=_share(task_filled, all_rows),
        model_fill=_share(model_filled, all_rows),
        excluded=excluded or {"accounts": 0, "generations": 0, "credits": 0.0},
        top_user=top_of({uid: (t.credits, t.generations) for uid, t in by_user.items()}, name_of_user),
        top_named_user=top_of({uid: (t.credits, t.generations) for uid, t in by_user.items()
                               if uid != UNASSIGNED_USER_ID}, name_of_user),
    )


__all__ = ["CHARGED", "PENDING", "FAILED", "ReportModel", "build_model", "top_of", "top_keys", "competition_ranks"]
