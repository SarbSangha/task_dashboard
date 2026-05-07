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
from services.otp_mail_service import fetch_auth_link_from_gmail, fetch_otp_from_gmail
from services.totp_service import generate_totp_code, parse_totp_config
from utils.credential_crypto import decrypt_secret, encrypt_secret
from utils.permissions import get_current_user, has_any_role, require_admin, require_user


router = APIRouter(prefix="/api/it-tools", tags=["IT Tools"])

VALID_SCOPES = {"company", "user"}
VALID_LAUNCH_MODES = {"external_link", "manual_credential", "sso", "api_proxy", "automation", "extension_autofill"}
EXTENSION_AUTOFILL_TICKET_TTL_SEC = 20 * 60
HOSTNAME_EQUIVALENT_GROUPS = (
    {"chatgpt.com", "chat.openai.com", "auth.openai.com", "openai.com"},
    {"claude.ai"},
    {"envato.com", "elements.envato.com", "market.envato.com"},
    {"freepik.com"},
    {"grammarly.com"},
    {"higgsfield.ai", "app.higgsfield.ai", "beta.higgsfield.ai"},
    {"heygen.com", "www.heygen.com", "auth.heygen.com", "app.heygen.com"},
    {"kling.ai", "klingai.com", "app.klingai.com"},
)
SUPPORTED_EXTENSION_AUTOFILL_HOSTS = frozenset().union(*HOSTNAME_EQUIVALENT_GROUPS)
SUPPORTED_EXTENSION_AUTOFILL_SLUGS = {"chatgpt", "claude", "envato", "freepik", "grammarly", "higgsfield", "heygen", "kling", "kling-ai", "klingai", "flow"}
PASSWORD_OPTIONAL_EXTENSION_AUTOFILL_SLUGS = {"claude"}
TOOL_CREDENTIAL_LOGIN_METHODS = {
    "freepik": {"email_password", "google"},
    "kling": {"email_password", "google"},
    "kling-ai": {"email_password", "google"},
    "klingai": {"email_password", "google"},
}


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
    credential_id: Optional[int] = None
    scope: str = Field("company")
    user_id: Optional[int] = None
    linked_credential_id: Optional[int] = None
    assigned_user_ids: Optional[list[int]] = None
    login_method: Optional[str] = Field(None, max_length=40)
    login_identifier: Optional[str] = None
    password: Optional[str] = None
    backup_codes: Optional[str] = None
    totp_secret: Optional[str] = None
    api_key: Optional[str] = None
    notes: Optional[str] = None
    is_active: bool = True
    create_new: bool = False


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


def _canonical_tool_slug(value: str) -> str:
    slug = _slugify(value or "")
    if slug == "chat-gpt":
        return "chatgpt"
    return slug


def _tool_supports_password_optional_credential(canonical_tool_slug: str) -> bool:
    return canonical_tool_slug in PASSWORD_OPTIONAL_EXTENSION_AUTOFILL_SLUGS


def _normalize_credential_login_method(canonical_tool_slug: str, value: Optional[str]) -> str:
    normalized = f"{value or ''}".strip().lower() or "email_password"
    allowed_values = TOOL_CREDENTIAL_LOGIN_METHODS.get(canonical_tool_slug, {"email_password"})
    if normalized not in allowed_values:
        raise HTTPException(status_code=400, detail=f"Unsupported login method '{normalized}' for this tool.")
    return normalized


def _credential_password_is_optional(canonical_tool_slug: str, login_method: str = "email_password") -> bool:
    return _tool_supports_password_optional_credential(canonical_tool_slug) or login_method == "google"


def _validate_tool_name(value: str) -> str:
    normalized = (value or "").strip()
    if len(normalized) < 2:
        raise HTTPException(status_code=400, detail="Tool name must be at least 2 characters long")
    return normalized


def _validate_tool_slug(value: Optional[str], *, fallback_name: str) -> str:
    slug = _slugify(value or fallback_name)
    if slug == "tool":
        raise HTTPException(status_code=400, detail="Tool slug is too generic. Enter a more specific tool name or slug.")
    return slug


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
        "linkedCredentialId": credential.linked_credential_id,
        "loginMethod": credential.login_method or "email_password",
        "hasLoginIdentifier": bool(credential.login_identifier_encrypted),
        "hasPassword": bool(credential.password_encrypted),
        "hasBackupCodes": bool(credential.backup_codes_encrypted),
        "hasTotpSecret": bool(credential.totp_secret_encrypted),
        "hasApiKey": bool(credential.api_key_encrypted),
        "loginIdentifierPreview": decrypt_secret(credential.login_identifier_encrypted) or None,
        "notes": credential.notes,
        "isActive": bool(credential.is_active),
        "createdAt": credential.created_at.isoformat() if credential.created_at else None,
        "updatedAt": credential.updated_at.isoformat() if credential.updated_at else None,
    }


def _build_admin_credential_summaries_by_tool(
    db: Session,
    tools: list[ITPortalTool],
) -> dict[str, list[dict]]:
    tool_ids = [tool.id for tool in tools if tool.id]
    if not tool_ids:
        return {}

    credentials = (
        db.query(ITPortalToolCredential)
        .filter(ITPortalToolCredential.tool_id.in_(tool_ids))
        .order_by(
            ITPortalToolCredential.tool_id.asc(),
            ITPortalToolCredential.scope.asc(),
            ITPortalToolCredential.updated_at.desc(),
            ITPortalToolCredential.created_at.desc(),
        )
        .all()
    )

    summaries_by_tool_id: dict[str, list[dict]] = {f"{tool.id}": [] for tool in tools}
    tool_by_id = {tool.id: tool for tool in tools}
    serialized_by_tool_and_credential_id: dict[tuple[int, int], dict] = {}
    company_credential_ids_by_tool_id: dict[int, set[int]] = {}

    for credential in credentials:
        serialized = _serialize_credential_summary(credential)
        tool_key = f"{credential.tool_id}"
        summaries_by_tool_id.setdefault(tool_key, []).append(serialized)
        serialized_by_tool_and_credential_id[(credential.tool_id, credential.id)] = serialized
        if credential.scope == "company":
            company_credential_ids_by_tool_id.setdefault(credential.tool_id, set()).add(credential.id)

    shareable_tool_ids = [
        tool_id
        for tool_id, tool in tool_by_id.items()
        if _tool_supports_shared_company_credential_assignments(_canonical_tool_slug(tool.slug or ""))
        and company_credential_ids_by_tool_id.get(tool_id)
    ]
    if not shareable_tool_ids:
        return summaries_by_tool_id

    latest_user_rows: dict[tuple[int, int], ITPortalToolCredential] = {}
    user_rows = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id.in_(shareable_tool_ids),
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.user_id.isnot(None),
        )
        .order_by(
            ITPortalToolCredential.tool_id.asc(),
            ITPortalToolCredential.user_id.asc(),
            ITPortalToolCredential.updated_at.desc(),
            ITPortalToolCredential.created_at.desc(),
        )
        .all()
    )
    for row in user_rows:
        key = (row.tool_id, int(row.user_id or 0))
        if key not in latest_user_rows:
            latest_user_rows[key] = row

    assigned_user_ids = sorted({
        user_id
        for (tool_id, user_id), row in latest_user_rows.items()
        if row.is_active and row.linked_credential_id in company_credential_ids_by_tool_id.get(tool_id, set())
    })
    users_by_id = {}
    if assigned_user_ids:
        users_by_id = {
            user.id: user
            for user in db.query(User).filter(User.id.in_(assigned_user_ids)).all()
        }

    assignments_by_tool_and_credential_id: dict[tuple[int, int], list[dict]] = {}
    for (tool_id, user_id), row in latest_user_rows.items():
        linked_credential_id = row.linked_credential_id
        if not row.is_active or linked_credential_id not in company_credential_ids_by_tool_id.get(tool_id, set()):
            continue
        user = users_by_id.get(user_id)
        if not user:
            continue
        assignments_by_tool_and_credential_id.setdefault((tool_id, linked_credential_id), []).append(
            {
                "id": user.id,
                "name": user.name,
                "email": user.email,
            }
        )

    for (tool_id, credential_id), summary in serialized_by_tool_and_credential_id.items():
        assigned_users = assignments_by_tool_and_credential_id.get((tool_id, credential_id), [])
        summary["assignedUsers"] = sorted(
            assigned_users,
            key=lambda user: f"{user.get('name') or ''} {user.get('email') or ''}".strip().lower(),
        )
        summary["assignedUserIds"] = [user["id"] for user in summary["assignedUsers"]]

    return summaries_by_tool_id


def _normalize_backup_codes(value: Optional[str]) -> list[str]:
    if value is None:
        return []

    normalized_codes: list[str] = []
    seen_codes: set[str] = set()
    for raw_part in re.split(r"[\r\n,;]+", value):
        digits_only = re.sub(r"\D", "", (raw_part or "").strip())
        if not digits_only:
            continue
        if len(digits_only) != 8:
            raise HTTPException(
                status_code=400,
                detail="Each backup code must contain exactly 8 digits.",
            )
        if digits_only in seen_codes:
            continue
        seen_codes.add(digits_only)
        normalized_codes.append(digits_only)
    return normalized_codes


def _decode_backup_codes(credential: Optional[ITPortalToolCredential]) -> list[str]:
    encrypted_value = getattr(credential, "backup_codes_encrypted", None)
    if not encrypted_value:
        return []

    decrypted_value = decrypt_secret(encrypted_value) or ""
    if not decrypted_value:
        return []

    try:
        parsed_value = json.loads(decrypted_value)
    except json.JSONDecodeError:
        parsed_value = None

    if isinstance(parsed_value, list):
        normalized_codes: list[str] = []
        seen_codes: set[str] = set()
        for item in parsed_value:
            digits_only = re.sub(r"\D", "", f"{item or ''}")
            if len(digits_only) != 8 or digits_only in seen_codes:
                continue
            seen_codes.add(digits_only)
            normalized_codes.append(digits_only)
        return normalized_codes

    return _normalize_backup_codes(decrypted_value)


def _normalize_totp_secret(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None

    normalized = f"{value or ''}".strip()
    if not normalized:
        return ""

    config = parse_totp_config(normalized)
    if normalized.lower().startswith("otpauth://"):
        return normalized
    return config.secret


def _decrypt_secret_value(value: Optional[str]) -> Optional[str]:
    decrypted = decrypt_secret(value) if value else None
    return decrypted or None


def _normalize_optional_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = f"{value or ''}".strip()
    return normalized or None


def _normalize_optional_secret(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = f"{value}"
    return normalized if normalized else None


def _payload_has_credential_content(payload: CredentialUpsertPayload) -> bool:
    return any(
        value is not None
        for value in (
            payload.login_identifier,
            payload.password,
            payload.backup_codes,
            payload.totp_secret,
            payload.api_key,
        )
    )


def _build_resolved_credential_snapshot(
    payload: CredentialUpsertPayload,
    *,
    canonical_tool_slug: str,
    source_credential: Optional[ITPortalToolCredential] = None,
) -> dict:
    login_method = (
        _normalize_credential_login_method(canonical_tool_slug, payload.login_method)
        if payload.login_method is not None
        else _normalize_credential_login_method(
            canonical_tool_slug,
            getattr(source_credential, "login_method", None),
        )
    )
    login_identifier = (
        _normalize_optional_text(payload.login_identifier)
        if payload.login_identifier is not None
        else _decrypt_secret_value(getattr(source_credential, "login_identifier_encrypted", None))
    )
    password = (
        _normalize_optional_secret(payload.password)
        if payload.password is not None
        else _decrypt_secret_value(getattr(source_credential, "password_encrypted", None))
    )
    api_key = (
        _normalize_optional_text(payload.api_key)
        if payload.api_key is not None
        else _decrypt_secret_value(getattr(source_credential, "api_key_encrypted", None))
    )
    backup_codes = (
        _normalize_backup_codes(payload.backup_codes)
        if payload.backup_codes is not None
        else _decode_backup_codes(source_credential)
    )
    totp_secret = (
        _normalize_totp_secret(payload.totp_secret)
        if payload.totp_secret is not None
        else _decrypt_secret_value(getattr(source_credential, "totp_secret_encrypted", None))
    )
    notes = (
        payload.notes.strip() or None
        if payload.notes is not None
        else getattr(source_credential, "notes", None)
    )
    return {
        "login_method": login_method,
        "login_identifier": login_identifier,
        "password": password,
        "api_key": api_key,
        "backup_codes": backup_codes,
        "totp_secret": totp_secret,
        "notes": notes,
    }


def _credential_snapshot_matches(
    credential: ITPortalToolCredential,
    snapshot: dict,
) -> bool:
    return (
        (credential.login_method or "email_password") == (snapshot.get("login_method") or "email_password")
        and
        _normalize_login_identifier(_decrypt_secret_value(credential.login_identifier_encrypted))
        == _normalize_login_identifier(snapshot.get("login_identifier"))
        and _decrypt_secret_value(credential.password_encrypted) == snapshot.get("password")
        and _decrypt_secret_value(credential.api_key_encrypted) == snapshot.get("api_key")
        and _decode_backup_codes(credential) == (snapshot.get("backup_codes") or [])
        and _decrypt_secret_value(credential.totp_secret_encrypted) == snapshot.get("totp_secret")
    )


def _ensure_reusable_company_credential(
    db: Session,
    *,
    tool_id: int,
    canonical_tool_slug: str,
    payload: CredentialUpsertPayload,
    actor_id: int,
    target_user_id: int,
    source_credential: Optional[ITPortalToolCredential] = None,
) -> ITPortalToolCredential:
    snapshot = _build_resolved_credential_snapshot(
        payload,
        canonical_tool_slug=canonical_tool_slug,
        source_credential=source_credential,
    )
    company_credentials = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.scope == "company",
            ITPortalToolCredential.user_id.is_(None),
        )
        .order_by(ITPortalToolCredential.updated_at.desc(), ITPortalToolCredential.created_at.desc())
        .all()
    )

    reusable_credential = next(
        (item for item in company_credentials if _credential_snapshot_matches(item, snapshot)),
        None,
    )
    created = reusable_credential is None
    if reusable_credential is None:
        reusable_credential = ITPortalToolCredential(
            tool_id=tool_id,
            scope="company",
            created_by=actor_id,
        )
        db.add(reusable_credential)

    reusable_credential.login_identifier_encrypted = (
        encrypt_secret(snapshot["login_identifier"])
        if snapshot["login_identifier"]
        else None
    )
    reusable_credential.login_method = snapshot["login_method"]
    reusable_credential.password_encrypted = (
        encrypt_secret(snapshot["password"])
        if snapshot["password"]
        else None
    )
    reusable_credential.api_key_encrypted = (
        encrypt_secret(snapshot["api_key"])
        if snapshot["api_key"]
        else None
    )
    reusable_credential.backup_codes_encrypted = (
        encrypt_secret(json.dumps(snapshot["backup_codes"]))
        if snapshot["backup_codes"]
        else None
    )
    reusable_credential.totp_secret_encrypted = (
        encrypt_secret(snapshot["totp_secret"])
        if snapshot["totp_secret"]
        else None
    )
    if payload.notes is not None or created:
        reusable_credential.notes = snapshot["notes"]
    reusable_credential.is_active = True
    reusable_credential.updated_by = actor_id
    reusable_credential.updated_at = datetime.utcnow()
    db.flush()

    _add_audit(
        db,
        actor_id=actor_id,
        action="credential_created" if created else "credential_updated",
        tool_id=tool_id,
        credential_id=reusable_credential.id,
        target_user_id=target_user_id,
        details={
            "scope": "company",
            "source": "specific_user_save",
        },
    )
    return reusable_credential


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


def _credential_has_secret_material(
    credential: Optional[ITPortalToolCredential],
    canonical_tool_slug: str = "",
) -> bool:
    login_method = _normalize_credential_login_method(
        canonical_tool_slug,
        getattr(credential, "login_method", None),
    ) if credential else "email_password"
    return bool(
        credential
        and (
            (
                credential.login_identifier_encrypted
                and (
                    credential.password_encrypted
                    or _credential_password_is_optional(canonical_tool_slug, login_method)
                )
            )
            or credential.api_key_encrypted
        )
    )


def _tool_supports_shared_company_credential_assignments(canonical_tool_slug: str) -> bool:
    return bool(canonical_tool_slug and canonical_tool_slug != "tool")


def _list_active_company_credential_records(db: Session, tool_id: int) -> list[ITPortalToolCredential]:
    return (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.is_active == True,
            ITPortalToolCredential.scope == "company",
            ITPortalToolCredential.user_id.is_(None),
        )
        .order_by(ITPortalToolCredential.updated_at.desc(), ITPortalToolCredential.created_at.desc())
        .all()
    )


def _resolve_linked_company_credential(
    db: Session,
    credential: Optional[ITPortalToolCredential],
    *,
    canonical_tool_slug: str = "",
) -> Optional[ITPortalToolCredential]:
    linked_credential_id = getattr(credential, "linked_credential_id", None)
    if not credential or not linked_credential_id:
        return None

    linked_credential = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.id == linked_credential_id,
            ITPortalToolCredential.tool_id == credential.tool_id,
            ITPortalToolCredential.scope == "company",
            ITPortalToolCredential.is_active == True,
        )
        .first()
    )
    if _credential_has_secret_material(linked_credential, canonical_tool_slug):
        return linked_credential
    return None


def _latest_user_credential_records_for_tool(
    db: Session,
    tool_id: int,
    user_ids: Optional[list[int]] = None,
) -> dict[int, ITPortalToolCredential]:
    query = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.user_id.isnot(None),
        )
    )
    if user_ids:
        query = query.filter(ITPortalToolCredential.user_id.in_(user_ids))

    rows = (
        query.order_by(
            ITPortalToolCredential.user_id.asc(),
            ITPortalToolCredential.updated_at.desc(),
            ITPortalToolCredential.created_at.desc(),
        )
        .all()
    )

    latest_records: dict[int, ITPortalToolCredential] = {}
    for row in rows:
        if row.user_id and row.user_id not in latest_records:
            latest_records[row.user_id] = row
    return latest_records


def _latest_user_credential_record(db: Session, tool_id: int, user_id: int) -> Optional[ITPortalToolCredential]:
    return (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.user_id == user_id,
        )
        .order_by(ITPortalToolCredential.updated_at.desc(), ITPortalToolCredential.created_at.desc())
        .first()
    )


def _latest_company_credential_record(db: Session, tool_id: int) -> Optional[ITPortalToolCredential]:
    company_credentials = _list_active_company_credential_records(db, tool_id)
    return company_credentials[0] if company_credentials else None


def _resolve_user_tool_overrides_map(
    db: Session,
    tool_ids: list[int],
    user_id: int,
) -> dict[int, ITPortalToolCredential]:
    if not tool_ids:
        return {}

    overrides = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id.in_(tool_ids),
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.user_id == user_id,
        )
        .order_by(
            ITPortalToolCredential.tool_id.asc(),
            ITPortalToolCredential.updated_at.desc(),
            ITPortalToolCredential.created_at.desc(),
        )
        .all()
    )

    latest_overrides: dict[int, ITPortalToolCredential] = {}
    for credential in overrides:
        latest_overrides.setdefault(credential.tool_id, credential)
    return latest_overrides


def _resolve_tool_credential(db: Session, tool_id: int, user_id: int) -> Optional[ITPortalToolCredential]:
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    canonical_tool_slug = _canonical_tool_slug(tool.slug or "") if tool else ""
    user_specific_credential = _latest_user_credential_record(db, tool_id, user_id)

    if not user_specific_credential or not user_specific_credential.is_active:
        return None

    linked_credential = _resolve_linked_company_credential(
        db,
        user_specific_credential,
        canonical_tool_slug=canonical_tool_slug,
    )
    if linked_credential:
        return linked_credential
    if _credential_has_secret_material(user_specific_credential, canonical_tool_slug):
        return user_specific_credential
    return None


def _normalize_login_identifier(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _resolve_chatgpt_totp_fallback(
    db: Session,
    *,
    tool: ITPortalTool,
    credential: ITPortalToolCredential,
    user_id: int,
) -> tuple[Optional[ITPortalTool], Optional[ITPortalToolCredential]]:
    if _canonical_tool_slug(tool.slug or "") != "chatgpt":
        return None, None

    current_login_identifier = _normalize_login_identifier(
        decrypt_secret(credential.login_identifier_encrypted)
    )
    if not current_login_identifier:
        return None, None

    flow_tool = (
        db.query(ITPortalTool)
        .filter(
            ITPortalTool.is_active == True,
            ITPortalTool.slug == "flow",
        )
        .first()
    )
    if not flow_tool:
        return None, None

    flow_credential = _resolve_tool_credential(db, flow_tool.id, user_id)
    if flow_credential and flow_credential.totp_secret_encrypted:
        flow_login_identifier = _normalize_login_identifier(
            decrypt_secret(flow_credential.login_identifier_encrypted)
        )
        if flow_login_identifier and flow_login_identifier == current_login_identifier:
            return flow_tool, flow_credential

    # Shared ChatGPT logins can be assigned to different users. If the current user
    # does not also resolve to the matching Flow credential, fall back to any active
    # shared Flow credential with the same Google login and an authenticator seed.
    for company_flow_credential in _list_active_company_credential_records(db, flow_tool.id):
        if not company_flow_credential.totp_secret_encrypted:
            continue
        flow_login_identifier = _normalize_login_identifier(
            decrypt_secret(company_flow_credential.login_identifier_encrypted)
        )
        if flow_login_identifier and flow_login_identifier == current_login_identifier:
            return flow_tool, company_flow_credential

    return None, None


def _resolve_tool_credentials_map(db: Session, tool_ids: list[int], user_id: int) -> dict[int, ITPortalToolCredential]:
    if not tool_ids:
        return {}
    credentials_by_tool: dict[int, ITPortalToolCredential] = {}
    for tool_id in tool_ids:
        credential = _resolve_tool_credential(db, tool_id, user_id)
        if credential:
            credentials_by_tool[tool_id] = credential
    return credentials_by_tool


def _apply_shared_credential_assignments(
    db: Session,
    *,
    tool_id: int,
    credential: ITPortalToolCredential,
    assigned_user_ids: list[int],
    actor_id: int,
) -> None:
    desired_user_ids = sorted({int(user_id) for user_id in assigned_user_ids if int(user_id) > 0})
    if desired_user_ids:
        users = (
            db.query(User)
            .filter(User.id.in_(desired_user_ids), User.is_deleted == False)
            .all()
        )
        found_user_ids = {user.id for user in users}
        missing_user_ids = [user_id for user_id in desired_user_ids if user_id not in found_user_ids]
        if missing_user_ids:
            raise HTTPException(status_code=404, detail="One or more selected users could not be found")

    active_user_rows = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.tool_id == tool_id,
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.user_id.isnot(None),
            ITPortalToolCredential.is_active == True,
        )
        .order_by(
            ITPortalToolCredential.user_id.asc(),
            ITPortalToolCredential.updated_at.desc(),
            ITPortalToolCredential.created_at.desc(),
        )
        .all()
    )
    active_rows_by_user: dict[int, list[ITPortalToolCredential]] = {}
    for row in active_user_rows:
        if row.user_id:
            active_rows_by_user.setdefault(row.user_id, []).append(row)

    currently_linked_user_ids = {
        row.user_id
        for row in active_user_rows
        if row.user_id and row.linked_credential_id == credential.id
    }
    desired_user_id_set = set(desired_user_ids)
    now = datetime.utcnow()

    for user_id in desired_user_ids:
        user_active_rows = active_rows_by_user.get(user_id, [])
        matching_row = next(
            (row for row in user_active_rows if row.linked_credential_id == credential.id),
            None,
        )

        if matching_row:
            for row in user_active_rows:
                if row.id == matching_row.id:
                    continue
                row.is_active = False
                row.updated_by = actor_id
                row.updated_at = now
            continue

        for row in user_active_rows:
            row.is_active = False
            row.updated_by = actor_id
            row.updated_at = now

        db.add(
            ITPortalToolCredential(
                tool_id=tool_id,
                scope="user",
                user_id=user_id,
                linked_credential_id=credential.id,
                is_active=True,
                created_by=actor_id,
                updated_by=actor_id,
                updated_at=now,
            )
        )

    for user_id in currently_linked_user_ids - desired_user_id_set:
        for row in active_rows_by_user.get(user_id, []):
            if row.linked_credential_id != credential.id:
                continue
            row.is_active = False
            row.updated_by = actor_id
            row.updated_at = now


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
        detail="Extension auto-fill currently supports ChatGPT/OpenAI, Claude, Envato, Freepik, Grammarly, Higgsfield, HeyGen, Kling AI, and Flow. Use Manual credential or Auto-login form submit for other tools.",
    )


def _find_extension_tool(db: Session, payload: ExtensionCredentialPayload) -> Optional[ITPortalTool]:
    extension_ticket = f"{payload.extension_ticket or ''}".strip()
    if extension_ticket:
        try:
            ticket_payload = _decode_ticket(extension_ticket)
        except HTTPException:
            ticket_payload = {}

        if ticket_payload.get("kind") == "extension_autofill":
            tool_id = int(ticket_payload.get("toolId") or 0)
            if tool_id > 0:
                ticket_tool = (
                    db.query(ITPortalTool)
                    .filter(ITPortalTool.id == tool_id, ITPortalTool.is_active == True)
                    .first()
                )
                if ticket_tool:
                    return ticket_tool

    tool_slug = _canonical_tool_slug(payload.tool_slug or "")
    hostname = _normalize_hostname(payload.hostname or payload.page_url)

    query = db.query(ITPortalTool).filter(ITPortalTool.is_active == True)
    active_tools = query.all()
    if tool_slug and tool_slug != "tool":
        for tool in active_tools:
            if _canonical_tool_slug(tool.slug or "") == tool_slug:
                return tool

    if not hostname:
        return None

    for tool in active_tools:
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
AUTH_LINK_MAX_WAIT_SEC = 60
AUTH_LINK_EMAIL_MAX_AGE_SEC = 300
_auth_link_consumed_tickets: dict[str, float] = {}


def _cleanup_otp_tickets() -> None:
    cutoff = time.monotonic() - OTP_TICKET_TTL_SEC
    stale_tickets = [ticket for ticket, consumed_at in _otp_consumed_tickets.items() if consumed_at < cutoff]
    for ticket in stale_tickets:
        del _otp_consumed_tickets[ticket]


def _cleanup_auth_link_tickets() -> None:
    cutoff = time.monotonic() - OTP_TICKET_TTL_SEC
    stale_tickets = [ticket for ticket, consumed_at in _auth_link_consumed_tickets.items() if consumed_at < cutoff]
    for ticket in stale_tickets:
        del _auth_link_consumed_tickets[ticket]


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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    is_admin = has_any_role(current_user, {"admin"})
    tools = (
        db.query(ITPortalTool)
        .filter(ITPortalTool.is_active == True)
        .order_by(ITPortalTool.category.asc(), ITPortalTool.name.asc())
        .all()
    )
    credentials_by_tool = _resolve_tool_credentials_map(db, [tool.id for tool in tools], current_user.id)
    if not is_admin:
        tools = [tool for tool in tools if tool.id in credentials_by_tool]

    response = {
        "success": True,
        "tools": [
            _serialize_tool(tool, credentials_by_tool.get(tool.id), is_admin=is_admin)
            for tool in tools
        ],
        "isAdmin": is_admin,
    }
    if is_admin:
        response["credentialSummariesByToolId"] = _build_admin_credential_summaries_by_tool(db, tools)
    return response


@router.post("/tools")
async def create_tool(
    payload: ToolCreatePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    name = _validate_tool_name(payload.name)
    slug = _validate_tool_slug(payload.slug, fallback_name=name)
    existing = db.query(ITPortalTool).filter(ITPortalTool.slug == slug).first()
    if existing:
        raise HTTPException(status_code=409, detail="Tool slug already exists")

    website_url = _validate_url(payload.website_url, "website_url")
    login_url = _validate_url(payload.login_url, "login_url")
    launch_mode = _validate_launch_mode(payload.launch_mode)
    _validate_extension_autofill_target(launch_mode, website_url, login_url, slug)

    tool = ITPortalTool(
        name=name,
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
        tool.name = _validate_tool_name(payload.name)
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
    current_user: User = Depends(get_current_user),
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
        raise HTTPException(status_code=403, detail="You are not assigned to this tool.")

    canonical_tool_slug = _canonical_tool_slug(tool.slug or "")
    login_method = _normalize_credential_login_method(canonical_tool_slug, credential.login_method)
    login_identifier = decrypt_secret(credential.login_identifier_encrypted)
    password = decrypt_secret(credential.password_encrypted)
    if not login_identifier or (
        not password and not _credential_password_is_optional(canonical_tool_slug, login_method)
    ):
        missing_detail = (
            "Assigned credential is missing the email address required for this tool"
            if _credential_password_is_optional(canonical_tool_slug, login_method)
            else "Assigned credential is missing username or password"
        )
        raise HTTPException(status_code=400, detail=missing_detail)

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
            "loginMethod": login_method,
            "loginIdentifier": login_identifier,
            "password": password or None,
            "backupCodes": _decode_backup_codes(credential),
        },
    }


@router.post("/extension/otp")
async def get_extension_otp(
    payload: OtpRequestPayload,
    current_user: User = Depends(get_current_user),
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


@router.post("/extension/auth-link")
async def get_extension_auth_link(
    payload: OtpRequestPayload,
    current_user: User = Depends(get_current_user),
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

    _cleanup_auth_link_tickets()
    if extension_ticket in _auth_link_consumed_tickets:
        raise HTTPException(
            status_code=409,
            detail="Auth link already fetched for this launch session. Launch the tool again from the dashboard.",
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

    attempts = max(1, AUTH_LINK_MAX_WAIT_SEC // OTP_POLL_INTERVAL_SEC)
    auth_link = None
    last_fetch_error = None
    for attempt_index in range(attempts):
        try:
            auth_link = await asyncio.to_thread(
                fetch_auth_link_from_gmail,
                mailbox.email_address,
                app_password,
                mailbox.auth_link_pattern,
                mailbox.auth_link_host,
                mailbox.otp_sender_filter,
                mailbox.otp_subject_pattern,
                AUTH_LINK_EMAIL_MAX_AGE_SEC,
            )
            last_fetch_error = None
        except imaplib.IMAP4.error as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Mailbox login failed for {mailbox.email_address}. Update the Gmail app password or enable IMAP. ({exc})",
            ) from exc
        except Exception as exc:
            last_fetch_error = exc
            auth_link = None

        if auth_link:
            break

        if attempt_index < attempts - 1:
            await asyncio.sleep(OTP_POLL_INTERVAL_SEC)

    if not auth_link:
        if last_fetch_error is not None:
            raise HTTPException(
                status_code=502,
                detail=f"Mailbox fetch failed: {last_fetch_error}",
            )
        raise HTTPException(
            status_code=408,
            detail="Auth link email did not arrive within the timeout window. Check the mailbox filters and try again.",
        )

    _auth_link_consumed_tickets[extension_ticket] = time.monotonic()
    _add_audit(
        db,
        actor_id=current_user.id,
        action="extension_auth_link_fetched",
        tool_id=tool.id,
        details={
            "hostname": _normalize_hostname(payload.hostname or payload.page_url),
            "mailbox": mailbox.email_address,
        },
    )
    db.commit()

    return {"success": True, "authLink": auth_link}


@router.post("/extension/totp")
async def get_extension_totp(
    payload: OtpRequestPayload,
    current_user: User = Depends(get_current_user),
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

    credential = _resolve_tool_credential(db, tool.id, current_user.id)
    if not credential:
        raise HTTPException(status_code=403, detail="You are not assigned to this tool.")

    totp_tool = tool
    totp_credential = credential
    encrypted_totp_secret = credential.totp_secret_encrypted
    if not encrypted_totp_secret:
        fallback_tool, fallback_credential = _resolve_chatgpt_totp_fallback(
            db,
            tool=tool,
            credential=credential,
            user_id=current_user.id,
        )
        if fallback_tool and fallback_credential:
            totp_tool = fallback_tool
            totp_credential = fallback_credential
            encrypted_totp_secret = fallback_credential.totp_secret_encrypted

    if not encrypted_totp_secret:
        raise HTTPException(
            status_code=404,
            detail=f"No TOTP secret configured for tool '{tool.name}'. Ask an admin to add it in the dashboard.",
        )

    raw_totp_secret = decrypt_secret(encrypted_totp_secret)
    if not raw_totp_secret:
        raise HTTPException(status_code=500, detail="TOTP secret could not be decrypted")

    try:
        totp_config = parse_totp_config(raw_totp_secret)
        otp, expires_in_sec = generate_totp_code(totp_config)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Stored TOTP configuration is invalid: {exc}") from exc

    _add_audit(
        db,
        actor_id=current_user.id,
        action="extension_totp_generated",
        tool_id=tool.id,
        credential_id=totp_credential.id,
        target_user_id=totp_credential.user_id,
        details={
            "hostname": _normalize_hostname(payload.hostname or payload.page_url),
            "credentialScope": totp_credential.scope,
            "expiresInSec": expires_in_sec,
            "totpSourceToolSlug": totp_tool.slug,
            "totpSourceToolName": totp_tool.name,
        },
    )
    db.commit()

    return {"success": True, "otp": otp, "expiresInSec": expires_in_sec}


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
    serialized_credentials = [_serialize_credential_summary(item) for item in credentials]

    canonical_tool_slug = _canonical_tool_slug(tool.slug or "")
    if _tool_supports_shared_company_credential_assignments(canonical_tool_slug):
        company_credential_ids = {
            credential.id
            for credential in credentials
            if credential.scope == "company"
        }
        latest_user_records = _latest_user_credential_records_for_tool(db, tool_id)
        assigned_user_ids = sorted({
            user_id
            for user_id, row in latest_user_records.items()
            if row.is_active and row.linked_credential_id in company_credential_ids
        })
        users_by_id = {}
        if assigned_user_ids:
            users_by_id = {
                user.id: user
                for user in db.query(User).filter(User.id.in_(assigned_user_ids)).all()
            }

        assignments_by_credential_id: dict[int, list[dict]] = {}
        for user_id, row in latest_user_records.items():
            linked_credential_id = row.linked_credential_id
            if not row.is_active or linked_credential_id not in company_credential_ids:
                continue
            user = users_by_id.get(user_id)
            if not user:
                continue
            assignments_by_credential_id.setdefault(linked_credential_id, []).append(
                {
                    "id": user.id,
                    "name": user.name,
                    "email": user.email,
                }
            )

        for item in serialized_credentials:
            assigned_users = assignments_by_credential_id.get(item["id"], [])
            item["assignedUsers"] = sorted(
                assigned_users,
                key=lambda user: f"{user.get('name') or ''} {user.get('email') or ''}".strip().lower(),
            )
            item["assignedUserIds"] = [user["id"] for user in item["assignedUsers"]]

    return {"success": True, "credentials": serialized_credentials}


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
    canonical_tool_slug = _canonical_tool_slug(tool.slug or "")
    scope = _validate_scope(payload)
    login_method = _normalize_credential_login_method(canonical_tool_slug, payload.login_method)

    if scope == "user":
        user = db.query(User).filter(User.id == payload.user_id, User.is_deleted == False).first()
        if not user:
            raise HTTPException(status_code=404, detail="Target user not found")
    elif payload.linked_credential_id:
        raise HTTPException(status_code=400, detail="Only user credentials can link to a saved company credential")

    if payload.assigned_user_ids is not None and (
        scope != "company"
        or not _tool_supports_shared_company_credential_assignments(canonical_tool_slug)
    ):
        raise HTTPException(status_code=400, detail="User assignment lists are only supported for shared company credentials")

    linked_credential = None
    if payload.linked_credential_id:
        linked_credential = (
            db.query(ITPortalToolCredential)
            .filter(
                ITPortalToolCredential.id == payload.linked_credential_id,
                ITPortalToolCredential.tool_id == tool_id,
                ITPortalToolCredential.scope == "company",
                ITPortalToolCredential.is_active == True,
            )
            .first()
        )
        if not linked_credential:
            raise HTTPException(status_code=404, detail="Linked shared credential not found")

    creating_new_shared_company_credential = (
        scope == "company"
        and _tool_supports_shared_company_credential_assignments(canonical_tool_slug)
        and not payload.credential_id
        and payload.create_new
    )
    if creating_new_shared_company_credential:
        has_login_identifier = bool((payload.login_identifier or "").strip())
        has_password = bool((payload.password or "").strip())
        if not has_login_identifier or (
            not has_password and not _credential_password_is_optional(canonical_tool_slug, login_method)
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "New shared Claude credentials require the sign-in email address."
                    if canonical_tool_slug == "claude"
                    else "New shared Google-login credentials require the Google email address."
                    if canonical_tool_slug in {"freepik", "kling", "kling-ai", "klingai"} and login_method == "google"
                    else "New shared company credentials require both username/email and password"
                ),
            )

    credential = None
    if payload.credential_id:
        credential = (
            db.query(ITPortalToolCredential)
            .filter(
                ITPortalToolCredential.id == payload.credential_id,
                ITPortalToolCredential.tool_id == tool_id,
            )
            .first()
        )
        if not credential:
            raise HTTPException(status_code=404, detail="Credential not found")
        if credential.scope != scope:
            raise HTTPException(status_code=400, detail="Credential scope does not match this update")
        if scope == "user" and credential.user_id != payload.user_id:
            raise HTTPException(status_code=400, detail="Credential user does not match this update")
    elif not (scope == "company" and _tool_supports_shared_company_credential_assignments(canonical_tool_slug) and payload.create_new):
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

    effective_linked_credential = linked_credential
    if scope == "user" and not effective_linked_credential and _payload_has_credential_content(payload):
        source_credential = _resolve_linked_company_credential(
            db,
            credential,
            canonical_tool_slug=canonical_tool_slug,
        ) or credential
        effective_linked_credential = _ensure_reusable_company_credential(
            db,
            tool_id=tool_id,
            canonical_tool_slug=canonical_tool_slug,
            payload=payload,
            actor_id=current_user.id,
            target_user_id=payload.user_id,
            source_credential=source_credential,
        )

    if scope == "user" and effective_linked_credential:
        credential.login_method = _normalize_credential_login_method(
            canonical_tool_slug,
            effective_linked_credential.login_method,
        )
        credential.login_identifier_encrypted = None
        credential.password_encrypted = None
        credential.backup_codes_encrypted = None
        credential.totp_secret_encrypted = None
        credential.api_key_encrypted = None
        credential.notes = None
    else:
        credential.login_method = login_method
        if payload.login_identifier is not None:
            normalized_login_identifier = (payload.login_identifier or "").strip()
            credential.login_identifier_encrypted = (
                encrypt_secret(normalized_login_identifier)
                if normalized_login_identifier
                else None
            )
        if payload.password is not None:
            credential.password_encrypted = (
                encrypt_secret(payload.password)
                if payload.password
                else None
            )
        if payload.backup_codes is not None:
            backup_codes = _normalize_backup_codes(payload.backup_codes)
            credential.backup_codes_encrypted = (
                encrypt_secret(json.dumps(backup_codes))
                if backup_codes
                else None
            )
        if payload.totp_secret is not None:
            normalized_totp_secret = _normalize_totp_secret(payload.totp_secret)
            credential.totp_secret_encrypted = (
                encrypt_secret(normalized_totp_secret)
                if normalized_totp_secret
                else None
            )
        if payload.api_key is not None:
            normalized_api_key = (payload.api_key or "").strip()
            credential.api_key_encrypted = (
                encrypt_secret(normalized_api_key)
                if normalized_api_key
                else None
            )
        if payload.notes is not None:
            credential.notes = payload.notes.strip() or None
    if scope == "user":
        credential.linked_credential_id = effective_linked_credential.id if effective_linked_credential else None
    else:
        credential.linked_credential_id = None
    credential.is_active = payload.is_active
    credential.updated_by = current_user.id
    credential.updated_at = datetime.utcnow()

    db.flush()
    if scope == "company" and _tool_supports_shared_company_credential_assignments(canonical_tool_slug) and payload.assigned_user_ids is not None:
        _apply_shared_credential_assignments(
            db,
            tool_id=tool_id,
            credential=credential,
            assigned_user_ids=payload.assigned_user_ids,
            actor_id=current_user.id,
        )
    _add_audit(
        db,
        actor_id=current_user.id,
        action="credential_created" if created else "credential_updated",
        tool_id=tool_id,
        credential_id=credential.id,
        target_user_id=credential.user_id,
        details={
            "scope": scope,
            "linkedCredentialId": credential.linked_credential_id,
            "assignedUserCount": len(payload.assigned_user_ids or []),
        },
    )
    db.commit()
    db.refresh(credential)
    return {"success": True, "credential": _serialize_credential_summary(credential)}


@router.delete("/tools/{tool_id}/credentials/{credential_id}")
async def delete_credential(
    tool_id: int,
    credential_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    credential = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.id == credential_id,
            ITPortalToolCredential.tool_id == tool_id,
        )
        .first()
    )
    if not credential:
        raise HTTPException(status_code=404, detail="Credential not found")

    if not credential.is_active:
        return {"success": True}

    now = datetime.utcnow()
    deactivated_link_count = 0

    if credential.scope == "company":
        linked_user_rows = (
            db.query(ITPortalToolCredential)
            .filter(
                ITPortalToolCredential.tool_id == tool_id,
                ITPortalToolCredential.scope == "user",
                ITPortalToolCredential.linked_credential_id == credential.id,
                ITPortalToolCredential.is_active == True,
            )
            .all()
        )
        for row in linked_user_rows:
            row.is_active = False
            row.updated_by = current_user.id
            row.updated_at = now
        deactivated_link_count = len(linked_user_rows)

    credential.is_active = False
    credential.updated_by = current_user.id
    credential.updated_at = now

    _add_audit(
        db,
        actor_id=current_user.id,
        action="credential_deleted",
        tool_id=tool_id,
        credential_id=credential.id,
        target_user_id=credential.user_id,
        details={
            "scope": credential.scope,
            "deactivatedLinkedUserCount": deactivated_link_count,
        },
    )
    db.commit()
    return {"success": True}


@router.post("/tools/{tool_id}/launch")
async def launch_tool(
    tool_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id, ITPortalTool.is_active == True).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    credential = _resolve_tool_credential(db, tool.id, current_user.id)
    if not credential:
        raise HTTPException(status_code=403, detail="You are not assigned to this tool.")

    revealed = None
    canonical_tool_slug = _canonical_tool_slug(tool.slug or "")
    revealed_login_method = _normalize_credential_login_method(canonical_tool_slug, credential.login_method)
    revealed = {
        "scope": credential.scope,
        "loginMethod": revealed_login_method,
        "loginIdentifier": decrypt_secret(credential.login_identifier_encrypted),
        "password": None if tool.launch_mode in {"automation", "extension_autofill"} else decrypt_secret(credential.password_encrypted),
        "backupCodes": _decode_backup_codes(credential),
        "apiKey": decrypt_secret(credential.api_key_encrypted),
        "notes": credential.notes,
    }

    launch_url = tool.login_url or tool.website_url
    extension_ticket = None
    extension_ticket_expires_at = None
    if tool.launch_mode == "automation":
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
        extension_ticket_expires_at = int(time.time()) + EXTENSION_AUTOFILL_TICKET_TTL_SEC
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
        raise HTTPException(status_code=403, detail="You are not assigned to this tool.")

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
