import logging
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from merge_duplicate_kling_usage_events import run  # noqa: E402
from models_new import Base, GenerationRecord, GenerationTag, ITPortalTool, ITPortalToolUsageEvent, User  # noqa: E402


engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _create_user(*, email: str, name: str, is_admin: bool) -> int:
    with SessionLocal() as db:
        user = User(
            email=email,
            name=name,
            hashed_password="hashed-password",
            is_active=True,
            is_deleted=False,
            is_admin=is_admin,
            position="admin" if is_admin else "artist",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def _create_tool() -> int:
    with SessionLocal() as db:
        tool = ITPortalTool(
            name="Kling",
            slug="kling",
            category="AI",
            website_url="https://kling.ai",
            is_active=True,
            status="active",
        )
        db.add(tool)
        db.commit()
        db.refresh(tool)
        return tool.id


def _create_usage_event(
    *,
    tool_id: int,
    user_id: int,
    generation_id: str,
    request_id: str | None,
    created_at: datetime,
    metadata_json: dict,
) -> int:
    with SessionLocal() as db:
        event = ITPortalToolUsageEvent(
            tool_id=tool_id,
            credential_id=None,
            user_id=user_id,
            event_type="generate_click",
            event_date=date(2026, 7, 1),
            status="settled",
            prompt_text="Create a smooth output video",
            generation_id=generation_id,
            request_id=request_id,
            metadata_json=metadata_json,
            created_at=created_at,
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        return event.id


def _create_generation_record(
    *,
    owner_user_id: int,
    provider_task_id: str,
    source_usage_event_id: int,
    ingestion_source: str,
    canonical_asset_url: str | None = None,
) -> int:
    with SessionLocal() as db:
        record = GenerationRecord(
            provider="kling",
            provider_task_id=provider_task_id,
            canonical_asset_url=canonical_asset_url,
            canonical_asset_key=(
                "cdn.example.com/generated/result.mp4" if canonical_asset_url else None
            ),
            prompt_text=None if canonical_asset_url is None else "Recovered prompt",
            ingestion_source=ingestion_source,
            capture_status="active",
            owner_user_id=owner_user_id,
            ownership_status="resolved",
            ownership_source="usage_event_user_id",
            source_usage_event_id=source_usage_event_id,
            created_at=_utc_now_naive(),
            updated_at=_utc_now_naive(),
            metadata_json={"origin": ingestion_source},
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record.id


def _create_tag(*, generation_id: int, created_by: int) -> int:
    with SessionLocal() as db:
        tag = GenerationTag(
            generation_id=generation_id,
            tag="cinematic",
            normalized_tag="cinematic",
            created_by=created_by,
            created_at=_utc_now_naive(),
        )
        db.add(tag)
        db.commit()
        db.refresh(tag)
        return tag.id


def main() -> None:
    user_id = _create_user(email="artist@example.com", name="Artist", is_admin=False)
    admin_id = _create_user(email="admin@example.com", name="Administrator", is_admin=True)
    tool_id = _create_tool()

    original_event_id = _create_usage_event(
        tool_id=tool_id,
        user_id=user_id,
        generation_id="314851370328568",
        request_id="314851370300609",
        created_at=datetime(2026, 7, 1, 4, 24, 48),
        metadata_json={
            "pipelineDiagnostics": {"taskIds": ["314851370328568", "314851370300609"]},
            "mediaAssets": [{"url": "https://cdn.example.com/generated/result.mp4"}],
        },
    )
    duplicate_event_id = _create_usage_event(
        tool_id=tool_id,
        user_id=admin_id,
        generation_id="314851370328568",
        request_id=None,
        created_at=datetime(2026, 7, 1, 4, 24, 49),
        metadata_json={
            "pipelineDiagnostics": {"taskIds": ["314851370328568"]},
        },
    )

    original_record_id = _create_generation_record(
        owner_user_id=user_id,
        provider_task_id="314851370328568",
        source_usage_event_id=original_event_id,
        ingestion_source="captured",
        canonical_asset_url=None,
    )
    duplicate_record_id = _create_generation_record(
        owner_user_id=admin_id,
        provider_task_id="314851370300609",
        source_usage_event_id=duplicate_event_id,
        ingestion_source="recovered",
        canonical_asset_url="https://cdn.example.com/generated/result.mp4",
    )
    duplicate_tag_id = _create_tag(generation_id=duplicate_record_id, created_by=admin_id)

    with SessionLocal() as db:
        summary = run(db, apply=True, logger=logging.getLogger("merge_duplicate_kling_usage_events_smoke"))

    _assert(summary["clustersFound"] == 1, "Expected one duplicate cluster to be detected")
    _assert(summary["clustersMerged"] == 1, "Expected duplicate cluster to be merged")
    _assert(summary["rowsDeleted"] == 1, "Expected duplicate usage event to be deleted")
    _assert(summary["generationRecordsDeleted"] == 1, "Expected duplicate generation record to be deleted")

    with SessionLocal() as db:
        remaining_events = db.query(ITPortalToolUsageEvent).order_by(ITPortalToolUsageEvent.id.asc()).all()
        remaining_records = db.query(GenerationRecord).order_by(GenerationRecord.id.asc()).all()
        remaining_tags = db.query(GenerationTag).order_by(GenerationTag.id.asc()).all()

        _assert(len(remaining_events) == 1, "Expected only the original usage event to remain")
        _assert(remaining_events[0].id == original_event_id, "Expected the original user event to be kept")
        _assert(len(remaining_records) == 1, "Expected only one canonical generation record to remain")
        _assert(remaining_records[0].id == original_record_id, "Expected the original generation record to be kept")
        _assert(
            remaining_records[0].canonical_asset_url == "https://cdn.example.com/generated/result.mp4",
            "Expected canonical record to inherit recovered asset URL",
        )
        _assert(
            remaining_records[0].source_usage_event_id == original_event_id,
            "Expected canonical generation record to stay attached to the original usage event",
        )
        _assert(
            remaining_records[0].owner_user_id == user_id,
            "Expected canonical generation record ownership to remain with the original non-admin user",
        )
        _assert(len(remaining_tags) == 1, "Expected duplicate tag row to be preserved through repointing")
        _assert(remaining_tags[0].id == duplicate_tag_id, "Expected existing tag row to be reused")
        _assert(
            remaining_tags[0].generation_id == original_record_id,
            "Expected duplicate generation tag to be re-pointed onto the canonical record",
        )

    print("merge_duplicate_kling_usage_events_smoke: ok")


if __name__ == "__main__":
    main()
