"""
Email delivery for scheduled reports — stdlib smtplib only (no new dependency).

Configuration comes from the admin UI (app_settings.smtp) and falls back to
SMTP_* env vars, so an env-configured deployment keeps working unchanged. The
password is stored encrypted with the same Fernet helper used for tool
credentials and is never returned by the API.

When unconfigured, callers record an 'email_skipped' audit entry rather than
pretending a message was sent.
"""

import os
import smtplib
from email.message import EmailMessage
from typing import Optional

SETTING_KEY = "smtp"


def _env_config() -> dict:
    return {
        "host": (os.environ.get("SMTP_HOST") or "").strip(),
        "port": int(os.environ.get("SMTP_PORT", "587") or 587),
        "username": (os.environ.get("SMTP_USERNAME") or "").strip(),
        "password": os.environ.get("SMTP_PASSWORD") or "",
        "fromAddress": (os.environ.get("SMTP_FROM") or "").strip(),
        "fromName": (os.environ.get("SMTP_FROM_NAME") or "").strip(),
        "useTls": os.environ.get("SMTP_STARTTLS", "1") not in ("0", "false", "False", ""),
        "source": "env",
    }


def load_config(db=None) -> dict:
    """Effective SMTP config: DB settings win, env vars are the fallback."""
    cfg = _env_config()
    if db is None:
        return cfg
    try:
        from models_new import AppSetting
        from utils.credential_crypto import decrypt_secret

        row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
        v = (row.value_json or {}) if row else {}
        if not v.get("host"):
            return cfg
        password = ""
        if v.get("passwordEnc"):
            try:
                password = decrypt_secret(v["passwordEnc"]) or ""
            except Exception:
                password = ""
        return {
            "host": (v.get("host") or "").strip(),
            "port": int(v.get("port") or 587),
            "username": (v.get("username") or "").strip(),
            "password": password,
            "fromAddress": (v.get("fromAddress") or "").strip(),
            "fromName": (v.get("fromName") or "").strip(),
            "useTls": bool(v.get("useTls", True)),
            "source": "settings",
        }
    except Exception:
        # A settings read must never break delivery — fall back to env.
        return cfg


def email_configured(db=None) -> bool:
    cfg = load_config(db)
    return bool(cfg.get("host") and cfg.get("fromAddress"))


def email_status(db=None) -> dict:
    """Safe-to-expose config summary. Never includes the password itself."""
    cfg = load_config(db)
    return {
        "configured": bool(cfg.get("host") and cfg.get("fromAddress")),
        "from": cfg.get("fromAddress") or None,
        "fromName": cfg.get("fromName") or None,
        "host": cfg.get("host") or None,
        "port": cfg.get("port"),
        "username": cfg.get("username") or None,
        "useTls": cfg.get("useTls"),
        "hasPassword": bool(cfg.get("password")),
        "source": cfg.get("source"),
    }


def _sender(cfg: dict) -> str:
    addr = cfg.get("fromAddress") or ""
    name = cfg.get("fromName") or ""
    return f"{name} <{addr}>" if name and addr else addr


def send_report_email(recipients, subject, html_body, attachments=None, db=None, config: Optional[dict] = None):
    """
    Send a report email with optional attachments [(filename, bytes, mimetype)].
    Returns (ok: bool, detail: str). Never raises to the caller.
    """
    cfg = config or load_config(db)
    if not (cfg.get("host") and cfg.get("fromAddress")):
        return False, "SMTP not configured"
    recipients = [r.strip() for r in (recipients or []) if r and r.strip()]
    if not recipients:
        return False, "No recipients"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _sender(cfg)
    msg["To"] = ", ".join(recipients)
    msg.set_content("This report requires an HTML-capable email client.")
    msg.add_alternative(html_body or "", subtype="html")

    for att in attachments or []:
        try:
            filename, data, mimetype = att
            maintype, _, subtype = (mimetype or "application/octet-stream").partition("/")
            msg.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=filename)
        except Exception:
            continue

    try:
        port = int(cfg.get("port") or 587)
        username = cfg.get("username")
        password = cfg.get("password") or ""
        if port == 465:  # implicit TLS
            with smtplib.SMTP_SSL(cfg["host"], port, timeout=30) as server:
                if username:
                    server.login(username, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(cfg["host"], port, timeout=30) as server:
                if cfg.get("useTls", True):
                    server.starttls()
                if username:
                    server.login(username, password)
                server.send_message(msg)
        return True, f"Sent to {len(recipients)} recipient(s)"
    except Exception as exc:  # noqa: BLE001 - report the reason, never crash a scheduled run
        return False, f"SMTP error: {exc}"
