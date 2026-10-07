"""keyword_ranking: sheet snapshot -> keywords / ranking_runs / ranking_checks.

Two writers feed the same tables:

* the importer (sync_ranking_sheet), run by every poll: reads the wide sheet,
  so it backfills all history on the first poll and picks up each new date
  column the job adds. It can only know what the sheet shows.
* the job's own report (ingest_job_report, POST /api/sheets/ranking-results):
  adds what only the job knows - the URL that actually ranked, the raw API
  response, cost, duration and settings.

Who did what:
* Keywords are typed by people in the Keyword URL Source Sheet; the job copies
  them here. KEYWORD_ADDED / EDITED / REMOVED are actor "user"; the Sheet
  Activity onEdit capture on the source sheet (or this one) names the person.
* Live URL is filled in by the job: it is the page Google ranks for the
  keyword (no keyword that never ranked has one). URL_CHANGED is actor
  "seo_api", and each run's check stores the Live URL seen with it as
  found_url, so a change of ranking page shows up between runs.
* Results are written by the job (actor "seo_api"). A result that changes
  after it was first seen is a MANUAL_RESULT_OVERRIDE when a human edit was
  captured on that cell, or when the run is older than OVERRIDE_AFTER_DAYS
  (the job never rewrites old runs); otherwise RESULT_UPDATED by the job.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from models_new import Keyword, RankingCheck, RankingRun, RequestEvent, SheetActivity, TrackedSheet

from .ranking import (
    AI_FAILED,
    BUCKET_FAILED,
    Position,
    infer_trigger,
    normalize_ai,
    normalize_keyword,
    normalize_position,
)

USER, SEO_API, UNKNOWN, SYSTEM = "user", "seo_api", "unknown", "system"
OVERRIDE_AFTER_DAYS = 2
KEYWORD_MATCH_WINDOW = timedelta(days=21)   # the job copies new keywords weekly
RAW_RESPONSE_MAX_CHARS = 8000
IST = timedelta(minutes=330)


def _event(db, sheet, tab, event_type, actor, *, keyword=None, email=None, column=None, old=None, new=None,
           meta=None, when, source="poller"):
    db.add(RequestEvent(sheet_id=sheet.id, keyword_id=keyword.id if keyword else None, tab_name=tab,
                        actor_type=actor, actor_email=email, event_type=event_type, column_name=column,
                        old_value=old, new_value=new, metadata_json=meta or {}, occurred_at=when, source=source))


def _target_url(row) -> str:
    text = (row.url or "").strip()
    if row.url_link and not text.startswith(("http://", "https://")):
        return row.url_link
    return text


def _find_keyword_edit(db, sheet: TrackedSheet, tab: str, text: str, now: datetime, *, removed=False) -> Optional[SheetActivity]:
    """The person behind a keyword change: an onEdit capture on the source
    sheet (or this sheet) whose new (or, for removals, old) value is the keyword."""
    norm = normalize_keyword(text)
    ids = [i for i in (sheet.source_spreadsheet_id, sheet.spreadsheet_id) if i]
    rows = (db.query(SheetActivity)
            .filter(SheetActivity.spreadsheet_id.in_(ids), SheetActivity.change_type == "EDIT",
                    SheetActivity.timestamp >= now - KEYWORD_MATCH_WINDOW,
                    SheetActivity.timestamp <= now)
            .order_by(SheetActivity.timestamp.desc()).limit(2000).all())
    for ev in rows:
        value = ev.old_value if removed else ev.new_value
        if value and normalize_keyword(value) == norm:
            return ev
        if not removed and ev.is_multi_cell and ev.new_value and norm and norm in normalize_keyword(ev.new_value):
            return ev
    return None


def _find_cell_edit(db, sheet, tab, row_number, columns, since: datetime) -> Optional[SheetActivity]:
    rows = (db.query(SheetActivity)
            .filter(SheetActivity.spreadsheet_id == sheet.spreadsheet_id, SheetActivity.sheet_name == tab,
                    SheetActivity.change_type == "EDIT", SheetActivity.timestamp >= since)
            .order_by(SheetActivity.timestamp.desc()).limit(500).all())
    for ev in rows:
        r0, c0 = ev.row or 0, ev.column or 0
        r1, c1 = r0 + max(1, ev.num_rows or 1) - 1, c0 + max(1, ev.num_columns or 1) - 1
        if r0 <= row_number <= r1 and any(c and c0 <= c <= c1 for c in columns):
            return ev
    return None


def _attribute(ev: Optional[SheetActivity], now: datetime) -> tuple:
    """(actor_email, when, meta) for a user action."""
    if ev is not None:
        return ev.user_email, ev.timestamp, {"sheetActivityId": ev.id, "sheet": ev.spreadsheet_id}
    return None, now, {"approximateTime": True}


def _result_tuple(check: RankingCheck) -> tuple:
    return check.position, check.bucket, check.ai_state


def _recount(db: Session, run: RankingRun) -> None:
    checks = db.query(RankingCheck).filter(RankingCheck.run_id == run.id).all()
    failed = sum(1 for c in checks if c.bucket == BUCKET_FAILED or c.ai_state == AI_FAILED)
    run.keywords_checked = len(checks)
    run.failed_count = failed
    run.success_count = len(checks) - failed


def sync_ranking_sheet(db: Session, sheet: TrackedSheet, tabs: dict, now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    tracked = [t["name"] for t in (sheet.tabs_json or []) if t.get("tracked")]
    first_sync = sheet.last_polled_at is None
    stats = {"tabs": 0, "keywords": 0, "added": 0, "edited": 0, "removed": 0, "runs": 0, "newRuns": 0,
             "checks": 0, "overrides": 0, "missingTabs": [], "problems": []}

    for tab_name in tracked:
        tab = tabs.get(tab_name)
        if tab is None or not tab.is_ranking:
            stats["missingTabs" if tab is None else "problems"].append(
                tab_name if tab is None else f"{tab_name}: {'; '.join(tab.problems) or 'not a ranking tab'}")
            continue
        stats["tabs"] += 1
        stats["problems"] += [f"{tab_name}: {p}" for p in tab.problems]

        # ---- keywords ----------------------------------------------------
        existing = {k.row_key: k for k in db.query(Keyword).filter(Keyword.sheet_id == sheet.id, Keyword.tab_name == tab_name)}
        seen_count: dict = {}
        current = []
        for row in tab.rows:
            norm = normalize_keyword(row.keyword)
            seen_count[norm] = seen_count.get(norm, 0) + 1
            current.append((f"{norm}#{seen_count[norm]}", norm, row))
        now_keys = {key for key, _n, _r in current}
        missing = [k for key, k in existing.items() if k.is_active and key not in now_keys]
        missing_by_row = {k.row_number: k for k in missing if k.row_number}
        by_key: dict = {}

        for key, norm, row in current:
            kw = existing.get(key)
            if kw is None and not first_sync and row.row_number in missing_by_row:
                kw = missing_by_row.pop(row.row_number)          # same row, new text: an edit
                missing.remove(kw)
                ev = _find_keyword_edit(db, sheet, tab_name, row.keyword, now)
                email, when, meta = _attribute(ev, now)
                _event(db, sheet, tab_name, "KEYWORD_EDITED", USER, keyword=kw, email=email, column="Keyword",
                       old=kw.keyword, new=row.keyword, meta=meta, when=when)
                kw.keyword, kw.keyword_norm, kw.row_key = row.keyword, norm, key
                stats["edited"] += 1
            elif kw is None:
                kw = Keyword(sheet_id=sheet.id, tab_name=tab_name, row_key=key, keyword=row.keyword, keyword_norm=norm,
                             target_url=_target_url(row) or None, s_no=row.s_no, row_number=row.row_number,
                             first_seen_at=now, last_seen_at=now, is_imported=first_sync)
                db.add(kw)
                db.flush()
                if first_sync:
                    _event(db, sheet, tab_name, "IMPORTED", SYSTEM, keyword=kw, new=row.keyword, when=now, source="import",
                           meta={"note": "Already in the sheet when it was registered; who added it is unknown."})
                else:
                    ev = _find_keyword_edit(db, sheet, tab_name, row.keyword, now)
                    email, when, meta = _attribute(ev, now)
                    kw.added_by_email, kw.added_at = email, when
                    _event(db, sheet, tab_name, "KEYWORD_ADDED", USER, keyword=kw, email=email, column="Keyword",
                           new=row.keyword, meta={**meta, "targetUrl": kw.target_url}, when=when)
                    stats["added"] += 1
            elif not kw.is_active:
                kw.is_active, kw.removed_at = True, None
                _event(db, sheet, tab_name, "KEYWORD_ADDED", USER, keyword=kw, column="Keyword", new=row.keyword,
                       meta={"approximateTime": True, "note": "Re-added"}, when=now)
                stats["added"] += 1
            url = _target_url(row) or None
            if not first_sync and (kw.target_url or None) != url and not (kw.target_url is None and url is None):
                _event(db, sheet, tab_name, "URL_CHANGED", SEO_API, keyword=kw, column="Live URL",
                       old=kw.target_url, new=url, meta={"approximateTime": True}, when=now)
            kw.target_url, kw.s_no, kw.row_number, kw.last_seen_at = url, row.s_no, row.row_number, now
            by_key[key] = (kw, row)

        for kw in missing:
            kw.is_active, kw.removed_at = False, now
            ev = _find_keyword_edit(db, sheet, tab_name, kw.keyword, now, removed=True)
            email, when, meta = _attribute(ev, now)
            _event(db, sheet, tab_name, "KEYWORD_REMOVED", USER, keyword=kw, email=email, column="Keyword",
                   old=kw.keyword, meta=meta, when=when)
            stats["removed"] += 1
        stats["keywords"] += len(by_key)

        # ---- runs and results -----------------------------------------------
        runs = {r.run_key: r for r in db.query(RankingRun).filter(RankingRun.sheet_id == sheet.id, RankingRun.tab_name == tab_name)}
        # The Live URL is only known as of now: on the first (backfill) read
        # it is credited to the latest run only, never to older runs.
        latest_key = tab.runs[-1].run_key if tab.runs else None
        for col in tab.runs:
            run = runs.get(col.run_key)
            if run is None:
                run = RankingRun(sheet_id=sheet.id, tab_name=tab_name, run_key=col.run_key, check_date=col.check_date,
                                 label=col.label, trigger=infer_trigger(col.check_date, col.is_baseline),
                                 column_letter=col.letter, source="importer", first_seen_at=now)
                db.add(run)
                db.flush()
                runs[col.run_key] = run
                stats["newRuns"] += 1
                _event(db, sheet, tab_name, "RUN_RECORDED", SEO_API, new=col.label, when=now,
                       source="import" if first_sync else "poller",
                       meta={"runId": run.id, "checkDate": col.check_date.isoformat(), "trigger": run.trigger,
                             "approximateTime": True})
            else:
                run.label, run.column_letter = run.label or col.label, col.letter
            stats["runs"] += 1
            existing_checks = {c.keyword_id: c for c in db.query(RankingCheck).filter(RankingCheck.run_id == run.id)}
            for key, (kw, row) in by_key.items():
                cell = row.cells.get(col.run_key)
                if cell is None:
                    continue
                raw_pos, raw_ai = cell
                pos, ai = normalize_position(raw_pos), normalize_ai(raw_ai)
                check = existing_checks.get(kw.id)
                values = (pos.position, pos.bucket, ai)
                if check is None:
                    page = kw.target_url if pos.bucket == "ranked" and (not first_sync or col.run_key == latest_key) else None
                    db.add(RankingCheck(keyword_id=kw.id, run_id=run.id, check_date=col.check_date, position=pos.position,
                                        bucket=pos.bucket, depth=pos.depth, ai_state=ai, raw_position=_raw(raw_pos),
                                        raw_ai=_raw(raw_ai), found_url=page, source="importer"))
                    stats["checks"] += 1
                    continue
                if _result_tuple(check) == values:
                    continue
                old_text = f"{check.raw_position or ''} / {check.raw_ai or ''}"
                new_text = f"{_raw(raw_pos) or ''} / {_raw(raw_ai) or ''}"
                run_start = datetime(col.check_date.year, col.check_date.month, col.check_date.day) - IST
                human = _find_cell_edit(db, sheet, tab_name, row.row_number, (col.position_col, col.ai_col), run_start)
                if human is not None or (now + IST).date() - col.check_date >= timedelta(days=OVERRIDE_AFTER_DAYS):
                    email, when, meta = _attribute(human, now)
                    if human is None:
                        meta["reason"] = f"Result changed {((now + IST).date() - col.check_date).days} days after the run"
                    _event(db, sheet, tab_name, "MANUAL_RESULT_OVERRIDE", USER if human else UNKNOWN, keyword=kw,
                           email=email, column=f"{col.label} ({col.letter})", old=old_text, new=new_text, meta=meta, when=when)
                    check.is_override = True
                    stats["overrides"] += 1
                else:
                    _event(db, sheet, tab_name, "RESULT_UPDATED", SEO_API, keyword=kw, column=f"{col.label} ({col.letter})",
                           old=old_text, new=new_text, meta={"approximateTime": True}, when=now)
                check.position, check.bucket, check.depth, check.ai_state = pos.position, pos.bucket, pos.depth, ai
                check.raw_position, check.raw_ai = _raw(raw_pos), _raw(raw_ai)
            db.flush()
            _recount(db, run)

    sheet.last_polled_at = now
    notes = ([f"Tracked tab(s) not found: {', '.join(stats['missingTabs'])}"] if stats["missingTabs"] else []) + stats["problems"]
    sheet.last_poll_status = "warning" if notes else "ok"
    sheet.last_poll_error = "; ".join(notes)[:2000] or None
    db.commit()
    return stats


def _raw(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()[:120] or None


# --------------------------------------------------------------------------- #
# The ranking job's own report
# --------------------------------------------------------------------------- #
def _trim_raw(raw):
    if raw is None:
        return None
    text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False, default=str)
    if len(text) <= RAW_RESPONSE_MAX_CHARS:
        return raw if not isinstance(raw, str) else {"text": raw}
    return {"truncated": True, "text": text[:RAW_RESPONSE_MAX_CHARS]}


def _resolve_run(db, sheet, tab, check_date: date, external_id: Optional[str], now) -> tuple:
    same_day = (db.query(RankingRun).filter(RankingRun.sheet_id == sheet.id, RankingRun.tab_name == tab,
                                            RankingRun.check_date == check_date).order_by(RankingRun.id).all())
    for run in same_day:
        if external_id and run.external_run_id == external_id:
            return run, False
    for run in same_day:
        if not run.external_run_id:
            return run, False                     # the importer saw this run's column first
    key = check_date.isoformat() if not same_day else f"{check_date.isoformat()}#{len(same_day) + 1}"
    run = RankingRun(sheet_id=sheet.id, tab_name=tab, run_key=key, check_date=check_date, first_seen_at=now,
                     trigger=infer_trigger(check_date, False), source="job")
    db.add(run)
    db.flush()
    return run, True


def ingest_job_report(db: Session, sheet: TrackedSheet, report, now: Optional[datetime] = None) -> dict:
    """Store one run as reported by the ranking job (see RankingReportIn)."""
    now = now or datetime.utcnow()
    run, created = _resolve_run(db, sheet, report.tab, report.runDate, report.runId, now)
    run.external_run_id = report.runId or run.external_run_id
    run.source = "job"
    if report.trigger:
        run.trigger = report.trigger
    for field_name, attr in (("api", "api"), ("location", "location"), ("gl", "gl"), ("cost", "cost"),
                             ("durationSeconds", "duration_seconds"), ("startedAt", "started_at"),
                             ("finishedAt", "finished_at")):
        value = getattr(report, field_name)
        if value is not None:
            setattr(run, attr, value.replace(tzinfo=None) if isinstance(value, datetime) and value.tzinfo else value)
    if report.errors:
        run.errors_json = report.errors[:200]

    keywords = (db.query(Keyword).filter(Keyword.sheet_id == sheet.id, Keyword.tab_name == report.tab)
                .order_by(Keyword.is_active.desc(), Keyword.row_number).all())
    by_norm: dict = {}
    for kw in keywords:
        by_norm.setdefault(kw.keyword_norm, kw)
    stored, unknown = 0, []
    for res in report.results:
        norm = normalize_keyword(res.keyword)
        kw = by_norm.get(norm)
        if kw is None:
            n = sum(1 for k in keywords if k.keyword_norm == norm) + 1
            kw = Keyword(sheet_id=sheet.id, tab_name=report.tab, row_key=f"{norm}#{n}", keyword=res.keyword.strip(),
                         keyword_norm=norm, target_url=res.targetUrl, first_seen_at=now, last_seen_at=now)
            db.add(kw)
            db.flush()
            ev = _find_keyword_edit(db, sheet, report.tab, res.keyword, now)
            email, when, meta = _attribute(ev, now)
            kw.added_by_email, kw.added_at = email, when
            _event(db, sheet, report.tab, "KEYWORD_ADDED", USER, keyword=kw, email=email, column="Keyword",
                   new=kw.keyword, meta={**meta, "via": "ranking job report"}, when=when, source="job")
            by_norm[norm] = kw
            keywords.append(kw)
            unknown.append(res.keyword)
        raw_pos = res.positionRaw if res.positionRaw is not None else res.position
        pos, ai = normalize_position(raw_pos), normalize_ai(res.aiOverview)
        if res.error:
            pos, ai = Position(None, BUCKET_FAILED), AI_FAILED
        check = db.query(RankingCheck).filter(RankingCheck.keyword_id == kw.id, RankingCheck.run_id == run.id).first()
        if check is None:
            check = RankingCheck(keyword_id=kw.id, run_id=run.id, check_date=run.check_date)
            db.add(check)
        check.position, check.bucket, check.depth, check.ai_state = pos.position, pos.bucket, pos.depth, ai
        check.raw_position, check.raw_ai = _raw(raw_pos), _raw(res.aiOverview)
        check.found_url = res.foundUrl
        check.raw_response = _trim_raw(res.raw if res.raw is not None else ({"error": res.error} if res.error else None))
        check.source = "job"
        stored += 1
    db.flush()
    _recount(db, run)
    if created:
        _event(db, sheet, report.tab, "RUN_RECORDED", SEO_API, new=run.label or run.check_date.isoformat(), when=now,
               source="job", meta={"runId": run.id, "trigger": run.trigger, "api": run.api, "cost": run.cost,
                                   "durationSeconds": run.duration_seconds, "checked": run.keywords_checked,
                                   "failed": run.failed_count})
    db.commit()
    return {"runId": run.id, "runCreated": created, "stored": stored, "newKeywords": unknown,
            "checked": run.keywords_checked, "failed": run.failed_count}
