import base64
import hashlib
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


def _derive_fernet_key(raw_secret: str) -> bytes:
    digest = hashlib.sha256(raw_secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _get_cipher() -> Fernet:
    configured_key = (os.getenv("TOOL_CREDENTIAL_ENCRYPTION_KEY") or "").strip()
    if configured_key:
        try:
            return Fernet(configured_key.encode("utf-8"))
        except Exception as exc:
            raise RuntimeError("Invalid TOOL_CREDENTIAL_ENCRYPTION_KEY. Use a Fernet key.") from exc

    fallback_secret = (os.getenv("SECRET_KEY") or "").strip()
    if not fallback_secret:
        fallback_secret = "rmw-dev-tool-credential-key-change-me"
    return Fernet(_derive_fernet_key(fallback_secret))


def encrypt_secret(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip()
    if not normalized:
        return None
    return _get_cipher().encrypt(normalized.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return _get_cipher().decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Unable to decrypt stored credential. Check encryption key.") from exc
