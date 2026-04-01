from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Outbox"])
router.add_api_route("/outbox", handlers.get_outbox, methods=["GET"])
