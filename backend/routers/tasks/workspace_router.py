from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Workspace"])
router.add_api_route("/debug/current-user", handlers.debug_current_user, methods=["GET"])
