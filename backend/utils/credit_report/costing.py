"""
Credit Consumption Report - what each generation cost in rupees.

Every tool counts in its own credits (a Kling credit is not a Freepik
credit), so credits are never added across tools for money. Each Charged
generation gets a rupee figure instead, by how the company pays for the tool:

* Pay-per-use (Kling, HeyGen, Splice): credits x the account's rate on the
  generation's IST date (Reports -> Credit Rates, tool_credit_rates). An
  account with no rate of its own uses its tool's latest rate on that date,
  flagged "rate assumed" (never the seeded ₹1 global placeholder, unless the
  tool has no rate at all). Entering the account's real rate in Credit Rates
  replaces the assumption with no code change.

* Subscriptions (every other tracked tool): each company account's fee
  (it_portal_tool_credentials.tool_cost, monthly unless configured annual),
  pro-rated to the report period by days, is shared across that account's
  Charged generations by size:
      Freepik    credits charged, or Freepik's own estimate on an
                 unlimited-plan generation (it charges 0 but records the cost)
      ElevenLabs credits from the character counter; when the counter did not
                 move, the text length (1 credit per character, est.);
                 0 for a free preview model
      others     one equal share per generation (no per-item cost, est.)
  An account with no generations in the period is "Paid, not used": its
  fee counts in total spend but belongs to no person or client.
* Every other company tool with an active fee (Semrush, Figma, Canva...) is
  "Paid, not tracked": the dashboard captures no usage for it, but its fee
  still counts in total spend, so the total is what the company pays.

The facts query (facts.facts_subquery) applies these rules in SQL through
rate_sql / fee_sql / account_sql below, so every sheet sums the same figure.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import Float, Integer, String, and_, case, cast, func, literal, or_
from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolCredential, ToolCreditRate

PAY_PER_USE = "Pay-per-use"
SUBSCRIPTION = "Subscription"
PAY_PER_USE_TOOLS = ("Kling", "HeyGen", "Splice")
SUBSCRIPTION_TOOLS = ("Freepik", "ElevenLabs", "Higgsfield", "Suno", "Envato", "Epidemic Sound", "Flow",
                      "ChatGPT", "Claude", "Grammarly")

# it_portal_tools name / slug (lower case) -> the report's tool name.
TOOL_ALIASES = {
    "kling": "Kling", "kling-ai": "Kling", "klingai": "Kling",
    "heygen": "HeyGen", "splice": "Splice",
    "freepik": "Freepik", "magnific": "Freepik", "elevenlabs": "ElevenLabs", "eleven labs": "ElevenLabs",
    "higgsfield": "Higgsfield",
    "suno": "Suno", "envato": "Envato", "envato elements": "Envato", "epidemic sound": "Epidemic Sound",
    "epidemicsound": "Epidemic Sound", "epidemic-sound": "Epidemic Sound", "flow": "Flow",
    "chatgpt": "ChatGPT", "chat gpt": "ChatGPT", "openai": "ChatGPT",
    "claude": "Claude", "claude ai": "Claude", "claude.ai": "Claude",
    "grammarly": "Grammarly", "grammarly-docs": "Grammarly", "grammarly docs": "Grammarly",
}


def report_tool(name: Optional[str], slug: Optional[str] = None) -> Optional[str]:
    for value in (slug, name):
        key = (value or "").strip().lower()
        if key in TOOL_ALIASES:
            return TOOL_ALIASES[key]
    return None


def period_fee(monthly: float, start: date, end: date) -> float:
    """A monthly fee pro-rated to [start, end] by days, month by month."""
    total, day = 0.0, start
    while day <= end:
        days_in_month = calendar.monthrange(day.year, day.month)[1]
        month_end = date(day.year, day.month, days_in_month)
        last = min(month_end, end)
        total += monthly * ((last - day).days + 1) / days_in_month
        day = last + timedelta(days=1)
    return total


@dataclass(frozen=True)
class RateRow:
    account: Optional[int]          # None = a tool-level rate
    tool: Optional[str]
    start: date
    end: Optional[date]
    rate: float

    def covers(self, day: date) -> bool:
        return self.start <= day and (self.end is None or day <= self.end)


@dataclass
class Account:
    id: int
    tool: str
    label: str
    monthly_fee: Optional[float]    # None = no fee entered
    billing: str                    # "monthly" | "annual"
    renewal_type: str
    renewal_date: Optional[date]
    auto_renew: bool
    is_active: bool
    period_fee: float = 0.0
    tracked: bool = True                 # False: an AI tool whose usage the dashboard does not capture
    frequency_unconfirmed: bool = False  # the fee may be monthly or annual: being checked


@dataclass
class CostSetup:
    start: date
    end: date
    rates: list = field(default_factory=list)            # [RateRow] for an account or a tool
    global_rate: Optional[float] = None
    accounts: dict = field(default_factory=dict)          # subscription accounts: id -> Account
    other_accounts: list = field(default_factory=list)    # active AI subscriptions with no usage tracked
    default_account: dict = field(default_factory=dict)   # tool -> account id for rows with no account

    # ------------------------------------------------------------------ #
    # Python twins (tests, previous period checks)
    # ------------------------------------------------------------------ #
    def rate_on(self, tool: str, account: Optional[int], day: date) -> tuple:
        """(rupees per credit, assumed?) for a pay-per-use generation."""
        for r in self.rates:
            if r.account is not None and r.account == account and r.covers(day):
                return r.rate, False
        for r in self.rates:
            if r.account is None and r.tool == tool and r.covers(day):
                return r.rate, False
        fallback = self._tool_fallback(tool)
        for r in fallback:
            if r.start <= day:
                return r.rate, True
        if fallback:
            return fallback[-1].rate, True
        return (self.global_rate or 0.0), True

    def _tool_fallback(self, tool: str) -> list:
        """The tool's rates, newest start first: a rate-less account borrows them."""
        return sorted((r for r in self.rates if r.tool == tool), key=lambda r: (r.start, r.account or 0), reverse=True)

    @property
    def subscription_total(self) -> float:
        return sum(a.period_fee for a in self.accounts.values())

    # ------------------------------------------------------------------ #
    # SQL
    # ------------------------------------------------------------------ #
    def account_sql(self, tool_col, account_col):
        """The row's account; a row with none goes to its tool's only account."""
        whens = [(tool_col == tool, literal(acc, Integer)) for tool, acc in sorted(self.default_account.items())]
        if not whens:
            return account_col
        return func.coalesce(account_col, case(*whens, else_=cast(literal(None), Integer)))

    def rate_sql(self, tool_col, account_col, day_col) -> tuple:
        """(rate expression, assumed 0/1 expression) for pay-per-use rows.
        day_col is the IST day as 'YYYY-MM-DD' text."""
        exact, assumed = [], []

        def in_range(r):
            cond = [day_col >= r.start.isoformat()]
            if r.end is not None:
                cond.append(day_col <= r.end.isoformat())
            return cond

        for r in self.rates:
            if r.account is not None:
                exact.append((and_(account_col == r.account, *in_range(r)), r.rate))
        for r in self.rates:
            if r.account is None and r.tool:
                exact.append((and_(tool_col == r.tool, *in_range(r)), r.rate))
        for tool in PAY_PER_USE_TOOLS:
            fallback = self._tool_fallback(tool)
            for r in fallback:
                assumed.append((and_(tool_col == tool, day_col >= r.start.isoformat()), r.rate))
            if fallback:
                assumed.append((tool_col == tool, fallback[-1].rate))
        default = literal(float(self.global_rate or 0.0), Float)
        rate = case(*[(c, literal(v, Float)) for c, v in exact + assumed], else_=default) if exact or assumed else default
        flag = case(*[(c, 0) for c, _v in exact], else_=1) if exact else literal(1, Integer)
        return rate, flag

    def fee_sql(self, account_col):
        """The account's fee for the whole report period (0 when none)."""
        whens = [(account_col == a.id, literal(a.period_fee, Float)) for a in self.accounts.values() if a.period_fee]
        return case(*whens, else_=literal(0.0, Float)) if whens else literal(0.0, Float)


def _key(text) -> str:
    return "".join(str(text or "").lower().split())


def load_cost_setup(db: Session, start: date, end: date, display) -> CostSetup:
    setup = CostSetup(start=start, end=end)
    tool_of_cred = {}
    untracked = {_key(t): t for t in display.untracked_ai_tools}
    c, t = ITPortalToolCredential, ITPortalTool
    # Named columns only: the report's read-only role cannot (and need not) read login secrets.
    rows = (db.query(c.id, c.scope, c.tool_cost, c.renewal_type, c.renewal_date, c.auto_renew, c.is_active,
                     t.name, t.slug)
            .join(t, c.tool_id == t.id).all())
    for cred in rows:
        name = report_tool(cred.name, cred.slug)
        tool_of_cred[cred.id] = name
        if (cred.scope or "company") != "company":
            continue
        if name in PAY_PER_USE_TOOLS:
            continue
        # Every other company tool the company pays for (Semrush, Figma, Canva...)
        # is "Paid, not tracked": its fee counts in total spend even though
        # the dashboard captures no usage for it, so total spend is what the
        # company actually pays.
        other = None
        if name not in SUBSCRIPTION_TOOLS:
            other = (untracked.get(_key(cred.name)) or untracked.get(_key(cred.slug))
                     or (cred.name or cred.slug or "").strip() or f"Tool {cred.id}")
        name = name if name in SUBSCRIPTION_TOOLS else other
        billing = display.billing.get(cred.id, "monthly")
        fee = float(cred.tool_cost) if cred.tool_cost is not None else None
        monthly = (fee / 12.0 if billing == "annual" else fee) if fee is not None else None
        account = Account(
            id=cred.id, tool=name, label=display.account_label(cred.id, name), monthly_fee=monthly, billing=billing,
            renewal_type=(cred.renewal_type or "MANUAL"), renewal_date=cred.renewal_date,
            auto_renew=bool(cred.auto_renew), is_active=bool(cred.is_active),
            period_fee=period_fee(monthly, start, end) if monthly else 0.0,
            tracked=not other, frequency_unconfirmed=cred.id in display.billing_unconfirmed,
        )
        if other:
            if account.is_active and account.monthly_fee:
                setup.other_accounts.append(account)
            continue
        setup.accounts[cred.id] = account
    for r in db.query(ToolCreditRate).all():
        if r.rate_per_credit is None or r.effective_from is None:
            continue
        rate = float(r.rate_per_credit)
        if r.credential_id is not None:
            setup.rates.append(RateRow(int(r.credential_id), tool_of_cred.get(r.credential_id), r.effective_from,
                                       r.effective_to, rate))
        elif r.tool_id is not None or r.provider:
            tool = None
            if r.tool_id is not None:
                t = db.get(ITPortalTool, r.tool_id)
                tool = report_tool(t.name, t.slug) if t else None
            tool = tool or report_tool(r.provider)
            if tool:
                setup.rates.append(RateRow(None, tool, r.effective_from, r.effective_to, rate))
        elif r.effective_from <= end and (r.effective_to is None or r.effective_to >= start):
            setup.global_rate = rate
    by_tool = {}
    for a in setup.accounts.values():
        by_tool.setdefault(a.tool, []).append(a)
    for tool, accounts in by_tool.items():
        for pick in ([a for a in accounts if a.is_active and a.monthly_fee], [a for a in accounts if a.is_active],
                     accounts):
            if len(pick) == 1:
                setup.default_account[tool] = pick[0].id
                break
    return setup


__all__ = ["PAY_PER_USE", "SUBSCRIPTION", "PAY_PER_USE_TOOLS", "SUBSCRIPTION_TOOLS", "CostSetup", "Account",
           "RateRow", "load_cost_setup", "period_fee", "report_tool"]
