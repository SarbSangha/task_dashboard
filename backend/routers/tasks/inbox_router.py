from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Inbox"])
router.add_api_route("/inbox", handlers.get_inbox, methods=["GET"])
router.add_api_route("/inbox/unread-count", handlers.get_unread_count, methods=["GET"])
router.add_api_route("/{task_id}/actions/mark-seen", handlers.mark_task_seen, methods=["POST"])
