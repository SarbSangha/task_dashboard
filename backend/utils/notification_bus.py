"""Fan realtime notifications out to every uvicorn worker on this host.

Production runs `uvicorn --workers N` (ecosystem.config.cjs). Each worker
process has its own NotificationHub, i.e. its own set of open WebSockets, so a
chat message handled by worker A could never reach a user whose socket lives
on worker B - the notification was silently lost and only showed up when the
panel's 90 s poll caught up.

Every worker binds a UDP socket on 127.0.0.1 and advertises its port as a small
file in a shared directory. Publishing sends the payload to every peer port;
peers deliver it to their own sockets only (no re-publish, no web push). The
directory name is derived from DATABASE_URL so two unrelated backends on one
machine (e.g. a dev server on :8001 against another database) never exchange
notifications for colliding user ids.

Datagrams on loopback are not lost under normal load; if a peer is gone its
port file goes stale (heartbeat-refreshed mtime) and is skipped, then pruned.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import socket
import tempfile
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

PEER_STALE_SECONDS = 90
PEER_PRUNE_SECONDS = 600
HEARTBEAT_SECONDS = 30
# Loopback UDP tops out just under 64 KiB; keep headroom for the envelope.
MAX_DATAGRAM_BYTES = 60_000

DeliverFn = Callable[[int, dict], Awaitable[None]]


def _bus_directory() -> Path:
    override = (os.getenv("NOTIFICATION_BUS_DIR") or "").strip()
    if override:
        return Path(override)
    scope = (os.getenv("DATABASE_URL") or "default").encode("utf-8")
    digest = hashlib.sha1(scope).hexdigest()[:12]
    return Path(tempfile.gettempdir()) / f"rmw-notify-{digest}"


def _encode(user_id: int, payload: dict) -> Optional[bytes]:
    data = json.dumps({"u": int(user_id), "p": payload}, default=str, separators=(",", ":")).encode("utf-8")
    if len(data) <= MAX_DATAGRAM_BYTES:
        return data
    # Clients re-fetch the thread on every chat event, so the bulky parts of an
    # oversized payload can be dropped without losing the notification itself.
    slim = dict(payload)
    slim.pop("attachments", None)
    metadata = dict(slim.get("metadata") or {})
    if isinstance(metadata.get("messageText"), str):
        metadata["messageText"] = metadata["messageText"][:1000]
    metadata.pop("replyTo", None)
    slim["metadata"] = metadata
    data = json.dumps({"u": int(user_id), "p": slim}, default=str, separators=(",", ":")).encode("utf-8")
    return data if len(data) <= MAX_DATAGRAM_BYTES else None


class _BusProtocol(asyncio.DatagramProtocol):
    def __init__(self, bus: "LocalNotificationBus"):
        self.bus = bus

    def datagram_received(self, data: bytes, addr) -> None:
        try:
            envelope = json.loads(data.decode("utf-8"))
            user_id = int(envelope["u"])
            payload = envelope["p"]
        except Exception:
            logger.warning("Ignoring malformed notification bus datagram from %s", addr)
            return
        self.bus.handle_incoming(user_id, payload)

    def error_received(self, exc: Exception) -> None:
        # Windows reports ICMP "port unreachable" from a dead peer here.
        logger.debug("Notification bus socket error: %s", exc)


class LocalNotificationBus:
    def __init__(self) -> None:
        self.directory = _bus_directory()
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._port: Optional[int] = None
        self._port_file: Optional[Path] = None
        self._deliver: Optional[DeliverFn] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._send_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._send_socket.setblocking(False)
        self.published = 0
        self.received = 0
        self.send_failures = 0

    @property
    def running(self) -> bool:
        return self._transport is not None

    async def start(self, deliver: DeliverFn) -> None:
        if self._transport is not None:
            return
        if (os.getenv("NOTIFICATION_BUS_ENABLED") or "1").strip().lower() in {"0", "false", "no", "off"}:
            logger.info("Notification bus disabled by NOTIFICATION_BUS_ENABLED")
            return
        self._deliver = deliver
        self._loop = asyncio.get_running_loop()
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            transport, _protocol = await self._loop.create_datagram_endpoint(
                lambda: _BusProtocol(self),
                local_addr=("127.0.0.1", 0),
            )
        except Exception:
            logger.exception("Notification bus failed to start; realtime stays per-worker")
            return
        self._transport = transport
        self._port = transport.get_extra_info("sockname")[1]
        self._port_file = self.directory / f"{os.getpid()}-{self._port}.port"
        self._write_port_file()
        self._heartbeat_task = self._loop.create_task(self._heartbeat(), name="notification-bus-heartbeat")
        logger.info("Notification bus listening on 127.0.0.1:%s (%s)", self._port, self.directory)

    async def stop(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            await asyncio.gather(self._heartbeat_task, return_exceptions=True)
            self._heartbeat_task = None
        if self._transport:
            self._transport.close()
            self._transport = None
        if self._port_file:
            try:
                self._port_file.unlink(missing_ok=True)
            except OSError:
                pass
            self._port_file = None

    def _write_port_file(self) -> None:
        if not self._port_file:
            return
        try:
            self._port_file.write_text(str(self._port), encoding="utf-8")
        except OSError:
            logger.warning("Notification bus could not write %s", self._port_file)

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            if self._port_file and self._port_file.exists():
                try:
                    os.utime(self._port_file, None)
                except OSError:
                    pass
            else:
                self._write_port_file()

    def _peer_ports(self) -> list[int]:
        now = time.time()
        ports = []
        try:
            entries = list(self.directory.glob("*.port"))
        except OSError:
            return ports
        for entry in entries:
            try:
                age = now - entry.stat().st_mtime
                if age > PEER_PRUNE_SECONDS:
                    entry.unlink(missing_ok=True)
                    continue
                if age > PEER_STALE_SECONDS:
                    continue
                port = int(entry.stem.rsplit("-", 1)[-1])
            except (OSError, ValueError):
                continue
            if port != self._port:
                ports.append(port)
        return ports

    def publish(self, user_id: int, payload: dict) -> int:
        """Send to every other worker. Safe to call from any thread."""
        if self._transport is None:
            return 0
        data = _encode(user_id, payload)
        if data is None:
            logger.warning("Notification for user_id=%s too large for the bus; peers skipped", user_id)
            return 0
        sent = 0
        for port in self._peer_ports():
            try:
                self._send_socket.sendto(data, ("127.0.0.1", port))
                sent += 1
            except OSError:
                self.send_failures += 1
        self.published += 1
        return sent

    def handle_incoming(self, user_id: int, payload: dict) -> None:
        self.received += 1
        if self._deliver and self._loop:
            self._loop.create_task(self._deliver(user_id, payload))

    def status(self) -> dict:
        return {
            "running": self.running,
            "port": self._port,
            "peers": len(self._peer_ports()) if self.running else 0,
            "published": self.published,
            "received": self.received,
            "sendFailures": self.send_failures,
        }


notification_bus = LocalNotificationBus()
