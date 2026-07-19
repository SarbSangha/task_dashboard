"""
Email delivery for scheduled reports — stdlib smtplib only (no new dependency).

Activated only when SMTP_* env vars are set. When unconfigured, callers record an
'email_skipped' audit entry rather than pretending a message was sent.
"""

import os
import smtplib
from email.message import EmailMessage


def email_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM"))


def email_status() -> dict:
    return {
        "configured": email_configured(),
        "from": os.environ.get("SMTP_FROM") or None,
        "host": os.environ.get("SMTP_HOST") or None,
    }


def send_report_email(recipients, subject, html_body, attachments=None):
    """
    Send a report email with optional attachments [(filename, bytes, mimetype)].
    Returns (ok: bool, detail: str). Never raises to the caller.
    """
    if not email_configured():
        return False, "SMTP not configured"
    recipients = [r for r in (recipients or []) if r]
    if not recipients:
        return False, "No recipients"

    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    sender = os.environ.get("SMTP_FROM")
    use_tls = os.environ.get("SMTP_STARTTLS", "1") not in ("0", "false", "False", "")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
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
        with smtplib.SMTP(host, port, timeout=30) as server:
            if use_tls:
                server.starttls()
            if username and password:
                server.login(username, password)
            server.send_message(msg)
        return True, f"Sent to {len(recipients)} recipient(s)"
    except Exception as exc:  # noqa: BLE001 - report the reason, never crash a scheduled run
        return False, f"SMTP error: {exc}"
