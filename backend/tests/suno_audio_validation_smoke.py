"""Smoke test for providers/suno/router.py's _looks_like_audio guard.

Why this exists (2026-09-07): a stored Suno mirror object
(suno-mirror/107/...-asset.m4a) would not play in the dashboard. It fetched
fine - HTTP 200, 2.99 MB, content-type audio/mp4 - but contained no
ftyp/moov/mdat/moof box, no Ogg/FLAC/RIFF magic and no MP3 frame sync: not a
decodable file in any container. It had been fetched from the
audiopipe.suno.ai LIVE-STREAMING endpoint instead of the finished CDN asset.

The base64 transport was ruled out first (sunoArrayBufferToBase64 round-trips
byte-exact, including at that file's precise length), so the bytes were
already wrong when they arrived. The damage was made permanent by
capture_audio marking the row asset_mirror_status="mirrored" anyway - and
that endpoint short-circuits on already_mirrored, so the clip could never
re-mirror itself even once a good URL existed.

_looks_like_audio is the backstop that must hold whatever extension version
is installed: a rejected payload leaves the row "pending" and retryable,
which is strictly better than a permanent unplayable "success".

Run: python backend/tests/suno_audio_validation_smoke.py
"""

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

_ROUTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "providers", "suno", "router.py")


def _load_guard():
    """Extracts the guard without importing the router (which would pull in
    the DB session, R2 config and the whole FastAPI app for a pure function)."""
    with open(_ROUTER, encoding="utf-8") as handle:
        source = handle.read()
    match = re.search(r"def _looks_like_audio.*?\n    return False\n", source, re.S)
    assert match, "could not find _looks_like_audio in providers/suno/router.py"
    namespace: dict = {}
    exec(match.group(0), namespace)  # noqa: S102 - reading our own source, not user input
    return namespace["_looks_like_audio"]


# A real audiopipe capture is high-entropy bytes with no container header.
# Reproduced here as deterministic pseudo-random data rather than shipping a
# 3 MB fixture - what matters is "no recognizable magic anywhere near the
# start", which is exactly what the original file looked like.
def _streamed_garbage(size: int = 4096) -> bytes:
    state = 0x9985_6E08
    out = bytearray()
    for _ in range(size):
        state = (1103515245 * state + 12345) & 0xFFFFFFFF
        out.append((state >> 16) & 0xFF)
    # Guarantee the first bytes cannot accidentally look like a frame sync.
    out[0:8] = bytes.fromhex("99856e08d8cdefce")
    return bytes(out)


CASES = [
    ("audiopipe stream capture (the real bug)", _streamed_garbage(), False),
    ("mp3 with ID3v2.4 tag", b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 32, True),
    ("raw mp3 frame sync", b"\xff\xfb\x90\x00" + b"\x00" * 32, True),
    ("m4a / mp4 (ftyp at offset 4)", b"\x00\x00\x00 ftypM4A " + b"\x00" * 32, True),
    ("fragmented mp4 (styp)", b"\x00\x00\x00 stypmsdh" + b"\x00" * 32, True),
    ("ogg", b"OggS" + b"\x00" * 32, True),
    ("flac", b"fLaC" + b"\x00" * 32, True),
    ("wav", b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 32, True),
    ("adts aac", b"\xff\xf1\x50\x80" + b"\x00" * 32, True),
    ("html error page", b"<!DOCTYPE html><html>nope</html>" + b" " * 32, False),
    ("json error body", b'{"detail":"forbidden"}' + b" " * 32, False),
    ("truncated / empty", b"\x00\x00\x00\x00", False),
]


def main() -> int:
    looks_like_audio = _load_guard()
    failures = 0
    for name, data, expected in CASES:
        actual = looks_like_audio(data)
        ok = actual is expected
        if not ok:
            failures += 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name:42} accepted={actual} (expected {expected})")
    print()
    if failures:
        print(f"{failures} case(s) FAILED")
        return 1
    print("ok  _looks_like_audio accepts every real audio container and rejects stream/error payloads")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
