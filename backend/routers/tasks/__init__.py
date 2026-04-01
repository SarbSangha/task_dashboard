from fastapi import APIRouter

from .inbox_router import router as inbox_router
from .outbox_router import router as outbox_router
from .tracking_router import router as tracking_router
from .workspace_router import router as workspace_router
from .trendings_router import router as trendings_router
from .task_core_router import router as task_core_router


router = APIRouter(prefix="/api/tasks", tags=["Tasks"])
router.include_router(task_core_router)
router.include_router(inbox_router)
router.include_router(outbox_router)
router.include_router(tracking_router)
router.include_router(workspace_router)
router.include_router(trendings_router)
