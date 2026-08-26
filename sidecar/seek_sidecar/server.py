# Seek — localhost WebSocket bridge.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Runs an asyncio WebSocket server on its own thread and marshals frames to and
# from the pynicotine main thread.
#
# SECURITY. This socket can enqueue downloads and rewrite settings, so it is not
# a debug endpoint:
#
#   * Bound to a loopback address only. Never 0.0.0.0. Enforced, not documented
#     — `_assert_loopback` rejects anything else at construction.
#   * Requires a token the Tauri shell generates at spawn and passes to both
#     sides. Any browser page on the machine can open a ws:// connection to
#     localhost; the token is what stops a random tab from queueing downloads.
#   * The token is compared with hmac.compare_digest, not ==, so it cannot be
#     recovered a byte at a time by timing the handshake.
#   * The Origin header is rejected unless it exactly matches one passed to
#     `--allow-origin`. NOTE: every client sends one — this was originally
#     written believing a packaged desktop webview sent none, and that is
#     false. WKWebView reports `tauri://localhost` for a bundled Tauri app, and
#     the Vite dev server's origin under `tauri dev`. The Tauri shell therefore
#     passes `--allow-origin` itself; without it the sidecar 403s its own
#     frontend forever and the app looks permanently offline.
#
#     The check still earns its place: it pins connections to the one origin the
#     app actually runs from, so a random page the user has open cannot drive
#     the socket even if the token leaked. There is deliberately no wildcard —
#     the token is the real gate, but an unbounded origin list discards the
#     second lock for nothing.
#   * Frames are size-capped before parsing so a malformed client cannot make
#     the sidecar allocate without bound.
#
# The token may be supplied as a `?token=` query parameter (which is how a
# WebSocket client can authenticate before the connection is established) or an
# `Authorization: Bearer` header. Query strings can end up in logs, so the
# header is preferred and the sidecar never logs the request target.

import asyncio
import hmac
import ipaddress
import json
import logging
import queue
import secrets
import threading
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed

from . import protocol

log = logging.getLogger("seek.server")

MAX_FRAME_BYTES = 4 * 1024 * 1024
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def generate_token():
    """A fresh 256-bit token. The Tauri shell should generate one per launch."""
    return secrets.token_urlsafe(32)


def _assert_loopback(host):
    if host in LOOPBACK_HOSTS:
        return host
    try:
        address = ipaddress.ip_address(host)
    except ValueError as error:
        raise ValueError(
            f"refusing to bind to non-loopback host {host!r}"
        ) from error
    if not address.is_loopback:
        raise ValueError(
            f"refusing to bind to non-loopback address {host!r} — the Seek "
            f"sidecar accepts commands that download files and change settings, "
            f"and must never be reachable off-machine"
        )
    return host


class Bridge:
    """The WebSocket side of the sidecar.

    Owns an asyncio loop on a dedicated thread. `submit()` is called from the
    socket thread and pushes onto a queue the pynicotine main thread drains;
    `broadcast()` is called from the main thread and hops onto the asyncio loop
    with call_soon_threadsafe. Nothing else crosses the boundary.
    """

    def __init__(self, token, host="127.0.0.1", port=0, on_command=None,
                 allowed_origins=()):
        self.host = _assert_loopback(host)
        self.port = port
        self._token = token
        self._on_command = on_command
        self._allowed_origins = frozenset(o for o in allowed_origins if o and o != "*")

        self.inbox = queue.SimpleQueue()   # main thread drains this
        self._clients = set()
        self._loop = None
        self._server = None
        self._thread = None
        self._ready = threading.Event()
        self._shutdown = None              # asyncio.Event, created on the loop
        self.bound_port = None

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self._thread = threading.Thread(
            target=self._run, name="SeekBridge", daemon=True
        )
        self._thread.start()
        if not self._ready.wait(timeout=10):
            raise RuntimeError("bridge failed to start within 10s")
        return self.bound_port

    def _run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        finally:
            self._loop.close()

    async def _serve(self):
        self._shutdown = asyncio.Event()
        async with websockets.serve(
            self._handle,
            self.host,
            self.port,
            process_request=self._authenticate,
            max_size=MAX_FRAME_BYTES,
            ping_interval=20,
            ping_timeout=20,
        ) as server:
            self._server = server
            self.bound_port = server.sockets[0].getsockname()[1]
            log.info("listening on ws://%s:%s", self.host, self.bound_port)
            self._ready.set()
            # Wait on an Event rather than loop.stop(). Stopping the loop
            # directly aborts `async with websockets.serve(...)` mid-flight, so
            # the server's own close path then runs against a closed loop and
            # raises. Signalling lets the context manager unwind normally.
            await self._shutdown.wait()

    def stop(self):
        loop, shutdown = self._loop, self._shutdown
        if loop is None or shutdown is None:
            return
        loop.call_soon_threadsafe(shutdown.set)
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._loop = None

    # -- auth --------------------------------------------------------------

    def _authenticate(self, connection, request):
        """Runs during the HTTP upgrade, before the WebSocket exists.

        Returning a response object rejects the connection; returning None
        accepts it.
        """
        headers = request.headers

        # A packaged Tauri client sends no Origin. Any browser page does, and
        # cannot suppress it — so a named origin is the only way to run the UI
        # from the dev server. Exact match only, never a prefix or a wildcard.
        origin = headers.get("Origin")
        if origin is not None and origin not in self._allowed_origins:
            log.warning("rejected connection carrying an Origin header")
            return connection.respond(403, "forbidden\n")

        presented = None
        auth = headers.get("Authorization")
        if auth and auth.startswith("Bearer "):
            presented = auth[7:].strip()
        else:
            query = parse_qs(urlparse(request.path).query)
            values = query.get("token")
            if values:
                presented = values[0]

        if presented is None:
            log.warning("rejected unauthenticated connection")
            return connection.respond(401, "unauthorized\n")

        if not hmac.compare_digest(presented, self._token):
            log.warning("rejected connection with an invalid token")
            return connection.respond(403, "forbidden\n")

        return None

    # -- frames ------------------------------------------------------------

    async def _handle(self, websocket):
        self._clients.add(websocket)
        log.info("client connected (%d total)", len(self._clients))
        try:
            async for raw in websocket:
                self._receive(websocket, raw)
        except ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            log.info("client disconnected (%d left)", len(self._clients))

    def _receive(self, websocket, raw):
        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            self._reply_error(websocket, None, "bad_request", "malformed JSON")
            return

        if not isinstance(message, dict):
            self._reply_error(websocket, None, "bad_request", "frame must be an object")
            return

        request_id = message.get("id")
        command = message.get("cmd")
        params = message.get("params") or {}

        if not isinstance(request_id, str) or not request_id:
            self._reply_error(websocket, None, "bad_request", "missing request id")
            return
        if command not in protocol.COMMANDS:
            self._reply_error(websocket, request_id, "unknown_command",
                              f"unknown command {command!r}")
            return

        try:
            protocol.validate_command(command, params)
        except protocol.SchemaError as error:
            self._reply_error(websocket, request_id, "bad_request", str(error))
            return

        # Hand off to the pynicotine main thread. Calling into core from here
        # would emit events off-thread and corrupt callback iteration.
        self.inbox.put((websocket, request_id, command, params))

    def _send(self, websocket, payload):
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

        async def _do():
            try:
                await websocket.send(raw)
            except ConnectionClosed:
                pass

        loop = self._loop
        if loop is not None:
            asyncio.run_coroutine_threadsafe(_do(), loop)

    def _reply_error(self, websocket, request_id, code, message):
        self._send(websocket, {
            "id": request_id or "",
            "ok": False,
            "error": {"code": code, "message": message},
        })

    # -- called from the pynicotine main thread ----------------------------

    def reply(self, websocket, request_id, result=None):
        self._send(websocket, {"id": request_id, "ok": True, "result": result or {}})

    def reply_error(self, websocket, request_id, code, message):
        self._reply_error(websocket, request_id, code, message)

    def broadcast(self, event_name, data):
        """Send an event to every connected client.

        The payload is validated first. A schema violation is logged and
        DROPPED rather than raised: this runs inside a pynicotine event
        callback, and letting an exception escape would make upstream call
        core.quit() and re-raise (events.py:275), taking the whole core down
        over one bad field.
        """
        try:
            protocol.validate_event(event_name, data)
        except protocol.SchemaError as error:
            log.error("refusing to emit invalid %s: %s", event_name, error)
            return

        if not self._clients:
            return

        raw = json.dumps({"ev": event_name, "data": data},
                         ensure_ascii=False, separators=(",", ":"))

        async def _do():
            for websocket in list(self._clients):
                try:
                    await websocket.send(raw)
                except ConnectionClosed:
                    self._clients.discard(websocket)

        loop = self._loop
        if loop is not None:
            asyncio.run_coroutine_threadsafe(_do(), loop)

    def drain(self, limit=256):
        """Pop pending commands. Called by the main loop."""
        out = []
        for _ in range(limit):
            try:
                out.append(self.inbox.get_nowait())
            except queue.Empty:
                break
        return out
