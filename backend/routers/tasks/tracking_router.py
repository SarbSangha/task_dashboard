from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Tracking"])
router.add_api_route("/all", handlers.get_all_user_tasks, methods=["GET"])
router.add_api_route("/{task_id}/actions/assign", handlers.assign_task_members, methods=["POST"])
router.add_api_route("/{task_id}/actions/submit", handlers.submit_task, methods=["POST"])
router.add_api_route("/{task_id}/actions/start", handlers.start_task_work, methods=["POST"])
router.add_api_route("/{task_id}/actions/approve", handlers.approve_task, methods=["POST"])
router.add_api_route("/{task_id}/actions/need-improvement", handlers.request_improvement, methods=["POST"])
router.add_api_route("/{task_id}/actions/forward", handlers.forward_task, methods=["POST"])
router.add_api_route("/{task_id}/actions/revoke", handlers.revoke_task, methods=["POST"])
router.add_api_route("/{task_id}/comments", handlers.add_comment, methods=["POST"])
router.add_api_route("/{task_id}/comments", handlers.get_comments, methods=["GET"])
router.add_api_route("/notifications/me", handlers.get_my_notifications, methods=["GET"])
router.add_api_route("/notifications/{notification_id}/read", handlers.mark_notification_read, methods=["POST"])
router.add_api_route("/notifications/{notification_id}", handlers.delete_notification, methods=["DELETE"])
router.add_api_websocket_route("/ws/notifications", handlers.notifications_ws)
