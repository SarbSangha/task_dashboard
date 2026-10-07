"""Read side of keyword_ranking sheets: cards, keywords, detail, runs, alerts, CSV.

Movement rules:
* a ranked position compares with a ranked position directly;
* "Not in Top N" counts as N+1 (just below the last place that run checked);
* when the two runs searched to different depths and one side is beyond the
  shallower depth ("Not in Top 10" then 30) the change is "not comparable":
  the sheet's early runs only checked the top 10, later ones the top 50.
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Iterator, Optional
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from models_new import Keyword, RankingCheck, RankingRun, RequestEvent, TrackedSheet

from .queries import _iso, _person, people_directory
from .ranking import AI_CITED, AI_NONE, AI_NOT_CITED, AI_UNPARSED, BUCKET_FAILED, BUCKET_RANKED, BUCKET_UNPARSED

IST = timedelta(minutes=330)
BIG_DROP = 5
MONDAY_RUN_GRACE = timedelta(hours=12)   # a Monday 9 AM run counts as missed after 9 PM IST
KEYWORD_EVENTS = ("KEYWORD_ADDED", "KEYWORD_EDITED", "KEYWORD_REMOVED")


def tracked_tabs(sheet: TrackedSheet) -> list:
    return [t["name"] for t in (sheet.tabs_json or []) if t.get("tracked")]


# --------------------------------------------------------------------------- #
# Comparisons
# --------------------------------------------------------------------------- #
def rank_value(position: Optional[int], bucket: str, depth: Optional[int]) -> Optional[int]:
    if bucket == BUCKET_RANKED and position:
        return position
    if bucket.startswith("not_in_top_") and depth:
        return depth + 1
    return None


def movement(prev: Optional[RankingCheck], cur: Optional[RankingCheck]) -> dict:
    """{"delta": positions gained (+) or lost (-) or None, "direction": ...}."""
    if cur is None:
        return {"delta": None, "direction": "none"}
    if prev is None:
        return {"delta": None, "direction": "new"}
    a = rank_value(prev.position, prev.bucket, prev.depth)
    b = rank_value(cur.position, cur.bucket, cur.depth)
    if a is None or b is None:
        return {"delta": None, "direction": "unknown"}
    a_out, b_out = prev.bucket != BUCKET_RANKED, cur.bucket != BUCKET_RANKED
    if a_out and b_out and prev.depth != cur.depth:
        return {"delta": None, "direction": "not_comparable"}
    if a_out and not b_out and prev.depth and cur.position > prev.depth:
        return {"delta": None, "direction": "not_comparable"}
    if b_out and not a_out and cur.depth and prev.position > cur.depth:
        return {"delta": None, "direction": "not_comparable"}
    delta = a - b
    if a_out and b_out:
        return {"delta": 0, "direction": "same"}
    return {"delta": delta, "direction": "improved" if delta > 0 else "dropped" if delta < 0 else "same"}


def _url_key(url: Optional[str]) -> str:
    if not url:
        return ""
    p = urlparse(url.strip().lower())
    host = (p.netloc or "").removeprefix("www.")
    return f"{host}{(p.path or '/').rstrip('/') or '/'}"


def url_mismatch(a: Optional[str], b: Optional[str]) -> bool:
    """Two known URLs that are different pages (www, case and trailing / ignored)."""
    return bool(a and b and _url_key(a) != _url_key(b))


def bucket_label(check: Optional[RankingCheck]) -> str:
    if check is None:
        return "—"
    if check.bucket == BUCKET_RANKED:
        return str(check.position)
    if check.bucket.startswith("not_in_top_"):
        return f"Not in Top {check.depth}"
    return {"failed": "Check failed", "unparsed": f"Unreadable: {check.raw_position}"}.get(check.bucket, check.bucket)


def _check_dict(c: RankingCheck, run: RankingRun, previous_page: Optional[str]) -> dict:
    """previous_page: the ranking page of the run before, to flag a page change."""
    return {
        "runId": run.id, "checkDate": c.check_date.isoformat(), "label": run.label, "trigger": run.trigger,
        "position": c.position, "bucket": c.bucket, "depth": c.depth, "display": bucket_label(c),
        "aiState": c.ai_state, "rawPosition": c.raw_position, "rawAi": c.raw_ai, "foundUrl": c.found_url,
        "pageChanged": url_mismatch(previous_page, c.found_url), "isOverride": bool(c.is_override), "source": c.source,
        "rawResponse": c.raw_response,
    }


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #
@dataclass
class Loaded:
    keywords: list
    runs: dict                 # run id -> RankingRun
    checks: dict               # keyword id -> [RankingCheck] in run order
    runs_by_tab: dict          # tab -> [RankingRun] in date order


def _run_order(run: RankingRun) -> tuple:
    return (run.check_date, run.run_key)


def load(db: Session, sheet: TrackedSheet, tab: Optional[str] = None, *, include_removed=False) -> Loaded:
    kq = db.query(Keyword).filter(Keyword.sheet_id == sheet.id)
    rq = db.query(RankingRun).filter(RankingRun.sheet_id == sheet.id)
    if tab:
        kq, rq = kq.filter(Keyword.tab_name == tab), rq.filter(RankingRun.tab_name == tab)
    if not include_removed:
        kq = kq.filter(Keyword.is_active.is_(True))
    keywords = kq.order_by(Keyword.tab_name, Keyword.row_number, Keyword.id).all()
    runs = {r.id: r for r in rq.all()}
    runs_by_tab: dict = defaultdict(list)
    for r in sorted(runs.values(), key=_run_order):
        runs_by_tab[r.tab_name].append(r)
    checks: dict = defaultdict(list)
    ids = [k.id for k in keywords]
    if ids:
        for c in db.query(RankingCheck).filter(RankingCheck.keyword_id.in_(ids)).yield_per(5000):
            if c.run_id in runs:
                checks[c.keyword_id].append(c)
    for lst in checks.values():
        lst.sort(key=lambda c: _run_order(runs[c.run_id]))
    return Loaded(keywords, runs, checks, runs_by_tab)


def _latest_pair(data: Loaded, kw: Keyword) -> tuple:
    """(previous, current) checks: the keyword's results in the tab's last two runs."""
    tab_runs = data.runs_by_tab.get(kw.tab_name, [])
    by_run = {c.run_id: c for c in data.checks.get(kw.id, [])}
    cur = by_run.get(tab_runs[-1].id) if tab_runs else None
    prev = by_run.get(tab_runs[-2].id) if len(tab_runs) > 1 else None
    return prev, cur


def _duplicates(keywords: list) -> dict:
    groups: dict = defaultdict(list)
    for k in keywords:
        groups[(k.tab_name, k.keyword_norm)].append(k)
    return {key: ks for key, ks in groups.items() if len(ks) > 1}


# --------------------------------------------------------------------------- #
# Overview cards
# --------------------------------------------------------------------------- #
def _run_stats(data: Loaded, tab: str, run: Optional[RankingRun]) -> Optional[dict]:
    if run is None:
        return None
    checks = [c for kw in data.keywords if kw.tab_name == tab for c in data.checks.get(kw.id, []) if c.run_id == run.id]
    ranked = [c.position for c in checks if c.bucket == BUCKET_RANKED]
    ai_known = [c for c in checks if c.ai_state in (AI_CITED, AI_NOT_CITED, AI_NONE)]
    cited = sum(1 for c in ai_known if c.ai_state == AI_CITED)
    return {
        "runId": run.id, "checkDate": run.check_date.isoformat(), "label": run.label, "trigger": run.trigger,
        "checked": len(checks), "top3": sum(1 for p in ranked if p <= 3), "top10": sum(1 for p in ranked if p <= 10),
        "ranked": len(ranked), "avgPosition": round(sum(ranked) / len(ranked), 1) if ranked else None,
        "citationRate": round(cited / len(ai_known), 3) if ai_known else None, "cited": cited,
        "failed": sum(1 for c in checks if c.bucket == BUCKET_FAILED),
    }


def overview(db: Session, sheet: TrackedSheet, tab: Optional[str] = None) -> dict:
    data = load(db, sheet, tab)
    sites = []
    for name in ([tab] if tab else tracked_tabs(sheet)):
        runs = data.runs_by_tab.get(name, [])
        latest = _run_stats(data, name, runs[-1] if runs else None)
        previous = _run_stats(data, name, runs[-2] if len(runs) > 1 else None)
        change = None
        if latest and previous:
            change = {
                "top3": latest["top3"] - previous["top3"], "top10": latest["top10"] - previous["top10"],
                "avgPosition": (round(latest["avgPosition"] - previous["avgPosition"], 1)
                                if latest["avgPosition"] is not None and previous["avgPosition"] is not None else None),
                "citationRate": (round(latest["citationRate"] - previous["citationRate"], 3)
                                 if latest["citationRate"] is not None and previous["citationRate"] is not None else None),
            }
        sites.append({"tab": name, "keywords": sum(1 for k in data.keywords if k.tab_name == name),
                      "runs": len(runs), "firstRun": runs[0].check_date.isoformat() if runs else None,
                      "latest": latest, "previous": previous, "change": change})
    return {"sites": sites, "tabs": tracked_tabs(sheet), "sourceUrl": sheet.source_url,
            "alertCounts": _alert_counts(alerts(db, sheet, tab, data=data))}


# --------------------------------------------------------------------------- #
# Keywords
# --------------------------------------------------------------------------- #
@dataclass
class KeywordFilters:
    tab: Optional[str] = None
    bucket: Optional[str] = None      # top3 | top10 | ranked | not_ranked | failed | unparsed
    ai: Optional[str] = None          # cited | not_cited | none
    added_by: Optional[str] = None    # email | unknown | imported
    movement: Optional[str] = None    # improved | dropped | same | new | not_comparable
    q: Optional[str] = None


def _matches(row: dict, f: KeywordFilters) -> bool:
    cur = row["current"] or {}
    if f.bucket:
        pos, bucket = cur.get("position"), cur.get("bucket") or ""
        ok = {
            "top3": bool(pos and pos <= 3), "top10": bool(pos and pos <= 10), "ranked": bucket == BUCKET_RANKED,
            "not_ranked": bucket.startswith("not_in_top_"), "failed": bucket == BUCKET_FAILED,
            "unparsed": bucket == BUCKET_UNPARSED or cur.get("aiState") == AI_UNPARSED,
        }.get(f.bucket, True)
        if not ok:
            return False
    if f.ai and cur.get("aiState") != f.ai:
        return False
    if f.added_by:
        email = (row["addedBy"] or {}).get("email")
        if f.added_by == "imported":
            if not row["isImported"]:
                return False
        elif f.added_by == "unknown":
            if email or row["isImported"]:
                return False
        elif (email or "").lower() != f.added_by.lower():
            return False
    if f.movement and row["change"]["direction"] != f.movement:
        return False
    if f.q and f.q.lower() not in row["keyword"].lower():
        return False
    return True


def keyword_rows(db: Session, sheet: TrackedSheet, f: KeywordFilters) -> list:
    data = load(db, sheet, f.tab)
    directory = people_directory(db)
    dupes = _duplicates(data.keywords)
    out = []
    for kw in data.keywords:
        checks = data.checks.get(kw.id, [])
        prev, cur = _latest_pair(data, kw)
        ranked = [c.position for c in checks if c.bucket == BUCKET_RANKED]
        row = {
            "id": kw.id, "tab": kw.tab_name, "keyword": kw.keyword, "targetUrl": kw.target_url, "sNo": kw.s_no,
            "rowNumber": kw.row_number, "addedBy": _person(directory, kw.added_by_email), "addedAt": _iso(kw.added_at),
            "isImported": bool(kw.is_imported),
            "current": _check_dict(cur, data.runs[cur.run_id], prev.found_url if prev else None) if cur else None,
            "previous": _check_dict(prev, data.runs[prev.run_id], None) if prev else None,
            "change": movement(prev, cur),
            "best": min(ranked) if ranked else None,
            "sparkline": [{"d": c.check_date.isoformat(), "v": rank_value(c.position, c.bucket, c.depth),
                           "b": c.bucket} for c in checks],
            "isDuplicate": (kw.tab_name, kw.keyword_norm) in dupes,
            "hasOverride": any(c.is_override for c in checks),
            "hasUnparsed": any(c.bucket == BUCKET_UNPARSED or c.ai_state == AI_UNPARSED for c in checks),
            "pageChanged": bool(prev and cur and url_mismatch(prev.found_url, cur.found_url)),
            "rankedWithoutUrl": bool(cur and cur.bucket == BUCKET_RANKED and not kw.target_url),
        }
        if _matches(row, f):
            out.append(row)
    return out


def keyword_detail(db: Session, sheet: TrackedSheet, kw: Keyword) -> dict:
    directory = people_directory(db)
    runs = {r.id: r for r in db.query(RankingRun).filter(RankingRun.sheet_id == sheet.id, RankingRun.tab_name == kw.tab_name)}
    checks = sorted((c for c in db.query(RankingCheck).filter(RankingCheck.keyword_id == kw.id) if c.run_id in runs),
                    key=lambda c: _run_order(runs[c.run_id]))
    events = (db.query(RequestEvent).filter(RequestEvent.keyword_id == kw.id)
              .order_by(RequestEvent.occurred_at.asc(), RequestEvent.id.asc()).all())
    others = (db.query(Keyword).filter(Keyword.sheet_id == sheet.id, Keyword.tab_name == kw.tab_name,
                                       Keyword.keyword_norm == kw.keyword_norm, Keyword.id != kw.id).all())
    history, last_page = [], None
    for i, c in enumerate(checks):
        h = _check_dict(c, runs[c.run_id], last_page)
        h["change"] = movement(checks[i - 1] if i else None, c)
        history.append(h)
        last_page = c.found_url or last_page
    return {
        "keyword": {"id": kw.id, "tab": kw.tab_name, "keyword": kw.keyword, "targetUrl": kw.target_url,
                    "sNo": kw.s_no, "rowNumber": kw.row_number, "isActive": bool(kw.is_active),
                    "isImported": bool(kw.is_imported), "addedBy": _person(directory, kw.added_by_email),
                    "addedAt": _iso(kw.added_at), "firstSeenAt": _iso(kw.first_seen_at), "removedAt": _iso(kw.removed_at)},
        "history": history,
        "events": [{"id": e.id, "eventType": e.event_type, "actorType": e.actor_type,
                    "actor": _person(directory, e.actor_email), "column": e.column_name, "oldValue": e.old_value,
                    "newValue": e.new_value, "metadata": e.metadata_json or {}, "occurredAt": _iso(e.occurred_at),
                    "source": e.source} for e in events],
        "duplicates": [{"id": o.id, "rowNumber": o.row_number, "isActive": bool(o.is_active)} for o in others],
    }


def runs_log(db: Session, sheet: TrackedSheet, tab: Optional[str] = None) -> list:
    q = db.query(RankingRun).filter(RankingRun.sheet_id == sheet.id)
    if tab:
        q = q.filter(RankingRun.tab_name == tab)
    return [{
        "id": r.id, "tab": r.tab_name, "checkDate": r.check_date.isoformat(), "label": r.label, "trigger": r.trigger,
        "column": r.column_letter, "checked": r.keywords_checked, "success": r.success_count, "failed": r.failed_count,
        "source": r.source, "api": r.api, "location": r.location, "gl": r.gl, "cost": r.cost,
        "durationSeconds": r.duration_seconds, "errors": r.errors_json or [], "externalRunId": r.external_run_id,
    } for r in sorted(q.all(), key=lambda r: (r.check_date, r.run_key), reverse=True)]


# --------------------------------------------------------------------------- #
# Alerts
# --------------------------------------------------------------------------- #
def _alert(kind, severity, tab, message, *, keyword=None, run=None, extra=None) -> dict:
    return {"type": kind, "severity": severity, "tab": tab, "message": message,
            "keywordId": keyword.id if keyword else None, "keyword": keyword.keyword if keyword else None,
            "runDate": run.check_date.isoformat() if run else None, **(extra or {})}


def missed_mondays(runs: list, now: datetime) -> list:
    """Mondays (IST) from the first run on that have no run dated that day."""
    if not runs:
        return []
    local_now = now + IST
    days = {r.check_date for r in runs}
    d = runs[0].check_date + timedelta(days=(7 - runs[0].check_date.weekday()) % 7)
    missed = []
    while d <= local_now.date():
        deadline = datetime(d.year, d.month, d.day, 9) + MONDAY_RUN_GRACE
        if local_now >= deadline and d not in days:
            missed.append(d)
        d += timedelta(days=7)
    return missed


def alerts(db: Session, sheet: TrackedSheet, tab: Optional[str] = None, *, data: Optional[Loaded] = None,
           now: Optional[datetime] = None) -> list:
    now = now or datetime.utcnow()
    data = data or load(db, sheet, tab)
    out = []
    for kw in data.keywords:
        prev, cur = _latest_pair(data, kw)
        run = data.runs[cur.run_id] if cur else None
        mv = movement(prev, cur)
        if mv["delta"] is not None and mv["delta"] <= -BIG_DROP:
            out.append(_alert("BIG_DROP", "high", kw.tab_name,
                              f"Dropped {abs(mv['delta'])} places: {bucket_label(prev)} → {bucket_label(cur)}", keyword=kw, run=run))
        if prev and cur and prev.bucket == BUCKET_RANKED and prev.position <= 10 and not (
                cur.bucket == BUCKET_RANKED and cur.position <= 10) and cur.bucket != BUCKET_FAILED:
            out.append(_alert("FELL_OUT_OF_TOP_10", "high", kw.tab_name,
                              f"Fell out of the top 10: {bucket_label(prev)} → {bucket_label(cur)}", keyword=kw, run=run))
        if prev and cur and prev.ai_state == AI_CITED and cur.ai_state in (AI_NOT_CITED, AI_NONE):
            out.append(_alert("LOST_AI_CITATION", "medium", kw.tab_name,
                              "No longer cited in the AI Overview" if cur.ai_state == AI_NOT_CITED
                              else "The AI Overview disappeared for this query", keyword=kw, run=run))
        if prev and cur and url_mismatch(prev.found_url, cur.found_url):
            out.append(_alert("RANKING_PAGE_CHANGED", "medium", kw.tab_name,
                              f"Google now ranks a different page: {prev.found_url} → {cur.found_url}", keyword=kw, run=run))
        if cur and cur.bucket == BUCKET_RANKED and not kw.target_url:
            out.append(_alert("RANKED_WITHOUT_URL", "low", kw.tab_name,
                              f"Ranks {cur.position} but the job left Live URL blank", keyword=kw, run=run))
        for c in data.checks.get(kw.id, []):
            r = data.runs[c.run_id]
            if c.bucket == BUCKET_UNPARSED:
                out.append(_alert("UNPARSEABLE_VALUE", "medium", kw.tab_name,
                                  f"Position '{c.raw_position}' in {r.label} ({r.column_letter}) can't be read", keyword=kw, run=r))
            if c.ai_state == AI_UNPARSED:
                out.append(_alert("UNPARSEABLE_VALUE", "medium", kw.tab_name,
                                  f"AI Overview '{c.raw_ai}' in {r.label} can't be read (expected Yes / No / No AI Overview)",
                                  keyword=kw, run=r))
            if c.is_override:
                out.append(_alert("MANUAL_OVERRIDE", "medium", kw.tab_name,
                                  f"Result in {r.label} was changed after the run", keyword=kw, run=r))
    for (tab_name, _norm), ks in _duplicates(data.keywords).items():
        rows = ", ".join(str(k.row_number) for k in ks)
        out.append(_alert("DUPLICATE_KEYWORD", "low", tab_name, f"'{ks[0].keyword}' appears {len(ks)} times (rows {rows})",
                          keyword=ks[0], extra={"keywordIds": [k.id for k in ks]}))
    for tab_name, runs in data.runs_by_tab.items():
        for d in missed_mondays(runs, now):
            out.append(_alert("MISSED_MONDAY_RUN", "high", tab_name, f"No ranking run on Monday {d:%d %b %Y}",
                              extra={"runDate": d.isoformat()}))
        if runs and runs[-1].failed_count:
            out.append(_alert("CHECKS_FAILED", "medium", tab_name,
                              f"{runs[-1].failed_count} of {runs[-1].keywords_checked} checks failed in {runs[-1].label}",
                              run=runs[-1]))
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda a: (order[a["severity"]], a["type"], a["tab"], a.get("runDate") or "", a.get("keyword") or ""))
    return out


def _alert_counts(items: list) -> dict:
    counts: dict = defaultdict(int)
    for a in items:
        counts[a["type"]] += 1
    return dict(counts)


# --------------------------------------------------------------------------- #
# Who added what
# --------------------------------------------------------------------------- #
def contributors(db: Session, sheet: TrackedSheet, tab: Optional[str] = None) -> list:
    directory = people_directory(db)
    q = db.query(RequestEvent).filter(RequestEvent.sheet_id == sheet.id, RequestEvent.event_type.in_(KEYWORD_EVENTS))
    if tab:
        q = q.filter(RequestEvent.tab_name == tab)
    people: dict = defaultdict(lambda: {"added": [], "edits": 0, "removed": 0, "last": None})
    names = {k.id: k.keyword for k in db.query(Keyword).filter(Keyword.sheet_id == sheet.id)}
    for e in q.order_by(RequestEvent.occurred_at.desc()):
        p = people[(e.actor_email or "").lower() or None]
        if e.event_type == "KEYWORD_ADDED":
            p["added"].append({"keywordId": e.keyword_id, "keyword": names.get(e.keyword_id, e.new_value),
                               "tab": e.tab_name, "at": _iso(e.occurred_at)})
        elif e.event_type == "KEYWORD_EDITED":
            p["edits"] += 1
        else:
            p["removed"] += 1
        p["last"] = max(filter(None, [p["last"], e.occurred_at]))
    imported = db.query(Keyword).filter(Keyword.sheet_id == sheet.id, Keyword.is_imported.is_(True))
    if tab:
        imported = imported.filter(Keyword.tab_name == tab)
    rows = [{**_person(directory, email), "addedCount": len(p["added"]), "added": p["added"][:100],
             "edits": p["edits"], "removed": p["removed"], "lastActivity": _iso(p["last"])} for email, p in people.items()]
    rows.sort(key=lambda r: (-(r["addedCount"] + r["edits"] + r["removed"]), r["email"] or "~"))
    return rows + [{"email": None, "name": "Before tracking", "userId": None, "imported": True,
                    "addedCount": imported.count(), "added": [], "edits": 0, "removed": 0, "lastActivity": None}]


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def _csv_safe(value) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _stream(header: list, rows) -> Iterator[str]:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    yield "﻿" + buf.getvalue()
    for row in rows:
        buf.seek(0)
        buf.truncate(0)
        w.writerow([_csv_safe(v) for v in row])
        yield buf.getvalue()


def keywords_csv(db: Session, sheet: TrackedSheet, f: KeywordFilters) -> Iterator[str]:
    rows = keyword_rows(db, sheet, f)
    return _stream(
        ["Site", "Keyword", "Live URL (ranking page)", "Added by", "Added at (UTC)", "Current", "Current AI Overview", "Previous",
         "Change", "Movement", "Best", "Duplicate", "Override", "Unreadable value"],
        ([r["tab"], r["keyword"], r["targetUrl"],
          "Before tracking" if r["isImported"] else (r["addedBy"]["email"] or "Unknown user"),
          r["addedAt"], (r["current"] or {}).get("display"), (r["current"] or {}).get("aiState"),
          (r["previous"] or {}).get("display"), r["change"]["delta"], r["change"]["direction"], r["best"],
          "yes" if r["isDuplicate"] else "", "yes" if r["hasOverride"] else "", "yes" if r["hasUnparsed"] else ""]
         for r in rows))


def history_csv(db: Session, sheet: TrackedSheet, f: KeywordFilters) -> Iterator[str]:
    wanted = {r["id"] for r in keyword_rows(db, sheet, f)}
    data = load(db, sheet, f.tab)

    def rows():
        for kw in data.keywords:
            if kw.id not in wanted:
                continue
            last_page = None
            for c in data.checks.get(kw.id, []):
                r = data.runs[c.run_id]
                yield [kw.tab_name, kw.keyword, kw.target_url, c.check_date.isoformat(), r.label, r.trigger, c.position,
                       c.bucket, c.depth, c.ai_state, c.raw_position, c.raw_ai, c.found_url,
                       "yes" if url_mismatch(last_page, c.found_url) else "", "yes" if c.is_override else "", c.source]
                last_page = c.found_url or last_page
    return _stream(["Site", "Keyword", "Target URL", "Check date", "Run", "Trigger", "Position", "Bucket", "Depth",
                    "AI Overview", "Raw position", "Raw AI Overview", "Ranking page", "Page changed", "Override", "Source"], rows())
