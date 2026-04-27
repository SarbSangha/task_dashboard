import asyncio
import base64
import hashlib
import hmac
import html
import imaplib
import json
import os
import re
import time
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ITPortalTool, ITPortalToolAudit, ITPortalToolCredential, ITPortalToolMailbox, User
from services.otp_mail_service import fetch_otp_from_gmail
from utils.credential_crypto import decrypt_secret, encrypt_secret
from utils.permissions import has_any_role, require_admin, require_user


router = APIRouter(prefix="/api/it-tools", tags=["IT Tools"])

VALID_SCOPES = {"company", "user"}
VALID_LAUNCH_MODES = {"external_link", "manual_credential", "sso", "api_proxy", "automation", "extension_autofill"}
HOSTNAME_EQUIVALENT_GROUPS = (
    {"chatgpt.com", "chat.openai.com", "auth.openai.com", "openai.com"},
    {"envato.com", "elements.envato.com", "market.envato.com"},
    {"freepik.com"},
    {"higgsfield.ai", "app.higgsfield.ai", "beta.higgsfield.ai"},
    {"kling.ai", "klingai.com", "app.klingai.com"},
)
SUPPORTED_EXTENSION_AUTOFILL_HOSTS = frozenset().union(*HOSTNAME_EQUIVALENT_GROUPS)
SUPPORTED_EXTENSION_AUTOFILL_SLUGS = {"chatgpt", "envato", "freepik", "higgsfield", "kling-ai", "klingai", "flow"}


class ToolCreatePayload(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    slug: Optional[str] = Field(None, max_length=140)
    category: str = Field("General", max_length=80)
    description: Optional[str] = None
    website_url: str = Field(..., min_length=8)
    login_url: Optional[str] = None
    icon: str = Field("Globe", max_length=40)
    launch_mode: str = Field("manual_credential")
    auto_login_action_url: Optional[str] = None
    auto_login_method: str = Field("POST", max_length=10)
    auto_login_username_field: str = Field("email", max_length=80)
    auto_login_password_field: str = Field("password", max_length=80)
    status: str = Field("active", max_length=40)
    is_active: bool = True


class ToolUpdatePayload(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=120)
    category: Optional[str] = Field(None, max_length=80)
    description: Optional[str] = None
    website_url: Optional[str] = Field(None, min_length=8)
    login_url: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=40)
    launch_mode: Optional[str] = None
    auto_login_action_url: Optional[str] = None
    auto_login_method: Optional[str] = Field(None, max_length=10)
    auto_login_username_field: Optional[str] = Field(None, max_length=80)
    auto_login_password_field: Optional[str] = Field(None, max_length=80)
    status: Optional[str] = Field(None, max_length=40)
    is_active: Optional[bool] = None


class CredentialUpsertPayload(BaseModel):
    scope: str = Field("company")
    user_id: Optional[int] = None
    login_identifier: Optional[str] = None
    password: Optional[str] = None
    api_key: Optional[str] = None
    notes: Optional[str] = None
    is_active: bool = True


class ExtensionCredentialPayload(BaseModel):
    tool_slug: Optional[str] = Field(None, max_length=140)
    hostname: Optional[str] = Field(None, max_length=255)
    page_url: Optional[str] = Field(None, max_length=2000)
    extension_ticket: Optional[str] = Field(None, max_length=4000)


class OtpRequestPayload(BaseModel):
    tool_slug: Optional[str] = Field(None, max_length=140)
    hostname: Optional[str] = Field(None, max_length=255)
    page_url: Optional[str] = Field(None, max_length=2000)
    extension_ticket: Optional[str] = Field(None, max_length=4000)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return slug or "tool"


def _validate_url(value: Optional[str], field_name: str) -> Optional[str]:
    normalized = (value or "").strip()
    if not normalized:
        return None
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a valid http(s) URL")
    return normalized


def _validate_launch_mode(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized not in VALID_LAUNCH_MODES:
        raise HTTPException(status_code=400, detail="Invalid launch mode")
    return normalized


def _validate_auto_login_method(value: Optional[str]) -> str:
    normalized = (value or "POST").strip().upper()
    if normalized not in {"POST", "GET"}:
        raise HTTPException(status_code=400, detail="Auto-login method must be GET or POST")
    return normalized


def _validate_field_name(value: Optional[str], fallback: str, field_name: str) -> str:
    normalized = (value or fallback).strip()
    if not normalized:
        return fallback
    if len(normalized) > 80:
        raise HTTPException(status_code=400, detail=f"{field_name} is too long")
    return normalized


def _auto_login_config_from_payload(payload: ToolCreatePayload | ToolUpdatePayload, existing: Optional[dict] = None) -> dict:
    current = dict(existing or {})
    auto_login = dict(current.get("autoLogin") or {})

    if getattr(payload, "auto_login_action_url", None) is not None:
        auto_login["actionUrl"] = _validate_url(payload.auto_login_action_url, "auto_login_action_url")
    elif not auto_login.get("actionUrl"):
        auto_login["actionUrl"] = None

    if getattr(payload, "auto_login_method", None) is not None:
        auto_login["method"] = _validate_auto_login_method(payload.auto_login_method)
    elif not auto_login.get("method"):
        auto_login["method"] = "POST"

    if getattr(payload, "auto_login_username_field", None) is not None:
        auto_login["usernameField"] = _validate_field_name(
            payload.auto_login_username_field, "email", "auto_login_username_field"
        )
    elif not auto_login.get("usernameField"):
        auto_login["usernameField"] = "email"

    if getattr(payload, "auto_login_password_field", None) is not None:
        auto_login["passwordField"] = _validate_field_name(
            payload.auto_login_password_field, "password", "auto_login_password_field"
        )
    elif not auto_login.get("passwordField"):
        auto_login["passwordField"] = "password"

    current["autoLogin"] = auto_login
    return current


def _validate_scope(payload: CredentialUpsertPayload) -> str:
    scope = (payload.scope or "").strip().lower()
    if scope not in VALID_SCOPES:
        raise HTTPException(status_code=400, detail="Credential scope must be company or user")
    if scope == "user" and not payload.user_id:
        raise HTTPException(status_code=400, detail="user_id is required for user credentials")
    if scope == "company" and payload.user_id:
        raise HTTPException(status_code=400, detail="Company credential must not include user_id")
    return scope


def _serialize_tool(tool: ITPortalTool, credential: Optional[ITPortalToolCredential] = None, is_admin: bool = False) -> dict:
    data = {
        "id": tool.id,
        "name": tool.name,
        "slug": tool.slug,
        "category": tool.category,
        "description": tool.description,
        "websiteUrl": tool.website_url,
        "loginUrl": tool.login_url,
        "icon": tool.icon,
        "launchMode": tool.launch_mode,
        "status": tool.status,
        "isActive": bool(tool.is_active),
        "hasCredential": bool(credential),
        "credentialScope": credential.scope if credential else None,
        "createdAt": tool.created_at.isoformat() if tool.created_at else None,
        "updatedAt": tool.updated_at.isoformat() if tool.updated_at else None,
    }
    if is_admin:
        data["metadata"] = tool.metadata_json or {}
        data["autoLogin"] = (tool.metadata_json or {}).get("autoLogin") or {}
    return data


def _serialize_credential_summary(credential: ITPortalToolCredential) -> dict:
    return {
        "id": credential.id,
        "toolId": credential.tool_id,
        "scope": credential.scope,
        "userId": credential.user_id,
        "hasLoginIdentifier": bool(credential.login_identifier_encrypted),
        "hasPassword": bool(credential.password_encrypted),
        "hasApiKey": bool(credential.api_key_encrypted),
        "notes": credential.notes,
        "isActive": bool(credential.is_active),
        "createdAt": credential.created_at.isoformat() if credential.created_at else None,
        "updatedAt": credential.updated_at.isoformat() if credential.updated_at else None,
    }


def _add_audit(
    db: Session,
    *,
    actor_id: int,
    action: str,
    tool_id: Optional[int] = None,
    credential_id: Optional[int] = None,
    target_user_id: Optional[int] = None,
    details: Optional[dict] = None,
) -> None:
    db.add(
        ITPortalToolAudit(
            actor_id=actor_id,
            action=action,
            tool_id=tool_id,
            credential_id=credential_id,
            target_user_id=target_user_id,
            details_json=details or {},
        )
    )


def _resolve_tool_credential(db: Session, tool_id: int, user_id: int) -> Optional[ITPortalToolCredential]:
    return (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.is_active == True,
            or_(
                and_(ITPortalToolCredential.scope == "user", ITPortalToolCredential.user_id == user_id),
                and_(ITPortalToolCredential.scope == "company", ITPortalToolCredential.user_id.is_(None)),
            ),
        )
        # Prefer the freshest applicable credential so a newly updated company
        # password does not get hidden behind an older user-specific override.
        .order_by(ITPortalToolCredential.updated_at.desc(), ITPortalToolCredential.scope.desc())
        .first()
    )


def _normalize_hostname(value: Optional[str]) -> str:
    normalized = (value or "").strip().lower()
    if not normalized:
        return ""
    if "://" in normalized:
        normalized = urlparse(normalized).hostname or ""
    if normalized.startswith("www."):
        normalized = normalized[4:]
    return normalized


def _hostname_matches(candidate: str, configured: str) -> bool:
    candidate = _normalize_hostname(candidate)
    configured = _normalize_hostname(configured)
    if not candidate or not configured:
        return False
    candidate_hosts = _expand_equivalent_hostnames(candidate)
    configured_hosts = _expand_equivalent_hostnames(configured)
    return any(
        candidate_host == configured_host or candidate_host.endswith(f".{configured_host}")
        for candidate_host in candidate_hosts
        for configured_host in configured_hosts
    )


def _expand_equivalent_hostnames(hostname: str) -> set[str]:
    normalized = _normalize_hostname(hostname)
    if not normalized:
        return set()

    expanded = {normalized}
    for group in HOSTNAME_EQUIVALENT_GROUPS:
        if normalized in group:
            expanded.update(group)
    return expanded


def _validate_extension_autofill_target(
    launch_mode: str,
    website_url: Optional[str],
    login_url: Optional[str],
    tool_slug: Optional[str] = None,
) -> None:
    if launch_mode != "extension_autofill":
        return

    normalized_slug = _slugify(tool_slug or "")
    if normalized_slug in SUPPORTED_EXTENSION_AUTOFILL_SLUGS:
        return

    candidate_urls = [website_url, login_url]
    for url in candidate_urls:
        hostname = _normalize_hostname(url)
        if hostname and any(_hostname_matches(hostname, supported) for supported in SUPPORTED_EXTENSION_AUTOFILL_HOSTS):
            return

    raise HTTPException(
        status_code=400,
        detail="Extension auto-fill currently supports ChatGPT/OpenAI, Envato, Freepik, Higgsfield, Kling AI, and Flow. Use Manual credential or Auto-login form submit for other tools.",
    )


def _find_extension_tool(db: Session, payload: ExtensionCredentialPayload) -> Optional[ITPortalTool]:
    tool_slug = _slugify(payload.tool_slug or "")
    hostname = _normalize_hostname(payload.hostname or payload.page_url)

    query = db.query(ITPortalTool).filter(ITPortalTool.is_active == True)
    if tool_slug != "tool":
        tool = query.filter(ITPortalTool.slug == tool_slug).first()
        if tool:
            return tool

    if not hostname:
        return None

    for tool in query.all():
        urls = [tool.website_url, tool.login_url]
        auto_login = (tool.metadata_json or {}).get("autoLogin") or {}
        urls.append(auto_login.get("actionUrl"))
        if any(_hostname_matches(hostname, item) for item in urls):
            return tool
    return None


def _ticket_secret() -> bytes:
    secret = (
        os.getenv("TOOL_CREDENTIAL_LAUNCH_SECRET")
        or os.getenv("SECRET_KEY")
        or os.getenv("TOOL_CREDENTIAL_ENCRYPTION_KEY")
        or "rmw-dev-tool-launch-secret-change-me"
    )
    return secret.encode("utf-8")


def _sign_ticket(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")
    signature = hmac.new(_ticket_secret(), body.encode("utf-8"), hashlib.sha256).digest()
    sig = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"{body}.{sig}"


def _decode_ticket(ticket: str) -> dict:
    try:
        body, sig = ticket.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid launch ticket") from exc

    expected = hmac.new(_ticket_secret(), body.encode("utf-8"), hashlib.sha256).digest()
    expected_sig = base64.urlsafe_b64encode(expected).decode("utf-8").rstrip("=")
    if not hmac.compare_digest(sig, expected_sig):
        raise HTTPException(status_code=400, detail="Invalid launch ticket")

    padded_body = body + ("=" * (-len(body) % 4))
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded_body.encode("utf-8")).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid launch ticket") from exc

    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=410, detail="Launch ticket expired")
    return payload


def _automation_launch_url(request: Request, ticket: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/it-tools/launch/{ticket}"


def _extension_ticket_error() -> HTTPException:
    return HTTPException(status_code=403, detail="Launch this tool from the dashboard before auto-fill can run")


OTP_POLL_INTERVAL_SEC = 5
OTP_MAX_WAIT_SEC = 60
OTP_EMAIL_MAX_AGE_SEC = 120
OTP_TICKET_TTL_SEC = 600
_otp_consumed_tickets: dict[str, float] = {}


def _cleanup_otp_tickets() -> None:
    cutoff = time.monotonic() - OTP_TICKET_TTL_SEC
    stale_tickets = [ticket for ticket, consumed_at in _otp_consumed_tickets.items() if consumed_at < cutoff]
    for ticket in stale_tickets:
        del _otp_consumed_tickets[ticket]


def _render_auto_login_page(tool: ITPortalTool, credential: ITPortalToolCredential) -> str:
    metadata = tool.metadata_json or {}
    auto_login = metadata.get("autoLogin") or {}
    action_url = auto_login.get("actionUrl") or tool.login_url or tool.website_url
    if not action_url:
        raise HTTPException(status_code=400, detail="Tool does not have an auto-login URL")

    method = _validate_auto_login_method(auto_login.get("method"))
    username_field = _validate_field_name(auto_login.get("usernameField"), "email", "auto_login_username_field")
    password_field = _validate_field_name(auto_login.get("passwordField"), "password", "auto_login_password_field")
    login_identifier = decrypt_secret(credential.login_identifier_encrypted) or ""
    password = decrypt_secret(credential.password_encrypted) or ""

    if not login_identifier or not password:
        raise HTTPException(status_code=400, detail="Assigned credential is missing username or password")

    escaped_action = html.escape(action_url, quote=True)
    escaped_method = html.escape(method.lower(), quote=True)
    escaped_tool = html.escape(tool.name or "Tool", quote=False)
    escaped_username_field = html.escape(username_field, quote=True)
    escaped_password_field = html.escape(password_field, quote=True)
    escaped_login_identifier = html.escape(login_identifier, quote=True)
    escaped_password = html.escape(password, quote=True)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Opening {escaped_tool}</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Arial, sans-serif;
      color: #18212f;
      background: #f5f7fb;
    }}
    main {{
      width: min(420px, calc(100vw - 32px));
      padding: 24px;
      border: 1px solid #d8dee9;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
    }}
    h1 {{ margin: 0 0 8px; font-size: 22px; }}
    p {{ margin: 0 0 18px; line-height: 1.5; color: #526070; }}
    button {{
      width: 100%;
      border: 0;
      border-radius: 8px;
      padding: 12px 14px;
      color: #fff;
      background: #1f6feb;
      font-weight: 700;
      cursor: pointer;
    }}
  </style>
</head>
<body>
  <main>
    <h1>Opening {escaped_tool}</h1>
    <p>Your assigned company credential is being submitted securely.</p>
    <form id="auto-login-form" action="{escaped_action}" method="{escaped_method}">
      <input type="hidden" name="{escaped_username_field}" value="{escaped_login_identifier}">
      <input type="hidden" name="{escaped_password_field}" value="{escaped_password}">
      <button type="submit">Continue</button>
    </form>
  </main>
  <script>
    window.addEventListener('load', function () {{
      window.setTimeout(function () {{
        document.getElementById('auto-login-form').submit();
      }}, 250);
    }});
  </script>
</body>
</html>"""


@router.get("/tools")
async def list_tools(
    current_user: User = Depends(require_user),
    db: Session = Depends(get_operational_db),
):
    is_admin = has_any_role(current_user, {"admin"})
    tools = (
        db.query(ITPortalTool)
        .filter(ITPortalTool.is_active == True)
        .order_by(ITPortalTool.category.asc(), ITPortalTool.name.asc())
        .all()
    )
    return {
        "success": True,
        "tools": [
            _serialize_tool(tool, _resolve_tool_credential(db, tool.id, current_user.id), is_admin=is_admin)
            for tool in tools
        ],
        "isAdmin": is_admin,
    }


@router.post("/tools")
async def create_tool(
    payload: ToolCreatePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    slug = _slugify(payload.slug or payload.name)
    existing = db.query(ITPortalTool).filter(ITPortalTool.slug == slug).first()
    if existing:
        raise HTTPException(status_code=409, detail="Tool slug already exists")

    website_url = _validate_url(payload.website_url, "website_url")
    login_url = _validate_url(payload.login_url, "login_url")
    launch_mode = _validate_launch_mode(payload.launch_mode)
    _validate_extension_autofill_target(launch_mode, website_url, login_url, slug)

    tool = ITPortalTool(
        name=payload.name.strip(),
        slug=slug,
        category=(payload.category or "General").strip() or "General",
        description=(payload.description or "").strip() or None,
        website_url=website_url,
        login_url=login_url,
        icon=(payload.icon or "Globe").strip() or "Globe",
        launch_mode=launch_mode,
        status=(payload.status or "active").strip().lower() or "active",
        is_active=payload.is_active,
        metadata_json=_auto_login_config_from_payload(payload),
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(tool)
    db.flush()
    _add_audit(db, actor_id=current_user.id, action="tool_created", tool_id=tool.id)
    db.commit()
    db.refresh(tool)
    return {"success": True, "tool": _serialize_tool(tool, is_admin=True)}


@router.patch("/tools/{tool_id}")
async def update_tool(
    tool_id: int,
    payload: ToolUpdatePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    if payload.name is not None:
        tool.name = payload.name.strip()
    if payload.category is not None:
        tool.category = payload.category.strip() or "General"
    if payload.description is not None:
        tool.description = payload.description.strip() or None
    if payload.website_url is not None:
        tool.website_url = _validate_url(payload.website_url, "website_url")
    if payload.login_url is not None:
        tool.login_url = _validate_url(payload.login_url, "login_url")
    if payload.icon is not None:
        tool.icon = payload.icon.strip() or "Globe"
    if payload.launch_mode is not None:
        tool.launch_mode = _validate_launch_mode(payload.launch_mode)
    if (
        payload.auto_login_action_url is not None
        or payload.auto_login_method is not None
        or payload.auto_login_username_field is not None
        or payload.auto_login_password_field is not None
    ):
        tool.metadata_json = _auto_login_config_from_payload(payload, tool.metadata_json or {})
    if payload.status is not None:
        tool.status = payload.status.strip().lower() or "active"
    if payload.is_active is not None:
        tool.is_active = payload.is_active
    _validate_extension_autofill_target(tool.launch_mode, tool.website_url, tool.login_url, tool.slug)
    tool.updated_by = current_user.id
    tool.updated_at = datetime.utcnow()

    _add_audit(db, actor_id=current_user.id, action="tool_updated", tool_id=tool.id)
    db.commit()
    db.refresh(tool)
    return {"success": True, "tool": _serialize_tool(tool, is_admin=True)}


@router.delete("/tools/{tool_id}")
async def delete_tool(
    tool_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    if not tool.is_active:
        return {"success": True}

    tool.is_active = False
    tool.status = "deleted"
    tool.updated_by = current_user.id
    tool.updated_at = datetime.utcnow()

    _add_audit(db, actor_id=current_user.id, action="tool_deleted", tool_id=tool.id)
    db.commit()
    return {"success": True}


@router.post("/extension/credential")
async def get_extension_credential(
    payload: ExtensionCredentialPayload,
    current_user: User = Depends(require_user),
    db: Session = Depends(get_operational_db),
):
    tool = _find_extension_tool(db, payload)
    if not tool:
        raise HTTPException(status_code=404, detail="No matching tool found for this page")
    if tool.launch_mode not in {"extension_autofill", "automation"}:
        raise HTTPException(status_code=400, detail="Tool is not configured for extension auto-fill")

    if payload.extension_ticket:
        ticket_payload = _decode_ticket(payload.extension_ticket)
        if ticket_payload.get("kind") != "extension_autofill":
            raise _extension_ticket_error()
        if int(ticket_payload.get("userId") or 0) != current_user.id:
            raise _extension_ticket_error()
        if int(ticket_payload.get("toolId") or 0) != tool.id:
            raise _extension_ticket_error()

    credential = _resolve_tool_credential(db, tool.id, current_user.id)
    if not credential:
        raise HTTPException(status_code=404, detail="No assigned credential found for this tool")

    login_identifier = decrypt_secret(credential.login_identifier_encrypted)
    password = decrypt_secret(credential.password_encrypted)
    if not login_identifier or not password:
        raise HTTPException(status_code=400, detail="Assigned credential is missing username or password")

    _add_audit(
        db,
        actor_id=current_user.id,
        action="extension_credential_revealed",
        tool_id=tool.id,
        credential_id=credential.id,
        target_user_id=credential.user_id,
        details={
            "hostname": _normalize_hostname(payload.hostname or payload.page_url),
            "credentialScope": credential.scope,
        },
    )
    db.commit()

    return {
        "success": True,
        "tool": {
            "id": tool.id,
            "name": tool.name,
            "slug": tool.slug,
            "launchMode": tool.launch_mode,
        },
        "credential": {
            "scope": credential.scope,
            "loginIdentifier": login_identifier,
            "password": password,
        },
    }


@router.post("/extension/otp")
async def get_extension_otp(
    payload: OtpRequestPayload,
    current_user: User = Depends(require_user),
    db: Session = Depends(get_operational_db),
):
    tool = _find_extension_tool(db, payload)
    if not tool:
        raise HTTPException(status_code=404, detail="No matching tool found for this page")
    if tool.launch_mode != "extension_autofill":
        raise HTTPException(status_code=400, detail="Tool is not configured for extension auto-fill")

    extension_ticket = (payload.extension_ticket or "").strip()
    if not extension_ticket:
        raise _extension_ticket_error()

    ticket_payload = _decode_ticket(extension_ticket)
    if ticket_payload.get("kind") != "extension_autofill":
        raise _extension_ticket_error()
    if int(ticket_payload.get("userId") or 0) != current_user.id:
        raise _extension_ticket_error()
    if int(ticket_payload.get("toolId") or 0) != tool.id:
        raise _extension_ticket_error()

    _cleanup_otp_tickets()
    if extension_ticket in _otp_consumed_tickets:
        raise HTTPException(
            status_code=409,
            detail="OTP already fetched for this launch session. Launch the tool again from the dashboard.",
        )

    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool.id).first()
    if not mailbox:
        raise HTTPException(
            status_code=404,
            detail=f"No mailbox configured for tool '{tool.name}'. Ask an admin to add the mailbox in the dashboard.",
        )

    app_password = decrypt_secret(mailbox.app_password_encrypted)
    if not app_password:
        raise HTTPException(status_code=500, detail="Mailbox app password could not be decrypted")

    attempts = max(1, OTP_MAX_WAIT_SEC // OTP_POLL_INTERVAL_SEC)
    otp = None
    last_fetch_error = None
    for attempt_index in range(attempts):
        try:
            otp = await asyncio.to_thread(
                fetch_otp_from_gmail,
                mailbox.email_address,
                app_password,
                mailbox.otp_regex,
                mailbox.otp_sender_filter,
                mailbox.otp_subject_pattern,
                OTP_EMAIL_MAX_AGE_SEC,
            )
            last_fetch_error = None
        except imaplib.IMAP4.error as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Mailbox login failed for {mailbox.email_address}. Update the Gmail app password or enable IMAP. ({exc})",
            ) from exc
        except Exception as exc:
            last_fetch_error = exc
            otp = None

        if otp:
            break

        if attempt_index < attempts - 1:
            await asyncio.sleep(OTP_POLL_INTERVAL_SEC)

    if not otp:
        if last_fetch_error is not None:
            raise HTTPException(
                status_code=502,
                detail=f"Mailbox fetch failed: {last_fetch_error}",
            )
        raise HTTPException(
            status_code=408,
            detail="OTP email did not arrive within the timeout window. Check the mailbox filters and try again.",
        )

    _otp_consumed_tickets[extension_ticket] = time.monotonic()
    _add_audit(
        db,
        actor_id=current_user.id,
        action="extension_otp_fetched",
        tool_id=tool.id,
        details={
            "hostname": _normalize_hostname(payload.hostname or payload.page_url),
            "mailbox": mailbox.email_address,
        },
    )
    db.commit()

    return {"success": True, "otp": otp}


@router.get("/tools/{tool_id}/credentials")
async def list_credentials(
    tool_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    credentials = (
        db.query(ITPortalToolCredential)
        .filter(ITPortalToolCredential.tool_id == tool_id)
        .order_by(ITPortalToolCredential.scope.asc(), ITPortalToolCredential.updated_at.desc())
        .all()
    )
    return {"success": True, "credentials": [_serialize_credential_summary(item) for item in credentials]}


@router.post("/tools/{tool_id}/credentials")
async def upsert_credential(
    tool_id: int,
    payload: CredentialUpsertPayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    scope = _validate_scope(payload)

    if scope == "user":
        user = db.query(User).filter(User.id == payload.user_id, User.is_deleted == False).first()
        if not user:
            raise HTTPException(status_code=404, detail="Target user not found")

    credential = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.scope == scope,
            ITPortalToolCredential.user_id == (payload.user_id if scope == "user" else None),
        )
        .order_by(ITPortalToolCredential.created_at.desc())
        .first()
    )

    created = credential is None
    if credential is None:
        credential = ITPortalToolCredential(
            tool_id=tool_id,
            scope=scope,
            user_id=payload.user_id if scope == "user" else None,
            created_by=current_user.id,
        )
        db.add(credential)

    if payload.login_identifier is not None:
        credential.login_identifier_encrypted = encrypt_secret(payload.login_identifier)
    if payload.password is not None:
        credential.password_encrypted = encrypt_secret(payload.password)
    if payload.api_key is not None:
        credential.api_key_encrypted = encrypt_secret(payload.api_key)
    if payload.notes is not None:
        credential.notes = payload.notes.strip() or None
    credential.is_active = payload.is_active
    credential.updated_by = current_user.id
    credential.updated_at = datetime.utcnow()

    db.flush()
    _add_audit(
        db,
        actor_id=current_user.id,
        action="credential_created" if created else "credential_updated",
        tool_id=tool_id,
        credential_id=credential.id,
        target_user_id=credential.user_id,
        details={"scope": scope},
    )
    db.commit()
    db.refresh(credential)
    return {"success": True, "credential": _serialize_credential_summary(credential)}


@router.post("/tools/{tool_id}/launch")
async def launch_tool(
    tool_id: int,
    request: Request,
    current_user: User = Depends(require_user),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id, ITPortalTool.is_active == True).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    credential = _resolve_tool_credential(db, tool.id, current_user.id)
    revealed = None
    if credential:
        revealed = {
            "scope": credential.scope,
            "loginIdentifier": decrypt_secret(credential.login_identifier_encrypted),
            "password": None if tool.launch_mode in {"automation", "extension_autofill"} else decrypt_secret(credential.password_encrypted),
            "apiKey": decrypt_secret(credential.api_key_encrypted),
            "notes": credential.notes,
        }

    launch_url = tool.login_url or tool.website_url
    extension_ticket = None
    extension_ticket_expires_at = None
    if tool.launch_mode == "automation":
        if not credential:
            raise HTTPException(status_code=400, detail="Auto-login requires an assigned credential")
        ticket = _sign_ticket(
            {
                "kind": "automation_launch",
                "toolId": tool.id,
                "userId": current_user.id,
                "exp": int(time.time()) + 60,
            }
        )
        launch_url = _automation_launch_url(request, ticket)
    elif tool.launch_mode == "extension_autofill":
        if not credential:
            raise HTTPException(status_code=400, detail="Extension auto-fill requires an assigned credential")
        extension_ticket_expires_at = int(time.time()) + 180
        extension_ticket = _sign_ticket(
            {
                "kind": "extension_autofill",
                "toolId": tool.id,
                "userId": current_user.id,
                "exp": extension_ticket_expires_at,
            }
        )

    _add_audit(
        db,
        actor_id=current_user.id,
        action="tool_launched",
        tool_id=tool.id,
        credential_id=credential.id if credential else None,
        target_user_id=credential.user_id if credential else None,
        details={"launchMode": tool.launch_mode, "credentialScope": credential.scope if credential else None},
    )
    db.commit()

    return {
        "success": True,
        "launchUrl": launch_url,
        "autoLogin": tool.launch_mode == "automation",
        "extensionAutoFill": tool.launch_mode == "extension_autofill",
        "extensionTicket": extension_ticket,
        "extensionTicketExpiresAt": extension_ticket_expires_at,
        "tool": _serialize_tool(tool, credential=credential),
        "credential": revealed,
    }


@router.get("/launch/{ticket}", response_class=HTMLResponse)
async def launch_with_ticket(
    ticket: str,
    db: Session = Depends(get_operational_db),
):
    payload = _decode_ticket(ticket)
    tool_id = int(payload.get("toolId") or 0)
    user_id = int(payload.get("userId") or 0)
    if not tool_id or not user_id:
        raise HTTPException(status_code=400, detail="Invalid launch ticket")
    if payload.get("kind") != "automation_launch":
        raise HTTPException(status_code=400, detail="Invalid launch ticket")

    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id, ITPortalTool.is_active == True).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    if tool.launch_mode != "automation":
        raise HTTPException(status_code=400, detail="Tool is not configured for auto-login")

    credential = _resolve_tool_credential(db, tool.id, user_id)
    if not credential:
        raise HTTPException(status_code=400, detail="Auto-login requires an assigned credential")

    _add_audit(
        db,
        actor_id=user_id,
        action="tool_auto_login_submitted",
        tool_id=tool.id,
        credential_id=credential.id,
        target_user_id=credential.user_id,
        details={"credentialScope": credential.scope},
    )
    db.commit()

    return HTMLResponse(
        content=_render_auto_login_page(tool, credential),
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
        },
    )
