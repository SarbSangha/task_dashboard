"""
Credit Consumption Report - Kling generations recorded twice.

One Kling job (one generation_id) can reach the database more than once:
the browser that clicked Generate records it at submit time
(generate_intent / expected_credit_lock / xhr_response), and any browser
that later scans the Kling history records it again
(asset_history_discovered). Each copy carries the job's full credits, so
summing them counts one charge two or more times - and the copies can sit
under different people.

Rule, among a job's Charged rows in the report period:

* keep the earliest row from the person who started the job (a submit-time
  source); drop the rest;
* a job seen only by history scans keeps its earliest row, credited to the
  one person who started Kling jobs on that account during the period, or
  to nobody ("Unknown user (imported history)") when that is not exactly
  one person - and is flagged "owner uncertain".

Charged Kling rows with no generation_id cannot be checked; they are kept
and listed. Read-only: the database is never changed, the report just
leaves the dropped rows out (see facts._kling_select).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolUsageEvent, User

# dom_balance_fallback is the click itself when the submit response was
# missed (53 of 254 click cards, 2026-10-15..21) - still the person who ran it.
STARTER_SOURCES = frozenset({"generate_intent", "expected_credit_lock", "xhr_response", "dom_balance_fallback"})
HISTORY_SOURCE = "asset_history_discovered"


@dataclass(frozen=True)
class KlingRow:
    id: int
    user_id: Optional[int]
    source: str
    credits: float
    created_at: object
    day: Optional[date]
    account: Optional[int]
    job: Optional[str]


@dataclass
class RecordedTwice:
    """One Kling job recorded more than once: the row kept and the rows removed."""

    job: str
    day: Optional[date]
    kept: KlingRow
    owner_id: Optional[int]            # who the kept row is credited to (None = Unknown user)
    removed: list                      # [KlingRow]
    owner_uncertain: bool

    @property
    def removed_credits(self) -> float:
        return sum(r.credits for r in self.removed)


@dataclass
class KlingDedup:
    jobs: list = field(default_factory=list)         # [RecordedTwice]
    no_job_id: list = field(default_factory=list)    # [KlingRow] Charged rows that cannot be checked
    names: dict = field(default_factory=dict)        # user id -> display name (for Data Quality)

    @property
    def drop_ids(self) -> set:
        return {r.id for j in self.jobs for r in j.removed}

    @property
    def owner_override(self) -> dict:
        """{kept event id: credited user id or None}, only where it differs from the row's own user."""
        return {j.kept.id: j.owner_id for j in self.jobs if j.owner_id != j.kept.user_id}

    @property
    def removed_rows(self) -> int:
        return sum(len(j.removed) for j in self.jobs)

    @property
    def removed_credits(self) -> float:
        return sum(j.removed_credits for j in self.jobs)

    @property
    def uncertain(self) -> list:
        return [j for j in self.jobs if j.owner_uncertain]


def find_recorded_twice(db: Session, start: date, end: date, *, kling_slugs, sane_max: float,
                        is_charged, name_of=None, ignore_users=()) -> KlingDedup:
    """Kling jobs recorded more than once among Charged rows with an IST
    event_date in [start, end]. `is_charged(raw status)` is the report's own
    charge rule; `name_of(user id, raw name)` its display name rule.
    `ignore_users` (excluded test & admin accounts) never count as the one
    person using an account."""
    ignore = set(ignore_users)
    e = ITPortalToolUsageEvent
    tool_ids = [tid for (tid,) in db.query(ITPortalTool.id).filter(
        func.lower(func.coalesce(ITPortalTool.slug, "")).in_(tuple(kling_slugs))).all()]
    out = KlingDedup()
    if not tool_ids:
        return out
    rows = (db.query(e.id, e.user_id, e.source, e.status, e.credits_burned, e.created_at, e.event_date,
                     e.credential_id, e.generation_id)
            .filter(e.tool_id.in_(tool_ids), e.event_date >= start, e.event_date <= end)
            .order_by(e.created_at, e.id).all())
    starters_by_account = defaultdict(set)
    by_job = defaultdict(list)
    for r in rows:
        source = (r.source or "").strip().lower()
        if source in STARTER_SOURCES and r.user_id is not None and int(r.user_id) not in ignore:
            starters_by_account[r.credential_id].add(int(r.user_id))
        if not is_charged(r.status):
            continue
        credits = float(r.credits_burned or 0.0)
        row = KlingRow(id=int(r.id), user_id=int(r.user_id) if r.user_id is not None else None, source=source,
                       credits=credits if 0 <= credits <= sane_max else 0.0, created_at=r.created_at,
                       day=r.event_date, account=r.credential_id, job=(r.generation_id or "").strip() or None)
        if row.job is None:
            out.no_job_id.append(row)
        else:
            by_job[row.job].append(row)

    for job, copies in by_job.items():
        if len(copies) < 2:
            continue
        starters = [c for c in copies if c.source in STARTER_SOURCES]
        if starters:
            kept, owner, uncertain = starters[0], starters[0].user_id, False
        else:
            kept = copies[0]
            people = starters_by_account.get(kept.account, set())
            owner, uncertain = (next(iter(people)) if len(people) == 1 else None), True
        out.jobs.append(RecordedTwice(job=job, day=kept.day, kept=kept, owner_id=owner,
                                      removed=[c for c in copies if c.id != kept.id], owner_uncertain=uncertain))
    out.jobs.sort(key=lambda j: (j.day or date.min, j.job))

    ids = {u for j in out.jobs for u in [j.kept.user_id, j.owner_id] + [r.user_id for r in j.removed] if u}
    ids |= {r.user_id for r in out.no_job_id if r.user_id}
    if ids:
        for uid, name in db.query(User.id, User.name).filter(User.id.in_(ids)).all():
            out.names[int(uid)] = name_of(uid, name) if name_of else (name or f"User {uid}")
    return out
