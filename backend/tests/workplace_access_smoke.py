import os
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, ParticipantRole, Task, TaskParticipant, TaskStatus, User, UserRole  # noqa: E402
from services.workplace_access_service import can_access_workplace_tools, get_workplace_tools_access_status  # noqa: E402


engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        UserRole.__table__,
        Task.__table__,
        TaskParticipant.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _create_user(
    *,
    email: str,
    position: str,
    is_admin: bool = False,
    enforce_active_task_policy: bool = True,
) -> int:
    with SessionLocal() as db:
        user = User(
            email=email,
            name=email.split("@", 1)[0],
            hashed_password="hashed-password",
            is_active=True,
            is_deleted=False,
            is_admin=is_admin,
            position=position,
            enforce_active_task_policy=enforce_active_task_policy,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def _create_task(
    *,
    creator_id: int,
    participant_user_id: int,
    status: TaskStatus,
    role: ParticipantRole = ParticipantRole.ASSIGNEE,
    is_active: bool = True,
    is_deleted: bool = False,
    title: str,
) -> int:
    with SessionLocal() as db:
        task = Task(
            title=title,
            creator_id=creator_id,
            status=status,
            is_deleted=is_deleted,
        )
        db.add(task)
        db.flush()
        db.add(
            TaskParticipant(
                task_id=task.id,
                user_id=participant_user_id,
                role=role,
                is_active=is_active,
            )
        )
        db.commit()
        return task.id


def _can_access(user_id: int) -> bool:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return can_access_workplace_tools(user, db)


def _access_status(user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return get_workplace_tools_access_status(user, db)


def main() -> int:
    admin_id = _create_user(
        email="admin@example.com",
        position="admin",
        is_admin=True,
        enforce_active_task_policy=True,
    )
    _assert(_can_access(admin_id) is True, "Administrator should always have access")
    print("PASS administrator access")

    policy_disabled_id = _create_user(
        email="policy-disabled@example.com",
        position="employee",
        enforce_active_task_policy=False,
    )
    _assert(_can_access(policy_disabled_id) is True, "Policy-disabled user should always have access")
    print("PASS policy-disabled access")

    inbox_creator_id = _create_user(email="creator@example.com", position="employee")
    employee_with_inbox_id = _create_user(email="employee-inbox@example.com", position="employee")
    _create_task(
        creator_id=inbox_creator_id,
        participant_user_id=employee_with_inbox_id,
        status=TaskStatus.PENDING,
        title="Employee inbox task",
    )
    _assert(_can_access(employee_with_inbox_id) is True, "Employee with active inbox task should have access")
    print("PASS employee inbox access")

    employee_self_assigned_id = _create_user(email="employee-self@example.com", position="employee")
    _create_task(
        creator_id=employee_self_assigned_id,
        participant_user_id=employee_self_assigned_id,
        status=TaskStatus.IN_PROGRESS,
        title="Employee self-assigned task",
    )
    _assert(_can_access(employee_self_assigned_id) is False, "Employee with only self-assigned task should be denied")
    print("PASS employee self-assigned denial")

    hod_creator_id = _create_user(email="hod-creator@example.com", position="employee")
    hod_with_inbox_id = _create_user(email="hod-inbox@example.com", position="Head of Department")
    _create_task(
        creator_id=hod_creator_id,
        participant_user_id=hod_with_inbox_id,
        status=TaskStatus.NEED_IMPROVEMENT,
        title="HOD inbox task",
    )
    _assert(_can_access(hod_with_inbox_id) is True, "HOD with active inbox task should have access")
    print("PASS HOD inbox access")

    hod_self_assigned_id = _create_user(email="hod-self@example.com", position="Head of Department")
    _create_task(
        creator_id=hod_self_assigned_id,
        participant_user_id=hod_self_assigned_id,
        status=TaskStatus.PENDING,
        title="HOD self-assigned task",
    )
    _assert(_can_access(hod_self_assigned_id) is True, "HOD with only active self-assigned task should have access")
    hod_self_status = _access_status(hod_self_assigned_id)
    _assert(hod_self_status["canAccessTools"] is True, "HOD self-assigned access should surface in access status")
    _assert(hod_self_status["hasActiveInboxTask"] is False, "HOD self-assigned access should not masquerade as inbox access")
    _assert(
        hod_self_status["matchedHodSelfAssignedException"] is True,
        "HOD self-assigned access should mark the business-rule exception",
    )
    print("PASS HOD self-assigned exception")

    hod_completed_self_id = _create_user(email="hod-completed@example.com", position="Head of Department")
    _create_task(
        creator_id=hod_completed_self_id,
        participant_user_id=hod_completed_self_id,
        status=TaskStatus.COMPLETED,
        title="Completed HOD self-assigned task",
    )
    _assert(_can_access(hod_completed_self_id) is False, "Completed HOD self-assigned task should not grant access")
    print("PASS completed HOD self-assigned denial")

    hod_no_tasks_id = _create_user(email="hod-empty@example.com", position="Head of Department")
    _assert(_can_access(hod_no_tasks_id) is False, "HOD with no active tasks should be denied")
    print("PASS HOD no-task denial")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
