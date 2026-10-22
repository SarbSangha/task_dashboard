"""
One-off repair for Kling cards showing another job's video.

Before the capture fix in content-kling.js (generationHasIdentityForOutput),
any video that started playing or appeared on the Kling page after a Generate
click could be stored as that click's output - and while a job renders people
replay their earlier outputs, so cards picked up a video from a job a few
cards back. The backend then picked a card's video alphabetically among
everything captured, and since a video can sit on only one card, the first
card to take a video pushed its rightful card onto a different one.

This recomputes every active Kling card's video:
  1. A video that exactly one card's Kling history row names (task id and
     output together - source "asset_history*") goes to that card.
  2. Every other card takes its best remaining choice by source trust
     (utils.generation_backfill._ranked_asset_choices), keeping its current
     video when that is still among its best allowed choices.
  3. A card left with nothing it can claim shows no video rather than
     someone else's.

Dry run by default; --apply writes.
"""
import argparse
import json
import logging

from database_config import OperationalSessionLocal
from models_new import GenerationRecord, ITPortalToolUsageEvent
from utils.generation_backfill import ASSET_SOURCE_TIER_IDENTITY, _canonical_asset_key, _ranked_asset_choices

PROVIDER = "kling"


def _media_assets(metadata) -> list:
    if not isinstance(metadata, dict):
        return []
    assets = metadata.get("mediaAssets")
    return [item for item in assets if isinstance(item, dict)] if isinstance(assets, list) else []


def _choices(record_metadata, event_metadata) -> list[tuple[str, str, int]]:
    """(url, key, tier) best first, from the card's own metadata and its
    source usage event's (the event can hold outputs merged after the card
    was last synced)."""
    merged = {"mediaAssets": _media_assets(record_metadata) + _media_assets(event_metadata)}
    choices = []
    seen_keys = set()
    for url, tier in _ranked_asset_choices(merged):
        key = _canonical_asset_key(url)
        if key and key not in seen_keys:
            seen_keys.add(key)
            choices.append((url, key, tier))
    return choices


def plan(records: list[dict], fixed_keys: set[str]) -> dict[int, tuple]:
    """records: [{id, created_at, current_key, choices}] for active cards.
    fixed_keys: keys held by cards this run doesn't touch (archived).
    Returns {record_id: (url, key, tier) or None}."""
    identity_claimers: dict[str, set[int]] = {}
    for record in records:
        for _url, key, tier in record["choices"]:
            if tier == ASSET_SOURCE_TIER_IDENTITY:
                identity_claimers.setdefault(key, set()).add(record["id"])
    reserved = {key: next(iter(ids)) for key, ids in identity_claimers.items() if len(ids) == 1}

    taken = set(fixed_keys)
    result: dict[int, tuple] = {}
    for record in sorted(records, key=lambda r: (r["created_at"], r["id"])):
        for choice in record["choices"]:
            if choice[2] == ASSET_SOURCE_TIER_IDENTITY and reserved.get(choice[1]) == record["id"] and choice[1] not in taken:
                result[record["id"]] = choice
                taken.add(choice[1])
                break

    def allowed(key: str, record_id: int) -> bool:
        return key not in taken and reserved.get(key, record_id) == record_id

    remaining = [r for r in records if r["id"] not in result]
    remaining.sort(key=lambda r: (min((c[2] for c in r["choices"]), default=99), r["created_at"], r["id"]))
    for record in remaining:
        options = [c for c in record["choices"] if allowed(c[1], record["id"])]
        if not options:
            result[record["id"]] = None
            continue
        best_tier = options[0][2]
        current = next((c for c in options if c[1] == record["current_key"] and c[2] == best_tier), None)
        choice = current or options[0]
        result[record["id"]] = choice
        taken.add(choice[1])
    return result


def run(session, apply: bool, logger: logging.Logger, sample_size: int = 25) -> dict:
    rows = (
        session.query(
            GenerationRecord.id, GenerationRecord.created_at, GenerationRecord.canonical_asset_url,
            GenerationRecord.canonical_asset_key, GenerationRecord.metadata_json,
            GenerationRecord.source_usage_event_id, GenerationRecord.archived_at,
        )
        .filter(GenerationRecord.provider == PROVIDER)
        .all()
    )
    event_ids = [row.source_usage_event_id for row in rows if row.source_usage_event_id and row.archived_at is None]
    event_metadata = {}
    for start in range(0, len(event_ids), 1000):
        chunk = event_ids[start:start + 1000]
        for event_id, metadata in (
            session.query(ITPortalToolUsageEvent.id, ITPortalToolUsageEvent.metadata_json)
            .filter(ITPortalToolUsageEvent.id.in_(chunk))
            .all()
        ):
            event_metadata[event_id] = metadata

    fixed_keys = {row.canonical_asset_key for row in rows if row.archived_at is not None and row.canonical_asset_key}
    records = [
        {
            "id": row.id,
            "created_at": row.created_at,
            "current_key": row.canonical_asset_key,
            "current_url": row.canonical_asset_url,
            "choices": _choices(row.metadata_json, event_metadata.get(row.source_usage_event_id)),
        }
        for row in rows
        if row.archived_at is None
    ]
    decisions = plan(records, fixed_keys)

    changes = []
    for record in records:
        choice = decisions.get(record["id"])
        new_key = choice[1] if choice else None
        if new_key == record["current_key"]:
            continue
        changes.append({
            "recordId": record["id"],
            "fromUrl": record["current_url"],
            "toUrl": choice[0] if choice else None,
            "toTier": choice[2] if choice else None,
        })

    summary = {
        "mode": "apply" if apply else "dry-run",
        "cardsChecked": len(records),
        "cardsChanged": len(changes),
        "movedToKlingHistoryVideo": sum(1 for c in changes if c["toTier"] == ASSET_SOURCE_TIER_IDENTITY),
        "movedToOtherVideo": sum(1 for c in changes if c["toUrl"] and c["toTier"] != ASSET_SOURCE_TIER_IDENTITY),
        "clearedToNoPreview": sum(1 for c in changes if not c["toUrl"]),
        "gainedVideo": sum(1 for c in changes if c["toUrl"] and not c["fromUrl"]),
        "sample": changes[:sample_size],
    }

    if apply and changes:
        by_id = {c["recordId"]: c for c in changes}
        targets = session.query(GenerationRecord).filter(GenerationRecord.id.in_(list(by_id))).all()
        # Release every key first: the (provider, canonical_asset_key) unique
        # index would reject a card taking a key another card is giving up
        # later in the same pass.
        for target in targets:
            target.canonical_asset_key = None
        session.flush()
        for target in targets:
            change = by_id[target.id]
            target.canonical_asset_url = change["toUrl"]
            target.canonical_asset_key = _canonical_asset_key(change["toUrl"]) if change["toUrl"] else None
            metadata = dict(target.metadata_json or {})
            history = list(metadata.get("videoRepairHistory") or [])
            history.append({"fromUrl": change["fromUrl"], "toUrl": change["toUrl"], "script": "repair_kling_card_videos"})
            metadata["videoRepairHistory"] = history[-10:]
            target.metadata_json = metadata
        session.commit()
    else:
        session.rollback()

    logger.info("Kling card video repair %s: checked=%s changed=%s", summary["mode"], len(records), len(changes))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Re-link each Kling card to its own video.")
    parser.add_argument("--apply", action="store_true", help="Write the changes. Omit for a dry run.")
    parser.add_argument("--sample", type=int, default=25, help="How many changes to list in the output.")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logger = logging.getLogger("repair_kling_card_videos")

    session = OperationalSessionLocal()
    try:
        summary = run(session, apply=args.apply, logger=logger, sample_size=args.sample)
        print(json.dumps(summary, indent=2, default=str))
        return 0
    except Exception as exc:
        session.rollback()
        logger.exception("Kling card video repair failed: %s", exc)
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
