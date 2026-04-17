from fastapi import APIRouter

from routers import tasks_router as handlers


router = APIRouter(tags=["Tasks"])
router.add_api_route("/project-id/validate", handlers.validate_project_id, methods=["GET"])
router.add_api_route("/project-id/generate", handlers.generate_project_id, methods=["POST"])
router.add_api_route("/task-id/validate", handlers.validate_task_id, methods=["GET"])
router.add_api_route("/task-id/generate", handlers.generate_task_id, methods=["POST"])
router.add_api_route("/reference-suggestions", handlers.get_task_reference_suggestions, methods=["GET"])
router.add_api_route("/create", handlers.create_task, methods=["POST"])
router.add_api_route("/users/forward-targets", handlers.get_forward_targets, methods=["GET"])
router.add_api_route("/{task_id}/workflow", handlers.get_task_workflow, methods=["GET"])
router.add_api_route("/{task_id}/stages/{stage_id}", handlers.update_task_stage, methods=["PATCH"])
router.add_api_route("/{task_id}/edit-task", handlers.edit_task_details, methods=["PUT"])
router.add_api_route("/{task_id}/edit-result", handlers.edit_task_result, methods=["PUT"])
