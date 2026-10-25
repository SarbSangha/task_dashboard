"""Admin-entered credits for a generation card - the provider capture cards
(routers/provider_card_admin_router.py) and Kling's cards
(routers/generation_records_router.py).

The value is written into the card's real credit column - the one the credit
report and every other report already read - so nothing downstream has to
know about overrides. Capture sync and repricing keep rewriting those columns
(Higgsfield normalization, Flow's repricing sweep, Kling usage-event capture,
each provider's projection into generation_records), so a session-wide
before_flush hook puts the admin value back whenever one of them changes it,
keeping the value they tried to write so a reset restores the latest
captured number rather than a stale one.

Where the admin value lives:
  provider generations rows  admin_edit_json["credits"]  {value, capturedValue, ...}
  generation_records         admin_credits (the marker the hook checks), plus
                             for Kling metadata_json["adminCredits"]
                             {value, capturedValue, capturedEventValue, ...}
  it_portal_tool_usage_events  no marker: held via its Kling generation record
"""
import math
from typing import Optional

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

# generations table -> its credit column (the one utils/credit_report/facts.py's TOOL_SOURCES reads)
CARD_CREDIT_COLUMNS = {
    "freepik_generations": "credits_charged",
    "higgsfield_generations": "credits_used",
    "heygen_generations": "credits_used",
    "suno_generations": "credits_used",
    "elevenlabs_generations": "credits_used",
    "envato_generations": "credits_badge",
    "flow_generations": "credits_used",
}

MAX_ADMIN_CREDITS = 1_000_000


def validate_admin_credits(raw, *, whole: bool, maximum: float = MAX_ADMIN_CREDITS):
    """The credit value an admin entered, as the column's type. Raises
    ValueError with a user-facing message."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        raise ValueError("Enter the credits as a number")
    if raw < 0:
        raise ValueError("Credits can't be negative")
    if raw > maximum:
        raise ValueError(f"Credits can't be more than {maximum:g}")
    if whole:
        if raw != int(raw):
            raise ValueError("Credits for this tool are whole numbers")
        return int(raw)
    return float(raw)


def admin_credits_entry(admin_edit_json) -> Optional[dict]:
    entry = admin_edit_json.get("credits") if isinstance(admin_edit_json, dict) else None
    return entry if isinstance(entry, dict) and entry.get("value") is not None else None


def admin_credits_payload(entry) -> Optional[dict]:
    """What a card serializes about its admin credits (None when not set)."""
    if not isinstance(entry, dict) or entry.get("value") is None:
        return None
    return {"value": entry["value"], "capturedValue": entry.get("capturedValue"), "editedAt": entry.get("editedAt")}


def _hold_card_credits(card, column: str) -> None:
    entry = admin_credits_entry(card.admin_edit_json)
    if entry is None:
        return
    current = getattr(card, column)
    if current == entry["value"]:
        return
    admin_edit_json = dict(card.admin_edit_json)
    admin_edit_json["credits"] = {**entry, "capturedValue": current}
    card.admin_edit_json = admin_edit_json
    setattr(card, column, entry["value"])


def _hold_record_credits(record) -> None:
    value = record.admin_credits
    if value is None or record.credits_burned == value:
        return
    metadata = record.metadata_json if isinstance(record.metadata_json, dict) else {}
    entry = metadata.get("adminCredits")
    if isinstance(entry, dict):
        record.metadata_json = {**metadata, "adminCredits": {**entry, "capturedValue": record.credits_burned}}
    record.credits_burned = value


def _hold_usage_event_credits(session, usage_event) -> None:
    if not inspect(usage_event).attrs.credits_burned.history.has_changes():
        return
    from models_new import GenerationRecord  # models_new imports this module

    with session.no_autoflush:
        record = (
            session.query(GenerationRecord)
            .filter(GenerationRecord.source_usage_event_id == usage_event.id, GenerationRecord.admin_credits.isnot(None))
            .first()
        )
    # The query matches on flushed state, so also check the in-memory one: a
    # reset in this same flush has already released the card.
    if record is None or record.admin_credits is None or usage_event.credits_burned == record.admin_credits:
        return
    metadata = record.metadata_json if isinstance(record.metadata_json, dict) else {}
    entry = metadata.get("adminCredits")
    if isinstance(entry, dict):
        record.metadata_json = {**metadata, "adminCredits": {**entry, "capturedEventValue": usage_event.credits_burned}}
    usage_event.credits_burned = record.admin_credits


def _keep_admin_credits(session, flush_context, instances) -> None:
    for obj in list(session.dirty):
        table = getattr(obj, "__tablename__", None)
        column = CARD_CREDIT_COLUMNS.get(table)
        if column:
            _hold_card_credits(obj, column)
        elif table == "generation_records":
            _hold_record_credits(obj)
        elif table == "it_portal_tool_usage_events":
            _hold_usage_event_credits(session, obj)


if not event.contains(Session, "before_flush", _keep_admin_credits):
    event.listen(Session, "before_flush", _keep_admin_credits)
