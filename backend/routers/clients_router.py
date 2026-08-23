# routers/clients_router.py
"""
Admin-managed Client list (see models_new.GenerationClient) plus the
ticket-authenticated read endpoint the browser extension calls from
freepik.com to populate the pre-generation Client picker
(content-freepik-task-modal.js) - independent of, and alongside, the Task
Mapping picker in tasks_router.py.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationClient, User
from routers.it_tools_router import _resolve_usage_event_actor
from services.workplace_access_service import enforce_workplace_tools_access
from utils.client_gate import get_active_clients
from utils.generation_gate import resolve_generation_gate_tool
from utils.permissions import require_admin, require_user

router = APIRouter(prefix="/api/clients", tags=["Clients"])


class ClientCreatePayload(BaseModel):
    name: str = Field(..., min_length=2, max_length=200)


class ClientUpdatePayload(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=200)
    is_active: Optional[bool] = None


def _serialize_client(client: GenerationClient) -> dict:
    return {
        "id": client.id,
        "name": client.name,
        "isActive": bool(client.is_active),
        "createdAt": client.created_at.isoformat() if client.created_at else None,
        "updatedAt": client.updated_at.isoformat() if client.updated_at else None,
    }


@router.get("/active")
def list_active_clients_for_generation(
    request: Request,
    usage_ticket: Optional[str] = Query(None),
    extension_ticket: Optional[str] = Query(None),
    tool_slug: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
):
    """Populates the pre-generation Client picker. Called directly by the
    browser extension's background script from freepik.com or kling.ai - same
    ticket-based identity resolution as GET /api/tasks/my-active, reused here
    rather than duplicated. Unlike tasks, the client list isn't per-user -
    any authenticated actor (proven via ticket) sees the same active list."""
    tool = resolve_generation_gate_tool(db, tool_slug)
    if not tool:
        raise HTTPException(status_code=503, detail="Tool is not configured")

    current_user = _resolve_usage_event_actor(
        request=request,
        db=db,
        tool=tool,
        usage_ticket=usage_ticket or "",
        extension_ticket=extension_ticket or "",
    )
    # A valid launch ticket proves *who* is calling, not that they are still
    # entitled to workplace tools - tickets outlive a revocation. Every other
    # ticket-authenticated endpoint pairs the two checks (see
    # it_tools_router.report_extension_usage_event); without it this endpoint
    # hands the full admin-curated customer list to anyone holding a ticket
    # minted before their access was pulled. Unlike /api/tasks/my-active,
    # which is self-scoped and so discloses nothing new, this list is shared
    # business data.
    enforce_workplace_tools_access(current_user, db)

    clients = get_active_clients(db)
    return {
        "success": True,
        "count": len(clients),
        "clients": [{"id": client.id, "name": client.name} for client in clients],
    }


@router.get("/for-tasks")
def list_active_clients_for_tasks(
    current_user: User = Depends(require_user),
    db: Session = Depends(get_operational_db),
):
    """Populates the Customer Name dropdown on the dashboard's Create Task
    form. Session-authenticated (any logged-in user, not just admins) -
    distinct from /active (browser-extension, ticket-authenticated) and from
    the admin-only GET "" below (full list, including inactive clients)."""
    clients = get_active_clients(db)
    return {"success": True, "clients": [{"id": client.id, "name": client.name} for client in clients]}


@router.get("")
def list_clients(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    clients = db.query(GenerationClient).order_by(GenerationClient.name.asc()).all()
    return {"success": True, "count": len(clients), "clients": [_serialize_client(c) for c in clients]}


@router.post("")
def create_client(
    payload: ClientCreatePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Client name must be at least 2 characters long")

    existing = (
        db.query(GenerationClient)
        .filter(func.lower(func.trim(GenerationClient.name)) == name.lower())
        .first()
    )
    if existing:
        if existing.is_active:
            raise HTTPException(status_code=409, detail="Client already exists")
        existing.name = name
        existing.is_active = True
        existing.updated_by = current_user.id
        existing.updated_at = datetime.utcnow()
        client = existing
    else:
        client = GenerationClient(
            name=name,
            is_active=True,
            created_by=current_user.id,
            updated_by=current_user.id,
        )
        db.add(client)

    db.commit()
    db.refresh(client)
    return {"success": True, "message": "Client added successfully", "client": _serialize_client(client)}


@router.patch("/{client_id}")
def update_client(
    client_id: int,
    payload: ClientUpdatePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    client = db.query(GenerationClient).filter(GenerationClient.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    if payload.name is not None:
        name = payload.name.strip()
        if len(name) < 2:
            raise HTTPException(status_code=400, detail="Client name must be at least 2 characters long")
        duplicate = (
            db.query(GenerationClient)
            .filter(
                GenerationClient.id != client_id,
                func.lower(func.trim(GenerationClient.name)) == name.lower(),
            )
            .first()
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="Another client already has that name")
        client.name = name

    if payload.is_active is not None:
        client.is_active = payload.is_active

    client.updated_by = current_user.id
    client.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(client)
    return {"success": True, "client": _serialize_client(client)}
