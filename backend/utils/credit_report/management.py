"""
Credit Consumption Report - the management view (Summary, Team & Clients).

Everything here is in rupees, computed from the same facts as the detail
sheets (costing.py), for the report period and the period before it:

* Pay-per-use   = Σ ₹ of pay-per-use generations (credits x rate).
* Subscriptions = the full fee for the period of every active subscription
                  account, used or not. The part shared across generations
                  belongs to people and clients; the rest is "Paid, not used".
* Total spend   = Pay-per-use + Subscriptions.

People, department and client figures are "spend on items" (what their
generations cost); they add up to Total spend minus "Paid, not used".
The previous period is the month before when the report covers whole
calendar months, else the same number of days just before it.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from .costing import PAY_PER_USE_TOOLS, period_fee
from .display import Budgets
from .facts import (CHARGED, NO_CLIENT, UNASSIGNED, UNASSIGNED_USER_ID, ReportFilters, load_account_groups,
                    load_day_groups, load_groups, load_issue_counts, load_last_used, load_upload_count, prepare)

IST = timedelta(minutes=330)

IN_USE = "In use"
LOW_USE = "Low use"
NOT_USED = "Not used"
RENEWAL_PASSED = "Renewal date passed — confirm still billed"
NOT_TRACKED = "Usage not tracked"
NO_FEE = "Fee not entered"


# --------------------------------------------------------------------------- #
# Formatting (sentences): Indian digit grouping
# --------------------------------------------------------------------------- #
def indian(n: float) -> str:
    """1109095 -> '11,09,095' (lakh / crore grouping), whole numbers."""
    n = int(round(n))
    sign, s = ("-" if n < 0 else ""), str(abs(n))
    if len(s) <= 3:
        return sign + s
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return sign + ",".join(groups + [tail])


def inr(n: float) -> str:
    return f"₹{indian(n)}"


def pct(part: float, whole: float) -> int:
    return int(round(100.0 * part / whole)) if whole else 0


def change_text(cur: float, prev: Optional[float]) -> str:
    """'▲ 12%', '▼ 5%', '▲ <1%' (a real change that rounds to 0), '— no change' (equal), or 'new'."""
    if prev is None:
        return "—"
    if not prev:
        return "new" if cur else "—"
    change = (cur - prev) / prev * 100.0
    if round(change) == 0:
        if round(cur - prev, 2) == 0:
            return "— no change"
        return f"{'▲' if change > 0 else '▼'} <1%"
    return f"{'▲' if change > 0 else '▼'} {abs(round(change))}%"


def period_label(start: date, end: date) -> str:
    if start == end:
        return f"{start.day} {start:%b %Y}"
    if (start.day == 1 and end == date(end.year, end.month, calendar.monthrange(end.year, end.month)[1])
            and (start.year, start.month) == (end.year, end.month)):
        return f"{start:%B %Y}"
    if (start.year, start.month) == (end.year, end.month):
        return f"{start.day}–{end.day} {end:%b %Y}"
    if start.year == end.year:
        return f"{start.day} {start:%b} – {end.day} {end:%b %Y}"
    return f"{start.day} {start:%b %Y} – {end.day} {end:%b %Y}"


def previous_period(start: date, end: date) -> tuple:
    """The month before a whole-month report; else the same length just before it."""
    whole_months = start.day == 1 and end == date(end.year, end.month, calendar.monthrange(end.year, end.month)[1])
    if whole_months:
        months = (end.year - start.year) * 12 + end.month - start.month + 1
        y, m = start.year, start.month - months
        while m < 1:
            y, m = y - 1, m + 12
        p_start = date(y, m, 1)
        p_end = start - timedelta(days=1)
        return p_start, p_end
    days = (end - start).days + 1
    return start - timedelta(days=days), start - timedelta(days=1)


def last_full_month(today: date) -> tuple:
    first = today.replace(day=1)
    end = first - timedelta(days=1)
    return end.replace(day=1), end


# --------------------------------------------------------------------------- #
# Aggregates
# --------------------------------------------------------------------------- #
@dataclass
class Agg:
    rupees: float = 0.0
    est: float = 0.0
    items: int = 0
    credits: float = 0.0
    users: set = field(default_factory=set)
    by_tool: dict = field(default_factory=lambda: defaultdict(float))
    by_client: dict = field(default_factory=lambda: defaultdict(float))
    by_dept: dict = field(default_factory=lambda: defaultdict(float))

    def add(self, g) -> None:
        self.rupees += g.rupees
        self.est += g.rupees_est
        self.items += g.generations
        self.credits += g.credits
        if g.user_id != UNASSIGNED_USER_ID:
            self.users.add(g.user_id)
        self.by_tool[g.tool] += g.rupees
        self.by_client[g.client] += g.rupees
        self.by_dept[g.department] += g.rupees

    @staticmethod
    def main(d: dict, skip=()) -> Optional[str]:
        best = sorted(((v, k) for k, v in d.items() if k not in skip and v > 0),
                      key=lambda x: (-round(x[0], 2), str(x[1]).lower()))
        return best[0][1] if best else None


@dataclass
class SubRow:
    """One subscription account in the period."""

    tool: str
    account: int
    label: str
    monthly_fee: Optional[float]
    period_fee: float
    items: int
    allocated: float                # ₹ shared across its items
    not_used: float                 # period fee that no item took
    last_used: Optional[date]
    renewal_date: Optional[date]
    status: str
    to_confirm: float = 0.0         # unused fee left out of the totals until the account is confirmed billed
    frequency_unconfirmed: bool = False
    tracked: bool = True            # False: usage not captured by the dashboard (Other AI subscriptions)

    @property
    def per_item(self) -> Optional[float]:
        return self.period_fee / self.items if self.items else None


@dataclass
class PeriodView:
    start: date
    end: date
    filtered: bool = False                                  # a department / user / tool / client filter is on
    total: Agg = field(default_factory=Agg)                 # spend on items
    by_dept: dict = field(default_factory=lambda: defaultdict(Agg))
    by_user: dict = field(default_factory=lambda: defaultdict(Agg))
    user_name: dict = field(default_factory=dict)
    user_dept: dict = field(default_factory=dict)
    by_client: dict = field(default_factory=lambda: defaultdict(Agg))
    by_tool: dict = field(default_factory=lambda: defaultdict(Agg))
    by_day: dict = field(default_factory=lambda: defaultdict(float))  # date -> ₹ on items
    subscriptions: list = field(default_factory=list)       # [SubRow]
    other_subscriptions: list = field(default_factory=list) # [SubRow] AI tools with no usage tracked
    pay_per_use: float = 0.0
    pay_per_use_est: float = 0.0
    issues: dict = field(default_factory=dict)              # load_issue_counts
    accounts_without_rate: list = field(default_factory=list)   # [(tool, account)] pay-per-use, rate assumed

    @property
    def label(self) -> str:
        return period_label(self.start, self.end)

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def subscription_fees(self) -> float:
        return sum(s.period_fee for s in self.subscriptions)

    @property
    def not_used(self) -> float:
        return sum(s.not_used for s in self.subscriptions)

    @property
    def to_confirm(self) -> float:
        """Unused fees of accounts whose renewal date passed: not in any total until confirmed."""
        return sum(s.to_confirm for s in self.subscriptions + self.other_subscriptions)

    @property
    def other_total(self) -> float:
        """Other AI subscriptions (usage not tracked), in Total spend but in no cost per item."""
        return 0.0 if self.filtered else sum(s.period_fee for s in self.other_subscriptions if not s.to_confirm)

    @property
    def subscription_total(self) -> float:
        """Tracked subscriptions in Total spend: every active account's fee (only what
        items used when a filter narrows the report to part of the company)."""
        if self.filtered:
            return self.total.rupees - self.pay_per_use
        return self.total.rupees - self.pay_per_use + self.not_used

    @property
    def total_spend(self) -> float:
        return self.pay_per_use + self.subscription_total + self.other_total

    @property
    def estimated(self) -> float:
        return self.total.est

    def tool_spend(self, tool: str) -> float:
        """A tool's ₹ including its subscriptions' unused part."""
        unused = 0.0 if self.filtered else sum(s.not_used for s in self.subscriptions if s.tool == tool)
        return self.by_tool[tool].rupees + unused if tool in self.by_tool else unused

    @property
    def tools(self) -> list:
        names = set(self.by_tool) | ({s.tool for s in self.subscriptions} if not self.filtered else set())
        return sorted(names, key=lambda t: (-round(self.tool_spend(t), 2), t))

    @property
    def people(self) -> list:
        """Named people by spend, highest first (the unknown-owner bucket is not a person)."""
        return sorted((uid for uid in self.by_user if uid != UNASSIGNED_USER_ID),
                      key=lambda u: (-round(self.by_user[u].rupees, 2), self.user_name.get(u, "").lower()))

    def cost_per_item(self, tool: str) -> Optional[float]:
        a = self.by_tool.get(tool)
        if not a or not a.items:
            return None
        return self.tool_spend(tool) / a.items


def _subscription_rows(filters: ReportFilters, accounts: list, last_used: dict, low_use: float,
                       which=None, tracked: bool = True) -> list:
    cost = filters.cost
    by_account = {(a.tool, a.account): a for a in accounts}
    confirmed = filters.display.confirmed_billed
    rows = []
    for acc in sorted(which if which is not None else cost.accounts.values(), key=lambda a: (a.tool, a.id)):
        used = by_account.get((acc.tool, acc.id))
        items = used.items if used else 0
        if not acc.is_active and not items:
            continue
        allocated = used.rupees if used else 0.0
        fee = acc.period_fee
        not_used = fee - allocated if tracked else 0.0
        not_used = not_used if not_used >= 1.0 else 0.0     # float remainder of a fully shared fee
        per_item = fee / items if items else None
        # A renewal date in the past: the account may have lapsed. Its unused fee
        # stays out of every total until someone confirms it is still billed.
        unconfirmed = bool(acc.renewal_date and acc.renewal_date < filters.end and acc.id not in confirmed)
        to_confirm = (not_used if tracked else fee) if unconfirmed else 0.0
        if unconfirmed:
            not_used = 0.0
        if unconfirmed:
            status = RENEWAL_PASSED
        elif not tracked:
            status = NOT_TRACKED
        elif not items:
            status = NOT_USED
        elif acc.monthly_fee is None:
            status = NO_FEE
        elif per_item is not None and per_item > low_use:
            status = LOW_USE
        else:
            status = IN_USE
        last = last_used.get(acc.id)
        rows.append(SubRow(tool=acc.tool, account=acc.id, label=acc.label, monthly_fee=acc.monthly_fee,
                           period_fee=fee, items=items, allocated=allocated, not_used=not_used,
                           last_used=(last + IST).date() if isinstance(last, datetime) else None,
                           renewal_date=acc.renewal_date, status=status, to_confirm=to_confirm,
                           frequency_unconfirmed=acc.frequency_unconfirmed, tracked=tracked))
    return rows


def fill_period(view: PeriodView, groups: list, day_groups: list = ()) -> PeriodView:
    """Add Charged FactGroups (and DayGroups) to a period's rupee figures."""
    for g in groups:
        if g.charge_status != CHARGED:
            continue
        view.total.add(g)
        view.by_dept[g.department].add(g)
        view.by_user[g.user_id].add(g)
        view.user_name[g.user_id] = g.user_name
        view.user_dept[g.user_id] = g.department
        view.by_client[g.client].add(g)
        view.by_tool[g.tool].add(g)
        if g.tool in PAY_PER_USE_TOOLS:
            view.pay_per_use += g.rupees
            view.pay_per_use_est += g.rupees_est
    for d in day_groups:
        if d.charge_status == CHARGED and d.day:
            view.by_day[date.fromisoformat(d.day)] += d.rupees
    return view


def build_period(db: Session, filters: ReportFilters, groups: Optional[list] = None,
                 last_used: Optional[dict] = None) -> PeriodView:
    prepare(db, filters)
    groups = groups if groups is not None else load_groups(db, filters)
    view = PeriodView(start=filters.start, end=filters.end,
                      filtered=bool(filters.department or filters.user_id is not None or filters.tool or filters.client))
    fill_period(view, groups, load_day_groups(db, filters))
    accounts = load_account_groups(db, filters)
    if last_used is None:
        last_used = load_last_used(db, filters.cost)
    view.subscriptions = _subscription_rows(filters, accounts, last_used, filters.display.low_use_rupees_per_item)
    view.other_subscriptions = _subscription_rows(filters, [], {}, 0.0, which=filters.cost.other_accounts,
                                                  tracked=False)
    view.issues = load_issue_counts(db, filters)
    own = {r.account for r in filters.cost.rates if r.account is not None}
    view.accounts_without_rate = sorted({(a.tool, a.account) for a in accounts
                                         if a.tool in PAY_PER_USE_TOOLS and a.rupees_est > 0 and a.account not in own},
                                        key=lambda x: (x[0], x[1] or 0))
    return view


# --------------------------------------------------------------------------- #
# The whole management view
# --------------------------------------------------------------------------- #
@dataclass
class Attention:
    text: str
    action: str
    rupees: float                   # impact, for ordering

    @property
    def sentence(self) -> str:
        return f"{self.text} → {self.action}"


@dataclass
class ManagementView:
    cur: PeriodView
    prev: PeriodView
    budgets: Budgets
    display: object                 # DisplayConfig
    generated_at: datetime
    excluded_names: list = field(default_factory=list)
    kling_removed_rows: int = 0
    kling_removed_credits: float = 0.0
    kling_uncertain: int = 0
    uploads: int = 0
    duplicates: int = 0             # possible double charges (rows)
    duplicate_rupees: float = 0.0
    key_points: list = field(default_factory=list)
    attention: list = field(default_factory=list)

    @property
    def title(self) -> str:
        return f"AI Tools — Spend & Usage · {self.cur.label}"

    def budget_for(self, monthly: Optional[float]) -> Optional[float]:
        return period_fee(monthly, self.cur.start, self.cur.end) if monthly else None

    @property
    def total_budget(self) -> Optional[float]:
        return self.budget_for(self.budgets.total)

    def split(self) -> dict:
        """Spend on items by kind of work, plus the unused subscription part."""
        internal = sum(a.rupees for c, a in self.cur.by_client.items() if self.display.is_internal(c))
        no_client = self.cur.by_client[NO_CLIENT].rupees if NO_CLIENT in self.cur.by_client else 0.0
        client_work = self.cur.total.rupees - internal - no_client
        return {"client": client_work, "internal": internal, "no_client": no_client,
                "not_used": 0.0 if self.cur.filtered else self.cur.not_used}


def build_management(db: Session, filters: ReportFilters, groups: list, *, generated_at: Optional[datetime] = None,
                     duplicates: int = 0, duplicate_rupees: float = 0.0) -> ManagementView:
    from .insights import attention_items, key_points

    prepare(db, filters)
    last_used = load_last_used(db, filters.cost)
    cur = build_period(db, filters, groups, last_used)
    p_start, p_end = previous_period(filters.start, filters.end)
    prev_filters = filters.shifted(p_start, p_end)
    prev = build_period(db, prev_filters, None, last_used)
    view = ManagementView(
        cur=cur, prev=prev, budgets=Budgets.load(), display=filters.display,
        generated_at=generated_at or (datetime.utcnow() + IST),
        excluded_names=[n for _i, n in filters.excluded_accounts] if filters.exclude_test_accounts else [],
        kling_removed_rows=filters.kling.removed_rows, kling_removed_credits=filters.kling.removed_credits,
        kling_uncertain=len(filters.kling.uncertain), uploads=load_upload_count(db, filters),
        duplicates=duplicates, duplicate_rupees=duplicate_rupees,
    )
    view.key_points = key_points(view)
    view.attention = attention_items(view)
    return view


__all__ = ["ManagementView", "PeriodView", "SubRow", "Agg", "Attention", "build_management", "build_period",
           "previous_period", "last_full_month", "period_label", "indian", "inr", "pct", "change_text",
           "IN_USE", "LOW_USE", "NOT_USED", "RENEWAL_PASSED", "NO_FEE", "NOT_TRACKED", "UNASSIGNED"]
