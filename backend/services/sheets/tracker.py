"""Snapshot diff -> content request timeline.

The Claude agent writes to the sheet through the API, which fires no
Apps Script trigger, so its responses are seen only by comparing each poll
with the stored copy of every row (ContentRequest.values_json). Each
change is classified by the column it touched (mapping.py) and by the
status transition it came with:

    Status -> Awaiting Approval   STRUCTURE_GENERATED  claude
    Status -> Approved            APPROVED             user
    Status -> In Progress         DRAFT_STARTED        claude
    Status -> Delivered           DELIVERED            claude  (+ ERROR if no Final Doc Link)
    Topic blank -> filled         NEW_REQUEST          user
    other input column            INPUT_EDIT           user
    Optimized Structure, no status change: blank -> text  STRUCTURE_GENERATED claude,
                                           text -> text   STRUCTURE_EDITED_BY_USER user

When the Sheet Activity Apps Script is installed, human edits also arrive
in sheet_activity with the editor's email and exact time. A change the
script saw is attributed to that person (onEdit only ever fires for
humans); everything else keeps the rule above, timed at the poll.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from models_new import ContentRequest, RequestEvent, SheetActivity, TrackedSheet

from . import mapping as M

ERROR_WORDS = ("error", "fail", "failed")
MATCH_WINDOW = timedelta(hours=6)       # how far back a poll looks for the matching human edit
LEASE = timedelta(minutes=5)

USER, CLAUDE, UNKNOWN, SYSTEM = "user", "claude", "unknown", "system"


@dataclass
class EventDraft:
    event_type: str
    actor_type: str
    column: Optional[str] = None
    old: Optional[str] = None
    new: Optional[str] = None
    meta: dict = field(default_factory=dict)


def stage_of(value: str, statuses: dict) -> Optional[str]:
    v = (value or "").strip().lower()
    if not v:
        return None
    for key, label in statuses.items():
        if v == (label or "").strip().lower():
            return key
    return "other"


def classify_row_change(old: dict, new: dict, mapping: dict, statuses: dict) -> list:
    """Events for one row going from ``old`` to ``new`` values (pure)."""
    old, new = old or {}, new or {}
    headers = [h for h in mapping if M.side_of(mapping, h) != "ignore"]
    changed = [h for h in headers if (old.get(h) or "") != (new.get(h) or "")]
    if not changed:
        return []
    status_h = M.first_header(mapping, "status")
    struct_h = M.first_header(mapping, "structure")
    link_h = M.first_header(mapping, "final_link")
    topic_h = M.first_header(mapping, "topic")
    consumed: set = set()
    user_events, claude_events = [], []

    # User inputs.
    for h in changed:
        if M.side_of(mapping, h) != "input":
            continue
        consumed.add(h)
        if h == topic_h and not (old.get(h) or "") and (new.get(h) or ""):
            user_events.append(EventDraft("NEW_REQUEST", USER, h, None, new.get(h)))
        else:
            user_events.append(EventDraft("INPUT_EDIT", USER, h, old.get(h) or None, new.get(h) or None))

    # Status transitions carry the outputs written with them.
    if status_h and status_h in changed:
        consumed.add(status_h)
        st_old, st_new = old.get(status_h) or "", new.get(status_h) or ""
        key = stage_of(st_new, statuses)
        meta = {"statusFrom": st_old or None, "statusTo": st_new or None}
        if key == "awaiting":
            ev = EventDraft("STRUCTURE_GENERATED", CLAUDE, struct_h, old.get(struct_h) or None, new.get(struct_h) or None, meta)
            if struct_h:
                consumed.add(struct_h)
            claude_events.append(ev)
        elif key == "approved":
            user_events.append(EventDraft("APPROVED", USER, status_h, st_old or None, st_new, meta))
        elif key == "in_progress":
            claude_events.append(EventDraft("DRAFT_STARTED", CLAUDE, status_h, st_old or None, st_new, meta))
        elif key == "delivered":
            link = (new.get(link_h) or "") if link_h else ""
            claude_events.append(EventDraft("DELIVERED", CLAUDE, link_h or status_h,
                                            (old.get(link_h) or None) if link_h else st_old or None,
                                            link or None, meta))
            if link_h:
                consumed.add(link_h)
            if not link:
                claude_events.append(EventDraft("ERROR", CLAUDE, link_h or status_h, None, None,
                                                {**meta, "message": "Delivered with no Final Doc Link"}))
        elif key == "other" and any(w in st_new.lower() for w in ERROR_WORDS):
            claude_events.append(EventDraft("ERROR", CLAUDE, status_h, st_old or None, st_new, {**meta, "message": st_new}))
        else:
            user_events.append(EventDraft("OTHER_STATUS_CHANGE", UNKNOWN, status_h, st_old or None, st_new or None, meta))

    if struct_h and struct_h in changed and struct_h not in consumed:
        consumed.add(struct_h)
        if not (old.get(struct_h) or ""):
            claude_events.append(EventDraft("STRUCTURE_GENERATED", CLAUDE, struct_h, None, new.get(struct_h) or None))
        else:
            user_events.append(EventDraft("STRUCTURE_EDITED_BY_USER", USER, struct_h, old.get(struct_h) or None,
                                          new.get(struct_h) or None))

    for h in changed:
        if h in consumed:
            continue
        actor = CLAUDE if (new.get(h) or "") else UNKNOWN
        claude_events.append(EventDraft("OUTPUT_UPDATED", actor, h, old.get(h) or None, new.get(h) or None))
    return user_events + claude_events


# --------------------------------------------------------------------------- #
# Polling lease (several backend workers, one poll per sheet)
# --------------------------------------------------------------------------- #
def claim_poll(db: Session, sheet_id: int, now: datetime) -> bool:
    res = db.execute(
        update(TrackedSheet)
        .where(TrackedSheet.id == sheet_id,
               or_(TrackedSheet.poll_lease_until.is_(None), TrackedSheet.poll_lease_until < now))
        .values(poll_lease_until=now + LEASE)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return res.rowcount == 1


# --------------------------------------------------------------------------- #
# Sync
# --------------------------------------------------------------------------- #
def row_values(row, mapping: dict) -> dict:
    """Mapped values of one row; link columns prefer the hyperlink target."""
    out = {}
    for header in mapping:
        text = row.values.get(header, "") if header in row.values else ""
        link = row.links.get(header) if getattr(row, "links", None) else None
        if link and M.is_link_header(mapping, header) and not text.startswith(("http://", "https://")):
            text = link
        out[header] = text
    return out


def _find_human_edit(db: Session, sheet: TrackedSheet, tab: str, row_number: int, column_number: Optional[int],
                     new_value: Optional[str], now: datetime) -> Optional[SheetActivity]:
    """The Sheet Activity onEdit event behind this cell change, if the
    Apps Script captured it."""
    if not row_number or not column_number:
        return None
    candidates = (
        db.query(SheetActivity)
        .filter(SheetActivity.spreadsheet_id == sheet.spreadsheet_id,
                SheetActivity.sheet_name == tab,
                SheetActivity.change_type == "EDIT",
                SheetActivity.timestamp >= now - MATCH_WINDOW)
        .order_by(SheetActivity.timestamp.desc())
        .limit(200)
        .all()
    )
    for ev in candidates:
        r0, c0 = ev.row or 0, ev.column or 0
        r1, c1 = r0 + max(1, ev.num_rows or 1) - 1, c0 + max(1, ev.num_columns or 1) - 1
        if not (r0 <= row_number <= r1 and c0 <= column_number <= c1):
            continue
        if ev.is_multi_cell or (ev.new_value or "") == (new_value or ""):
            return ev
    return None


def _set_stage(req: ContentRequest, draft: EventDraft, when: datetime) -> None:
    t = draft.event_type
    if t == "NEW_REQUEST":
        req.requested_at = req.requested_at or when
    elif t == "STRUCTURE_GENERATED":
        req.awaiting_at = when
    elif t == "APPROVED":
        req.approved_at = when
    elif t == "DRAFT_STARTED":
        req.in_progress_at = when
    elif t == "DELIVERED":
        req.delivered_at = when
        if draft.new:
            req.error = None
    elif t == "ERROR":
        req.error = (draft.meta or {}).get("message") or draft.new or "Error"


def _previous_stage_time(req: ContentRequest, event_type: str) -> Optional[datetime]:
    return {
        "STRUCTURE_GENERATED": req.requested_at,
        "DRAFT_STARTED": req.approved_at,
        "DELIVERED": req.in_progress_at or req.approved_at,
    }.get(event_type)


def _record(db, sheet, req, tab, draft, vals, columns, row_number, now, source="poller"):
    when = now
    meta = dict(draft.meta or {})
    actor_type, actor_email = draft.actor_type, None
    human = _find_human_edit(db, sheet, tab, row_number, columns.get(draft.column), draft.new, now) if draft.column else None
    if human is not None:
        actor_type, actor_email, when = USER, human.user_email, human.timestamp
        meta["sheetActivityId"] = human.id
    else:
        meta["approximateTime"] = True
    if actor_type == CLAUDE:
        inputs = {h: vals.get(h) for h in vals if (sheet.mapping_json.get(h) or {}).get("side") == "input"}
        previous = _previous_stage_time(req, draft.event_type)
        meta.update({
            "inputs": inputs,
            "model": None, "tokenUsage": None,       # not visible to the poller (scheduled Claude agent)
            "durationSeconds": int((when - previous).total_seconds()) if previous else None,
            "observedBy": "poller",
        })
    _set_stage(req, draft, when)
    if draft.event_type == "NEW_REQUEST" and actor_email and not req.created_by_email:
        req.created_by_email = actor_email
    db.add(RequestEvent(
        request_id=req.id, sheet_id=sheet.id, tab_name=tab, actor_type=actor_type, actor_email=actor_email,
        event_type=draft.event_type, column_name=draft.column, old_value=draft.old, new_value=draft.new,
        metadata_json=meta, occurred_at=when, source=source,
    ))


def sync_sheet(db: Session, sheet: TrackedSheet, tabs: dict, now: Optional[datetime] = None) -> dict:
    """Apply one poll's workbook to the sheet's requests. Returns counters."""
    now = now or datetime.utcnow()
    mapping = sheet.mapping_json or {}
    statuses = M.validate_statuses(sheet.statuses_json)
    config = M.validate_config(sheet.config_json)
    key_h = M.pick_key_column(mapping, config)
    topic_h = M.first_header(mapping, "topic")
    status_h = M.first_header(mapping, "status")
    tracked = [t["name"] for t in (sheet.tabs_json or []) if t.get("tracked")]
    first_sync = sheet.last_polled_at is None
    stats = {"tabs": 0, "rows": 0, "created": 0, "events": 0, "removed": 0, "missingTabs": []}

    existing = {(r.tab_name, r.row_key): r for r in db.query(ContentRequest).filter(ContentRequest.sheet_id == sheet.id)}
    seen: set = set()

    for tab_name in tracked:
        tab = tabs.get(tab_name)
        if tab is None:
            stats["missingTabs"].append(tab_name)
            continue
        stats["tabs"] += 1
        columns = {h: i + 1 for i, h in enumerate(tab.headers)}
        keys_this_tab: set = set()
        for row in tab.rows:
            if config["skipExampleRows"] and row.is_example:
                continue
            vals = row_values(row, mapping)
            raw_key = (vals.get(key_h) or "").strip() if key_h else ""
            key = raw_key or f"row-{row.row_number}"
            if key in keys_this_tab:                      # duplicate "No." values
                key = f"{key}@row{row.row_number}"
            keys_this_tab.add(key)
            has_content = any(vals.get(h) for h in mapping if M.side_of(mapping, h) in ("input", "output"))
            req = existing.get((tab_name, key))
            if req is None and not has_content:
                continue                                  # pre-numbered empty row
            stats["rows"] += 1
            seen.add((tab_name, key))
            if req is None:
                req = ContentRequest(sheet_id=sheet.id, tab_name=tab_name, row_key=key, row_number=row.row_number,
                                     values_json={}, first_seen_at=now, last_changed_at=now, is_imported=first_sync)
                db.add(req)
                db.flush()
                existing[(tab_name, key)] = req
                stats["created"] += 1
                if first_sync:
                    db.add(RequestEvent(
                        request_id=req.id, sheet_id=sheet.id, tab_name=tab_name, actor_type=SYSTEM,
                        event_type="IMPORTED", new_value=vals.get(status_h) or None,
                        metadata_json={"values": vals, "note": "Already in the sheet when it was registered; "
                                                               "earlier history is unknown."},
                        occurred_at=now, source="import"))
                    stats["events"] += 1
                    _set_import_stage(req, vals.get(status_h) or "", statuses, now)
                    _apply_values(req, vals, topic_h, status_h, row.row_number, now, changed=True)
                    if stage_of(vals.get(status_h), statuses) == "delivered" and not vals.get(M.first_header(mapping, "final_link") or ""):
                        req.error = "Delivered with no Final Doc Link"
                    continue
            elif req.removed_at is not None:
                req.removed_at = None
            drafts = classify_row_change(req.values_json or {}, vals, mapping, statuses)
            for d in drafts:
                _record(db, sheet, req, tab_name, d, vals, columns, row.row_number, now)
            stats["events"] += len(drafts)
            _apply_values(req, vals, topic_h, status_h, row.row_number, now, changed=bool(drafts))

    present_tabs = {t for t in tracked if t in tabs}
    for (tab_name, key), req in existing.items():
        if tab_name in present_tabs and (tab_name, key) not in seen and req.removed_at is None:
            req.removed_at = now
            db.add(RequestEvent(request_id=req.id, sheet_id=sheet.id, tab_name=tab_name, actor_type=UNKNOWN,
                                event_type="REMOVED", metadata_json={"rowKey": key}, occurred_at=now))
            stats["removed"] += 1

    sheet.last_polled_at = now
    sheet.last_poll_status = "ok" if not stats["missingTabs"] else "warning"
    sheet.last_poll_error = (f"Tracked tab(s) not found: {', '.join(stats['missingTabs'])}"
                             if stats["missingTabs"] else None)
    db.commit()
    return stats


def _apply_values(req, vals, topic_h, status_h, row_number, now, *, changed: bool) -> None:
    req.values_json = dict(vals)
    req.topic = (vals.get(topic_h) or None) if topic_h else None
    req.status = (vals.get(status_h) or None) if status_h else None
    req.row_number = row_number
    if changed:
        req.last_changed_at = now


def _set_import_stage(req, status: str, statuses: dict, now: datetime) -> None:
    """Imported rows: stage times are unknown, so none are invented."""
    req.requested_at = None
    req.status = status or None
