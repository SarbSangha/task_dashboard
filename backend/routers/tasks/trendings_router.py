from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Trendings"])
router.add_api_route("/assets", handlers.get_task_assets, methods=["GET"])
