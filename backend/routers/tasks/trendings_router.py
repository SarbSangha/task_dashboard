from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Trendings"])
router.add_api_route("/assets", handlers.get_task_assets, methods=["GET"])
router.add_api_route("/assets/directory/groups", handlers.get_task_asset_directory_groups, methods=["GET"])
router.add_api_route("/assets/directory/files", handlers.get_task_asset_directory_files, methods=["GET"])
