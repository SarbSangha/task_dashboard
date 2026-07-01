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
    GenerationProjectCreatePayload,
    create_generation_project,
    get_generation_project,
    list_generation_projects,
    list_generation_project_generations,
    router,
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


def _create_project(user_id: int, name: str, description: str | None = None) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        payload = GenerationProjectCreatePayload(name=name, description=description)
        return asyncio.run(create_generation_project(payload, db=db, current_user=user))


def _list_projects(user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return asyncio.run(list_generation_projects(db=db, current_user=user))


def _get_project(user_id: int, project_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return asyncio.run(get_generation_project(project_id=project_id, db=db, current_user=user))


def _list_project_generations(user_id: int, project_id: int, limit: int = 24, offset: int = 0) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return asyncio.run(
            list_generation_project_generations(
                project_id=project_id,
                limit=limit,
                offset=offset,
                db=db,
                current_user=user,
            )
        )


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
            prompt_text=f"Prompt for {provider_task_id}",
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


def main() -> int:
    user_a_id = _create_user("user-a@example.com", "User A")
    user_b_id = _create_user("user-b@example.com", "User B")

    post_route = next(
        route
        for route in router.routes
        if getattr(route, "path", "") == "/api/generation-projects"
        and "POST" in getattr(route, "methods", set())
    )
    _assert(post_route.status_code == 201, "POST /api/generation-projects should declare HTTP 201")
    print("PASS route status declaration")

    created = _create_project(user_a_id, "Marketing")
    _assert(created["success"] is True, "Create project should succeed")
    _assert(created["data"]["name"] == "Marketing", "Created project name should match input")
    _assert(created["data"]["normalizedName"] == "marketing", "Project name should normalize to lowercase")
    _assert(created["data"]["generationCount"] == 0, "New project should start with zero generations")
    print("PASS create project")

    try:
        _create_project(user_a_id, "Marketing")
        raise AssertionError("Duplicate project should raise HTTPException")
    except HTTPException as exc:
        _assert(exc.status_code == 409, "Duplicate project should return 409")
    print("PASS duplicate protection")

    for duplicate_name in ("marketing", "MARKETING", "  Marketing  "):
        try:
            _create_project(user_a_id, duplicate_name)
            raise AssertionError(f"Normalization duplicate should fail for {duplicate_name!r}")
        except HTTPException as exc:
            _assert(exc.status_code == 409, f"Normalization duplicate should return 409 for {duplicate_name!r}")
    print("PASS normalization duplicate protection")

    other_owner_same_name = _create_project(user_b_id, "Marketing")
    _assert(other_owner_same_name["success"] is True, "Different owner should be able to reuse same project name")
    print("PASS owner-scoped duplicate rule")

    _create_generation(owner_user_id=user_a_id, provider_task_id="project-a-task-1", project_id=created["data"]["id"])
    _create_generation(owner_user_id=user_a_id, provider_task_id="project-a-task-2", project_id=created["data"]["id"])
    _create_generation(owner_user_id=user_a_id, provider_task_id="project-a-archived", project_id=created["data"]["id"], archived=True)

    with SessionLocal() as db:
        archived_project = GenerationProject(
            owner_user_id=user_a_id,
            name="Archived Project",
            normalized_name="archived project",
            created_by=user_a_id,
            updated_by=user_a_id,
            created_at=_utc_now_naive(),
            updated_at=_utc_now_naive(),
            archived_at=_utc_now_naive(),
        )
        db.add(archived_project)
        db.commit()

    list_a = _list_projects(user_a_id)
    names_a = [item["name"] for item in list_a["data"]]
    _assert(names_a == ["Marketing"], f"User A should only see active owned projects, got {names_a}")
    _assert(list_a["data"][0]["generationCount"] == 2, "Project list should include active generation counts")
    print("PASS archived project filtering")

    list_b = _list_projects(user_b_id)
    names_b = [item["name"] for item in list_b["data"]]
    _assert(names_b == ["Marketing"], f"User B should only see their own projects, got {names_b}")
    print("PASS user isolation")

    project_detail = _get_project(user_a_id, created["data"]["id"])
    _assert(project_detail["data"]["id"] == created["data"]["id"], "Project detail should return the requested project")
    _assert(project_detail["data"]["generationCount"] == 2, "Project detail should expose the active generation count")
    print("PASS project detail")

    project_generations = _list_project_generations(user_a_id, created["data"]["id"], limit=1, offset=0)
    _assert(project_generations["pagination"]["total"] == 2, "Project generations should paginate active generations only")
    _assert(len(project_generations["data"]) == 1, "Project generations should respect the requested limit")
    _assert(project_generations["project"]["generationCount"] == 2, "Project generation list should include project count metadata")
    print("PASS project generations pagination")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
