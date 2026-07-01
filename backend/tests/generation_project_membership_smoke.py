import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, GenerationProject, GenerationRecord, User  # noqa: E402
from routers.generation_projects_router import (  # noqa: E402
    assign_generation_to_project,
    create_generation_project,
    GenerationProjectCreatePayload,
    remove_generation_from_project,
    router as generation_projects_router,
)
from routers.generation_records_router import (  # noqa: E402
    list_ungrouped_generations,
    router as generation_records_router,
)


engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[User.__table__, GenerationProject.__table__, GenerationRecord.__table__],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _create_user(email: str, name: str) -> int:
    with SessionLocal() as db:
        user = User(
            email=email,
            name=name,
            hashed_password="hashed-password",
            is_active=True,
            is_deleted=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def _create_project(user_id: int, name: str) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        payload = GenerationProjectCreatePayload(name=name)
        return asyncio.run(create_generation_project(payload, db=db, current_user=user))


def _create_generation(
    *,
    owner_user_id: int,
    provider_task_id: str,
    project_id: int | None = None,
    archived: bool = False,
) -> int:
    now = _utc_now_naive()
    with SessionLocal() as db:
        generation = GenerationRecord(
            provider="kling",
            provider_task_id=provider_task_id,
            provider_generation_id=None,
            canonical_asset_url=None,
            canonical_asset_key=None,
            prompt_text=f"Prompt for {provider_task_id}",
            model_label="test-model",
            duration_label="5s",
            resolution_label="720p",
            credits_burned=5,
            ingestion_source="captured",
            capture_status="active",
            owner_user_id=owner_user_id,
            ownership_status="resolved",
            ownership_source="usage_event_user_id",
            project_id=project_id,
            metadata_json={},
            created_at=now,
            updated_at=now,
            archived_at=now if archived else None,
        )
        db.add(generation)
        db.commit()
        db.refresh(generation)
        return generation.id


def _assign(project_id: int, generation_id: int, user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return asyncio.run(
            assign_generation_to_project(
                project_id=project_id,
                generation_id=generation_id,
                db=db,
                current_user=user,
            )
        )


def _remove(project_id: int, generation_id: int, user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return asyncio.run(
            remove_generation_from_project(
                project_id=project_id,
                generation_id=generation_id,
                db=db,
                current_user=user,
            )
        )


def _list_ungrouped(user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return asyncio.run(list_ungrouped_generations(db=db, current_user=user))


def main() -> int:
    user_a_id = _create_user("phase2c-user-a@example.com", "Phase 2C User A")
    user_b_id = _create_user("phase2c-user-b@example.com", "Phase 2C User B")

    project_a1 = _create_project(user_a_id, "Campaign Alpha")["data"]
    project_a2 = _create_project(user_a_id, "Campaign Beta")["data"]

    route_assign = next(
        route
        for route in generation_projects_router.routes
        if getattr(route, "path", "") == "/api/generation-projects/{project_id}/generations/{generation_id}"
        and "POST" in getattr(route, "methods", set())
    )
    route_remove = next(
        route
        for route in generation_projects_router.routes
        if getattr(route, "path", "") == "/api/generation-projects/{project_id}/generations/{generation_id}"
        and "DELETE" in getattr(route, "methods", set())
    )
    route_ungrouped = next(
        route
        for route in generation_records_router.routes
        if getattr(route, "path", "") == "/api/generations/ungrouped"
        and "GET" in getattr(route, "methods", set())
    )
    _assert(route_assign is not None, "Assign route should exist")
    _assert(route_remove is not None, "Remove route should exist")
    _assert(route_ungrouped is not None, "Ungrouped route should exist")
    print("PASS route registration")

    generation_a_1 = _create_generation(owner_user_id=user_a_id, provider_task_id="task-a-1")
    generation_a_2 = _create_generation(owner_user_id=user_a_id, provider_task_id="task-a-2", project_id=project_a1["id"])
    generation_b_1 = _create_generation(owner_user_id=user_b_id, provider_task_id="task-b-1")
    _create_generation(owner_user_id=user_a_id, provider_task_id="task-a-archived", archived=True)

    assign_result = _assign(project_a1["id"], generation_a_1, user_a_id)
    _assert(assign_result["success"] is True, "Assign should succeed")
    _assert(assign_result["data"]["projectId"] == project_a1["id"], "Generation should be assigned to project A1")
    print("PASS assign generation to project")

    move_result = _assign(project_a2["id"], generation_a_1, user_a_id)
    _assert(move_result["success"] is True, "Reassign should succeed")
    _assert(move_result["data"]["projectId"] == project_a2["id"], "Generation should move to project A2")
    print("PASS move generation via reassignment")

    remove_result = _remove(project_a2["id"], generation_a_1, user_a_id)
    _assert(remove_result["success"] is True, "Remove should succeed")
    _assert(remove_result["data"]["projectId"] is None, "Generation should become ungrouped after removal")
    print("PASS remove generation from project")

    ungrouped_a = _list_ungrouped(user_a_id)
    ungrouped_a_ids = sorted(item["id"] for item in ungrouped_a["data"])
    _assert(
        ungrouped_a_ids == [generation_a_1],
        f"Ungrouped query should only include user A's active ungrouped generation, got {ungrouped_a_ids}",
    )
    _assert(ungrouped_a["pagination"]["total"] == 1, "Ungrouped query should report pagination totals")
    print("PASS ungrouped query for owner")

    ungrouped_b = _list_ungrouped(user_b_id)
    ungrouped_b_ids = [item["id"] for item in ungrouped_b["data"]]
    _assert(
        ungrouped_b_ids == [generation_b_1],
        f"Ungrouped query should be user-scoped, got {ungrouped_b_ids}",
    )
    print("PASS ungrouped user isolation")

    try:
        _assign(project_a1["id"], generation_b_1, user_a_id)
        raise AssertionError("Ownership mismatch should raise HTTPException")
    except HTTPException as exc:
        _assert(exc.status_code == 403, "Cross-owner assignment should return 403")
    print("PASS ownership validation")

    still_assigned = _list_ungrouped(user_a_id)
    still_assigned_ids = [item["id"] for item in still_assigned["data"]]
    _assert(generation_a_2 not in still_assigned_ids, "Assigned generation should not appear in ungrouped list")
    print("PASS assigned generations excluded from ungrouped")

    engine.dispose()
    print("PHASE 2C SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
