import base64
import hashlib
import hmac
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, urlparse


_VALID_BASE32_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
_SUPPORTED_ALGORITHMS = {
    "SHA1": hashlib.sha1,
    "SHA256": hashlib.sha256,
    "SHA512": hashlib.sha512,
}


@dataclass(frozen=True)
class TOTPConfig:
    secret: str
    digits: int = 6
    period: int = 30
    algorithm: str = "SHA1"


def _normalize_base32_secret(value: str) -> str:
    normalized = "".join(ch for ch in f"{value or ''}".strip().upper() if ch not in {" ", "-"})
    normalized = normalized.rstrip("=")
    if not normalized:
        raise ValueError("TOTP secret is required.")
    if any(ch not in _VALID_BASE32_CHARS for ch in normalized):
        raise ValueError("TOTP secret must be a valid base32 string.")
    return normalized


def _decode_base32_secret(value: str) -> bytes:
    normalized = _normalize_base32_secret(value)
    padded = normalized + ("=" * (-len(normalized) % 8))
    try:
        return base64.b32decode(padded, casefold=True)
    except Exception as exc:  # pragma: no cover - defensive
        raise ValueError("TOTP secret must be a valid base32 string.") from exc


def parse_totp_config(value: Optional[str]) -> TOTPConfig:
    raw_value = f"{value or ''}".strip()
    if not raw_value:
        raise ValueError("TOTP secret is required.")

    if raw_value.lower().startswith("otpauth://"):
        parsed = urlparse(raw_value)
        if parsed.scheme.lower() != "otpauth" or parsed.netloc.lower() != "totp":
            raise ValueError("Only otpauth://totp URIs are supported.")

        params = parse_qs(parsed.query or "", keep_blank_values=False)
        secret = _normalize_base32_secret((params.get("secret") or [""])[0])
        digits = int((params.get("digits") or ["6"])[0] or "6")
        period = int((params.get("period") or ["30"])[0] or "30")
        algorithm = ((params.get("algorithm") or ["SHA1"])[0] or "SHA1").upper()
    else:
        secret = _normalize_base32_secret(raw_value)
        digits = 6
        period = 30
        algorithm = "SHA1"

    if digits not in {6, 8}:
        raise ValueError("TOTP digits must be 6 or 8.")
    if period <= 0 or period > 300:
        raise ValueError("TOTP period must be between 1 and 300 seconds.")
    if algorithm not in _SUPPORTED_ALGORITHMS:
        raise ValueError("Unsupported TOTP algorithm.")

    _decode_base32_secret(secret)
    return TOTPConfig(secret=secret, digits=digits, period=period, algorithm=algorithm)


def generate_totp_code(config: TOTPConfig, now: Optional[int] = None) -> tuple[str, int]:
    current_time = int(time.time() if now is None else now)
    time_counter = current_time // config.period
    counter_bytes = time_counter.to_bytes(8, byteorder="big", signed=False)
    secret_bytes = _decode_base32_secret(config.secret)
    digest = hmac.new(secret_bytes, counter_bytes, _SUPPORTED_ALGORITHMS[config.algorithm]).digest()
    offset = digest[-1] & 0x0F
    binary = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    token = str(binary % (10 ** config.digits)).zfill(config.digits)
    remaining_seconds = config.period - (current_time % config.period)
    if remaining_seconds <= 0:
        remaining_seconds = config.period
    return token, remaining_seconds
