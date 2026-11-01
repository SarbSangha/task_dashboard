# providers/figma/router.py
"""
API surface for the Figma provider.

  POST /capture/events   browser extension (background-figma-capture.js): "prompt" and
                         "balance" events, each carrying the tab's dashboard launch ticket
  GET  /view             admin: prompts with their credits, per person / day / file, and
                         each Figma account's balance, for a period
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.figma import queries as figma_queries
from providers.figma.capture import (
    ingest_event,
    resolve_figma_actor,
    resolve_figma_credential,
    resolve_figma_tool,
)
from providers.figma.constants import VIEW_DEFAULT_LIMIT, VIEW_MAX_LIMIT, VIEW_MAX_RANGE_MS
from providers.figma.schemas import CaptureEventResult, CaptureEventsRequest, CaptureEventsResponse, ViewOut
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/figma", tags=["figma"])
logger = logging.getLogger("figma_router")


def _ms_to_utc(value: int) -> datetime:
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).replace(tzinfo=None)


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_figma_tool(db)
    if not tool:
        return CaptureEventsResponse(success=False, results=[
            CaptureEventResult(client_event_id=e.client_event_id, status="rejected", reason="figma tool is not configured")
            for e in payload.events
        ])

    results = []
    # One flush can mix tabs (and so people): resolve each ticket once.
    resolved: dict[tuple, tuple] = {}
    for item in payload.events:
        key = (item.usage_ticket, item.extension_ticket, item.credential_id)
        if key not in resolved:
            try:
                user = resolve_figma_actor(request=request, db=db, tool=tool,
                                           usage_ticket=item.usage_ticket, extension_ticket=item.extension_ticket)
                credential = resolve_figma_credential(db, tool_id=tool.id, user_id=user.id,
                                                      explicit_credential_id=item.credential_id)
                resolved[key] = (user, credential.id if credential else None, None)
            except HTTPException as error:
                resolved[key] = (None, None, str(error.detail))
        user, credential_id, error = resolved[key]
        if error is not None:
            results.append(CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason=error))
            continue
        savepoint = db.begin_nested()
        try:
            outcome = ingest_event(
                db, event_type=item.event_type, tool=tool, credential_id=credential_id, user=user,
                client_event_id=item.client_event_id, payload=item.payload,
                extension_version=item.extension_version, tab_id=item.tab_id,
                task_id=item.linked_task_id, client_id=item.linked_client_id,
            )
            savepoint.commit()
        except Exception:
            logger.exception("figma capture event failed client_event_id=%s", item.client_event_id)
            savepoint.rollback()
            # Not answered, so the extension keeps it queued and retries.
            continue
        results.append(CaptureEventResult(client_event_id=item.client_event_id, status=outcome.status,
                                          id=outcome.id, reason=outcome.reason))
    db.commit()
    return CaptureEventsResponse(success=True, results=results)


@router.get("/view", response_model=ViewOut)
def get_view(
    from_ms: int = Query(..., ge=1),
    to_ms: int = Query(..., ge=1),
    owner_user_id: Optional[int] = None,
    q: Optional[str] = Query(default=None, max_length=200),
    sort: str = Query(default="ts", pattern="^(ts|credits|person|file)$"),
    direction: str = Query(default="desc", pattern="^(asc|desc)$"),
    tz_offset_min: int = Query(default=0, ge=-14 * 60, le=14 * 60),
    limit: int = Query(default=VIEW_DEFAULT_LIMIT, ge=1, le=VIEW_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    if to_ms <= from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be after from_ms")
    if to_ms - from_ms > VIEW_MAX_RANGE_MS:
        raise HTTPException(status_code=400, detail="Pick a period of at most about a year")
    data = figma_queries.build_view(
        db, start=_ms_to_utc(from_ms), end=_ms_to_utc(to_ms),
        owner_user_id=owner_user_id, q=q, sort=sort, descending=direction == "desc",
        limit=limit, offset=offset, tz_offset_min=tz_offset_min,
    )
    return ViewOut(data=data)
