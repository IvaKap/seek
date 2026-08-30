# Seek — the headless Nicotine+ host.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Boots pynicotine's core with no GUI, subscribes to its event bus, translates
# events onto the wire, and executes inbound commands on the main thread.
#
# This is a REPLACEMENT for pynicotine/headless/application.py, not a wrapper
# around it: that module answers "you have no credentials" by prompting on
# stdin, which would hang a GUI-launched sidecar forever (RECON.md §2). What we
# reuse is its pump — `while events.process_thread_events(): sleep(...)`.
#
# `upstream/` is not modified in any way. Everything here works through the
# public event bus and the public methods on `core.*`.

import json
import logging
import base64
import os
import platform
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import (
    discover as discover_mod, enrich, library as library_mod, logfile,
    nicotine_import, registries, translate,
)
from .protocol import PROTOCOL_VERSION

# pynicotine's own decoder for the profile description. Upstream stores that
# field as a Python repr(); `unescape` is the exact inverse and is what
# UserInfo uses when it sends the field to a peer.
from pynicotine import utils

log = logging.getLogger("seek.core")

SIDECAR_VERSION = "0.2.6"

# Upstream speed limits are in KiB/s; our wire is bytes/sec everywhere.
KIB = 1024

# Components deliberately left out (RECON.md §2):
#   update_checker  — calls out to pypi.org on start. The brief says no
#                     telemetry, and an unsolicited outbound request tied to
#                     startup is close enough to the line.
#   now_playing     — the only D-Bus/GTK surface in the core.
#   cli / signal_handler / error_handler — the sidecar owns its lifecycle.
#   portmapper      — UPnP/NAT-PMP; should be a user setting, not a default.
BASE_COMPONENTS = {
    "network_thread", "users", "notifications", "network_filter",
    "statistics", "search", "downloads", "uploads", "interests",
    "userbrowse", "userinfo", "buddies", "pluginhandler",
    # Chat is a shipped feature, so its components must be enabled. Without
    # these, `core.chatrooms` and `core.privatechat` are None and every chat
    # command raises the moment the user opens the screen — which only shows
    # up after a real sign-in, since nothing asks for a room list before then.
    "chatrooms", "privatechat",
}

# `shares` is OPT-IN, and that is a product decision as much as a technical one.
#
# Technically: Shares._start() unconditionally calls rescan_shares(init=True),
# which spawns a subprocess using multiprocessing's *spawn* method
# (shares.py:1240). Spawn re-imports __main__ in the child, so the entry point
# must be a real file with an `if __name__ == "__main__"` guard — ours is. Under
# a test runner __main__ is the runner, and the child re-runs the whole suite.
#
# Product-wise, and this matters more: enabling shares exposes the user's
# filesystem to the Soulseek network. Doing that implicitly, before Seek has a
# Settings UI where the user picks what to share, is not a default the sidecar
# gets to choose.
#
# There is a real cost to leaving it off. Soulseek is a reciprocal network and a
# client that shares nothing gets deprioritised or banned by many peers; upstream
# also initialises Shares *before* Users specifically so share stats reach the
# server before we watch our own username. This needs a deliberate product
# decision before Seek is used against the live network.
SHARES_COMPONENT = "shares"


def _label_defaults(row):
    """Fill fields added after this row was written.

    `seek-state.json` outlives the schema — a watchlist saved by 0.2.6 has no
    `imageUri`, `newCount` or `knownIds`, and the generated validator DROPS an
    event whose shape is wrong rather than repairing it. Without this the whole
    watchlist would silently stop arriving for anyone upgrading, which is the
    hardest kind of failure to diagnose because nothing errors.
    """
    row.setdefault("imageUri", None)
    row.setdefault("lastCheckedAt", None)
    row.setdefault("newCount", 0)
    row.setdefault("knownIds", [])
    return row


class CoreHost:
    """Owns the pynicotine core and the main-thread pump."""

    POLL_INTERVAL = 0.05  # 20 Hz. Upstream's headless loop uses 0.1; the brief
                          # budgets 100 ms from sidecar to screen, and a 100 ms
                          # pump alone would spend all of it.

    def __init__(self, bridge, config_folder, data_folder, upstream_path=None,
                 enable_shares=False, log_file=""):
        self.bridge = bridge
        self.config_folder = config_folder
        self.data_folder = data_folder
        self.enable_shares = enable_shares
        # Reported in the hello reply so Settings can tell someone where to find
        # it. Empty when running without one — a test host, or a machine where
        # the file could not be opened.
        self.log_file = log_file or ""
        self._running = False
        self._shutdown_done = False
        self._last_sweep = 0.0

        self.searches = registries.SearchRegistry()
        self.transfers = registries.TransferRegistry()

        self._connection = {
            "status": "offline",
            "username": None,
            "publicAddress": None,
            "error": None,
        }
        self._share_scanning = False
        self._share_ready = False
        self._share_last_scan = None
        self._share_restart_required = False
        self._folder_requests = {}   # (username, folderPath) -> request info
        self._peer_extra = {}        # username -> {"files", "folders", "country"}

        # Spectral analysis is CPU-bound (decode + FFT) and must never run on
        # the pynicotine main loop — blocking it stalls every transfer and every
        # search result in flight. One worker: analysis is a background
        # curiosity, not something worth contending for cores with playback or
        # the network thread.
        self._analysis_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="SeekSpectral"
        )

        # Discovery gets its own worker rather than sharing the one above.
        # Both are single-threaded on purpose, and the artwork queue is the
        # busy one: a search fills it with a request per release card. A URL
        # lookup is something the user is WATCHING a card for, and putting it
        # behind thirty covers would make the Dig Bar feel broken while being
        # perfectly correct.
        self._discover_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="SeekDiscover"
        )

        self._import_upstream(upstream_path)

    # -- boot --------------------------------------------------------------

    def _import_upstream(self, upstream_path):
        """Point config at Seek's own folders BEFORE anything can load it.

        This ordering is not cosmetic. `config.load_config()` runs inside
        `core.init_components()`, and the default path on macOS is
        ~/.config/nicotine — a real user's real Nicotine+ settings. Setting the
        paths late, or not at all, silently rewrites them (RECON.md §7).
        """
        if upstream_path is None:
            upstream_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.dirname(
                    os.path.abspath(__file__)))),
                "upstream",
            )
        if upstream_path not in sys.path:
            sys.path.insert(0, upstream_path)

        os.makedirs(self.config_folder, exist_ok=True)
        os.makedirs(self.data_folder, exist_ok=True)

        import pynicotine  # noqa: F401  — installs the gettext `_` builtin
        from pynicotine.config import config

        config.set_config_file(os.path.join(self.config_folder, "config"))
        config.set_data_folder(self.data_folder)

        from pynicotine.core import core
        from pynicotine.events import events
        from pynicotine.slskmessages import UserStatus
        from pynicotine.transfers import TransferStatus

        self.config = config
        self.core = core
        self.events = events
        self.UserStatus = UserStatus
        self.TransferStatus = TransferStatus

        log.info("upstream at %s", upstream_path)
        log.info("config  -> %s", config.config_file_path)
        log.info("data    -> %s", config.data_folder_path)

    def start(self):
        components = set(BASE_COMPONENTS)
        if self.enable_shares or self._stored_consent() == "granted":
            components.add(SHARES_COMPONENT)
        self.core.init_components(enabled_components=components)
        self._connect_events()
        self.core.start()
        self._running = True

        # Sign in on launch if credentials are stored and the user has not
        # opted out. This uses UPSTREAM's own `auto_connect_startup` flag rather
        # than a parallel Seek setting: the credentials already live in the
        # pynicotine config, and a second source of truth for "should I sign in"
        # is how the two end up disagreeing.
        #
        # `core.connect()` calls `setup()` and returns quietly when the config is
        # incomplete, so a first run with no account is a no-op rather than an
        # error — but check anyway, so the log says something useful.
        server = self.config.sections["server"]
        if server.get("auto_connect_startup", True):
            if server.get("login") and server.get("passw"):
                log.info("signing in as the stored account")
                self._connection.update({"status": "connecting", "error": None})
                self.core.connect()
            else:
                log.info("no stored credentials; staying signed out")

    def _connect_events(self):
        """Subscribe after init_components, never before.

        pynicotine.search.Search connects `file-search-response` in its own
        constructor and signals rejection by setting `msg.token = None`. A
        consumer registered first would see unfiltered results — including from
        users the user has explicitly ignored (RECON.md §2).
        """
        for name, callback in (
            ("server-login", self._on_server_login),
            ("server-disconnect", self._on_server_disconnect),
            ("set-connection-stats", self._on_connection_stats),
            ("set-wishlist-interval", self._on_wishlist_interval),
            ("file-search-response", self._on_search_response),
            ("search-failed", self._on_search_failed),
            ("remove-search", self._on_search_removed),
            ("user-stats", self._on_user_stats),
            ("user-status", self._on_user_status),
            ("shared-file-list-response", self._on_browse_response),
            ("shared-file-list-failed", self._on_browse_failed),
            ("folder-contents-response", self._on_folder_contents),
            ("folder-contents-failed", self._on_folder_contents_failed),
            ("update-download", self._on_update_download),
            ("abort-download", self._on_abort_download),
            ("clear-download", self._on_clear_download),
            ("clear-downloads", self._on_clear_downloads),
            # The upload half. Upstream emits the same four events with the
            # same signatures, except `clear-uploads`, which takes no
            # `clear_deleted` — there is no such thing for a file you own.
            ("update-upload", self._on_update_upload),
            ("abort-upload", self._on_abort_upload),
            ("clear-upload", self._on_clear_upload),
            ("clear-uploads", self._on_clear_uploads),
            ("folder-download-finished", self._on_folder_finished),
            ("say-chat-room", self._on_room_message),
            ("echo-room-message", self._on_room_echo),
            ("message-user", self._on_private_message),
            ("echo-private-message", self._on_private_echo),
            ("join-room", self._on_join_room),
            ("leave-room", self._on_leave_room),
            ("user-joined-room", self._on_room_user_change),
            ("user-left-room", self._on_room_user_change),
            ("room-list", self._on_room_list),
            ("shares-scanning", self._on_shares_scanning),
            ("shares-ready", self._on_shares_ready),
            ("update-stat", self._on_update_stat),
        ):
            self.events.connect(name, self._guard(name, callback))

    def _guard(self, name, callback):
        """Wrap a callback so it can never propagate.

        `events.emit` treats any exception from a non-plugin callback as fatal:
        it calls core.quit() and re-raises (events.py:275-284). One malformed
        payload in our translation layer would otherwise take down the whole
        core, mid-download.
        """
        def wrapped(*args, **kwargs):
            try:
                callback(*args, **kwargs)
            except Exception:
                log.exception("error handling upstream event %r", name)
        wrapped.__module__ = "seek_sidecar"
        return wrapped

    # -- main loop ---------------------------------------------------------

    def run_forever(self):
        try:
            while self._running:
                if not self.events.process_thread_events():
                    break
                self._pump_commands()
                self._pump_searches()
                self._pump_stalls()
                time.sleep(self.POLL_INTERVAL)
        finally:
            self.shutdown()

    def stop(self):
        """Ask the main loop to exit. Safe to call from a signal handler."""
        self._running = False

    def shutdown(self, timeout=5.0):
        """Shut the core down properly. Idempotent.

        Setting a flag is not enough. `events._run_scheduler` loops on
        `while self._is_active`, and that flag is only cleared by the `quit`
        event — which `core.quit()` reaches via `schedule-quit`. The scheduler
        runs on a NON-daemon thread (events.py:386), so skipping this leaves the
        interpreter hanging at exit waiting for a thread that will never return.
        """
        if self._shutdown_done:
            return
        self._shutdown_done = True

        try:
            self.core.quit()
            deadline = time.monotonic() + timeout
            # Pump until the event bus reports itself inactive and drained.
            while time.monotonic() < deadline:
                if not self.events.process_thread_events():
                    break
                time.sleep(0.02)
        except Exception:
            log.exception("error during core shutdown")

        self._analysis_pool.shutdown(wait=False)
        self._discover_pool.shutdown(wait=False)

        try:
            self.config.write_configuration()
        except Exception:
            log.exception("could not write configuration on shutdown")

    def _pump_commands(self):
        for websocket, request_id, command, params in self.bridge.drain():
            try:
                result = self.dispatch(command, params)
            except CommandError as error:
                self.bridge.reply_error(websocket, request_id, error.code, str(error))
                continue
            except Exception as error:
                log.exception("command %s failed", command)
                self.bridge.reply_error(websocket, request_id, "internal", str(error))
                continue
            self.bridge.reply(websocket, request_id, result)

    def _pump_searches(self):
        if self.searches.due():
            for payload in self.searches.flush():
                self.bridge.broadcast("search.result", payload)
        for token, reason in self.searches.expired():
            self._close_search(token, reason)

    def _pump_stalls(self):
        now = time.monotonic()
        if (now - self._last_sweep) < 1.0:
            return
        self._last_sweep = now
        for record in self.transfers.sweep():
            upstream = self._find_upstream_transfer(record)
            if upstream is not None:
                self.bridge.broadcast(
                    "transfer.updated",
                    translate.transfer(
                        record, upstream, self.transfers.since_progress(record)
                    ),
                )

    # -- upstream event handlers -------------------------------------------

    def _on_server_login(self, msg):
        if msg.success:
            self._connection.update({
                "status": "online",
                "username": msg.username,
                "publicAddress": msg.ip_address,
                "error": None,
            })
        else:
            self._connection.update({
                "status": "failed",
                "username": None,
                "error": msg.rejection_reason or "login rejected",
            })
        self.bridge.broadcast("connection.state", dict(self._connection))

    def _on_server_disconnect(self, _msg):
        self._connection.update({
            "status": "offline", "username": None, "publicAddress": None,
        })
        self.bridge.broadcast("connection.state", dict(self._connection))
        for payload in self.searches.close_all("disconnected"):
            self.bridge.broadcast("search.closed", payload)

    def _on_connection_stats(self, total_conns=0, download_bandwidth=0,
                             upload_bandwidth=0):
        # Defaults are load-bearing: upstream emits this with no arguments at
        # all as a reset (RECON.md §3).
        self._socket_count = int(total_conns or 0)
        self.bridge.broadcast("connection.stats", translate.connection_stats(
            total_conns, download_bandwidth, upload_bandwidth
        ))
        # The only regular tick there is, so it is where the connections view
        # gets its liveness. `_publish_connections` emits only on a change.
        self._publish_connections()

    def _country_from_search(self, msg):
        """Two-letter country code for the peer that sent a search response.

        This costs NOTHING on the network, which is the whole reason flags are
        affordable at all. A search response arrives over a DIRECT peer
        connection, so slskproto stamps the peer's real address onto the
        message (`msg.addr`, set at slskproto.py:716) before any of this runs,
        and `get_country_code` is a bisect over a bundled CSV.

        The obvious alternative is not affordable. Upstream only resolves and
        caches a country for WATCHED users, and the only way to get an address
        for one of those is `request_ip_address()` — a round trip to the
        Soulseek server, per user. A single search returns thousands of peers,
        and asking the server about every one of them is exactly the kind of
        traffic that gets a client throttled.

        Cached per username because one peer sends many responses, and because
        `user.stats` reads the same store when the server answers about someone
        we watch.
        """
        extra = self._peer_extra.setdefault(msg.username, {})
        if "country" in extra:
            return extra["country"]

        code = ""
        try:
            address = getattr(msg, "addr", None)
            if address:
                code = self.core.network_filter.get_country_code(address[0]) or ""
        except Exception:
            # An unparseable address, or country data that failed to load. A
            # missing flag is fine; a crashed search handler is not.
            code = ""
        if not code:
            # Whatever the server has already told us about this user, if we
            # happen to be watching them.
            code = (self.core.users.countries or {}).get(msg.username) or ""

        extra["country"] = code
        return code

    # -- your own profile ---------------------------------------------------
    #
    # Seek has only ever read OTHER people's user info. What a peer actually
    # receives is `UserInfo._get_user_info_response`, so this reports the whole
    # of that rather than just the two editable fields — the useful question is
    # "what does a stranger see", not "what did I type".

    #: A profile picture crosses the socket as a data: URI, so it is base64 and
    #: it sits in a JSON frame. Real Soulseek profile pictures are small; a
    #: multi-megabyte one is a mistake worth reporting rather than transferring.
    PICTURE_CAP = 2 * 1024 * 1024

    def _profile_picture(self, path):
        """(dataUri, error, byteCount) for the configured picture."""
        if not path:
            return None, "", 0
        resolved = self._resolve_path(path)
        if not os.path.isfile(resolved):
            return None, "That file is not there any more.", 0
        try:
            size = os.path.getsize(resolved)
            if size > self.PICTURE_CAP:
                return None, (
                    f"That picture is {size // (1024 * 1024)} MB. Soulseek "
                    "profile pictures are meant to be small; pick something "
                    "under 2 MB."
                ), size
            with open(resolved, "rb") as handle:
                data = handle.read()
        except OSError as error:
            return None, f"That file could not be read: {error.strerror or error}", 0

        mime = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        uri = "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))
        return uri, "", len(data)

    def _profile(self):
        info = self.config.sections["userinfo"]
        path = str(info.get("pic") or "")
        uri, error, size = self._profile_picture(path)

        shares = self._share_state()
        uploads = self.core.uploads

        return {
            "username": str(
                self.core.users.login_username
                or self.config.sections["server"].get("login") or ""
            ),
            # DECODED. Upstream stores a Python repr() and unescapes on send;
            # the escaped form must never leave the sidecar.
            "description": utils.unescape(str(info.get("descr") or "")),
            "picturePath": path,
            "pictureUri": uri,
            "pictureError": error,
            "pictureBytes": size,
            "pictureVisible": bool(info.get("picture_visible", True)),
            # Null before a scan, which is NOT "sharing nothing".
            "sharedFiles": shares["fileCount"],
            "sharedFolders": shares["folderCount"],
            "uploadSlots": int(uploads.get_total_uploads_allowed()) if uploads else 0,
            "freeSlots": bool(uploads.is_new_upload_accepted()) if uploads else False,
            # `get_upload_queue_size(username)` answers PER REQUESTING PEER —
            # a privileged user is told a different number — and a profile has
            # no one requester to answer for. `queued_transfers` is the figure
            # that method returns for everyone else, which is what an ordinary
            # peer sees.
            "queueSize": len(getattr(uploads, "queued_transfers", ()) or ()) if uploads else 0,
        }

    def _cmd_profile_get(self, _params):
        return self._profile()

    def _cmd_profile_set(self, params):
        info = self.config.sections["userinfo"]

        if params.get("description") is not None:
            # repr(), because that is exactly what `unescape` reverses — see
            # gtkgui/dialogs/preferences.py:1287, which is the only other thing
            # that writes this field. Storing the raw string instead corrupts
            # anything containing a backslash: `C:\new` comes back as `C:` and
            # a newline, and a description wrapped in quotes silently loses
            # them. Measured both ways before this was written.
            info["descr"] = repr(str(params["description"]))

        if params.get("picturePath") is not None:
            path = str(params["picturePath"]).strip()
            if path:
                resolved = self._resolve_path(path)
                if not os.path.isfile(resolved):
                    raise CommandError("not_found", f"no such file: {resolved}")
                info["pic"] = resolved
            else:
                # The empty string is how the UI says "remove it".
                info["pic"] = ""

        if params.get("pictureVisible") is not None:
            info["picture_visible"] = bool(params["pictureVisible"])

        self.config.write_configuration()
        return self._profile()

    # -- who we are talking to ----------------------------------------------
    #
    # NOT a socket table. `slskproto._conns` lives in the network thread and is
    # private to it, and `upstream/` is not modified — so a real socket list is
    # not available through the public API at all. What IS public, on both
    # `core.downloads` and `core.uploads`, is `active_users` and `queued_users`:
    # who has a transfer running or waiting, in either direction. That is the
    # useful half, and the upload side of it is invisible everywhere else in
    # Seek today.

    def _connection_snapshot(self):
        peers = {}

        def note(component, active_key, queued_key):
            if component is None:
                return
            for username, transfers in (component.active_users or {}).items():
                peers.setdefault(username, self._blank_peer(username))[active_key] += len(transfers)
            for username, transfers in (component.queued_users or {}).items():
                peers.setdefault(username, self._blank_peer(username))[queued_key] += len(transfers)

        note(self.core.downloads, "downloading", "downloadQueued")
        note(self.core.uploads, "uploading", "uploadQueued")

        return {
            # Last figure the network thread reported. Usually far larger than
            # the peer list, because most sockets carry the distributed search
            # network rather than a transfer.
            "socketCount": int(getattr(self, "_socket_count", 0)),
            "peers": sorted(peers.values(), key=lambda p: p["username"].lower()),
        }

    def _blank_peer(self, username):
        return {
            "username": username,
            "country": (self._peer_extra.get(username) or {}).get("country") or None,
            "downloading": 0,
            "downloadQueued": 0,
            "uploading": 0,
            "uploadQueued": 0,
        }

    def _cmd_connections_get(self, _params):
        return self._connection_snapshot()

    def _publish_connections(self):
        """Emit only when the picture actually changed.

        Called from the once-a-second connection-stats tick, which is the only
        regular thing that runs — but the peer list is usually identical from
        one second to the next, and a snapshot nobody asked for is not worth a
        frame.
        """
        snapshot = self._connection_snapshot()
        signature = (snapshot["socketCount"], tuple(
            (p["username"], p["downloading"], p["downloadQueued"],
             p["uploading"], p["uploadQueued"])
            for p in snapshot["peers"]
        ))
        if signature == getattr(self, "_connections_signature", None):
            return
        self._connections_signature = signature
        self.bridge.broadcast("connections.changed", snapshot)

    # -- transfer statistics ------------------------------------------------
    #
    # Upstream's `statistics` component has been enabled since the beginning
    # and never surfaced. It keeps two sets of the same six counters: a session
    # set that resets on start, and a total set persisted in the pynicotine
    # config. The upload half is the interesting one — Seek has no upload view
    # at all, so those bytes have been moving unseen.

    #: Upstream emits `update-stat` once per fragment per transfer, which is
    #: several a second with a few downloads running. A statistics screen has
    #: no use for that resolution, and neither does a websocket.
    STATS_MIN_INTERVAL = 1.0

    def _on_update_stat(self, *_args, **_kwargs):
        now = time.monotonic()
        last = getattr(self, "_stats_sent_at", 0.0)
        if now - last < self.STATS_MIN_INTERVAL:
            return
        self._stats_sent_at = now
        self.bridge.broadcast("stats.changed", self._transfer_stats())

    def _transfer_stats(self):
        """Both counter sets, raw. No ratio, no percentages — those are
        arithmetic for display, and arithmetic for display is TypeScript's."""
        stored = self.config.sections.get("statistics") or {}
        session = getattr(self.core.statistics, "session_stats", None) or {}

        def counts(source):
            return {
                "startedDownloads": int(source.get("started_downloads") or 0),
                "completedDownloads": int(source.get("completed_downloads") or 0),
                "downloadedSize": int(source.get("downloaded_size") or 0),
                "startedUploads": int(source.get("started_uploads") or 0),
                "completedUploads": int(source.get("completed_uploads") or 0),
                "uploadedSize": int(source.get("uploaded_size") or 0),
            }

        return {
            # Upstream only sets this on a genuinely first run, so it can be 0
            # on a config that predates the field. Forwarded as 0 rather than
            # invented, and the frontend then declines to word a span.
            "sinceTimestamp": int(stored.get("since_timestamp") or 0),
            "session": counts(session),
            "total": counts(stored),
        }

    def _cmd_stats_get(self, _params):
        return self._transfer_stats()

    def _on_search_response(self, msg):
        if msg.token is None or msg.list is None:
            return  # rejected upstream: unknown token, or an ignored user/IP
        self._country_from_search(msg)
        extra = self._peer_extra.get(msg.username, {})
        peer = translate.peer_stats_from_search(msg, **extra)

        overflow = self.searches.accept(
            msg.token, peer, translate.file_refs_from_search(msg.list), private=False
        )
        if msg.privatelist:
            overflow = self.searches.accept(
                msg.token, peer,
                translate.file_refs_from_search(msg.privatelist), private=True,
            ) or overflow

        if overflow:
            self._close_search(msg.token, overflow)

    def _on_search_failed(self, token, is_offline=False):
        self.bridge.broadcast("search.failed", {
            "searchId": token,
            "reason": "offline" if is_offline else "failed",
        })

    def _on_search_removed(self, token):
        self._close_search(token, "stopped")

    def _on_user_stats(self, msg):
        username = msg.user
        if not username:
            return
        extra = self._peer_extra.setdefault(username, {})
        extra["files"] = msg.files
        extra["folders"] = msg.dirs
        self.bridge.broadcast("user.stats", translate.peer_stats(
            username,
            free_slots=False,
            upload_speed=msg.avgspeed,
            queue_length=0,
            files=msg.files,
            folders=msg.dirs,
            country=extra.get("country"),
        ))

    def _on_user_status(self, msg):
        # users.py:355 sets msg.user = None for stale self-status updates.
        if not msg.user:
            return
        self.bridge.broadcast("user.status", {
            "username": msg.user,
            "status": translate.user_status(msg.status),
            "privileged": msg.privileged,
        })

    def _on_browse_response(self, msg):
        folders = translate.folder_refs_from_browse(msg.list, msg.privatelist)
        file_count = sum(len(folder["files"]) for folder in folders)
        total_size = sum(f["size"] for folder in folders for f in folder["files"])
        self.bridge.broadcast("user.browse.result", {
            "username": msg.username,
            "folders": folders,
            "fileCount": file_count,
            "totalSize": total_size,
        })

    def _on_browse_failed(self, username, is_offline=False):
        self.bridge.broadcast("user.browse.failed", {
            "username": username,
            "reason": "offline" if is_offline else "failed",
        })

    def _on_folder_contents(self, msg):
        if msg.dir is None or msg.list is None:
            return
        key = (msg.username, msg.dir)
        request = self._folder_requests.pop(key, None)
        folders = translate.folder_refs_from_contents(msg.list)

        enqueued = 0
        if request is not None:
            enqueued = self._enqueue_folder_files(
                msg.username, msg.dir, folders,
                request["destination"], request["recurse"],
            )

        self.bridge.broadcast("folder.contents", {
            "requestId": request["requestId"] if request else "",
            "username": msg.username,
            "folderPath": msg.dir,
            "folders": folders,
            "enqueued": enqueued,
        })

    def _on_folder_contents_failed(self, username, folder_path, is_offline=False):
        request = self._folder_requests.pop((username, folder_path), None)
        self.bridge.broadcast("folder.contents.failed", {
            "requestId": request["requestId"] if request else None,
            "username": username,
            "folderPath": folder_path,
            "reason": "offline" if is_offline else "failed",
        })

    def _on_update_download(self, upstream_transfer, _update_parent=True):
        self._emit_transfer(upstream_transfer, "download")

    def _on_abort_download(self, upstream_transfer, _status=None, _update_parent=True):
        self._emit_transfer(upstream_transfer, "download")

    def _on_clear_download(self, upstream_transfer, _update_parent=True):
        self._forget_transfer("download", upstream_transfer)

    def _on_clear_downloads(self, downloads, _statuses=None, _clear_deleted=False):
        self._forget_transfers("download", downloads)

    # -- uploads ------------------------------------------------------------
    #
    # Seek serves peers from the moment sharing is on, and until now none of it
    # was visible: no commands, no events, no state. The engine has been
    # sending files and counting the bytes (see `stats.get`) with nothing on
    # screen. These four events are upstream's own, and they mirror the
    # download set exactly — same names, same signatures, one argument fewer on
    # `clear-uploads`, because `clear_deleted` has no meaning for a file that is
    # yours and still there.

    def _on_update_upload(self, upstream_transfer, _update_parent=True):
        self._emit_transfer(upstream_transfer, "upload")

    def _on_abort_upload(self, upstream_transfer, _status=None, _update_parent=True):
        self._emit_transfer(upstream_transfer, "upload")

    def _on_clear_upload(self, upstream_transfer, _update_parent=True):
        self._forget_transfer("upload", upstream_transfer)

    def _on_clear_uploads(self, uploads, _statuses=None):
        self._forget_transfers("upload", uploads)

    def _forget_transfer(self, direction, upstream_transfer):
        self._forget_transfers(direction, [upstream_transfer])

    def _forget_transfers(self, direction, items):
        ids = []
        for item in items or ():
            record = self.transfers.forget(registries.transfer_key(
                direction, item.username, item.virtual_path
            ))
            if record is not None:
                ids.append(record.id)
        if not ids:
            return
        # Drop the remembered outcomes with them. The transfer is gone; if the
        # same file is queued from the same peer again it is a new attempt and
        # deserves to be judged on its own.
        counted = dict(self._load_state().get("transfer_outcomes") or {})
        if any(counted.pop(i, None) is not None for i in ids):
            self._save_state(transfer_outcomes=counted)
        self.bridge.broadcast("transfer.removed", {"transferIds": ids})

    def _on_folder_finished(self, folder_path):
        self.bridge.broadcast("folder.finished", {"localFolder": folder_path})

    def _on_shares_scanning(self, *_args, **_kwargs):
        self._share_scanning = True
        self.bridge.broadcast("shares.state", self._share_state())

    def _on_shares_ready(self, *_args, **_kwargs):
        self._share_scanning = False
        self._share_ready = True
        self._share_last_scan = time.time()
        self.bridge.broadcast("shares.state", self._share_state())

    # -- shares ------------------------------------------------------------

    # Seek's own state, kept OUT of pynicotine's config file.
    #
    # The obvious approach — a [seek] section in the pynicotine config — does not
    # work: upstream writes unknown sections to disk happily but discards them on
    # reload, because load_config() only repopulates sections it has defaults
    # for. Verified: write [seek] share_consent=declined, reload, section is
    # empty. Consent would silently reset to "unset" on every restart and
    # re-prompt someone who had already said no, which is precisely how you
    # train a user to click through dialogs without reading them.
    #
    # A separate file also keeps Seek state out of a config the user may still
    # be sharing with a real Nicotine+ install.

    def _state_path(self):
        return os.path.join(self.data_folder, "seek-state.json")

    def _load_state(self):
        try:
            with open(self._state_path(), encoding="utf-8") as handle:
                data = json.load(handle)
                return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_state(self, **updates):
        state = self._load_state()
        state.update(updates)
        try:
            os.makedirs(self.data_folder, exist_ok=True)
            with open(self._state_path(), "w", encoding="utf-8") as handle:
                json.dump(state, handle, indent=2)
        except OSError:
            log.exception("could not persist Seek state")
        return state

    def _stored_consent(self):
        """Read the persisted sharing decision.

        'declined' is a real, durable answer, not the absence of one.
        """
        value = self._load_state().get("share_consent")
        return value if value in ("unset", "granted", "declined") else "unset"

    def _share_folders(self):
        folders = []
        for entry in self.config.sections["transfers"].get("shared") or ():
            if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                virtual_name, path = str(entry[0]), str(entry[1])
            else:
                continue
            folders.append({
                "virtualName": virtual_name,
                "path": path,
                "exists": os.path.isdir(path),
            })
        return folders

    def _share_state(self):
        stats = {"fileCount": None, "folderCount": None, "totalSize": None}
        shares = self.core.shares
        if shares is not None and self._share_ready:
            try:
                stats["fileCount"] = int(len(shares.share_dbs.get("public_files", ())))
                # `public_streams`, one stream per folder — there is NO
                # `public_folders` key, and asking for one returned the empty
                # default every time, so this reported 0 folders beside 6,474
                # files for as long as it has existed. Nothing displayed it
                # until the profile screen did. Upstream counts the same way
                # when it tells the SERVER how much you share (shares.py:1102),
                # so this now matches what peers are told.
                stats["folderCount"] = int(len(shares.share_dbs.get("public_streams", ())))
            except Exception:
                pass
        return {
            "consent": self._stored_consent(),
            "folders": self._share_folders(),
            "scanning": bool(self._share_scanning),
            "ready": bool(self._share_ready),
            "lastScanAt": self._share_last_scan,
            "restartRequired": bool(self._share_restart_required),
            **stats,
        }

    def _resolve_local_file(self, params):
        """An absolute path from either `path` or a finished `transferId`.

        Shared by spectral analysis and metadata: both need the bytes on disk,
        and both must refuse a transfer that has not finished rather than
        analysing a partial file.
        """
        path = params.get("path")
        transfer_id = params.get("transferId")

        if not path:
            if not transfer_id:
                raise CommandError("bad_request", "one of path or transferId is required")
            record = self.transfers.get(transfer_id)
            if record is None:
                raise CommandError("not_found", f"unknown transfer {transfer_id}")
            upstream = self._find_upstream_transfer(record)
            if upstream is None:
                raise CommandError("not_found", "transfer is no longer known to the core")
            if translate.transfer_state(upstream.status) != "finished":
                raise CommandError(
                    "bad_request",
                    "this needs the downloaded bytes; the transfer has not finished",
                )
            path = self.core.downloads.get_current_download_file_path(upstream)

        if not path or not os.path.isfile(path):
            raise CommandError("not_found", f"no such file: {path}")
        return path

    def _cmd_organise_file(self, params):
        """Move a completed file into Artist/Year - Album/.

        Three hard rules, because this moves a user's files:
          * never leave the download folder — a bad match must not scatter
            music across the disk;
          * never overwrite — a colliding name is a reason to stop, not to
            silently replace something that took an hour to fetch;
          * never move without a confident match — an unknown release stays
            exactly where it is.
        """
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")

        path = self._resolve_local_file(params)
        root = self._download_root()
        if not root or not os.path.isdir(root):
            raise CommandError("bad_request", "no download folder is configured")

        # Refuse to act on anything outside the download folder. `realpath`
        # first: a symlink out of the tree would otherwise pass a prefix test.
        real_root = os.path.realpath(root)
        real_path = os.path.realpath(path)
        if os.path.commonpath([real_root, real_path]) != real_root:
            raise CommandError("bad_request", "that file is not in the download folder")

        current = enrich.read_tags(path)
        folder = os.path.basename(os.path.dirname(path))
        artist = current.get("albumartist") or current.get("artist") or ""
        release = current.get("album") or folder

        summary = None
        cache = self._art_cache()
        ckey = enrich.cache_key(artist, release)
        summary = cache.get_meta(ckey)
        if summary is None:
            match = enrich.mb_search_release(artist, release)
            if match:
                summary = enrich.release_summary(enrich.mb_release_detail(match["id"]))
                summary["score"] = int(match.get("score", 0))
                cache.put_meta(ckey, summary)

        if not summary:
            return {
                "moved": False, "fromPath": path, "toPath": "",
                "reason": "no confident MusicBrainz match, so nothing was moved",
            }

        target = enrich.organised_path(real_root, summary, os.path.basename(path))
        if os.path.realpath(target) == real_path:
            return {
                "moved": False, "fromPath": path, "toPath": path,
                "reason": "already where it should be",
            }
        if os.path.exists(target):
            return {
                "moved": False, "fromPath": path, "toPath": target,
                "reason": "a file of that name is already there; nothing was overwritten",
            }

        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(path, target)
        except OSError as error:
            raise CommandError("internal", f"could not move: {error}") from error

        log.info("organised %s -> %s", os.path.basename(path), target)
        return {"moved": True, "fromPath": path, "toPath": target, "reason": ""}

    def _cmd_preview_get(self, params):
        """Decode an excerpt on the worker pool; the audio arrives as an event."""
        path = self._resolve_local_file(params)
        request_id = registries.transfer_id(path, "preview")
        self._analysis_pool.submit(
            self._run_preview, request_id, path,
            params.get("startSeconds"), params.get("seconds"),
        )
        return {"requestId": request_id}

    def _run_preview(self, request_id, path, start, seconds):
        try:
            wav, start_at, length, duration = spectral.excerpt_wav(
                path, start or 0, seconds or 20,
            )
        except Exception as error:                     # noqa: BLE001 - worker
            self.bridge.broadcast("preview.failed", {
                "requestId": request_id, "reason": str(error),
            })
            return
        self.bridge.broadcast("preview.result", {
            "requestId": request_id,
            "path": path,
            "dataUri": "data:audio/wav;base64,"
                       + base64.b64encode(wav).decode("ascii"),
            "startSeconds": int(start_at),
            "seconds": float(length),
            "durationSeconds": float(duration),
        })

    # -- preferences and peer history --------------------------------------

    DEFAULT_APP_SETTINGS = {
        "autoConnect": True,
        "preferLossless": False,
        "minBitrate": 0,
        "rejectTranscodes": False,
        "autoOrganise": False,
        "externalLookups": True,
        "artworkCacheMb": 500,
        "embedArtwork": True,
        "writeCoverFile": False,
        "autoDigSessions": True,
        # Both off by default. The first changes where a download APPEARS and
        # the second forgets records, and neither should start happening to
        # somebody who never asked for it.
        "stalledFailMinutes": 0,
        "clearCompletedDays": 0,
        "acoustidApiKey": False,
        "youtubeApiKey": False,
    }

    def _app_settings(self):
        stored = self._load_state().get("app_settings") or {}
        out = dict(self.DEFAULT_APP_SETTINGS)
        out.update({k: v for k, v in stored.items() if k in out})
        # Auto-connect is upstream's flag, read from where it actually lives.
        out["autoConnect"] = bool(
            self.config.sections["server"].get("auto_connect_startup", True)
        )
        out["hasCredentials"] = bool(self.config.sections["server"].get("passw"))
        out["username"] = self.config.sections["server"].get("login") or ""
        # The token itself never leaves the sidecar; only whether one exists.
        out["discogsToken"] = bool(stored.get("discogsToken"))
        out["acoustidApiKey"] = bool(stored.get("acoustidApiKey"))
        out["youtubeApiKey"] = bool(stored.get("youtubeApiKey"))
        return out

    def _cmd_app_diagnostics(self, _params):
        """Everything a bug report needs, in one paste.

        Gathered here rather than in the frontend because the webview cannot
        read the log, and because its user agent lies about macOS: it reports
        the version as 10_15_7 for ever, and says "Intel" on Apple silicon.
        `platform` knows the truth.
        """
        text, size = logfile.tail(self.log_file) if self.log_file else ("", 0)
        return {
            "os": f"macOS {platform.mac_ver()[0]}" if platform.mac_ver()[0]
                  else platform.platform(),
            "arch": platform.machine(),
            "python": platform.python_version(),
            "logPath": self.log_file,
            "logTail": text,
            "logBytes": size,
            # Empty means identify-by-sound is simply unavailable, which is a
            # different bug report from it being broken.
            "fpcalc": discover_mod.fpcalc_path() or "",
        }

    def _cmd_app_settings_get(self, _params):
        return self._app_settings()

    def _cmd_app_settings_patch(self, params):
        stored = dict(self._load_state().get("app_settings") or {})
        for key in ("externalLookups", "embedArtwork", "writeCoverFile",
                    "preferLossless", "rejectTranscodes", "autoOrganise",
                    "autoDigSessions"):
            if params.get(key) is not None:
                stored[key] = bool(params[key])
        if params.get("autoConnect") is not None:
            # Written to the pynicotine config, not Seek's state, because that is
            # where it is read from — and it keeps a real Nicotine+ install in
            # step if the user ever points one at the same folder.
            self.config.sections["server"]["auto_connect_startup"] = bool(
                params["autoConnect"]
            )
            self.config.write_configuration()
        if params.get("minBitrate") is not None:
            stored["minBitrate"] = max(0, int(params["minBitrate"]))
        # Clamped, not trusted. These come off number inputs, and a negative
        # threshold would mean "every download has already been quiet too long"
        # — i.e. the whole list into Failed on the next tick.
        for key in ("stalledFailMinutes", "clearCompletedDays"):
            if params.get(key) is not None:
                stored[key] = max(0, int(params[key]))
        if params.get("artworkCacheMb") is not None:
            stored["artworkCacheMb"] = max(50, int(params["artworkCacheMb"]))
        if params.get("acoustidApiKey") is not None:
            key = str(params["acoustidApiKey"]).strip()
            if key:
                stored["acoustidApiKey"] = key
            else:
                stored.pop("acoustidApiKey", None)
        if params.get("youtubeApiKey") is not None:
            key = str(params["youtubeApiKey"]).strip()
            if key:
                stored["youtubeApiKey"] = key
            else:
                stored.pop("youtubeApiKey", None)
        if params.get("discogsToken") is not None:
            token = str(params["discogsToken"]).strip()
            if token:
                stored["discogsToken"] = token
            else:
                stored.pop("discogsToken", None)

        self._save_state(app_settings=stored)
        # Apply the cap immediately rather than at next launch: a cache that
        # ignores its own setting until restart is a setting that does nothing.
        if getattr(self, "_artwork_cache", None) is not None:
            self._artwork_cache.cap = int(stored.get("artworkCacheMb", 500)) * 1024 * 1024

        state = self._app_settings()
        self.bridge.broadcast("app.settings", state)
        return state

    #: How many per-transfer outcomes to remember. Comfortably more than the
    #: transfers upstream keeps in its own list, which is what bounds re-counting.
    OUTCOME_CAP = 5000

    TERMINAL_OK = "finished"
    TERMINAL_BAD = {
        "user_logged_off", "connection_closed", "connection_timeout",
        "download_folder_error", "local_file_error",
    }

    def _record_outcome(self, record, state):
        """Count ONE outcome per transfer, not one per state transition.

        This used to fire on every transition into a terminal state, guarded
        only by "the state changed". That is not the same thing, because a
        transfer OSCILLATES: a queued download whose peer goes offline reads
        `user_logged_off`, returns to `queued` when they come back, and fails
        again on the next disconnect — for as long as it sits in the queue.

        Measured on a real config before this was fixed: four peers holding
        stuck queued transfers had accumulated 524, 522, 438 and 161 "failures"
        between them, against 381 downloads ever STARTED on the whole account.
        1,792 failures out of 381 attempts is impossible on its face, and the
        peer chip had been reporting "0 of 524 with you" — a claim about the
        user's own history that was simply untrue. Worse, it is a scoring
        input: `reliabilityFrom` sank those peers to the bottom of every
        source list on evidence that did not exist.

        So the outcome is remembered on the RECORD, and a transfer contributes
        once. A transfer already counted as failed that later finishes moves
        its count rather than adding to it — a retry that works is not a
        failure and a success, it is a success.
        """
        username = record.username
        if not username:
            return
        if state == self.TERMINAL_OK:
            field = "ok"
        elif state in self.TERMINAL_BAD:
            field = "failed"
        else:
            return

        # The memory of what a transfer already contributed is PERSISTED, not
        # held on the in-memory record. The record dies with the process, and
        # upstream reloads its transfer list on every start — so a download
        # stuck against an offline peer is restored as `queued`, fails once,
        # and was counted again on every single launch. Measured on a real
        # config: one peer's four stuck files added exactly +4 per restart,
        # for ever.
        #
        # "N of M transfers from this peer finished" has to mean transfers, not
        # attempts. Four files that never arrived are four failures, whether
        # you restart the app once or a hundred times.
        state = self._load_state()
        counted = dict(state.get("transfer_outcomes") or {})
        previous = counted.get(record.id)
        if previous == field:
            return
        # A finished transfer is done; nothing after it can un-finish it.
        if previous == "ok":
            return

        peers = dict(state.get("peers") or {})
        entry = dict(peers.get(username) or {"ok": 0, "failed": 0, "lastSeen": 0})
        entry[field] = int(entry.get(field, 0)) + 1
        if previous is not None:
            # failed -> ok. Take the failure back rather than counting both.
            entry[previous] = max(0, int(entry.get(previous, 0)) - 1)
        entry["lastSeen"] = int(time.time())
        peers[username] = entry

        counted[record.id] = field
        if len(counted) > self.OUTCOME_CAP:
            # Insertion-ordered, so this drops the oldest. Losing the memory of
            # an ancient transfer only risks counting it once more, and only if
            # it is still in upstream's list that long.
            counted = dict(list(counted.items())[-self.OUTCOME_CAP:])

        self._save_state(peers=peers, transfer_outcomes=counted)
        self.bridge.broadcast("peers.stats", self._peer_history())

    def _peer_history(self):
        peers = self._load_state().get("peers") or {}
        return {
            "items": [
                {
                    "username": name,
                    "ok": int(e.get("ok", 0)),
                    "failed": int(e.get("failed", 0)),
                    "lastSeen": int(e.get("lastSeen", 0)),
                }
                for name, e in peers.items()
            ],
        }

    def _cmd_peers_stats(self, _params):
        return self._peer_history()

    # -- library -----------------------------------------------------------
    #
    # Scanning is IO-bound and can take minutes over a network volume, so it
    # runs on the worker pool and reports progress. Doing it on the main thread
    # would freeze the protocol loop for the whole walk.

    def _library(self):
        if getattr(self, "_library_index", None) is None:
            self._library_index = library_mod.Library(
                os.path.join(self.data_folder, "library.json")
            )
        return self._library_index

    def _download_root(self):
        return self.config.sections["transfers"].get("downloaddir") or ""

    def _cmd_library_state(self, _params):
        return self._library().state()

    def _cmd_library_releases(self, _params):
        # `formats` is a dict in the index and a JSON string on the wire: the
        # schema has no map type, and inventing one for a field the sidecar
        # never reads would be a lot of protocol for no benefit.
        out = []
        for release in self._library().releases():
            item = dict(release)
            item["formats"] = json.dumps(item.get("formats") or {})
            item["year"] = int(item.get("year") or 0)
            item["genre"] = item.get("genre") or ""
            out.append(item)
        return {"items": out}

    def _cmd_library_owned(self, _params):
        return self._library().owned_keys()

    def _cmd_library_gaps(self, params):
        """Which tracks of an owned release are missing.

        One release at a time, deliberately. A whole-collection sweep would be
        one rate-limited MusicBrainz request per release — hours for a large
        library, and most of it wasted on records the user never asks about.
        """
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        artist = params.get("artist") or ""
        release = params.get("release") or ""
        key = params.get("key") or ""
        if not release:
            raise CommandError("bad_request", "nothing to look up")
        self._analysis_pool.submit(self._run_gaps, key, artist, release)
        return {"requestId": enrich.cache_key(artist, release)}

    def _run_gaps(self, key, artist, release):
        blank = {
            "key": key, "matched": False, "releaseTitle": release,
            "releaseArtist": artist, "score": 0, "tracks": [],
        }
        try:
            cache = self._art_cache()
            ckey = enrich.cache_key(artist, release)
            summary = cache.get_meta(ckey)
            if summary is None:
                match = enrich.mb_search_release(artist, release)
                if match:
                    summary = enrich.release_summary(
                        enrich.mb_release_detail(match["id"])
                    )
                    summary["score"] = int(match.get("score", 0))
                    cache.put_meta(ckey, summary)
            if summary:
                index = self._library()
                blank.update({
                    "matched": True,
                    "releaseTitle": summary.get("title") or release,
                    "releaseArtist": summary.get("artist") or artist,
                    "score": int(summary.get("score") or 0),
                    "tracks": [
                        {
                            "position": t.get("position") or 0,
                            "title": t.get("title") or "",
                            "artist": t.get("artist") or "",
                            "have": index.has_track(
                                t.get("artist") or summary.get("artist") or "",
                                t.get("title") or "",
                            ),
                        }
                        for t in (summary.get("tracks") or [])
                    ],
                })
        except Exception as error:                     # noqa: BLE001 - worker
            log.debug("gap lookup failed for %s - %s: %s", artist, release, error)
        self.bridge.broadcast("library.gaps", blank)

    def _cmd_library_scan(self, params):
        index = self._library()
        if index.state()["scanning"]:
            return index.state()
        # The download folder is always included; extras are added to it, never
        # instead of it, so a scan cannot silently forget where things land.
        roots = [self._download_root()] + list(params.get("roots") or [])
        read_tags = params.get("readTags")
        self._analysis_pool.submit(
            self._run_library_scan, roots, True if read_tags is None else bool(read_tags),
        )
        state = index.state()
        state["scanning"] = True
        return state

    def _run_library_scan(self, roots, read_tags):
        index = self._library()

        def progress(seen):
            state = index.state()
            state["scanning"] = True
            state["trackCount"] = seen
            self.bridge.broadcast("library.state", state)

        try:
            state = index.scan(roots, progress=progress, read_tags=read_tags)
        except Exception as error:                     # noqa: BLE001 - worker
            log.exception("library scan failed: %s", error)
            state = index.state()
        self.bridge.broadcast("library.state", state)

    # -- artwork and metadata ----------------------------------------------
    #
    # Both go through the SAME MusicBrainz release match, and both run on the
    # worker pool. A command handler executes on pynicotine's main thread, so
    # doing a rate-limited network call here would freeze the protocol loop —
    # the reply is immediate and the answer arrives as an event.
    #
    # External lookups are opt-out. `externalLookups=False` means no request
    # leaves the machine, and the command fails honestly rather than quietly
    # returning nothing.
    #
    # This must read the setting through `_app_settings()`, which is where the
    # patch handler writes it. It previously read a top-level `external_lookups`
    # key that nothing has ever written, so the gate was permanently open and the
    # Settings toggle did nothing at all — the failure mode of a privacy switch
    # you cannot see: everything works, so nothing looks wrong.

    def _lookups_allowed(self):
        return bool(self._app_settings().get("externalLookups", True))

    def _art_cache(self):
        if getattr(self, "_artwork_cache", None) is None:
            self._artwork_cache = enrich.ArtCache(
                os.path.join(self.data_folder, "artwork"),
                cap_bytes=int(self._app_settings().get("artworkCacheMb", 500))
                * 1024 * 1024,
            )
        return self._artwork_cache

    def _cmd_artwork_stats(self, _params):
        return self._art_cache().stats()

    def _cmd_artwork_clear(self, _params):
        cache = self._art_cache()
        cache.clear()
        return cache.stats()

    def _cmd_artwork_get(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        artist = params.get("artist") or ""
        release = params.get("release") or ""
        key = params.get("key") or ""
        if not release and not artist:
            raise CommandError("bad_request", "nothing to look up")
        request_id = enrich.cache_key(artist, release)
        self._analysis_pool.submit(self._run_artwork, request_id, key, artist, release)
        return {"requestId": request_id}

    def _run_artwork(self, request_id, key, artist, release):
        try:
            data, mime, source, summary = enrich.lookup_release(
                artist, release, self._art_cache(),
            )
        except Exception as error:                     # noqa: BLE001 - worker
            self.bridge.broadcast("artwork.failed", {
                "key": key, "requestId": request_id, "reason": str(error),
            })
            return
        uri = "data:%s;base64,%s" % (
            mime or "image/jpeg", base64.b64encode(data).decode("ascii"),
        )
        summary = summary or {}
        self.bridge.broadcast("artwork.result", {
            "key": key, "requestId": request_id, "dataUri": uri, "source": source,
            # Completeness rides along free: the same MusicBrainz match that
            # produced the cover already knows how many tracks the release has.
            "trackCount": int(summary.get("trackCount") or 0),
            "date": summary.get("date") or "",
            "label": summary.get("label") or "",
            "mbid": summary.get("mbid") or "",
        })

    def _cmd_metadata_inspect(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        path = self._resolve_local_file(params)
        request_id = registries.transfer_id(path, "meta")
        self._analysis_pool.submit(
            self._run_metadata, request_id, path, params.get("transferId"),
        )
        return {"requestId": request_id}

    def _run_metadata(self, request_id, path, transfer_id):
        blank = {
            "requestId": request_id, "path": path, "transferId": transfer_id,
            "matched": False, "score": 0, "query": "", "trackMatched": False,
            "releaseTitle": "", "releaseArtist": "", "date": "", "label": "",
            "mbid": "", "changes": [],
        }
        try:
            current = enrich.read_tags(path)
            # The folder is the release, the same assumption the whole app makes.
            folder = os.path.basename(os.path.dirname(path))
            artist = current.get("albumartist") or current.get("artist") or ""
            release = current.get("album") or folder
            blank["query"] = " ".join(
                x for x in (enrich.normalise(artist), enrich.normalise(release)) if x
            )
            match = enrich.mb_search_release(artist, release)
            if not match:
                self.bridge.broadcast("metadata.proposal", blank)
                return
            summary = enrich.release_summary(enrich.mb_release_detail(match["id"]))
            _proposed, changes, track_matched = enrich.propose_tags(path, summary, current)
            blank.update({
                "matched": True,
                "score": int(match.get("score", 0)),
                "trackMatched": track_matched,
                "releaseTitle": summary["title"],
                "releaseArtist": summary["artist"],
                "date": summary["date"],
                "label": summary["label"],
                "mbid": summary["mbid"],
                "changes": [
                    {"field": f, "current": str(current.get(f, "")), "proposed": str(v)}
                    for f, v in changes.items()
                ],
            })
        except Exception as error:                     # noqa: BLE001 - worker
            log.debug("metadata lookup failed for %s: %s", path, error)
        self.bridge.broadcast("metadata.proposal", blank)

    def _cmd_metadata_apply(self, params):
        path = params.get("path") or ""
        if not os.path.isfile(path):
            raise CommandError("not_found", f"no such file: {path}")
        fields = {
            f["field"]: f["proposed"]
            for f in (params.get("fields") or []) if f.get("field")
        }
        art = None
        if params.get("embedArtwork"):
            if not self._lookups_allowed():
                raise CommandError("unsupported", "external lookups are switched off")
            try:
                data, mime, _src = enrich.fetch_artwork(
                    params.get("artist") or "", params.get("release") or "",
                    self._art_cache(),
                )
                art = (data, mime)
            except Exception as error:                 # noqa: BLE001
                raise CommandError("not_found", f"no artwork: {error}") from error
        try:
            enrich.write_tags(path, fields, art)
        except Exception as error:                     # noqa: BLE001
            raise CommandError("internal", str(error)) from error
        return {
            "path": path, "written": len(fields), "artworkEmbedded": art is not None,
        }

    # -- discovery ---------------------------------------------------------
    #
    # Same shape as artwork, for the same reason: the handler runs on
    # pynicotine's main thread, so it hands the work to a worker and answers
    # with a request id. Everything it emits is a raw provider fact — see
    # `discover.py` and the note above `DiscoverParsed` in the schema.

    def _discogs_token(self):
        """The token VALUE, which `_app_settings()` deliberately will not give.

        That method reports `discogsToken` as a boolean because the token must
        never cross the socket. Reading it here is fine and is the point of
        storing it on this side: the sidecar spends it, the frontend never sees
        it again after typing it once.
        """
        stored = self._load_state().get("app_settings") or {}
        return str(stored.get("discogsToken") or "")

    def _cmd_discover_parseUrl(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        url = (params.get("url") or "").strip()
        if not url:
            raise CommandError("bad_request", "no URL given")
        request_id = registries.transfer_id("discover", url)
        self._discover_pool.submit(self._run_discover, request_id, url)
        return {"requestId": request_id}

    def _acoustid_key(self):
        stored = self._load_state().get("app_settings") or {}
        return str(stored.get("acoustidApiKey") or "")

    def _youtube_key(self):
        """The YouTube Data API key, for reading a public playlist.

        Deliberately only the simple API key. YouTube also issues an OAuth
        client, but that is for a user's PRIVATE data; a public playlist needs
        none of it, so this app holds no client secret to leak.
        """
        stored = self._load_state().get("app_settings") or {}
        return str(stored.get("youtubeApiKey") or "")

    def _cmd_discover_fingerprint(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        path = (params.get("path") or "").strip()
        if not os.path.isfile(path):
            raise CommandError("not_found", f"no such file: {path}")
        request_id = registries.transfer_id("fingerprint", path)
        limit = params.get("durationLimit") or discover_mod.FINGERPRINT_SECONDS
        self._discover_pool.submit(self._run_fingerprint, request_id, path, int(limit))
        return {"requestId": request_id}

    def _run_fingerprint(self, request_id, path, seconds):
        try:
            payload = discover_mod.identify(path, self._acoustid_key(), seconds)
        except discover_mod.DiscoverError as error:
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": path,
                "reason": str(error), "needs": getattr(error, "needs", ""),
                "unreachable": bool(getattr(error, "unreachable", False)),
                "unauthorised": bool(getattr(error, "unauthorised", False)),
            })
            return
        except Exception as error:                     # noqa: BLE001 - worker
            log.exception("fingerprint failed for %s", path)
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": path, "reason": str(error), "needs": "",
                "unreachable": False,
                "unauthorised": False,
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.identified", payload)

    def _cmd_discover_related(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        artist = params.get("artist") or ""
        release = params.get("release") or ""
        if not artist and not release:
            raise CommandError("bad_request", "nothing to relate")
        request_id = registries.transfer_id("related", f"{artist}|{release}")
        self._discover_pool.submit(
            self._run_related, request_id, artist, release, params.get("label") or "",
        )
        return {"requestId": request_id}

    def _run_related(self, request_id, artist, release, label):
        try:
            payload = discover_mod.related(
                artist, release, label, self._discogs_token(),
            )
        except Exception as error:                     # noqa: BLE001 - worker
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": "", "reason": str(error),
                "needs": getattr(error, "needs", ""),
                "unreachable": bool(getattr(error, "unreachable", False)),
                "unauthorised": bool(getattr(error, "unauthorised", False)),
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.relatedResults", payload)

    def _cmd_discover_parseTracklist(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        url = (params.get("url") or "").strip()
        if not url:
            raise CommandError("bad_request", "no URL given")
        request_id = registries.transfer_id("tracklist", url)
        self._discover_pool.submit(self._run_tracklist, request_id, url)
        return {"requestId": request_id}

    def _run_tracklist(self, request_id, url):
        try:
            payload = discover_mod.parse_tracklist(url)
        except Exception as error:                     # noqa: BLE001 - worker
            # No tracklist is the ORDINARY outcome, so this reports through the
            # same failure event rather than pretending it is exceptional.
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": url,
                "reason": str(error), "needs": "",
                "unreachable": False,
                "unauthorised": False,
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.tracklistParsed", payload)

    def _cmd_discover_playlist(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        playlist_id = str(params.get("playlistId") or "").strip()
        if not playlist_id:
            raise CommandError("bad_request", "no playlist id")
        request_id = registries.transfer_id("playlist", playlist_id)
        self._discover_pool.submit(self._run_playlist, request_id, playlist_id)
        return {"requestId": request_id}

    def _run_playlist(self, request_id, playlist_id):
        try:
            payload = discover_mod.playlist_items(playlist_id, self._youtube_key())
        except discover_mod.DiscoverError as error:
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": playlist_id,
                "reason": str(error), "needs": getattr(error, "needs", ""),
                "unreachable": bool(getattr(error, "unreachable", False)),
                "unauthorised": bool(getattr(error, "unauthorised", False)),
            })
            return
        except Exception as error:                     # noqa: BLE001 - worker
            log.exception("playlist failed for %s", playlist_id)
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": playlist_id,
                "reason": str(error), "needs": "",
                "unreachable": False,
                "unauthorised": False,
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.playlistItems", payload)

    def _cmd_discover_wantlist(self, _params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        # No parameters at all: the username comes from the token, so there is
        # nothing for the caller to get wrong.
        request_id = registries.transfer_id("wantlist", "discogs")
        self._discover_pool.submit(self._run_wantlist, request_id)
        return {"requestId": request_id}

    def _run_wantlist(self, request_id):
        try:
            payload = discover_mod.wantlist(self._discogs_token())
        except discover_mod.DiscoverError as error:
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": "",
                "reason": str(error), "needs": getattr(error, "needs", ""),
                "unreachable": bool(getattr(error, "unreachable", False)),
                "unauthorised": bool(getattr(error, "unauthorised", False)),
            })
            return
        except Exception as error:                     # noqa: BLE001 - worker
            log.exception("wantlist failed")
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": "",
                "reason": str(error), "needs": "",
                "unreachable": False,
                "unauthorised": False,
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.wantlistItems", payload)

    def _cmd_discover_browse(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        kind = params.get("kind") or ""
        if kind not in ("label", "artist"):
            raise CommandError("bad_request", f"cannot browse a {kind!r}")
        source = params.get("sourceKind") or ""
        target = params.get("url") or params.get("name") or str(params.get("id") or "")
        if not target:
            raise CommandError("bad_request", "nothing to browse")
        request_id = registries.transfer_id(f"browse:{source}:{kind}", target)
        self._discover_pool.submit(self._run_browse, request_id, params)
        return {"requestId": request_id}

    def _run_browse(self, request_id, params):
        url = params.get("url") or ""
        try:
            payload = discover_mod.browse(
                params.get("sourceKind") or "",
                params.get("kind") or "",
                entity_id=params.get("id"),
                name=params.get("name"),
                url=params.get("url"),
                discogs_token=self._discogs_token(),
            )
        except discover_mod.DiscoverError as error:
            self.bridge.broadcast("discover.browseFailed", {
                "requestId": request_id, "url": url,
                "reason": str(error), "needs": getattr(error, "needs", ""),
                "unreachable": bool(getattr(error, "unreachable", False)),
                "unauthorised": bool(getattr(error, "unauthorised", False)),
            })
            return
        except Exception as error:                     # noqa: BLE001 - worker
            log.exception("browse failed for %s", url or params.get("name"))
            self.bridge.broadcast("discover.browseFailed", {
                "requestId": request_id, "url": url,
                "reason": str(error), "needs": "",
                "unreachable": False,
                "unauthorised": False,
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.catalog", payload)

    def _run_discover(self, request_id, url):
        try:
            payload = discover_mod.parse_url(url, discogs_token=self._discogs_token())
        except discover_mod.DiscoverError as error:
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": url,
                "reason": str(error), "needs": getattr(error, "needs", ""),
                "unreachable": bool(getattr(error, "unreachable", False)),
                "unauthorised": bool(getattr(error, "unauthorised", False)),
            })
            return
        except Exception as error:                     # noqa: BLE001 - worker
            # A worker thread that raises takes nothing down, but it also tells
            # nobody: the frontend would sit on a skeleton card forever waiting
            # for an event that is never coming.
            log.exception("discover failed for %s", url)
            self.bridge.broadcast("discover.parseFailed", {
                "requestId": request_id, "url": url,
                "reason": str(error), "needs": "",
                "unreachable": False,
                "unauthorised": False,
            })
            return
        payload["requestId"] = request_id
        self.bridge.broadcast("discover.parsed", payload)

    # -- want list ---------------------------------------------------------
    #
    # A record of intent, stored beside history and saved searches in
    # seek-state.json for the reason in CLAUDE.md §5: load_config() silently
    # drops config sections it has no defaults for.
    #
    # The sidecar stores and never interprets. It does not decide whether an
    # entry has been FOUND — that is a match between a search result and an
    # intention, which is fuzzy matching over parsed paths, and lives in
    # app/src/domain/ with the rest of it.

    WANT_CAP = 2000

    # A session opens when a BURST arrives — three entries inside ten minutes —
    # and stays open while the burst continues, closing after half an hour of
    # quiet. The numbers come straight from DISCOVERY.md, and the shape of the
    # rule is the point: one link saved on its own is not a digging session, and
    # calling it one would make the feature noise rather than a record.
    SESSION_BURST = 3
    SESSION_WINDOW = 10 * 60
    SESSION_IDLE = 30 * 60

    def _sessions(self):
        stored = self._load_state().get("dig_sessions")
        return list(stored) if isinstance(stored, list) else []

    def _session_state(self):
        return {"sessions": self._sessions()}

    def _sessions_publish(self, sessions, entries=None):
        """Persist sessions, and the want list too when a link changed.

        Both go in one write. Two writes would leave a window where an entry
        points at a session that is not on disk yet, and the file is read back
        on every launch.
        """
        if entries is None:
            self._save_state(dig_sessions=sessions)
        else:
            self._save_state(dig_sessions=sessions, want_list=entries[: self.WANT_CAP])
            self.bridge.broadcast("want.changed", self._want_state())
        state = self._session_state()
        self.bridge.broadcast("session.changed", state)
        return state

    def _active_session(self, sessions, now):
        """The session still collecting, if any. Closes stale ones in passing.

        Lazy rather than timed: a background timer to close sessions would be a
        thread doing nothing but waiting, and nothing observes a session between
        two want list writes anyway.
        """
        active = None
        for session in sessions:
            if session.get("closed"):
                continue
            if now - float(session.get("lastActiveAt") or 0) > self.SESSION_IDLE:
                session["closed"] = True
                continue
            active = session
        return active

    def _new_session(self, now, name=""):
        return {
            "id": uuid.uuid4().hex,
            # Empty until the user renames it. Wording a timestamp is display
            # formatting, and that belongs on the TypeScript side.
            "name": name,
            "createdAt": now,
            "lastActiveAt": now,
            "closed": False,
        }

    def _assign_sessions(self, entries, added_ids, now):
        """Group a burst of additions. Returns the session list to persist.

        Called only from want.add, because that is the only moment the grouping
        can change: a session is a record of when things were added.
        """
        if not added_ids or not self._app_settings().get("autoDigSessions", True):
            return None

        sessions = self._sessions()
        active = self._active_session(sessions, now)
        by_id = {e.get("id"): e for e in entries}

        if active is not None:
            for entry_id in added_ids:
                entry = by_id.get(entry_id)
                if entry is not None:
                    entry["sessionId"] = active["id"]
            active["lastActiveAt"] = now
            return sessions

        # No session open. Do the recent unassigned entries amount to a burst?
        recent = [
            e for e in entries
            if not e.get("sessionId")
            and now - float(e.get("addedAt") or 0) <= self.SESSION_WINDOW
        ]
        if len(recent) < self.SESSION_BURST:
            # Not a binge, just a link. Closing a stale session is still a
            # change worth persisting, so only skip when nothing moved.
            return sessions if any(s.get("closed") for s in sessions) else None

        session = self._new_session(now)
        # Backdate to the first entry of the burst: the session started when
        # the digging did, not when the third link happened to confirm it.
        session["createdAt"] = min(float(e.get("addedAt") or now) for e in recent)
        for entry in recent:
            entry["sessionId"] = session["id"]
        sessions.insert(0, session)
        return sessions

    # -- watched labels -----------------------------------------------------

    # A bookmark with progress on it, and since 0.2.7 a new-release notifier
    # as well — see `_cmd_labels_check` below for which of the original
    # objections that answered and which one it simply accepts.
    #
    # The stored counts are the one place this file keeps a derived number,
    # and it is deliberate: DigSession omits its counts because the frontend
    # holds the whole want list and can recount for free, whereas a catalogue
    # is not persisted anywhere and recounting one costs several rate-limited
    # HTTP requests. They are written only when a catalogue is actually read,
    # and they carry `lastSeenAt` so nothing can render them as current.

    LABEL_CAP = 200

    def _labels(self):
        stored = self._load_state().get("watched_labels")
        if not isinstance(stored, list):
            return []
        # Migrated on the way OUT, so every reader sees a complete row whatever
        # version wrote the file.
        return [_label_defaults(dict(row)) for row in stored if isinstance(row, dict)]

    def _labels_state(self):
        return {"labels": self._labels()}

    def _labels_publish(self, labels):
        self._save_state(watched_labels=labels[: self.LABEL_CAP])
        state = self._labels_state()
        self.bridge.broadcast("labels.changed", state)
        return state

    def _find_label(self, labels, label_id):
        label = next((l for l in labels if l.get("id") == label_id), None)
        if label is None:
            raise CommandError("not_found", f"no watched label {label_id}")
        return label

    @staticmethod
    def _label_identity(source_kind, kind, name, url, entity_id):
        """What makes two watchings the same catalogue.

        The id where there is one, because a label can be renamed on Discogs
        and a URL can be written several ways. Otherwise the URL, and only
        failing both, the name — which is the weakest of the three and the
        reason `entityId` is carried at all.
        """
        if entity_id:
            return f"{source_kind}:{kind}:#{entity_id}"
        if url:
            return f"{source_kind}:{kind}:{url.rstrip('/').lower()}"
        return f"{source_kind}:{kind}:~{(name or '').strip().lower()}"

    def _cmd_labels_list(self, _params):
        return self._labels_state()

    def _cmd_labels_watch(self, params):
        kind = params.get("kind") or ""
        if kind not in ("label", "artist"):
            # 'track' and 'release' are catalogues of nothing.
            raise CommandError("bad_request", f"cannot watch a {kind!r}")
        name = str(params.get("name") or "").strip()
        if not name:
            raise CommandError("bad_request", "a watched catalogue needs a name")

        # Only providers that actually HAVE a catalogue, because the single
        # promise this list makes is that a row can be re-opened. `discover.browse`
        # serves discogs and bandcamp and refuses everything else, so a
        # youtube or manual row would be a bookmark that permanently fails.
        source_kind = params.get("sourceKind") or ""
        if source_kind not in ("discogs", "bandcamp"):
            raise CommandError(
                "bad_request", f"{source_kind or 'that source'} has no catalogue to watch"
            )

        url = str(params.get("url") or "").strip()
        entity_id = params.get("entityId")
        entity_id = int(entity_id) if entity_id else None

        # Same promise, second half. Bandcamp has no ids at all — `browse`
        # raises "Bandcamp has no ids; a page URL is required" — so a Bandcamp
        # row without a URL could never be read again.
        if source_kind == "bandcamp" and not url:
            raise CommandError(
                "bad_request", "a Bandcamp catalogue can only be watched by its page URL"
            )

        identity = self._label_identity(source_kind, kind, name, url, entity_id)

        labels = self._labels()
        for existing in labels:
            if self._label_identity(
                existing.get("sourceKind"), existing.get("kind"),
                existing.get("name"), existing.get("url"),
                existing.get("entityId"),
            ) != identity:
                continue
            # Already watched. Refresh what identifies it and leave the counts
            # alone — those describe a READING, not the choice to watch.
            existing["name"] = name
            existing["url"] = url or existing.get("url") or ""
            if entity_id:
                existing["entityId"] = entity_id
            return self._labels_publish(labels)

        labels.insert(0, {
            "id": uuid.uuid4().hex,
            "sourceKind": source_kind,
            "kind": kind,
            "name": name,
            "url": url,
            "entityId": entity_id,
            "addedAt": time.time(),
            # Null, not zero. "Never read" and "read and found nothing" are
            # different things and the UI words them differently.
            "lastSeenAt": None,
            "releaseCount": None,
            "ownedCount": None,
            "wantedCount": None,
            "note": "",
            # Captured when the catalogue is first read, not now: watching is a
            # decision and should not cost an HTTP request.
            "imageUri": None,
            # Never checked for new releases, which is distinct from checked and
            # found none.
            "lastCheckedAt": None,
            "newCount": 0,
            "knownIds": [],
        })
        return self._labels_publish(labels)

    def _cmd_labels_unwatch(self, params):
        label_id = params.get("id") or ""
        labels = self._labels()
        self._find_label(labels, label_id)
        # Nothing saved FROM the catalogue is touched. The want list and the
        # library are not a function of the watchlist.
        return self._labels_publish([l for l in labels if l.get("id") != label_id])

    def _cmd_labels_note(self, params):
        labels = self._labels()
        self._find_label(labels, params.get("id") or "")["note"] = str(
            params.get("note") or ""
        )
        return self._labels_publish(labels)

    def _cmd_labels_seen(self, params):
        labels = self._labels()
        label = self._find_label(labels, params.get("id") or "")
        label["lastSeenAt"] = time.time()
        label["releaseCount"] = max(0, int(params.get("releaseCount") or 0))
        label["ownedCount"] = max(0, int(params.get("ownedCount") or 0))
        label["wantedCount"] = max(0, int(params.get("wantedCount") or 0))
        # Opening the catalogue IS the acknowledgement. There is no dismiss
        # button, because a badge you can clear without looking is a badge that
        # stops meaning anything.
        label["newCount"] = 0
        return self._labels_publish(labels)

    # -- checking for new releases -----------------------------------------
    #
    # This feature was argued against in this file, and the argument still
    # holds in one respect: a brand-new release is the one thing Soulseek does
    # not have yet, so some of these notifications will lead to an empty
    # search. Iva asked for it anyway, knowing that. What the design CAN fix is
    # the other two objections, and it does:
    #
    #   Discogs is a database, not a release feed. A record catalogued decades
    #   late would otherwise report as new, so a Discogs entry additionally has
    #   to be recent by its own YEAR before it counts.
    #
    #   Bandcamp has no API to poll. True, and it does not need one: its whole
    #   catalogue is a single HTML page, newest first, which makes it by far
    #   the cheaper half of this.
    #
    # NEVER called on mount. A Discogs catalogue is up to seven sequentially
    # rate-limited requests, so a dozen watched entries checked the instant a
    # screen appeared would be about ninety seconds of someone else's API
    # budget, spent without being asked.

    #: How recent a Discogs release must be to count as new, in years.
    NEW_RELEASE_YEARS = 1

    @staticmethod
    def _release_key(entry):
        """What identifies a release ACROSS checks.

        The Discogs id when there is one, and the URL otherwise — Bandcamp has
        no ids. Never the title: labels reissue, and a repress arriving under
        the same name is not a new record.
        """
        discogs_id = entry.get("discogsId") or 0
        return f"d{discogs_id}" if discogs_id else str(entry.get("url") or "")

    def _cmd_labels_check(self, params):
        wanted = [str(i) for i in (params.get("ids") or [])]
        labels = self._labels()
        targets = [row for row in labels if not wanted or row.get("id") in wanted]
        if not targets:
            return self._labels_state()
        # Bandcamp first: one request each, so the cheap answers arrive before
        # the expensive ones even if the user closes the screen halfway.
        targets.sort(key=lambda row: 0 if row.get("sourceKind") == "bandcamp" else 1)
        self._discover_pool.submit(self._run_label_check, [row["id"] for row in targets])
        return self._labels_state()

    def _run_label_check(self, ids):
        for label_id in ids:
            try:
                self._check_one_label(label_id)
            except Exception:                          # noqa: BLE001 - worker
                # One unreachable catalogue must not stop the rest. The row
                # keeps its old counts and its old lastCheckedAt, which is what
                # "we could not look" honestly looks like.
                #
                # BUT IT MUST BE SAID SOMEWHERE. This ran on a worker with a
                # bare `continue` and no log line, and the result was a button
                # that could be pressed forever with nothing changing and no
                # error anywhere — not in the UI, not in the log, not in the
                # state file. Undiagnosable from the outside, and the exact
                # "silently does nothing" answer labelStore.ts argues against.
                log.exception("could not check catalogue %s", label_id)

    def _check_one_label(self, label_id):
        labels = self._labels()
        label = self._find_label(labels, label_id)
        payload = discover_mod.browse(
            label.get("sourceKind") or "",
            label.get("kind") or "",
            entity_id=label.get("entityId"),
            name=label.get("name"),
            url=label.get("url"),
            discogs_token=self._discogs_token(),
            # Fetched once and kept. A logo does not change, and this is the
            # only place that pays for one.
            want_image=not label.get("imageUri"),
        )
        releases = payload.get("releases") or []
        seen = {self._release_key(r) for r in releases if self._release_key(r)}

        known = set(label.get("knownIds") or [])
        fresh = seen - known

        if label.get("sourceKind") == "discogs":
            # Recent by its own year, as well as unseen. Without this the first
            # check of any catalogue reports its entire back catalogue as new,
            # and every later one reports whatever a volunteer happened to
            # catalogue that week.
            this_year = time.gmtime().tm_year
            recent = {
                self._release_key(r) for r in releases
                if isinstance(r.get("year"), int)
                and r["year"] >= this_year - self.NEW_RELEASE_YEARS
            }
            fresh &= recent

        labels = self._labels()
        label = self._find_label(labels, label_id)
        label["lastCheckedAt"] = time.time()
        label["knownIds"] = sorted(seen)
        if payload.get("imageUri"):
            label["imageUri"] = payload["imageUri"]
        # A FIRST check teaches the baseline and announces nothing. Reporting
        # three hundred "new" releases the first time you press the button
        # would be true and useless.
        label["newCount"] = 0 if not known else label.get("newCount", 0) + len(fresh)
        self._labels_publish(labels)

    def _cmd_session_list(self, _params):
        sessions = self._sessions()
        # Reading the list is a fair moment to notice a session has gone quiet.
        before = [s.get("closed") for s in sessions]
        self._active_session(sessions, time.time())
        if [s.get("closed") for s in sessions] != before:
            self._save_state(dig_sessions=sessions)
        return {"sessions": sessions}

    def _cmd_session_create(self, params):
        now = time.time()
        sessions = self._sessions()
        # One session collects at a time; starting a new one closes the old.
        for session in sessions:
            if not session.get("closed"):
                session["closed"] = True
        sessions.insert(0, self._new_session(now, str(params.get("name") or "")))
        return self._sessions_publish(sessions)

    def _find_session(self, sessions, session_id):
        session = next((s for s in sessions if s.get("id") == session_id), None)
        if session is None:
            raise CommandError("not_found", f"no session {session_id}")
        return session

    def _cmd_session_rename(self, params):
        sessions = self._sessions()
        self._find_session(sessions, params.get("id") or "")["name"] = str(
            params.get("name") or ""
        )
        return self._sessions_publish(sessions)

    def _cmd_session_close(self, params):
        sessions = self._sessions()
        self._find_session(sessions, params.get("id") or "")["closed"] = True
        return self._sessions_publish(sessions)

    def _cmd_session_delete(self, params):
        session_id = params.get("id") or ""
        sessions = self._sessions()
        self._find_session(sessions, session_id)

        entries = self._want_entries()
        touched = False
        for entry in entries:
            if entry.get("sessionId") == session_id:
                # Unlinked, never deleted. The session groups things you
                # wanted; it is not the things themselves.
                entry["sessionId"] = None
                touched = True

        sessions = [s for s in sessions if s.get("id") != session_id]
        return self._sessions_publish(sessions, entries if touched else None)

    # Every optional field, with what an entry written by an older build should
    # be read as. The state file outlives the schema: a `want_list` persisted
    # before digging sessions existed has no `sessionId`, and the generated
    # validator refuses to emit a struct with a missing key — so the
    # `want.changed` event would be DROPPED rather than sent, and the frontend
    # would simply stop hearing about a list it could still write to. Silent,
    # and invisible from the UI. Backfilling on read costs nothing and makes
    # every future field addition safe by the same route.
    WANT_DEFAULTS = {
        "album": None, "year": None, "label": None, "catalogNumber": None,
        "sourceUrl": None, "sourceTitle": None, "artworkUri": None,
        "status": "pending", "searchedAt": None, "notes": None,
        "duration": None, "tracklist": [], "sessionId": None,
        "sourceKind": "manual", "artist": "", "title": "", "addedAt": 0.0,
    }

    def _want_entries(self):
        stored = self._load_state().get("want_list")
        if not isinstance(stored, list):
            return []
        entries = []
        for raw in stored:
            if not isinstance(raw, dict) or not raw.get("id"):
                continue
            entry = dict(self.WANT_DEFAULTS)
            entry.update(raw)
            entries.append(entry)
        return entries

    def _want_state(self):
        return {"entries": self._want_entries()}

    def _want_publish(self, entries):
        self._save_state(want_list=entries[: self.WANT_CAP])
        state = self._want_state()
        self.bridge.broadcast("want.changed", state)
        return state

    def _cmd_want_list(self, _params):
        return self._want_state()

    def _cmd_want_add(self, params):
        entries = self._want_entries()
        # A URL pasted twice is the same intention twice, not two of them.
        seen_urls = {e.get("sourceUrl") for e in entries if e.get("sourceUrl")}
        seen_keys = {
            (str(e.get("artist", "")).lower(), str(e.get("title", "")).lower())
            for e in entries
        }

        now = time.time()
        added_ids = []
        for raw in params.get("entries") or []:
            url = raw.get("sourceUrl") or None
            key = (str(raw.get("artist") or "").lower(),
                   str(raw.get("title") or "").lower())
            if (url and url in seen_urls) or (key != ("", "") and key in seen_keys):
                continue
            entry = dict(raw)
            # id and addedAt are the sidecar's to mint. A client that sent its
            # own would be able to overwrite an existing entry by guessing one.
            entry["id"] = uuid.uuid4().hex
            entry["addedAt"] = now
            entry.setdefault("status", "pending")
            entry.setdefault("searchedAt", None)
            entry["sessionId"] = None
            entries.insert(0, entry)
            if url:
                seen_urls.add(url)
            seen_keys.add(key)
            added_ids.append(entry["id"])

        if not added_ids:
            return self._want_state()

        # Grouping happens here because this is the only moment it can change:
        # a session records WHEN things were added.
        sessions = self._assign_sessions(entries, added_ids, now)
        if sessions is not None:
            self._save_state(dig_sessions=sessions)
            self.bridge.broadcast("session.changed", {"sessions": sessions})
        return self._want_publish(entries)

    def _cmd_want_remove(self, params):
        ids = set(params.get("ids") or [])
        if not ids:
            return self._want_state()
        entries = [e for e in self._want_entries() if e.get("id") not in ids]
        return self._want_publish(entries)

    def _cmd_want_update(self, params):
        entry_id = params.get("id") or ""
        entries = self._want_entries()
        target = next((e for e in entries if e.get("id") == entry_id), None)
        if target is None:
            raise CommandError("not_found", f"no want list entry {entry_id}")

        for field in ("artist", "title", "album", "status", "notes"):
            if params.get(field) is not None:
                target[field] = params[field]
        # Stamp the search time here rather than trusting a client clock, and
        # only when the status actually says a search just started.
        if params.get("status") == "searching":
            target["searchedAt"] = time.time()
        return self._want_publish(entries)

    # -- history, saved searches, buddies ----------------------------------
    #
    # These live in seek-state.json rather than the pynicotine config, for the
    # reason recorded in CLAUDE.md: load_config() silently drops sections it has
    # no defaults for, so anything we invent there survives the write and
    # vanishes on reload.

    HISTORY_CAP = 50

    def _cmd_history_list(self, _params):
        return {"items": self._load_state().get("history", [])}

    def _cmd_history_record(self, params):
        query = (params.get("query") or "").strip()
        if not query:
            return {"items": self._load_state().get("history", [])}
        items = [q for q in self._load_state().get("history", []) if q != query]
        items.insert(0, query)
        del items[self.HISTORY_CAP:]
        self._save_state(history=items)
        return {"items": items}

    def _cmd_history_clear(self, _params):
        self._save_state(history=[])
        return {"items": []}

    def _cmd_saved_list(self, _params):
        return {"items": self._load_state().get("saved", [])}

    def _cmd_saved_add(self, params):
        query = (params.get("query") or "").strip()
        if not query:
            raise CommandError("bad_request", "empty query")
        entry = {"query": query, "filtersJson": params.get("filtersJson") or ""}
        items = [x for x in self._load_state().get("saved", []) if x.get("query") != query]
        items.insert(0, entry)
        self._save_state(saved=items)
        return {"items": items}

    def _cmd_saved_remove(self, params):
        query = (params.get("query") or "").strip()
        items = [x for x in self._load_state().get("saved", []) if x.get("query") != query]
        self._save_state(saved=items)
        return {"items": items}

    def _buddy_state(self):
        return {"items": sorted(self.core.buddies.users)}

    def _cmd_buddies_list(self, _params):
        return self._buddy_state()

    def _cmd_buddies_add(self, params):
        self.core.buddies.add_buddy(params["username"])
        state = self._buddy_state()
        self.bridge.broadcast("buddies.state", state)
        return state

    def _cmd_buddies_remove(self, params):
        self.core.buddies.remove_buddy(params["username"])
        state = self._buddy_state()
        self.bridge.broadcast("buddies.state", state)
        return state

    # -- wishlist ----------------------------------------------------------
    #
    # Upstream owns the timer. `add_wish` schedules the re-runs itself, on an
    # interval the SERVER dictates (`set-wishlist-interval`), and running a
    # wishlist search more often than that is what gets a client throttled.
    # So Seek never polls — it registers the wish and listens.

    def _wishlist_state(self):
        return {
            "items": list(reversed(list(self.core.search.wishlist))),
            "intervalSeconds": int(self.core.search.wishlist_interval or 0),
        }

    def _cmd_wishlist_list(self, _params):
        return self._wishlist_state()

    def _cmd_wishlist_add(self, params):
        query = (params.get("query") or "").strip()
        if not query:
            raise CommandError("bad_request", "empty wish")
        self.core.search.add_wish(query)
        state = self._wishlist_state()
        self.bridge.broadcast("wishlist.state", state)
        return state

    def _cmd_wishlist_remove(self, params):
        query = (params.get("query") or "").strip()
        self.core.search.remove_wish(query)
        state = self._wishlist_state()
        self.bridge.broadcast("wishlist.state", state)
        return state

    def _on_wishlist_interval(self, *_args, **_kwargs):
        self.bridge.broadcast("wishlist.state", self._wishlist_state())

    def _cmd_shares_get(self, _params):
        return self._share_state()

    def _cmd_shares_set(self, params):
        consent = params["consent"]
        folders = params["folders"]

        if consent == "granted" and not folders:
            raise CommandError(
                "bad_request",
                "consent 'granted' with no folders is a contradiction; use "
                "'declined' to share nothing",
            )
        if consent == "declined" and folders:
            raise CommandError(
                "bad_request", "consent 'declined' cannot carry shared folders"
            )

        # Resolve and check every path BEFORE writing any of them, so a bad
        # third folder cannot leave the first two half-applied.
        #
        # A shared folder is checked for readability, not writability: peers
        # only ever read it, and a read-only archive volume is a perfectly
        # reasonable thing to share. Offering a folder that cannot be read is
        # the failure that matters — it advertises files to the network that
        # every request for will then fail, which is worse for the people
        # asking than not sharing at all.
        resolved = []
        for folder in folders:
            if not folder["path"]:
                raise CommandError("bad_request", "a shared folder needs a path")
            path = self._resolve_path(folder["path"])
            if not os.path.isdir(path):
                raise CommandError(
                    "bad_request", f"this shared folder is not a folder: {path}"
                )
            if not os.access(path, os.R_OK | os.X_OK):
                raise CommandError(
                    "bad_request", f"this shared folder cannot be read: {path}"
                )
            virtual = folder["virtualName"] or os.path.basename(path.rstrip(os.sep)) or path
            resolved.append((virtual, path))

        names = [v for v, _ in resolved]
        duplicate = next((n for n in names if names.count(n) > 1), None)
        if duplicate is not None:
            # Upstream keys shares on the virtual name, so two folders sharing
            # one name silently means peers can reach only one of them.
            raise CommandError(
                "bad_request",
                f"two shared folders are both called {duplicate!r}; peers key on "
                "that name, so it has to be unique",
            )

        self._save_state(share_consent=consent)
        self.config.sections["transfers"]["shared"] = resolved

        # The shares component is chosen at init_components() time. Granting
        # consent in a session that started without it cannot retroactively
        # build the index, so say so rather than silently doing nothing.
        if consent == "granted" and self.core.shares is None:
            self._share_restart_required = True

        self.config.write_configuration()
        state = self._share_state()
        self.bridge.broadcast("shares.state", state)
        return state

    def _cmd_shares_rescan(self, params):
        if self.core.shares is None:
            raise CommandError(
                "unsupported",
                "the shares component is not running; grant sharing consent and "
                "restart the sidecar",
            )
        self.core.shares.rescan_shares(force=bool(params.get("force")))
        return {}

    # -- import from Nicotine+ ---------------------------------------------

    def _cmd_import_inspect(self, _params):
        """Report what an existing Nicotine+ install offers.

        Reads nothing else and imports nothing. Only ever reached through an
        explicit user action — there is no startup path to this command.
        """
        return nicotine_import.inspect()

    def _cmd_import_apply(self, params):
        try:
            result = nicotine_import.apply(self.config, params)
        except FileNotFoundError as error:
            raise CommandError("not_found", str(error)) from error
        except Exception as error:
            raise CommandError("internal", f"import failed: {error}") from error

        if result["importedShares"]:
            # Importing shares is itself an explicit act of sharing.
            self._save_state(share_consent="granted")
            if self.core.shares is None:
                self._share_restart_required = True

        self.config.write_configuration()
        self.bridge.broadcast("shares.state", self._share_state())

        # Importing credentials writes them to disk but does NOT log in — that
        # was the whole failure: the panel reported success while the app stayed
        # signed out with nothing to explain why. Connect straight away, and let
        # the connection.state event report the outcome.
        if result.get("importedCredentials"):
            try:
                self._cmd_connection_connect({"username": None, "password": None})
            except CommandError as error:
                log.warning("import connected credentials but login failed: %s", error)

        return result

    # -- transfer plumbing -------------------------------------------------

    def _emit_transfer(self, upstream_transfer, direction, file=None):
        record = self.transfers.record_for(
            direction, upstream_transfer.username, upstream_transfer.virtual_path, file
        )
        state = translate.transfer_state(upstream_transfer.status)
        is_new = record.last_emitted_state is None

        self.transfers.observe(record, state, upstream_transfer.current_byte_offset)
        # Peer reliability, from OUR OWN history — the protocol tells us nothing
        # about how a stranger behaves. Counted ONCE PER TRANSFER rather than
        # once per transition; `_record_outcome` explains why that distinction
        # cost a peer 524 phantom failures.
        #
        # DOWNLOADS ONLY, and that is not an oversight. This score answers "how
        # reliably does this peer SEND ME THINGS", and it is an input to source
        # ranking. An upload finishing says something about my own connection
        # and nothing about theirs; an upload failing usually means they
        # cancelled or went away mid-fetch, which is not evidence against them
        # as a source either. Counting uploads here would quietly move the
        # ranking on data that does not bear on it.
        # And only for a transition we actually WITNESSED. The first state we
        # ever see for a transfer is a restoration, not an event: upstream
        # reloads its saved transfer list on every start, and anything whose
        # peer is offline comes back already terminal — so a stuck download
        # logged one fresh "failure" per sidecar restart, for ever.
        #
        # Measured after the per-transfer fix was already in: one restart added
        # 12 outcomes across the stuck transfers — one peer +4, another +3.
        # Slower than the 500-at-a-time oscillation it replaced, and exactly as
        # untrue.
        #
        # A transfer queued now cannot be missed by this: its first emit is
        # `queued`, which is not terminal, so the count still lands on the real
        # transition afterwards.
        witnessed = record.last_emitted_state is not None
        if direction == "download" and witnessed and state != record.last_emitted_state:
            self._record_outcome(record, state)
        record.last_emitted_state = state

        payload = translate.transfer(
            record, upstream_transfer, self.transfers.since_progress(record)
        )
        self.bridge.broadcast("transfer.added" if is_new else "transfer.updated",
                              payload)

    def _component_for(self, direction):
        return self.core.uploads if direction == "upload" else self.core.downloads

    def _find_upstream_transfer(self, record):
        component = self._component_for(record.direction)
        if component is None:
            return None
        # Upstream keys its dict on username + virtual_path with no separator
        # (transfers.py:396). Ours is a hash with one; this is the join.
        return component.transfers.get(record.username + record.path)

    def _iter_upstream_transfers(self, transfer_ids, direction=None):
        """Resolve wire ids back to pynicotine Transfer objects.

        Returns {direction: [transfer]}, because the two directions are
        different lists on different components and an action has to be applied
        to each with the right one. Pass `direction` to take only that half —
        which is how `transfer.pause` refuses uploads rather than doing
        something surprising with them.
        """
        out = {"download": [], "upload": []}
        for transfer_id in transfer_ids:
            record = self.transfers.get(transfer_id)
            if record is None:
                continue
            if direction is not None and record.direction != direction:
                continue
            upstream = self._find_upstream_transfer(record)
            if upstream is not None:
                out[record.direction].append(upstream)
        return out

    def _enqueue_folder_files(self, username, root, folders, destination, recurse):
        count = 0
        for folder in folders:
            path = folder["path"]
            if not recurse and path != root:
                continue
            if recurse and path != root and not path.startswith(root + "\\"):
                continue
            target = destination or self.core.downloads.get_folder_destination(
                username, path, root_folder_path=root
            )
            for file in folder["files"]:
                self.core.downloads.enqueue_download(
                    username, file["path"], folder_path=target, size=file["size"]
                )
                count += 1
        return count

    def _close_search(self, token, reason):
        for payload in self.searches.flush():
            self.bridge.broadcast("search.result", payload)
        payload = self.searches.close(token, reason)
        if payload is None:
            return
        # Stop the network thread parsing further responses for this token.
        try:
            self.core.search.remove_allowed_token(token)
        except Exception:
            # The token is NOT logged. It is a credential, and this file is
            # written to be attached to a bug report.
            log.debug("could not remove an allowed token", exc_info=True)
        self.bridge.broadcast("search.closed", payload)

    # -- command dispatch --------------------------------------------------

    def dispatch(self, command, params):
        handler = getattr(self, "_cmd_" + command.replace(".", "_"), None)
        if handler is None:
            raise CommandError("unsupported", f"{command} is not implemented")
        return handler(params)

    def _require_online(self):
        if self.core.users.login_status == self.UserStatus.OFFLINE:
            raise CommandError("not_connected", "not connected to the Soulseek server")

    def _cmd_hello(self, params):
        if params.get("protocolVersion") != PROTOCOL_VERSION:
            raise CommandError(
                "bad_request",
                f"protocol version mismatch: client {params.get('protocolVersion')}, "
                f"sidecar {PROTOCOL_VERSION}",
            )
        # `client` is documented in the schema as "for the sidecar log" and was
        # being ignored. Logged here so every log opens with who connected and
        # which versions are talking — the first three questions of any report.
        log.info("client %r connected: sidecar %s, core %s",
                 str(params.get("client") or "unknown"), SIDECAR_VERSION,
                 __import__("pynicotine").__version__)
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "sidecarVersion": SIDECAR_VERSION,
            "logPath": self.log_file,
            "coreVersion": __import__("pynicotine").__version__,
            "connection": dict(self._connection),
            "transfers": self._transfer_snapshot(),
            "searches": [s.info() for s in self.searches.searches.values()
                         if s.closed is None],
        }

    def _cmd_connection_connect(self, params):
        # Null means "use what is stored". After an import the credentials are
        # already in the config, and requiring them here would mean handing a
        # password back out of the sidecar just to hand it straight back in.
        username = params.get("username")
        password = params.get("password")
        if username:
            self.config.sections["server"]["login"] = username
        if password:
            self.config.sections["server"]["passw"] = password

        if not self.config.sections["server"].get("login"):
            raise CommandError("bad_request", "no username stored or supplied")
        if not self.config.sections["server"].get("passw"):
            raise CommandError("bad_request", "no password stored or supplied")

        # Persist so a restart does not lose the login. Neither value is ever
        # logged, echoed, or returned by any command.
        self.config.write_configuration()

        self._connection.update({"status": "connecting", "error": None})
        self.bridge.broadcast("connection.state", dict(self._connection))
        self.core.connect()
        return {}

    def _cmd_connection_disconnect(self, _params):
        self.core.disconnect()
        return {}

    def _cmd_search_start(self, params):
        self._require_online()
        mode = params.get("mode") or "global"
        before = set(self.core.search.searches)
        self.core.search.do_search(
            params["query"], mode,
            room=params.get("room"),
            users=params.get("users") or None,
            switch_page=False,
        )
        new = set(self.core.search.searches) - before
        if not new:
            raise CommandError("internal", "upstream did not register the search")
        token = new.pop()
        upstream = self.core.search.searches[token]

        search = self.searches.add(
            token, upstream.term, upstream.term_transmitted, mode,
            result_cap=params.get("resultCap"),
            idle_timeout=params.get("timeoutSeconds"),
        )
        self.bridge.broadcast("search.started", search.info())
        return {"searchId": token}

    def _cmd_search_stop(self, params):
        token = params["searchId"]
        self.core.search.remove_search(token)
        self._close_search(token, "stopped")
        return {}

    def _cmd_user_browse(self, params):
        self._require_online()
        self.core.userbrowse.browse_user(
            params["username"], new_request=True, switch_page=False
        )
        return {}

    def _cmd_user_stats(self, params):
        self._require_online()
        self.core.users.watch_user(params["username"], context="seek")
        self.core.users.request_user_stats(params["username"])
        return {}

    def _cmd_transfer_enqueue(self, params):
        self._require_online()
        username = params["username"]
        path = params["path"]
        key = username + path
        already = key in self.core.downloads.transfers

        self.core.downloads.enqueue_download(
            username, path,
            folder_path=params.get("destination"),
            size=params.get("size") or 0,
            paused=bool(params.get("paused")),
        )
        # `transfer.enqueue` only ever queues a DOWNLOAD — an upload is
        # something a peer asks you for, never something you start.
        record = self.transfers.record_for("download", username, path, params.get("file"))

        # Emit the row ourselves rather than waiting for upstream to.
        #
        # `enqueue_download` has two paths that return WITHOUT calling
        # `_update_transfer`, so no `update-download` fires and nothing appears:
        #   * a duplicate — it returns at once (downloads.py, "Duplicate
        #     download found, stop here"), which is the common case of pressing
        #     Get twice on a peer with a long queue;
        #   * `_enqueue_transfer` returning False on a file I/O error in the
        #     incomplete folder.
        # Both look identical from the outside: the button does nothing at all.
        # Pressing Get must always put a row on the Downloads screen, even when
        # the row's news is "you already asked for this".
        upstream_transfer = self.core.downloads.transfers.get(key)
        if upstream_transfer is not None:
            self._emit_transfer(upstream_transfer, "download", params.get("file"))

        return {"transferId": record.id, "alreadyQueued": already}

    def _cmd_transfer_enqueueFolder(self, params):
        self._require_online()
        username = params["username"]
        folder_path = params["folderPath"]
        request_id = registries.transfer_id(username, folder_path)
        self._folder_requests[(username, folder_path)] = {
            "requestId": request_id,
            "destination": params.get("destination"),
            "recurse": bool(params.get("recurse")),
        }
        self.core.downloads.request_folder(username, folder_path)
        return {"requestId": request_id}

    def _cmd_transfer_pause(self, params):
        # DOWNLOADS ONLY. Upstream has no paused state for an upload — it is
        # not in the statuses uploads.py ever sets — and a peer waiting on you
        # is not something to quietly park. Upload ids are filtered out rather
        # than aborted with some near-enough status.
        items = self._iter_upstream_transfers(params["transferIds"], "download")
        if items["download"]:
            self.core.downloads.abort_downloads(
                items["download"], self.TransferStatus.PAUSED
            )
        return {}

    def _cmd_transfer_cancel(self, params):
        items = self._iter_upstream_transfers(params["transferIds"])
        if items["download"]:
            self.core.downloads.abort_downloads(
                items["download"], self.TransferStatus.CANCELLED
            )
        if items["upload"] and self.core.uploads is not None:
            # The denied_message is the difference between telling the peer you
            # stopped and just going quiet on them. Upstream sends it as an
            # UploadDenied, which their client shows.
            self.core.uploads.abort_uploads(
                items["upload"],
                denied_message="Cancelled by the uploader",
                status=self.TransferStatus.CANCELLED,
            )
        return {}

    def _cmd_transfer_resume(self, params):
        items = self._iter_upstream_transfers(params["transferIds"])
        if items["download"]:
            self.core.downloads.retry_downloads(items["download"])
        if items["upload"] and self.core.uploads is not None:
            self.core.uploads.retry_uploads(items["upload"])
        return {}

    _cmd_transfer_retry = _cmd_transfer_resume

    def _cmd_transfer_clear(self, params):
        items = self._iter_upstream_transfers(params["transferIds"])
        if items["download"]:
            self.core.downloads.clear_downloads(items["download"])
        if items["upload"] and self.core.uploads is not None:
            self.core.uploads.clear_uploads(items["upload"])
        return {}

    def _cmd_transfer_list(self, _params):
        return {"transfers": self._transfer_snapshot()}

    def _transfer_snapshot(self):
        """Both directions, one list. The frontend separates them on
        `direction`; nothing here has to know which screen wants which."""
        out = []
        for direction, component in (
            ("download", self.core.downloads), ("upload", self.core.uploads),
        ):
            if component is None:
                continue
            for upstream in list(component.transfers.values()):
                record = self.transfers.record_for(
                    direction, upstream.username, upstream.virtual_path
                )
                out.append(translate.transfer(
                    record, upstream, self.transfers.since_progress(record)
                ))
        return out

    # -- settings ----------------------------------------------------------

    # -- spectral analysis (post-download only) ----------------------------

    def _cmd_analysis_spectral(self, params):
        """Queue a post-download spectral check.

        This is deliberately NOT available for search results. Spectral analysis
        needs the actual audio bytes, so it can only ever run on a file already
        on disk (docs/PRODUCT.md §6). The search-time metadata heuristic is a
        prediction; this is a finding. They are separate fields on the wire and
        must stay separate in the UI.
        """
        path = self._resolve_local_file(params)
        transfer_id = params.get("transferId")

        request_id = registries.transfer_id(path, str(transfer_id or ""))
        self._analysis_pool.submit(self._run_analysis, request_id, path, transfer_id)
        return {"requestId": request_id}

    def _run_analysis(self, request_id, path, transfer_id):
        """Worker-thread body. Never raises into the pool."""
        from . import spectral
        try:
            payload = spectral.analyse(path, request_id=request_id,
                                       transfer_id=transfer_id)
        except Exception as error:
            log.warning("spectral analysis failed for %s: %s", path, error)
            self.bridge.broadcast("analysis.failed", {
                "requestId": request_id, "path": path, "reason": str(error),
            })
            return
        self.bridge.broadcast("analysis.result", payload)

    # -- chat --------------------------------------------------------------
    #
    # Soulseek chat carries no message ids and no server timestamp for rooms,
    # so a room line is stamped on arrival. Private messages DO carry the
    # server's timestamp, because they are delivered offline — using our own
    # clock there would misdate every message queued while we were away.

    def _chat_line(self, scope, target, username, message, *, outgoing=False,
                   kind="message", mentioned=False, timestamp=None):
        return {
            "scope": scope,
            "target": target,
            "username": username,
            "message": message,
            "outgoing": bool(outgoing),
            "kind": kind,
            "mentioned": bool(mentioned),
            "timestamp": int(timestamp if timestamp else time.time()),
        }

    #: Upstream's message_type vocabulary, mapped to the wire's ChatMessageKind.
    #:
    #: These are DIFFERENT vocabularies and nothing enforced that they agreed.
    #: `privatechat.get_message_type` and `chatrooms.get_message_type` both
    #: return exactly "action", "local" or "remote"; the schema allows
    #: "message", "action", "local", "hilite". So every message from another
    #: person arrived as "remote", failed validation, and was DROPPED by the
    #: generated validator — silently, because dropping is what it does.
    #:
    #: Measured, not theorised: five real replies were binned this way, and
    #: three busy chat rooms looked empty for forty minutes.
    #:
    #: "remote" becomes "message" rather than gaining its own kind, because
    #: direction is already carried by `outgoing`; kind is about what sort of
    #: line it is, not who sent it.
    CHAT_KINDS = {
        "remote": "message",
        "local": "local",
        "action": "action",
        "hilite": "hilite",
        "message": "message",
    }

    @classmethod
    def _chat_kind(cls, raw):
        """Map an upstream message_type onto a valid kind.

        Falls back to "message" for anything unrecognised ON PURPOSE. An
        unmapped value must never be able to drop a user's message again: a
        line shown with a slightly wrong style is a cosmetic problem, a line
        thrown away is a lost conversation.
        """
        return cls.CHAT_KINDS.get(raw or "", "message")

    def _own_username(self):
        return self.core.users.login_username or ""

    def _on_room_message(self, msg):
        self.bridge.broadcast("chat.message", self._chat_line(
            "room", msg.room, msg.user, msg.message,
            outgoing=msg.user == self._own_username(),
            kind=self._chat_kind(getattr(msg, "message_type", None)),
            mentioned=bool(getattr(msg, "mention_type", None)),
        ))

    def _on_room_echo(self, room, text, message_type):
        self.bridge.broadcast("chat.message", self._chat_line(
            "room", room, self._own_username(), text,
            outgoing=True, kind=self._chat_kind(message_type or "local"),
        ))

    def _on_private_message(self, msg, **_unused):
        """A private message. Upstream reports BOTH directions on this event.

        `privatechat.send_message()` ends with
        `events.emit("message-user", MessageUser(username, message))`, where
        `username` is the RECIPIENT — the same field that holds the SENDER on an
        incoming message, and the same event name. Read naively, every message
        you send is rendered in your own window under the other person's name.
        Measured against the live server: sending to `bob` displayed
        "bob: <your text>".

        The two are told apart by `message_id`. It is assigned in
        `parse_network_message`, so it exists only on a message that really came
        off the wire; the outgoing emit builds the object in memory and leaves
        it None. Do not switch this to comparing `msg.user` against our own
        username — that is the one case where it cannot work, because messaging
        yourself makes sender and recipient identical, which is exactly the test
        that hid this bug in the first place.
        """
        outgoing = getattr(msg, "message_id", None) is None
        self.bridge.broadcast("chat.message", self._chat_line(
            "private", msg.user,
            self._own_username() if outgoing else msg.user,
            msg.message,
            outgoing=outgoing,
            kind=self._chat_kind(getattr(msg, "message_type", None)),
            # You cannot be mentioned by yourself.
            mentioned=(not outgoing) and bool(getattr(msg, "mention_type", None)),
            # The server's timestamp, not ours: private messages are delivered
            # offline and our clock would misdate everything sent while away.
            timestamp=getattr(msg, "timestamp", None),
        ))

    def _on_private_echo(self, user, text, message_type):
        self.bridge.broadcast("chat.message", self._chat_line(
            "private", user, self._own_username(), text,
            outgoing=True, kind=self._chat_kind(message_type or "local"),
        ))

    def _on_join_room(self, msg):
        self._emit_members(msg.room, [u.username for u in (msg.users or [])])
        self._emit_rooms()

    def _on_leave_room(self, msg):
        self._emit_rooms()

    def _on_room_user_change(self, msg):
        room = getattr(msg, "room", None)
        if not room:
            return
        users = self.core.chatrooms.joined_rooms.get(room)
        names = sorted(users.users) if users and getattr(users, "users", None) else []
        self._emit_members(room, names)

    def _on_room_list(self, msg):
        self._emit_rooms(msg)

    def _emit_members(self, room, names):
        self.bridge.broadcast("chat.members", {"room": room, "users": list(names)})

    def _emit_rooms(self, msg=None):
        joined = set(getattr(self.core.chatrooms, "joined_rooms", {}) or {})
        counts = {}
        private = set()
        if msg is not None:
            for name, count in (getattr(msg, "rooms", None) or []):
                counts[name] = count
            for attr in ("ownedprivaterooms", "otherprivaterooms"):
                for name, count in (getattr(msg, attr, None) or []):
                    counts[name] = count
                    private.add(name)
            self._room_counts = counts
            self._private_rooms = private
        else:
            counts = getattr(self, "_room_counts", {})
            private = getattr(self, "_private_rooms", set())

        names = set(counts) | joined
        rooms = [{
            "name": name,
            "userCount": int(counts.get(name, 0)),
            "joined": name in joined,
            "private": name in private,
        } for name in sorted(names)]
        self.bridge.broadcast("chat.rooms", {"rooms": rooms})

    def _cmd_chat_rooms(self, _params):
        self._require_online()
        self.core.chatrooms.request_room_list()
        return {}

    def _cmd_chat_join(self, params):
        self._require_online()
        self.core.chatrooms.show_room(params["room"])
        return {}

    def _cmd_chat_leave(self, params):
        self.core.chatrooms.remove_room(params["room"])
        self._emit_rooms()
        return {}

    def _cmd_chat_say(self, params):
        self._require_online()
        target = params["target"]
        message = params["message"]
        if params["scope"] == "room":
            self.core.chatrooms.send_message(target, message)
        else:
            self.core.privatechat.show_user(target, switch_page=False)
            self.core.privatechat.send_message(target, message)
        return {}

    def _cmd_chat_open(self, params):
        self._require_online()
        self.core.privatechat.show_user(params["username"], switch_page=False)
        return {}

    # -- local paths --------------------------------------------------------

    # These exist because `settings.patch` used to write whatever string it was
    # handed. A mistyped download folder is not a cosmetic problem: every
    # transfer then fails with upstream's `download_folder_error`, one file at a
    # time, with nothing on the settings screen suggesting the folder is why.

    @staticmethod
    def _resolve_path(path):
        # Empty stays empty. os.path.abspath("") returns the CURRENT WORKING
        # DIRECTORY, so without this an empty field resolves to whatever folder
        # the sidecar happened to be launched from — which then reports itself
        # as an existing, writable, perfectly good download folder.
        raw = str(path or "").strip()
        if not raw:
            return ""
        # expandvars BEFORE expanduser, and both before abspath. Upstream's
        # config genuinely holds paths like `${NICOTINE_DATA_HOME}/incomplete`
        # — that is the shipped default for the in-progress folder — and it
        # expands them with os.path.expandvars at the point of use
        # (pynicotine/downloads.py). Checking the unexpanded string reports
        # that a perfectly good folder does not exist.
        return os.path.abspath(os.path.expanduser(os.path.expandvars(raw)))

    @staticmethod
    def _writable_dir(path):
        """Whether a file can actually be created in `path`.

        Deliberately not `os.access(path, os.W_OK)`. That reads the permission
        bits, which is the wrong question on the two failures that matter on a
        Mac: a read-only mount and a TCC-protected folder (Desktop, Documents,
        an external volume) both report the user as having write permission,
        because they do — the refusal comes from the volume or the sandbox, and
        neither is in the mode. Writing a file is the only honest test.
        """
        if not os.path.isdir(path):
            return False
        probe = os.path.join(path, f".seek-write-test-{uuid.uuid4().hex}")
        try:
            with open(probe, "w"):
                pass
        except OSError:
            return False
        try:
            os.unlink(probe)
        except OSError:
            pass
        return True

    def _path_check(self, path):
        resolved = self._resolve_path(path)
        if not resolved:
            return {
                "path": str(path or ""), "resolved": "", "exists": False,
                "isDirectory": False, "writable": False,
                "parentExists": False, "parentWritable": False,
            }
        parent = os.path.dirname(resolved.rstrip(os.sep)) or os.sep
        is_dir = os.path.isdir(resolved)
        parent_exists = os.path.isdir(parent)
        return {
            "path": str(path or ""),
            "resolved": resolved,
            "exists": os.path.exists(resolved),
            "isDirectory": is_dir,
            "writable": self._writable_dir(resolved),
            "parentExists": parent_exists,
            "parentWritable": self._writable_dir(parent) if parent_exists else False,
        }

    def _cmd_fs_check(self, params):
        return self._path_check(params["path"])

    def _cmd_fs_ensureFolder(self, params):
        resolved = self._resolve_path(params["path"])
        if not resolved or resolved == os.sep:
            raise CommandError("bad_request", "a folder path is required")
        try:
            os.makedirs(resolved, exist_ok=True)
        except OSError as error:
            raise CommandError(
                "bad_request", f"could not create {resolved}: {error.strerror or error}"
            ) from error
        return self._path_check(resolved)

    def _require_writable_dir(self, label, path):
        """Resolve a folder for the config, or refuse with a reason.

        Returns the resolved path, so the config never stores `~` — upstream
        expands nothing, and a literal `~/Music` becomes a directory called `~`
        beside wherever the process happened to start.
        """
        check = self._path_check(path)
        if not check["exists"]:
            raise CommandError("bad_request", f"{label} does not exist: {check['resolved']}")
        if not check["isDirectory"]:
            raise CommandError("bad_request", f"{label} is not a folder: {check['resolved']}")
        if not check["writable"]:
            raise CommandError("bad_request", f"{label} is not writable: {check['resolved']}")
        return check["resolved"]

    def _cmd_settings_get(self, _params):
        return {"settings": self._read_settings()}

    def _cmd_settings_patch(self, params):
        patch = params["settings"]
        transfers = self.config.sections["transfers"]
        server = self.config.sections["server"]

        if patch.get("downloadFolder") is not None:
            transfers["downloaddir"] = self._require_writable_dir(
                "the download folder", patch["downloadFolder"]
            )
        if patch.get("incompleteFolder") is not None:
            transfers["incompletedir"] = self._require_writable_dir(
                "the in-progress folder", patch["incompleteFolder"]
            )
        if patch.get("uploadSlots") is not None:
            transfers["uploadslots"] = int(patch["uploadSlots"])
        if patch.get("listenPort") is not None:
            port = int(patch["listenPort"])
            server["portrange"] = (port, port)
        if patch.get("autoConnect") is not None:
            server["auto_connect_startup"] = bool(patch["autoConnect"])

        # Upstream stores limits in KiB/s and gates them behind a mode string;
        # the wire is bytes/sec throughout, so convert and set the mode.
        for wire_key, limit_key, mode_key in (
            ("maxDownloadSpeed", "downloadlimit", "use_download_speed_limit"),
            ("maxUploadSpeed", "uploadlimit", "use_upload_speed_limit"),
        ):
            if patch.get(wire_key) is None:
                continue
            value = int(patch[wire_key])
            if value <= 0:
                transfers[mode_key] = "unlimited"
            else:
                transfers[mode_key] = "primary"
                transfers[limit_key] = max(1, value // KIB)

        if patch.get("stallSeconds") is not None:
            self.transfers.stall_seconds = int(patch["stallSeconds"])

        self.core.downloads.update_transfer_limits()
        self.core.uploads.update_transfer_limits()
        self.config.write_configuration()
        return {"settings": self._read_settings()}

    def _read_settings(self):
        transfers = self.config.sections["transfers"]
        server = self.config.sections["server"]

        def limit(limit_key, mode_key):
            if transfers.get(mode_key) == "unlimited":
                return 0
            return int(transfers.get(limit_key) or 0) * KIB

        # The folders are reported EXPANDED. The config may hold
        # `${NICOTINE_DATA_HOME}/incomplete`, which is a real and working value
        # upstream but not one a person can act on: it cannot be pasted into
        # Finder, and a settings field showing it invites an edit that would
        # then be refused. Expanding here does not rewrite the config — the
        # placeholder survives until the user actually changes the folder.
        return {
            "downloadFolder": self._resolve_path(transfers.get("downloaddir")) or None,
            "incompleteFolder": self._resolve_path(transfers.get("incompletedir")) or None,
            "listenPort": int((server.get("portrange") or (0, 0))[0]),
            "maxDownloadSpeed": limit("downloadlimit", "use_download_speed_limit"),
            "maxUploadSpeed": limit("uploadlimit", "use_upload_speed_limit"),
            "uploadSlots": int(transfers.get("uploadslots") or 0),
            "autoConnect": bool(server.get("auto_connect_startup")),
            "stallSeconds": int(self.transfers.stall_seconds),
        }


class CommandError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
