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
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import (
    checksums, discover as discover_mod, enrich, handoff, library as library_mod,
    logfile, nicotine_import, registries, translate, youtube_oauth,
)
from .protocol import PROTOCOL_VERSION

# pynicotine's own decoder for the profile description. Upstream stores that
# field as a Python repr(); `unescape` is the exact inverse and is what
# UserInfo uses when it sends the field to a peer.
from pynicotine import utils

log = logging.getLogger("seek.core")

SIDECAR_VERSION = "0.3.0"

# Upstream speed limits are in KiB/s; our wire is bytes/sec everywhere.
KIB = 1024

# How many already-seen results one wish remembers. Twice the frontend's 1,000
# results per run, because ids collect across runs as peers come and go: at
# 250, a big wish forgot part of what you had seen and announced it as new
# after every restart. Ids are 8 hex characters, so a full wish is ~24 KB.
WISH_SEEN_CAP = 2000

# How many greeted peers we remember. Far larger than WISH_SEEN_CAP because the
# entries are just usernames and forgetting one means greeting somebody twice —
# the single thing the feature exists to avoid. Ten thousand of them is well
# under a megabyte.
GREETED_CAP = 10_000

# The upload greeting, before the user edits it. One line, because the server
# strips line breaks out of a private message (privatechat.py `send_message`),
# and it does not thank anyone for anything — a stranger taking a file has not
# done you a favour.
DEFAULT_UPLOAD_GREETING = (
    "Hey — thanks for stopping by. I'm sharing through Seek, a Mac Soulseek "
    "client: https://github.com/IvaKap/seek"
)

# Guards the read-modify-write of seek-state.json. Until the YouTube tab, every
# writer ran on pynicotine's main thread and could not race itself; enrichment
# writes matches from the discover worker pool, so the file's load→mutate→dump
# now has to be atomic against a concurrent write from either side. Re-entrant
# because `_save_state` loads inside the same lock. One process, one CoreHost
# (test_integration.py owns the only instance), so a module lock is enough.
_STATE_LOCK = threading.RLock()

# A YouTube row before its Discogs lookup has run. Copied per row, never shared.
_YT_PENDING = {
    "status": "pending", "discogsId": None, "artist": "", "track": "",
    "album": "", "genres": [], "styles": [], "releaseUrl": "",
}

# Components deliberately left out (RECON.md §2):
#   update_checker  — calls out to pypi.org on start. The brief says no
#                     telemetry, and an unsolicited outbound request tied to
#                     startup is close enough to the line.
#   now_playing     — the only D-Bus/GTK surface in the core.
#   cli / signal_handler / error_handler — the sidecar owns its lifecycle.
#
# `portmapper` (UPnP / NAT-PMP) used to be on this list, as "should be a user
# setting, not a default" — and then the setting never came, so Seek simply
# never forwarded its port. Behind a home router that means no peer can open a
# connection to us, and when the peer is ALSO behind one, nobody can: the
# download sits on "They did not answer". It is now enabled, and gated by
# upstream's own `server.upnp` (default True, as in Nicotine+), which
# `Settings.portMapping` exposes. Upstream checks that flag at every mapping
# attempt (portmapper.py:620, :696), so the switch needs no restart.
BASE_COMPONENTS = {
    "network_thread", "users", "notifications", "network_filter",
    "statistics", "search", "downloads", "uploads", "interests",
    "userbrowse", "userinfo", "buddies", "pluginhandler", "portmapper",
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

    #: Why the server last signed us out, for `_on_server_disconnect`. Class
    #: defaults, so a test host built without __init__ has them too.
    _relogged = False      # the server said the account signed in elsewhere
    _signing_out = False   # Seek asked for this disconnect itself
    #: Set when Seek is quitting, so a long copy to a USB stick stops between
    #: chunks instead of holding the exit for the whole album.
    _quitting = False

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
        stall = self._load_state().get("stall_seconds")
        if isinstance(stall, int) and stall > 0:
            self.transfers.stall_seconds = stall

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
        # Paths upstream named in `shares-unavailable`: it refused to rescan
        # because they could not be read. Cleared by `shares-scanning`, which
        # only fires when a scan really starts.
        self._share_unavailable = []
        self._folder_requests = {}   # (username, folderPath) -> [request info], oldest first
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

        # File work that follows a download, and the commands that move or
        # rewrite files (Organise, Fix tags). Its own worker so a long library
        # scan on the analysis pool never holds a finished download hostage, and
        # ONE worker so the jobs for a release run in order — the last file's
        # artwork is written before its folder is moved, never after.
        self._post_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="SeekPostDownload"
        )
        # The library walk, alone. On the analysis worker, a scan of a big
        # collection held covers, Verify and gap checks behind it for minutes.
        self._scan_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="SeekLibraryScan"
        )
        # Where a file went when Seek moved it: old path -> new path. Read by the
        # resolver so Verify and Fix tags keep working after an Organise, and by
        # a queued job whose file moved before it ran.
        self._moved_paths = {}
        # The request a command handler is answering, for `_defer`.
        self._replying = None

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
        # Shares is ALWAYS enabled, even when nothing is shared. Upstream's
        # download re-enqueue path (downloads.py `_enqueue_transfer`)
        # dereferences `core.shares.initialized` UNCONDITIONALLY — it even has a
        # branch for "shares not yet initialized" — so a None shares component
        # crashes the engine the instant a restored queued download's peer comes
        # online (`_user_status` -> `_enqueue_transfer`). With any queued or
        # incomplete transfer left over from a previous session that is
        # essentially every launch, which is the "Sidecar unreachable" crash.
        #
        # An empty shares component advertises no files; consent and folders
        # still gate what is actually shared (see `shares.set`). So this is a
        # crash-safety change, not a privacy one.
        components = set(BASE_COMPONENTS)
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
            ("log-message", self._on_upstream_log),
            ("set-connection-stats", self._on_connection_stats),
            ("set-wishlist-interval", self._on_wishlist_interval),
            ("file-search-response", self._on_search_response),
            ("search-failed", self._on_search_failed),
            ("remove-search", self._on_search_removed),
            ("user-stats", self._on_user_stats),
            ("user-status", self._on_user_status),
            ("ignore-user", self._on_user_lists_changed),
            ("unignore-user", self._on_user_lists_changed),
            ("ban-user", self._on_user_lists_changed),
            ("unban-user", self._on_user_lists_changed),
            ("user-info-response", self._on_user_info_response),
            ("user-info-failed", self._on_user_info_failed),
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
            ("user-joined-room", self._on_user_joined_room),
            ("user-left-room", self._on_user_left_room),
            ("room-list", self._on_room_list),
            ("shares-scanning", self._on_shares_scanning),
            ("shares-ready", self._on_shares_ready),
            ("shares-unavailable", self._on_shares_unavailable),
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
        self._quitting = True

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

        # A library walk can run for minutes, and Python waits for pool threads
        # at exit, so quitting mid-scan sat out the shell's whole grace period
        # and ended in a kill. Ask it to stop; the old index is kept.
        if getattr(self, "_library_index", None) is not None:
            self._library_index.cancel()
        self._analysis_pool.shutdown(wait=False)
        self._discover_pool.shutdown(wait=False)
        self._post_pool.shutdown(wait=False)
        self._scan_pool.shutdown(wait=False)

        try:
            self.config.write_configuration()
        except Exception:
            log.exception("could not write configuration on shutdown")

    def _pump_commands(self):
        for websocket, request_id, command, params in self.bridge.drain():
            self._replying = (websocket, request_id, command)
            try:
                result = self.dispatch(command, params)
            except CommandError as error:
                self.bridge.reply_error(websocket, request_id, error.code, str(error))
                continue
            except Exception as error:
                log.exception("command %s failed", command)
                self.bridge.reply_error(websocket, request_id, "internal", str(error))
                continue
            finally:
                self._replying = None
            if result is DEFERRED:
                continue
            self.bridge.reply(websocket, request_id, result)

    def _defer(self, work, *args):
        """Answer the current command from the post-download worker.

        For commands that make network calls or move files. Organise and Fix
        tags called MusicBrainz ON THIS THREAD — a 12 s timeout per request and
        a rate limit that sleeps — so one press froze every transfer, search
        result and chat line until it came back. The client still gets an
        ordinary reply to the request it sent; it just comes from the worker.
        """
        websocket, request_id, command = self._replying

        def run():
            try:
                result = work(*args)
            except CommandError as error:
                self.bridge.reply_error(websocket, request_id, error.code, str(error))
            except Exception as error:                 # noqa: BLE001 - worker
                log.exception("command %s failed", command)
                self.bridge.reply_error(websocket, request_id, "internal", str(error))
            else:
                self.bridge.reply(websocket, request_id, result)

        self._post_pool.submit(run)
        return DEFERRED

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

    def _on_upstream_log(self, _timestamp_format, msg, *_rest):
        """Hear upstream say the account signed in somewhere else.

        The server's Relogged message is handled inside the network thread and
        never reaches the event bus; the only trace it leaves is this log line,
        written just before the disconnect event is queued. Runs on whichever
        thread logged, so it only sets a flag. Compared through upstream's own
        `_`, so a translated line still matches; tests/test_signin.py pins the
        wording against upstream's source.
        """
        if msg == _("Someone logged in to your Soulseek account elsewhere"):  # noqa: F821
            self._relogged = True

    def _on_server_login(self, msg):
        self._relogged = self._signing_out = False
        if msg.success:
            log.info("signed in to the Soulseek server")
            # Upstream's own login handler runs first and restores a saved
            # away status (users.py), so ask it rather than assume online.
            away = self.core.users.login_status == self.UserStatus.AWAY
            self._connection.update({
                "status": "away" if away else "online",
                "username": msg.username,
                "publicAddress": msg.ip_address,
                "error": None,
            })
        else:
            # A code such as INVALIDPASS: no name, no password.
            log.warning("sign-in refused: %s", msg.rejection_reason or "no reason given")
            self._connection.update({
                "status": "failed",
                "username": None,
                "error": msg.rejection_reason or "login rejected",
            })
        self.bridge.broadcast("connection.state", dict(self._connection))

    def _on_server_disconnect(self, msg):
        """Signed out, and why, because "Not signed in" alone sent a person
        hunting. A dropped connection upstream retries by itself; the server
        ending the session it does not, so that one is reported as an error:
        `relogged` when the server said the account signed in elsewhere, and
        `server_closed` for the rarer endings (a message it could not read)."""
        manual = getattr(msg, "manual_disconnect", False)
        error = None
        if self._relogged:
            error = "relogged"
        elif self._connection.get("status") == "failed":
            # A refused login closes the connection too; its reason stands.
            error = self._connection.get("error")
        elif manual and not self._signing_out and not getattr(self, "_shutdown_done", False):
            error = "server_closed"
        self._relogged = self._signing_out = False
        if error in ("relogged", "server_closed"):
            log.warning("signed out by the server (%s); not signing in again by itself", error)
        elif manual:
            log.info("signed out")
        else:
            log.info("lost the connection to the server; upstream will reconnect")
        self._connection.update({
            "status": "offline", "username": None, "publicAddress": None, "error": error,
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

        return translate.picture_data_uri(data), "", len(data)

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

        self._persist_config()
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

    def _adopt_wishlist_search(self, token):
        """Register a wishlist run the first time results arrive for it.

        THE WISHLIST WAS WRITE-ONLY WITHOUT THIS. `searches.add` was called from
        exactly one place — `search.start`, a search the user ran — and
        `accept()` drops any token it does not know. Upstream mints its own
        token for a wish and emits NO event when the timer fires it
        (`add-search` comes from `do_search`, the manual path, only). So every
        automatic result was thrown away at this door: the wish was registered,
        upstream re-ran it forever, and Seek never showed a single hit.

        Adopting on first response rather than at add time is deliberate. A wish
        keeps ONE token across every re-run, so there is no start to hook — but
        there is always a first result, and that is the moment the search
        becomes worth having.

        Upstream conveniently files a wish in BOTH of its maps —
        `wishlist[term] = searches[token] = search` — so this is a direct
        lookup and needs no scan.
        """
        known = self.searches.get(token)
        if known is not None and known.closed is None:
            return
        upstream = self.core.search.searches.get(token)
        if upstream is None or getattr(upstream, "mode", None) != "wishlist":
            return
        # A wish you removed, answered by a peer who was still replying to its
        # last run. Adopting it would bring the removed wish back on screen.
        if upstream.term not in self.core.search.wishlist:
            return
        # `add` REPLACES any entry under this token, which is what a re-run
        # needs: the previous run's results are done with, and carrying them
        # forward would walk the result cap up until the search closed itself
        # and started dropping again.
        search = self.searches.add(
            token, upstream.term, upstream.term_transmitted, "wishlist",
        )
        # Not the term: the log is for bug reports, and Settings promises it
        # holds "not what you searched for".
        log.info("a wishlist search produced results")
        self.bridge.broadcast("search.started", search.info())

    def _on_search_response(self, msg):
        if msg.token is None or msg.list is None:
            return  # rejected upstream: unknown token, or an ignored user/IP
        self._adopt_wishlist_search(msg.token)
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
        # Our own status: away was set or cleared (upstream fakes this event
        # for itself in `set_away_mode`, since the server sends none).
        if msg.user == self._connection.get("username") and \
                self._connection.get("status") in ("online", "away"):
            status = translate.user_status(msg.status)
            if status in ("online", "away") and status != self._connection["status"]:
                self._connection["status"] = status
                self.bridge.broadcast("connection.state", dict(self._connection))
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

    def _on_user_info_response(self, msg):
        # This event also fires for OUR OWN profile if `userinfo.show_user()`
        # is ever called with no username; Seek never does that (the outbound
        # `profile.get` command reads local config directly instead), so
        # every message reaching this handler is a real peer's answer.
        if not getattr(msg, "username", None):
            return
        self.bridge.broadcast("user.info.result", translate.user_info(msg))

    def _on_user_info_failed(self, username, is_offline=False):
        self.bridge.broadcast("user.info.failed", {
            "username": username,
            "reason": "offline" if is_offline else "failed",
        })

    def _on_folder_contents(self, msg):
        if msg.dir is None or msg.list is None:
            return
        key = (msg.username, msg.dir)
        # One answer settles every Get still waiting on this folder, oldest
        # first. A second Get used to REPLACE the first, losing its Download
        # to… folder; now the first queues, and upstream drops the second's
        # files as duplicates — what would have happened had the peer answered
        # between the two clicks.
        requests = self._folder_requests.pop(key, [])
        folders = translate.folder_refs_from_contents(msg.list)

        enqueued = 0
        held = None
        for request in requests:
            files = self._folder_files(msg.dir, folders, request["recurse"])
            limit = request["confirmAbove"]
            if limit is not None and len(files) > limit:
                # Only here is the real count known: a search shows a fraction
                # of a folder. Held, not queued; the app asks and sends again.
                if held is None:
                    held = {"count": len(files), "recurse": request["recurse"],
                            "destination": request["destination"]}
                continue
            enqueued += self._enqueue_folder_files(
                msg.username, msg.dir, files, request["destination"],
            )

        self.bridge.broadcast("folder.contents", {
            "requestId": requests[0]["requestId"] if requests else "",
            "username": msg.username,
            "folderPath": msg.dir,
            "folders": folders,
            "enqueued": enqueued,
            "held": held,
        })

    def _on_folder_contents_failed(self, username, folder_path, is_offline=False):
        requests = self._folder_requests.pop((username, folder_path), [])
        self.bridge.broadcast("folder.contents.failed", {
            "requestId": requests[0]["requestId"] if requests else None,
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
        # Organise the release as one, after its files' artwork jobs — the
        # worker is FIFO, so those were queued first.
        if not folder_path or not self._app_settings().get("autoOrganise"):
            return
        if not self._lookups_allowed():
            return
        real_root = self._real_download_root()
        if real_root is not None:
            self._post_pool.submit(self._organise_folder_quietly, folder_path, real_root)

    def _organise_folder_quietly(self, folder_path, real_root):
        try:
            self._organise_folder(folder_path, real_root)
        except Exception as error:                     # noqa: BLE001 - worker
            log.warning("organising a release failed: %s", type(error).__name__)

    def _on_shares_scanning(self, *_args, **_kwargs):
        self._share_scanning = True
        # At launch upstream reports the missing share and THEN scans anyway
        # (init=True carries on to load the old index, shares.py:1150-1163), so
        # the report that came with this very scan must survive it. Any later
        # scan without a report means the shares are all back.
        if getattr(self, "_share_unavailable_fresh", False):
            self._share_unavailable_fresh = False
        else:
            self._share_unavailable = []
        self.bridge.broadcast("shares.state", self._share_state())

    def _on_shares_unavailable(self, shares=(), *_args, **_kwargs):
        # Upstream's rescan refused (shares.py:1144-1153) and said nothing else.
        # Seek ignored this event, so "Indexing…" never appeared, nothing said
        # why, and the stale index went on being served.
        self._share_unavailable = sorted({
            str(entry[1]) for entry in (shares or ())
            if isinstance(entry, (list, tuple)) and len(entry) >= 2
        })
        self._share_unavailable_fresh = True
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
        # Under the lock so a read never sees a half-written file mid-dump.
        with _STATE_LOCK:
            path = self._state_path()
            try:
                with open(path, encoding="utf-8") as handle:
                    data = json.load(handle)
                    return data if isinstance(data, dict) else {}
            except FileNotFoundError:
                return {}
            except (OSError, ValueError):
                # A parse error on an EXISTING file is DAMAGED state, not absent
                # state. Silently returning {} here is how one truncated write
                # erased everything: the next _save_state rebuilds the file from
                # {}, keeping only the keys written that session and dropping the
                # rest for good — the Discogs token, wish filters, saved searches,
                # share consent. Preserve the file so the loss is loud and
                # recoverable rather than silent and permanent. (Atomic writes
                # below make this path rare; this is the belt to that braces.)
                try:
                    if os.path.getsize(path) > 0:
                        aside = f"{path}.corrupt-{int(time.time())}"
                        os.replace(path, aside)
                        log.error("seek-state.json was unreadable; kept it at %s", aside)
                except OSError:
                    log.exception("seek-state.json unreadable and could not be set aside")
                return {}

    def _save_state(self, **updates):
        # The whole load→update→dump is one critical section: a worker writing a
        # match and the main thread writing a setting must not clobber each
        # other. RLock, because _load_state re-enters it.
        with _STATE_LOCK:
            state = self._load_state()
            state.update(updates)
            try:
                os.makedirs(self.data_folder, exist_ok=True)
                # ATOMIC: write a temp file, fsync it, then os.replace onto the
                # real path. A crash or a kill (the app kills the sidecar on
                # exit) mid-write then leaves EITHER the old complete file or the
                # new complete one — never the truncated JSON that _load_state
                # would read as {} and the next save would cement into total loss.
                path = self._state_path()
                tmp = f"{path}.tmp"
                # 0600: this file holds the Discogs token, API keys and the
                # Google refresh token, and was readable by every account on
                # the Mac. os.replace keeps the temp file's mode.
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                os.chmod(tmp, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(state, handle, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, path)
                self._state_write_failed = False
            except OSError:
                log.exception("could not persist Seek state")
                self._state_write_failed = True
            return state

    def _store(self, **updates):
        """`_save_state` for a command that answers the person who asked: a
        write that never reached the disk is an error, not a success. (Every
        save used to reply "done" and log the failure where nobody looks.)"""
        # Under the lock, so a worker's save cannot change the flag in between.
        with _STATE_LOCK:
            state = self._save_state(**updates)
            failed = getattr(self, "_state_write_failed", False)
        if failed:
            raise CommandError("internal", "could not save that to disk")
        return state

    def _persist_config(self):
        """Write the Nicotine+ config and check it landed. Upstream reports a
        failed write only in its log (config.write_configuration returns
        nothing), so the file itself is the evidence: upstream renames the old
        one to `.old` and writes a new file, so a real write changes the inode
        — which, unlike the modification time, cannot collide on a drive that
        keeps only whole seconds (HFS+)."""
        path = getattr(self.config, "config_file_path", None)

        def identity():
            try:
                st = os.stat(path) if path else None
            except OSError:
                return None
            return (st.st_ino, st.st_mtime_ns) if st else None

        before = identity()
        self.config.write_configuration()
        after = identity()
        if path and (after is None or after == before):
            raise CommandError("internal", "could not save the configuration to disk")

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
            "unavailable": list(self._share_unavailable),
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

        path = self._follow_move(path)
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

        The checks run here; the lookup and the move run on the post-download
        worker (see `_defer`), so a slow MusicBrainz never freezes the engine.
        """
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")

        path = self._resolve_local_file(params)
        real_root = self._real_download_root()
        if real_root is None:
            raise CommandError("bad_request", "no download folder is configured")
        if not self._inside(real_root, path):
            raise CommandError("bad_request", "that file is not in the download folder")
        return self._defer(self._organise_now, path, real_root)

    def _real_download_root(self):
        root = self._download_root()
        if not root or not os.path.isdir(root):
            return None
        return os.path.realpath(root)

    @staticmethod
    def _inside(real_root, path):
        # `realpath` first: a symlink out of the tree would otherwise pass.
        real_path = os.path.realpath(path)
        return os.path.commonpath([real_root, real_path]) == real_root

    def _release_summary_for(self, path):
        """The MusicBrainz release a downloaded file belongs to, or None.

        Worker thread: this may make two rate-limited requests. Cached by
        artist + release, so a whole album costs one lookup, not fifteen.
        """
        current = enrich.read_tags(path)
        folder = os.path.basename(os.path.dirname(path))
        artist = current.get("albumartist") or current.get("artist") or ""
        release = current.get("album") or folder
        cache = self._art_cache()
        ckey = enrich.cache_key(artist, release)
        summary = cache.get_meta(ckey)
        if summary is None:
            match = enrich.mb_search_release(artist, release)
            if match:
                summary = enrich.release_summary(enrich.mb_release_detail(match["id"]))
                summary["score"] = int(match.get("score", 0))
                cache.put_meta(ckey, summary)
        return summary or None

    def _organise_now(self, path, real_root):
        """Worker body of Organise for ONE file."""
        path = self._follow_move(path)
        summary = self._release_summary_for(path)
        if not summary:
            return {
                "moved": False, "fromPath": path, "toPath": "",
                "reason": "no confident MusicBrainz match, so nothing was moved",
            }

        target = enrich.organised_path(real_root, summary, os.path.basename(path))
        if os.path.realpath(target) == os.path.realpath(path):
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

        self._record_moves([(path, target)])
        return {"moved": True, "fromPath": path, "toPath": target, "reason": ""}

    def _organise_folder(self, folder, real_root):
        """Move a finished release folder — the audio AND everything beside it —
        into Artist/Year - Album/. Worker thread.

        The whole folder, not file by file: a release's `.ffp`, `.md5`, cue and
        cover only mean anything next to its audio, and moving the tracks out
        from under them would break the checksum check on every organised
        release. Same rules as Organise: never outside the download folder,
        never over an existing file, never without a confident match.
        """
        real_folder = os.path.realpath(folder)
        if real_folder == real_root or not self._inside(real_root, real_folder):
            return []
        try:
            names = sorted(os.listdir(real_folder))
        except OSError:
            return []
        audio = [n for n in names if os.path.splitext(n)[1].lower() in enrich.AUDIO_EXTENSIONS]
        if not audio:
            return []
        summary = self._release_summary_for(os.path.join(real_folder, audio[0]))
        if not summary:
            return []
        target_dir = os.path.dirname(enrich.organised_path(real_root, summary, "_"))
        if os.path.realpath(target_dir) == real_folder:
            return []

        moves = []
        os.makedirs(target_dir, exist_ok=True)
        for name in names:
            src = os.path.join(real_folder, name)
            dst = os.path.join(target_dir, name)
            if not os.path.isfile(src) or os.path.exists(dst):
                continue
            try:
                os.replace(src, dst)
            except OSError:
                continue
            moves.append((src, dst))
        try:
            os.rmdir(real_folder)                     # only succeeds when empty
        except OSError:
            pass
        self._record_moves(moves)
        return moves

    def _follow_move(self, path):
        """Where Seek moved `path` to — but only if nothing is there now. A
        later download can land at the old name, and that file is the one
        meant, not the one moved away from it."""
        if path and not os.path.exists(path):
            return self._moved_paths.get(path, path)
        return path

    def _record_moves(self, moves):
        """Remember where files went, and tell the core — on ITS thread."""
        if not moves:
            return
        for old, new in moves:
            self._moved_paths[old] = new
        self.events.invoke_main_thread(self._apply_moves, list(moves))

    def _apply_moves(self, moves):
        """Point finished downloads at where their files now live.

        Upstream finds a finished file from the transfer's `folder_path`, so a
        moved file read as missing: Verify and Fix tags failed with "no such
        file", and the row kept pointing at an empty folder. Updating the
        folder keeps every later lookup — Verify, Fix tags, Show in Finder,
        and the next launch, since upstream saves it — pointing at the file.
        """
        moved = dict(moves)
        downloads = getattr(self.core, "downloads", None)
        if downloads is None:
            return
        for upstream in list(downloads.transfers.values()):
            if translate.transfer_state(upstream.status) != "finished":
                continue
            current = downloads.get_current_download_file_path(upstream)
            new = moved.get(current)
            if new is None:
                continue
            upstream.folder_path = os.path.dirname(new)
            self._emit_transfer(upstream, "download", None)

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
        # Off. This switch was shown ON for a long time while doing nothing at
        # all; now that it rewrites files, it must not start doing so for
        # everyone who never chose it. Anyone who did choose it keeps it.
        "embedArtwork": False,
        "writeCoverFile": False,
        "autoDigSessions": True,
        "checkUpdates": True,
        # Both off by default. The first changes where a download APPEARS and
        # the second forgets records, and neither should start happening to
        # somebody who never asked for it.
        "stalledFailMinutes": 0,
        "clearCompletedDays": 0,
        # Off, and it stays off until someone turns it on: this one sends
        # messages to strangers, which is not something to start doing on a
        # user's behalf because they installed an update.
        "uploadGreetingEnabled": False,
        "uploadGreeting": DEFAULT_UPLOAD_GREETING,
        "acoustidApiKey": False,
        "youtubeApiKey": False,
        "youtubeOauthClientId": False,
        "youtubeOauthClientSecret": False,
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
        out["youtubeOauthClientId"] = bool(stored.get("youtubeOauthClientId"))
        out["youtubeOauthClientSecret"] = bool(stored.get("youtubeOauthClientSecret"))
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
                    "autoDigSessions", "uploadGreetingEnabled", "checkUpdates"):
            if params.get(key) is not None:
                stored[key] = bool(params[key])
        if params.get("uploadGreeting") is not None:
            # Emptying the box restores the default rather than sending a blank
            # message — an empty greeting is never what was meant. Newlines go
            # here rather than at the server, so what the box shows after a save
            # is what a peer will actually receive.
            text = " ".join(str(params["uploadGreeting"]).split())
            stored["uploadGreeting"] = text or DEFAULT_UPLOAD_GREETING
        if params.get("autoConnect") is not None:
            # Written to the pynicotine config, not Seek's state, because that is
            # where it is read from — and it keeps a real Nicotine+ install in
            # step if the user ever points one at the same folder.
            self.config.sections["server"]["auto_connect_startup"] = bool(
                params["autoConnect"]
            )
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
        oauth_changed = False
        for field in ("youtubeOauthClientId", "youtubeOauthClientSecret"):
            if params.get(field) is not None:
                value = str(params[field]).strip()
                if value:
                    stored[field] = value
                else:
                    stored.pop(field, None)
                oauth_changed = True
        if params.get("discogsToken") is not None:
            token = str(params["discogsToken"]).strip()
            if token:
                stored["discogsToken"] = token
            else:
                stored.pop("discogsToken", None)

        self._store(app_settings=stored)
        # The config after Seek's own file, so a failed config write costs
        # only this flag and the rest of the patch is still saved.
        if params.get("autoConnect") is not None:
            self._persist_config()
        # Apply the cap immediately rather than at next launch: a cache that
        # ignores its own setting until restart is a setting that does nothing.
        if getattr(self, "_artwork_cache", None) is not None:
            self._artwork_cache.cap = int(stored.get("artworkCacheMb", 500)) * 1024 * 1024

        state = self._app_settings()
        self.bridge.broadcast("app.settings", state)
        # Keep the Google-auth state in step: adding or clearing the client
        # credentials changes whether sign-in is possible, and anything reading
        # `youtube.auth` (or a stale cached one) must hear about it.
        if oauth_changed:
            self.bridge.broadcast("youtube.auth", self._youtube_auth_state())
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
        # EXPANDED. Upstream's default is the literal
        # "${NICOTINE_DATA_HOME}/downloads" and it only expands it at use, so
        # for anyone who never changed the folder this was not a directory:
        # Organise refused, and every after-download step silently skipped.
        return self._resolve_path(self.config.sections["transfers"].get("downloaddir"))

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
            "releaseArtist": artist, "score": 0, "tracks": [], "lookupFailed": False,
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
                                key,
                            ),
                        }
                        for t in (summary.get("tracks") or [])
                    ],
                })
        except Exception as error:                     # noqa: BLE001 - worker
            log.debug("gap lookup failed: %s", error)
            blank["lookupFailed"] = True
        self.bridge.broadcast("library.gaps", blank)

    def _cmd_library_scan(self, params):
        index = self._library()
        if index.state()["scanning"]:
            return index.state()
        # The download folder is always included; extras are added to it, never
        # instead of it, so a scan cannot silently forget where things land.
        roots = [self._download_root()] + list(params.get("roots") or [])
        read_tags = params.get("readTags")
        self._scan_pool.submit(
            self._run_library_scan, roots, True if read_tags is None else bool(read_tags),
        )
        state = index.state()
        state["scanning"] = True
        return state

    def _cmd_library_cancel(self, _params):
        # Takes effect at the next folder; the index from before stands.
        index = self._library()
        index.cancel()
        return index.state()

    def _run_library_scan(self, roots, read_tags):
        index = self._library()

        def progress(seen):
            state = index.state()
            state["scanning"] = True
            state["trackCount"] = seen
            self.bridge.broadcast("library.state", state)

        try:
            state = index.scan(roots, progress=progress, read_tags=read_tags,
                               download_root=self._download_root())
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
            "mbid": "", "changes": [], "lookupFailed": False,
            "md5Sibling": any(
                p.lower().endswith(".md5")
                for p in checksums.find_sidecars(self._checksum_folder(path))
            ),
        }
        # Read outside the lookup's try: a file whose tags cannot be read is
        # not a MusicBrainz outage, and must not be reported as one. The match
        # still runs, from the folder name.
        try:
            current = enrich.read_tags(path)
        except Exception:                              # noqa: BLE001 - a bad header
            current = {}
        try:
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
                # Only fields a file can hold. The label used to be proposed,
                # ticked, "written" in the count, and never written at all.
                "changes": [
                    {"field": f, "current": str(current.get(f, "")), "proposed": str(v)}
                    for f, v in changes.items() if f in enrich.TAG_FIELDS
                ],
            })
        except Exception as error:                     # noqa: BLE001 - worker
            log.debug("metadata lookup failed: %s", error)
            blank["lookupFailed"] = True
        self.bridge.broadcast("metadata.proposal", blank)

    def _cmd_metadata_apply(self, params):
        path = self._follow_move(params.get("path") or "")
        if not os.path.isfile(path):
            raise CommandError("not_found", f"no such file: {path}")
        fields = {
            f["field"]: f["proposed"]
            for f in (params.get("fields") or []) if f.get("field")
        }
        embed = bool(params.get("embedArtwork"))
        if embed and not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        clear = [f for f in (params.get("clear") or []) if f in enrich.TAG_FIELDS]
        return self._defer(
            self._apply_metadata, path, fields, embed,
            params.get("artist") or "", params.get("release") or "", clear,
        )

    def _apply_metadata(self, path, fields, embed, artist, release, clear=()):
        """Worker body of Fix tags.

        A missing cover no longer refuses the whole write. It used to raise
        before a single tag was written, so on exactly the obscure releases
        the panel exists for — the ones no cover service has — every checked
        correction was thrown away. Tags are written; the reply says whether
        the artwork made it.
        """
        art = None
        if embed:
            try:
                data, mime, _src = enrich.fetch_artwork(artist, release, self._art_cache())
                art = (data, mime)
            except Exception:                          # noqa: BLE001 - no cover is normal
                art = None
        # What is there now, so the reply can offer it back as Undo. If it
        # cannot be read, no Undo is offered: inventing empty values would make
        # Undo erase the tags it claims to restore.
        try:
            before = enrich.read_tags(path)
        except Exception:                              # noqa: BLE001 - undo is a bonus
            before = None
        try:
            enrich.write_tags(path, fields, art, clear)
        except Exception as error:                     # noqa: BLE001
            raise CommandError("internal", str(error)) from error
        touched = [f for f in fields if f in enrich.TAG_FIELDS] + list(clear)
        return {
            "path": path,
            "written": len([f for f in fields if f in enrich.TAG_FIELDS]),
            "artworkEmbedded": art is not None,
            "previous": [] if before is None else [
                {"field": f, "current": str(fields.get(f, "")), "proposed": str(before.get(f) or "")}
                for f in touched
            ],
        }

    # -- after a download finishes -------------------------------------------
    #
    # The three switches under Settings → After downloading were stored and
    # never read: turning on "Organise completed downloads" moved nothing.
    # These are them. Each runs on the post-download worker, never the main
    # loop, and each only ever touches files inside the download folder.

    def _after_download(self, upstream_transfer):
        """A download just finished (witnessed, not restored at launch)."""
        settings = self._app_settings()
        embed = bool(settings.get("embedArtwork"))
        cover = bool(settings.get("writeCoverFile"))
        organise = bool(settings.get("autoOrganise"))
        if not (embed or cover or organise) or not self._lookups_allowed():
            return
        real_root = self._real_download_root()
        if real_root is None:
            return
        path = self.core.downloads.get_current_download_file_path(upstream_transfer)
        if not path or not self._inside(real_root, path):
            return
        if os.path.splitext(path)[1].lower() not in enrich.AUDIO_EXTENSIONS:
            return
        # A single file lands loose in the download folder and gets no
        # folder-finished event (upstream skips the default folder,
        # downloads.py:453), so it is organised here. A file that is part of a
        # release waits for the folder, so the release moves as one.
        loose = os.path.realpath(os.path.dirname(path)) == real_root
        self._post_pool.submit(
            self._post_process_file, path, real_root, embed, cover, organise and loose,
        )

    def _post_process_file(self, path, real_root, embed, cover, organise):
        path = self._follow_move(path)
        if not os.path.isfile(path):
            return
        folder = os.path.dirname(path)
        # A loose file sits in the download folder itself, which is shared by
        # every loose download: a cover written there belongs to no release and
        # would stop the next one from getting its own.
        cover = cover and os.path.realpath(folder) != real_root
        # Separate tries: a file whose artwork step fails is still organised.
        if embed or cover:
            try:
                self._add_artwork(path, folder, embed, cover)
            except Exception as error:                 # noqa: BLE001 - worker
                log.warning("post-download artwork failed: %s", type(error).__name__)
        if organise:
            try:
                self._organise_now(path, real_root)
            except Exception as error:                 # noqa: BLE001 - worker
                log.warning("post-download organise failed: %s", type(error).__name__)

    def _add_artwork(self, path, folder, embed, cover):
        names = os.listdir(folder)
        # Rewriting tags changes the file's bytes, which breaks a whole-file
        # `.md5` the uploader published (an `.ffp` survives, being a hash of the
        # audio). The checksum is the only hard fact about those bytes, so a
        # folder that came with one keeps its files exactly as they arrived.
        embed = embed and not any(n.lower().endswith(".md5") for n in names)
        embed = embed and not enrich.has_artwork(path)
        has_cover = any(
            os.path.splitext(n)[0].lower() in ("cover", "folder", "front")
            and os.path.splitext(n)[1].lower() in (".jpg", ".jpeg", ".png")
            for n in names
        )
        cover = cover and not has_cover
        if not (embed or cover):
            return
        current = enrich.read_tags(path)
        artist = current.get("albumartist") or current.get("artist") or ""
        release = current.get("album") or os.path.basename(folder)
        try:
            data, mime, _src = enrich.fetch_artwork(artist, release, self._art_cache())
        except Exception:                              # noqa: BLE001 - no cover is normal
            return
        if embed:
            enrich.write_tags(path, {}, (data, mime))
        if cover:
            name = "cover.png" if "png" in (mime or "") else "cover.jpg"
            target = os.path.join(folder, name)
            if not os.path.exists(target):
                with open(target, "wb") as handle:
                    handle.write(data)

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

    # -- YouTube sheets ----------------------------------------------------
    #
    # A playlist, fetched once and kept as a persisted "sheet", each row a video
    # cross-referenced to a Discogs release. Discogs search is rate-gated and
    # costs two requests a row, so enrichment runs on the discover pool and
    # dribbles matches back on `youtube.sheet` rather than blocking a command.
    #
    # THE SEAM HOLDS: the sidecar fetches and searches, but the artist/title a
    # row is searched BY is parsed on the frontend (parseTitle.ts) and handed in
    # via `youtube.enrich` — Python derives nothing from a title here.

    def _yt_enriching(self):
        """Sheet ids with a live enrichment pass. Runtime only, not persisted."""
        current = getattr(self, "_yt_enriching_set", None)
        if current is None:
            current = set()
            self._yt_enriching_set = current
        return current

    def _youtube_sheets(self):
        stored = self._load_state().get("youtube_sheets")
        return list(stored) if isinstance(stored, list) else []

    def _mutate_youtube(self, fn):
        """Read → mutate → save the sheet list as one locked critical section.

        `fn(sheets)` edits the list in place and may return a value. Held under
        `_STATE_LOCK` for the whole span so a worker's match and a command's
        edit cannot interleave; a CommandError raised inside `fn` propagates
        without writing.
        """
        with _STATE_LOCK:
            sheets = self._youtube_sheets()
            result = fn(sheets)
            self._save_state(youtube_sheets=sheets)
            return result

    @staticmethod
    def _find_sheet(sheets, sheet_id):
        return next((s for s in sheets if s.get("id") == sheet_id), None)

    def _sheet_view(self, sheet):
        """The persisted sheet plus the two computed fields the wire wants."""
        view = dict(sheet)
        view.setdefault("lastFetchedAt", None)
        view["pending"] = sum(
            1 for r in sheet.get("rows", []) if r["match"]["status"] == "pending"
        )
        view["enriching"] = sheet.get("id") in self._yt_enriching()
        return view

    def _youtube_state(self):
        return {"sheets": [self._sheet_view(s) for s in self._youtube_sheets()]}

    def _youtube_row(self, item, details):
        vid = str(item.get("videoId") or "")
        detail = details.get(vid, {})
        return {
            "video": {
                "videoId": vid,
                "title": str(item.get("title") or ""),
                "channel": str(item.get("channel") or ""),
                "url": f"https://www.youtube.com/watch?v={vid}" if vid else "",
                "description": str(detail.get("description") or ""),
                "durationSeconds": detail.get("durationSeconds"),
                "publishedAt": detail.get("publishedAt"),
            },
            "match": dict(_YT_PENDING),
            "downloaded": False,
        }

    def _broadcast_sheet(self, sheet_id):
        sheet = self._find_sheet(self._youtube_sheets(), sheet_id)
        if sheet is not None:
            self.bridge.broadcast("youtube.sheet", self._sheet_view(sheet))

    def _broadcast_youtube_state(self):
        self.bridge.broadcast("youtube.state", self._youtube_state())

    def _apply_match(self, sheet_id, video_id, match):
        """Set one row's match. False if the sheet or row is gone (deleted mid-run)."""
        def fn(sheets):
            sheet = self._find_sheet(sheets, sheet_id)
            if sheet is None:
                return False
            for row in sheet["rows"]:
                if row["video"]["videoId"] == video_id:
                    row["match"] = match
                    return True
            return False
        return self._mutate_youtube(fn)

    def _youtube_fetch_failed(self, request_id, source_id, error):
        """Reuse discover.parseFailed — the youtube store keys it by requestId."""
        self.bridge.broadcast("discover.parseFailed", {
            "requestId": request_id, "url": source_id, "reason": str(error),
            "needs": getattr(error, "needs", ""),
            "unreachable": bool(getattr(error, "unreachable", False)),
            "unauthorised": bool(getattr(error, "unauthorised", False)),
        })

    def _cmd_youtube_list(self, _params):
        return self._youtube_state()

    def _cmd_youtube_addSheet(self, params):
        source = str(params.get("source") or "playlist")
        # Liked videos are the private 'LL' list, whatever id the caller sent.
        source_id = "LL" if source == "liked" else str(params.get("sourceId") or "").strip()
        title = str(params.get("title") or "").strip() or ("Liked videos" if source == "liked" else source_id)
        if not source_id:
            raise CommandError("bad_request", "no playlist id")
        if source == "liked" and not self._youtube_access_token():
            raise CommandError(
                "bad_request",
                "liked videos need Google sign-in — sign in first",
            )
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        request_id = registries.transfer_id("youtube.add", source_id)
        self._discover_pool.submit(
            self._run_add_sheet, request_id, source, source_id, title
        )
        return {"requestId": request_id}

    def _run_add_sheet(self, request_id, source, source_id, title):
        try:
            key = self._youtube_key()
            token = self._youtube_access_token()   # "" unless signed in
            listing = discover_mod.playlist_items(source_id, key, access_token=token)
            details = discover_mod.youtube_video_details(
                [it["videoId"] for it in listing["items"] if it.get("videoId")],
                key, access_token=token,
            )
        except discover_mod.DiscoverError as error:
            self._youtube_fetch_failed(request_id, source_id, error)
            return
        except Exception as error:                       # noqa: BLE001 - worker
            log.exception("youtube add failed for %s", source_id)
            self._youtube_fetch_failed(request_id, source_id, error)
            return

        now = int(time.time())
        sheet = {
            "id": uuid.uuid4().hex[:12],
            "title": title,
            "source": source,
            "sourceId": source_id,
            "rows": [self._youtube_row(it, details) for it in listing["items"]],
            "total": int(listing.get("total") or 0),
            "complete": bool(listing.get("complete", True)),
            "addedAt": now,
            "lastFetchedAt": now,
        }
        self._mutate_youtube(lambda sheets: sheets.append(sheet))
        self._broadcast_youtube_state()

    def _cmd_youtube_refreshSheet(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        sheet_id = str(params.get("sheetId") or "")
        if self._find_sheet(self._youtube_sheets(), sheet_id) is None:
            raise CommandError("not_found", "no such sheet")
        request_id = registries.transfer_id("youtube.refresh", sheet_id)
        self._discover_pool.submit(self._run_refresh_sheet, request_id, sheet_id)
        return {"requestId": request_id}

    def _run_refresh_sheet(self, request_id, sheet_id):
        sheet = self._find_sheet(self._youtube_sheets(), sheet_id)
        if sheet is None:
            return
        try:
            key = self._youtube_key()
            token = self._youtube_access_token()
            listing = discover_mod.playlist_items(sheet["sourceId"], key, access_token=token)
            have = {r["video"]["videoId"] for r in sheet["rows"]}
            fresh = [it["videoId"] for it in listing["items"]
                     if it.get("videoId") and it["videoId"] not in have]
            details = discover_mod.youtube_video_details(fresh, key, access_token=token)
        except discover_mod.DiscoverError as error:
            self._youtube_fetch_failed(request_id, sheet["sourceId"], error)
            return
        except Exception as error:                       # noqa: BLE001 - worker
            log.exception("youtube refresh failed for %s", sheet_id)
            self._youtube_fetch_failed(request_id, sheet["sourceId"], error)
            return

        def fn(sheets):
            live = self._find_sheet(sheets, sheet_id)
            if live is None:
                return
            seen = {r["video"]["videoId"] for r in live["rows"]}
            for item in listing["items"]:
                vid = item.get("videoId") or ""
                if vid and vid not in seen:
                    live["rows"].append(self._youtube_row(item, details))
                    seen.add(vid)
            live["total"] = int(listing.get("total") or len(live["rows"]))
            live["complete"] = bool(listing.get("complete", True))
            live["lastFetchedAt"] = int(time.time())
        self._mutate_youtube(fn)
        self._broadcast_sheet(sheet_id)

    def _cmd_youtube_removeSheet(self, params):
        sheet_id = str(params.get("sheetId") or "")

        def fn(sheets):
            before = len(sheets)
            sheets[:] = [s for s in sheets if s.get("id") != sheet_id]
            if len(sheets) == before:
                raise CommandError("not_found", "no such sheet")
        self._mutate_youtube(fn)
        state = self._youtube_state()
        self.bridge.broadcast("youtube.state", state)
        return state

    def _cmd_youtube_setDownloaded(self, params):
        sheet_id = str(params.get("sheetId") or "")
        video_id = str(params.get("videoId") or "")
        value = bool(params.get("downloaded"))

        def fn(sheets):
            sheet = self._find_sheet(sheets, sheet_id)
            if sheet is None:
                raise CommandError("not_found", "no such sheet")
            for row in sheet["rows"]:
                if row["video"]["videoId"] == video_id:
                    row["downloaded"] = value
                    return
            raise CommandError("not_found", "no such row")
        self._mutate_youtube(fn)
        state = self._youtube_state()
        self.bridge.broadcast("youtube.state", state)
        return state

    def _cmd_youtube_enrich(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        sheet_id = str(params.get("sheetId") or "")
        if self._find_sheet(self._youtube_sheets(), sheet_id) is None:
            raise CommandError("not_found", "no such sheet")
        queries = [q for q in (params.get("queries") or []) if q.get("videoId")]
        request_id = registries.transfer_id("youtube.enrich", sheet_id)
        self._discover_pool.submit(self._run_enrich, request_id, sheet_id, queries)
        return {"requestId": request_id}

    def _run_enrich(self, request_id, sheet_id, queries):
        token = self._discogs_token()
        self._yt_enriching().add(sheet_id)
        self._broadcast_sheet(sheet_id)
        try:
            for query in queries:
                # Checked BEFORE the search, not after: a sheet deleted mid-pass
                # must stop us before we spend the next rate-gated Discogs
                # request, not merely stop us from storing its result.
                if self._find_sheet(self._youtube_sheets(), sheet_id) is None:
                    break
                video_id = str(query.get("videoId") or "")
                match = self._match_one(
                    token, str(query.get("artist") or ""), str(query.get("title") or "")
                )
                if not self._apply_match(sheet_id, video_id, match):
                    break
                self._broadcast_sheet(sheet_id)
        finally:
            self._yt_enriching().discard(sheet_id)
            self._broadcast_sheet(sheet_id)

    def _cmd_youtube_rematch(self, params):
        if not self._lookups_allowed():
            raise CommandError("unsupported", "external lookups are switched off")
        sheet_id = str(params.get("sheetId") or "")
        video_id = str(params.get("videoId") or "")
        if self._find_sheet(self._youtube_sheets(), sheet_id) is None:
            raise CommandError("not_found", "no such sheet")
        request_id = registries.transfer_id("youtube.rematch", sheet_id + video_id)
        self._discover_pool.submit(
            self._run_rematch, request_id, sheet_id, video_id,
            str(params.get("artist") or ""), str(params.get("title") or ""),
            str(params.get("discogsUrl") or "").strip(),
        )
        return {"requestId": request_id}

    def _run_rematch(self, request_id, sheet_id, video_id, artist, title, url):
        token = self._discogs_token()
        if url:
            try:
                match = discover_mod.discogs_release_by_url(url, token)
            except discover_mod.DiscoverError as error:
                match = dict(_YT_PENDING)
                match["status"] = "error"
                log.info("manual rematch rejected: %s", error)
            except Exception:                            # noqa: BLE001 - worker
                log.exception("manual rematch failed")
                match = dict(_YT_PENDING)
                match["status"] = "error"
        else:
            match = self._match_one(token, artist, title)
        self._apply_match(sheet_id, video_id, match)
        self._broadcast_sheet(sheet_id)

    def _match_one(self, token, artist, title):
        """One Discogs search, turned into a match. Never raises into the pool."""
        try:
            return discover_mod.discogs_search_release(artist, title, token)
        except discover_mod.DiscoverError as error:
            log.info("discogs match unavailable: %s", error)
        except Exception:                                # noqa: BLE001 - worker
            log.exception("discogs match failed")
        match = dict(_YT_PENDING)
        match["status"] = "error"
        return match

    # -- Google sign-in (optional: private playlists + liked videos) --------
    #
    # Public playlists never touch this. Sign-in yields a refresh token kept in
    # seek-state.json; an access token is derived from it on demand and cached
    # in memory. Neither token crosses the socket — `youtube.auth` reports only
    # the FACT of a session. The flow itself is in youtube_oauth.py.

    def _youtube_oauth_creds(self):
        stored = self._load_state().get("app_settings") or {}
        return (str(stored.get("youtubeOauthClientId") or ""),
                str(stored.get("youtubeOauthClientSecret") or ""))

    def _youtube_refresh_token(self):
        stored = self._load_state().get("youtube_oauth")
        return str(stored.get("refresh_token") or "") if isinstance(stored, dict) else ""

    def _youtube_access_token(self):
        """A valid access token, refreshed if the cached one has expired.

        Returns "" when not signed in or the refresh fails — the caller then
        falls back to the public key path, or refuses a private request.
        """
        refresh = self._youtube_refresh_token()
        if not refresh:
            return ""
        if getattr(self, "_yt_access", "") and time.time() < getattr(self, "_yt_access_exp", 0):
            return self._yt_access
        client_id, client_secret = self._youtube_oauth_creds()
        if not client_id or not client_secret:
            return ""
        try:
            payload = youtube_oauth.refresh_token(client_id, client_secret, refresh)
        except youtube_oauth.OAuthError as error:
            log.warning("youtube token refresh failed: %s", error)
            return ""
        self._yt_access = str(payload.get("access_token") or "")
        # A minute of slack so a token never expires mid-request.
        self._yt_access_exp = time.time() + max(0, int(payload.get("expires_in") or 0) - 60)
        return self._yt_access

    def _youtube_auth_state(self, error=""):
        client_id, client_secret = self._youtube_oauth_creds()
        return {
            "configured": bool(client_id and client_secret),
            "signedIn": bool(self._youtube_refresh_token()),
            "account": str(getattr(self, "_yt_account", "") or ""),
            "error": str(error or ""),
        }

    def _cmd_youtube_authState(self, _params):
        return self._youtube_auth_state()

    def _cmd_youtube_signIn(self, _params):
        client_id, client_secret = self._youtube_oauth_creds()
        if not client_id or not client_secret:
            raise CommandError(
                "bad_request",
                "add a Google OAuth client id and secret in Settings first",
            )
        request_id = registries.transfer_id("youtube.signin", client_id)
        # A dedicated thread, NOT the discover pool: the loopback blocks for as
        # long as the user takes to consent, and that must not tie up a worker
        # the rest of discovery shares.
        threading.Thread(
            target=self._run_sign_in, args=(request_id, client_id, client_secret),
            daemon=True,
        ).start()
        return {"requestId": request_id}

    def _run_sign_in(self, _request_id, client_id, client_secret):
        try:
            payload = youtube_oauth.run_loopback(client_id, client_secret)
        except youtube_oauth.OAuthError as error:
            log.info("youtube sign-in failed: %s", error)
            self.bridge.broadcast("youtube.auth", self._youtube_auth_state(str(error)))
            return
        except Exception as error:                       # noqa: BLE001 - worker
            log.exception("youtube sign-in crashed")
            self.bridge.broadcast("youtube.auth", self._youtube_auth_state(str(error)))
            return
        self._save_state(youtube_oauth={"refresh_token": payload["refresh_token"]})
        self._yt_access = str(payload.get("access_token") or "")
        self._yt_access_exp = time.time() + max(0, int(payload.get("expires_in") or 0) - 60)
        self._yt_account = self._youtube_account_title()
        self.bridge.broadcast("youtube.auth", self._youtube_auth_state())

    def _cmd_youtube_signOut(self, _params):
        self._save_state(youtube_oauth={})
        self._yt_access = ""
        self._yt_access_exp = 0
        self._yt_account = ""
        state = self._youtube_auth_state()
        self.bridge.broadcast("youtube.auth", state)
        return state

    def _youtube_account_title(self):
        """The signed-in channel's title, for display. Best-effort."""
        token = self._youtube_access_token()
        if not token:
            return ""
        try:
            payload = discover_mod._fetch_json(   # noqa: SLF001 - same module family
                "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
                headers={"Authorization": f"Bearer {token}"},
            )
            items = payload.get("items") or []
            if items:
                return str((items[0].get("snippet") or {}).get("title") or "")
        except Exception:                                # noqa: BLE001
            log.info("could not read the signed-in channel title", exc_info=True)
        return ""

    def _cmd_youtube_myPlaylists(self, _params):
        if not self._youtube_access_token():
            raise CommandError("bad_request", "not signed in to Google")
        request_id = registries.transfer_id("youtube.myplaylists", "")
        self._discover_pool.submit(self._run_my_playlists, request_id)
        return {"requestId": request_id}

    def _run_my_playlists(self, request_id):
        # Liked videos first — it is the one everyone wants and is not returned
        # by the playlists list, so it is synthesised here.
        items = [{"id": "LL", "title": "Liked videos", "itemCount": 0, "privacy": ""}]
        try:
            items.extend(discover_mod.youtube_my_playlists(self._youtube_access_token()))
        except Exception as error:                       # noqa: BLE001 - worker
            log.warning("could not list playlists: %s", error)
        self.bridge.broadcast("youtube.playlists", {"requestId": request_id, "items": items})

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
            log.warning("fingerprint failed: %s", type(error).__name__)
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
            log.warning("discovery browse failed: %s", type(error).__name__)
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
            log.warning("discover failed: %s", type(error).__name__)
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

    def _wish_filters(self):
        """Per-wish filters, keyed by wish text.

        SEEK'S STATE, not pynicotine's — `load_config()` silently drops sections
        it has no defaults for, so anything of ours in its config survives the
        write and vanishes on reload. Upstream also has its own filter slots and
        they are deliberately unused; the reasoning is on `WishFilters` in
        shared/schema.py.
        """
        stored = self._load_state().get("wish_filters")
        return dict(stored) if isinstance(stored, dict) else {}

    def _wish_auto(self):
        """Which wishes auto-download, keyed by wish text. Seek's state.

        Stored as a set of enabled wishes — off is absence, exactly as clearing
        a filter removes its key rather than storing an all-defaults object.
        """
        stored = self._load_state().get("wish_auto")
        return {q: True for q in stored} if isinstance(stored, list) else {}

    def _wishlist_state(self):
        filters = self._wish_filters()
        auto = self._wish_auto()
        return {
            "items": [
                {"query": q, "filters": filters.get(q), "auto": q in auto}
                for q in reversed(list(self.core.search.wishlist))
            ],
            "intervalSeconds": int(self.core.search.wishlist_interval or 0),
        }

    def _cmd_wishlist_list(self, _params):
        return self._wishlist_state()

    # -- what a wish has already shown you ---------------------------------
    #
    # Upstream keeps ONE token per wish and re-runs it forever, so the same
    # peers holding the same files come back on every single run. A badge that
    # fires for those says "news" when there is none, and after a week of that
    # it is furniture. This is the record that lets the frontend tell a new
    # result from the fourth appearance of an old one.
    #
    # Stored, not derived: the point is to survive a restart. Without that,
    # quitting Seek resurrects every result a wish has ever found.

    def _wish_seen(self):
        """Per-wish seen-sets, keyed by wish text. Seek's state, not upstream's."""
        stored = self._load_state().get("wish_seen")
        if not isinstance(stored, dict):
            return {}
        return {q: list(ids) for q, ids in stored.items() if isinstance(ids, list)}

    def _cmd_wishlist_seenList(self, _params):
        seen = self._wish_seen()
        return {"items": [{"query": q, "ids": ids} for q, ids in seen.items() if ids]}

    def _cmd_wishlist_seen(self, params):
        query = str(params.get("query") or "").strip()
        if not query:
            raise CommandError("bad_request", "empty wish")
        if query not in self.core.search.wishlist:
            raise CommandError("not_found", "no such wish")

        incoming, known = [], set()
        for entry in params.get("ids") or []:
            entry = str(entry)
            if entry and entry not in known:
                known.add(entry)
                incoming.append(entry)

        # Re-marking MOVES an id to the end rather than leaving it where it
        # was. A file a peer still offers is re-marked every time you look, so
        # the window fills with what is current; leaving it in place would let
        # a still-live result age out while newer noise kept it company.
        stored = self._wish_seen()
        merged = [e for e in stored.get(query, []) if e not in known] + incoming

        # OLDEST DROPPED FIRST, and re-marking moves an id back to the end.
        # A result still being offered every run is re-marked every time you
        # look, so what falls out of the window is what stopped appearing —
        # which is exactly what you no longer need to remember. One that does
        # fall out and later returns reads as new again; bounded and honest,
        # and the alternative is a state file that only ever grows.
        if len(merged) > WISH_SEEN_CAP:
            merged = merged[-WISH_SEEN_CAP:]

        stored[query] = merged
        self._save_state(wish_seen=stored)
        return {"count": len(merged)}

    def _cmd_wishlist_add(self, params):
        query = (params.get("query") or "").strip()
        if not query:
            raise CommandError("bad_request", "empty wish")
        self.core.search.add_wish(query)
        state = self._wishlist_state()
        self.bridge.broadcast("wishlist.state", state)
        return state

    def _cmd_wishlist_filters(self, params):
        query = str(params.get("query") or "").strip()
        if not query:
            raise CommandError("bad_request", "empty wish")
        if query not in self.core.search.wishlist:
            raise CommandError("not_found", "no such wish")

        stored = self._wish_filters()
        filters = params.get("filters")
        if filters is None:
            # Clearing REMOVES the key rather than storing an empty filter set.
            # An all-defaults object and "no filters" render identically and
            # behave identically, and keeping both invites code that has to ask
            # which one it is looking at.
            stored.pop(query, None)
        else:
            stored[query] = dict(filters)
        self._store(wish_filters=stored)

        state = self._wishlist_state()
        self.bridge.broadcast("wishlist.state", state)
        return state

    def _cmd_wishlist_auto(self, params):
        query = str(params.get("query") or "").strip()
        if not query:
            raise CommandError("bad_request", "empty wish")
        if query not in self.core.search.wishlist:
            raise CommandError("not_found", "no such wish")
        enabled = set(self._wish_auto())
        if params.get("auto"):
            enabled.add(query)
        else:
            enabled.discard(query)
        self._store(wish_auto=sorted(enabled))
        state = self._wishlist_state()
        self.bridge.broadcast("wishlist.state", state)
        return state

    # -- the auto-download claim ledger ------------------------------------
    #
    # Stored ONLY so a restart neither re-downloads a candidate already on disk
    # nor forgets one awaiting review. The frontend owns it — deciding what to
    # claim and when it is reviewed is a decision, and decisions are the app's,
    # exactly as with wish_seen. The sidecar stores it verbatim.

    def _auto_claims(self):
        stored = self._load_state().get("auto_claims")
        return list(stored) if isinstance(stored, list) else []

    def _cmd_wishlist_claimsList(self, _params):
        return {"items": self._auto_claims()}

    def _cmd_wishlist_claims(self, params):
        # Kept to the four known fields so a client bug cannot bloat the state
        # file, but never interpreted here.
        clean = []
        for it in params.get("items") or []:
            if not isinstance(it, dict):
                continue
            clean.append({
                "query": str(it.get("query") or ""),
                "user": str(it.get("user") or ""),
                "transferId": str(it.get("transferId") or ""),
                "path": str(it.get("path") or ""),
                "status": str(it.get("status") or ""),
            })
        self._store(auto_claims=clean)
        return {"items": clean}

    # -- who has already been sent the upload greeting ----------------------
    #
    # Same rule as the ledger above: stored so it survives a restart, never
    # interpreted. Deciding who is new is the frontend's. This one matters more
    # than most — losing it means messaging people a second time, and there is
    # no way to take that back.

    def _greeted_peers(self):
        stored = self._load_state().get("greeted_peers")
        return [str(u) for u in stored if u] if isinstance(stored, list) else []

    def _cmd_greeting_sentList(self, _params):
        return {"users": self._greeted_peers()}

    def _cmd_greeting_sent(self, params):
        seen = set()
        clean = []
        for user in params.get("users") or []:
            name = str(user or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            clean.append(name)
        # Oldest first, so the tail is the newest — the end worth keeping when
        # a very long-lived install finally reaches the cap.
        clean = clean[-GREETED_CAP:]
        self._save_state(greeted_peers=clean)
        return {"users": clean}

    def _cmd_wishlist_remove(self, params):
        query = (params.get("query") or "").strip()
        wish = self.core.search.wishlist.get(query)
        self.core.search.remove_wish(query)
        # `remove_wish` keeps the search entry once the wish has run, and with it
        # the token peers answer on. `remove_search` drops both and emits
        # remove-search, which closes the run here.
        if wish is not None:
            self.core.search.remove_search(wish.token)
        # Otherwise re-adding the same text later silently inherits filters the
        # user last saw months ago — and, worse, starts life believing it has
        # already shown you results you have never seen.
        stored = self._wish_filters()
        if stored.pop(query, None) is not None:
            self._store(wish_filters=stored)
        seen = self._wish_seen()
        if seen.pop(query, None) is not None:
            self._store(wish_seen=seen)
        enabled = set(self._wish_auto())
        if query in enabled:
            enabled.discard(query)
            self._store(wish_auto=sorted(enabled))
        claims = self._auto_claims()
        kept = [c for c in claims if c.get("query") != query]
        if len(kept) != len(claims):
            self._store(auto_claims=kept)
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
        # A folder that is ALREADY shared is kept even while it cannot be found.
        # Checking every folder used to mean one unplugged drive blocked every
        # change to the list — including removing a different folder, which is
        # the change that matters most. Only folders being ADDED are checked.
        already = {path for _virtual, path in (
            (str(e[0]), str(e[1])) for e in (self.config.sections["transfers"].get("shared") or ())
            if isinstance(e, (list, tuple)) and len(e) >= 2
        )}
        resolved = []
        for folder in folders:
            if not folder["path"]:
                raise CommandError("bad_request", "a shared folder needs a path")
            path = self._resolve_path(folder["path"])
            if path in already and not (os.path.isdir(path) and os.access(path, os.R_OK | os.X_OK)):
                virtual = folder["virtualName"] or os.path.basename(path.rstrip(os.sep)) or path
                resolved.append((virtual, path))
                continue
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

        removed = already - {path for _virtual, path in resolved}

        self.config.sections["transfers"]["shared"] = resolved
        try:
            self._store(share_consent=consent)
            self._persist_config()
        finally:
            # The rescan runs even when the save failed: it is what stops a
            # withdrawn folder being served, and the change is in force now.
            if self.core.shares is not None:
                self.core.shares.rescan_shares(force=bool(removed))

        # Shares is always running now (see start()), so a consent change takes
        # effect THIS session: re-index to match the new folder set — a granted
        # set advertises those folders, a cleared one stops — rather than the old
        # "restart required" dance.
        #
        # A REMOVAL is forced. Upstream refuses to rescan while any share is
        # missing, which would leave a folder you just stopped sharing in the
        # index, still browsable and downloadable by anyone. Forcing drops an
        # unplugged drive's files from the index too — but those requests fail
        # anyway, and a folder you withdrew staying public is the worse error.
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

        try:
            if result["importedShares"]:
                # Importing shares is itself an explicit act of sharing.
                self._store(share_consent="granted")
            self._persist_config()
        finally:
            # Shares runs from launch now, so imported folders take effect this
            # session with a rescan rather than needing a restart.
            if result["importedShares"] and self.core.shares is not None:
                self.core.shares.rescan_shares()
            self.bridge.broadcast("shares.state", self._share_state())
            # Account details changed: Settings reads them from app.settings.
            self.bridge.broadcast("app.settings", self._app_settings())

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
            if state == "finished":
                self._after_download(upstream_transfer)
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

    @staticmethod
    def _folder_files(root, folders, recurse):
        """The (folder path, file) pairs a request for `root` takes: the
        folder's own files, plus its subfolders' when `recurse`."""
        out = []
        for folder in folders:
            path = folder["path"]
            if not recurse and path != root:
                continue
            if recurse and path != root and not path.startswith(root + "\\"):
                continue
            out.extend((path, file) for file in folder["files"])
        return out

    def _enqueue_folder_files(self, username, root, files, destination):
        targets = {}
        for path, file in files:
            # Into the chosen folder, but with the release's own folders kept,
            # as upstream's Download to does (userbrowse.download_folder). This
            # used to drop every file of every subfolder flat into the target.
            if path not in targets:
                targets[path] = self.core.downloads.get_folder_destination(
                    username, path, root_folder_path=root,
                    download_folder_path=destination or None,
                )
            self.core.downloads.enqueue_download(
                username, file["path"], folder_path=targets[path], size=file["size"]
            )
        return len(files)

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

        self._connection.update({"status": "connecting", "error": None})
        self.bridge.broadcast("connection.state", dict(self._connection))
        log.info("signing in")
        self.core.connect()
        # Persist so a restart does not lose the login — after connecting, so
        # a failed save never stands between you and this session. Neither
        # value is ever logged, echoed, or returned by any command.
        self.bridge.broadcast("app.settings", self._app_settings())
        self._persist_config()
        return {}

    def _cmd_connection_disconnect(self, _params):
        # Signing out means staying out, next launch included: automatic
        # sign-in used to bring the account straight back. Signing in again
        # does not turn it back on — the Settings switch is the one control.
        self._signing_out = True
        self.core.disconnect()
        self.config.sections["server"]["auto_connect_startup"] = False
        self.bridge.broadcast("app.settings", self._app_settings())
        self._persist_config()
        return {}

    def _user_lists(self):
        server = self.config.sections["server"]
        return {
            "ignored": list(server.get("ignorelist") or []),
            "banned": list(server.get("banlist") or []),
        }

    def _on_user_lists_changed(self, _username):
        self.bridge.broadcast("users.lists", self._user_lists())

    def _cmd_users_lists(self, _params):
        return self._user_lists()

    def _cmd_users_away(self, params):
        on, remember = bool(params["on"]), bool(params["remember"])
        if self.core.users.login_status == self.UserStatus.OFFLINE:
            # Nothing to tell the server yet; login restores the saved value.
            if remember:
                self.config.sections["server"]["away"] = on
                self._persist_config()
            return {}
        # Saved first: a save that fails must leave the status as it was, or
        # the reply says "didn't work" about an away that already happened.
        if remember:
            self.config.sections["server"]["away"] = on
            self._persist_config()
        self.core.users.set_away_mode(on, save_state=False)
        return {}

    def _cmd_users_ignore(self, params):
        username = params["username"].strip()
        if not username:
            raise CommandError("bad_request", "a username is required")
        if params["on"]:
            self.core.network_filter.ignore_user(username)
        else:
            self.core.network_filter.unignore_user(username)
        # Upstream writes the config itself and logs a failure; check it.
        self._persist_config()
        return self._user_lists()

    def _cmd_users_ban(self, params):
        username = params["username"].strip()
        if not username:
            raise CommandError("bad_request", "a username is required")
        if params["on"]:
            self.core.network_filter.ban_user(username)
        else:
            self.core.network_filter.unban_user(username)
        self._persist_config()
        return self._user_lists()

    def _cmd_search_start(self, params):
        self._require_online()
        mode = params.get("mode") or "global"
        # Upstream quietly substitutes when these are missing — its default
        # auto-join room, or your own username — so a search would go somewhere
        # nobody chose. And 'wishlist' is upstream's own timer, not a request.
        if mode == "wishlist":
            raise CommandError("bad_request", "wishlist searches are run by the wishlist")
        if mode == "rooms" and not (params.get("room") or "").strip():
            raise CommandError("bad_request", "choose a room to search")
        if mode == "user" and not [u for u in params.get("users") or [] if u.strip()]:
            raise CommandError("bad_request", "name a user to search")
        if mode == "buddies" and not self.core.buddies.users:
            raise CommandError("bad_request", "you have no buddies to search yet")
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

    def _cmd_user_info_get(self, params):
        """Ask a peer directly for their profile (description, picture).

        Goes through upstream's own `UserInfo.show_user`, same as
        `_cmd_user_browse` goes through `userbrowse.browse_user` — it already
        does the allow-listing and the request send; reimplementing that here
        would just be a second, divergent copy of it. It also permanently adds
        the username to `core.userinfo.users`, same lifetime as a browse
        session; there is no unwatch call, matching how browsing a user is
        never explicitly "closed" upstream either.
        """
        self._require_online()
        self.core.userinfo.show_user(params["username"], switch_page=False)
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
        self._folder_requests.setdefault((username, folder_path), []).append({
            "requestId": request_id,
            "destination": params.get("destination"),
            "recurse": bool(params.get("recurse")),
            "confirmAbove": params.get("confirmAbove"),
        })
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
            # Abort AND clear. Abort alone is not a cancel: upstream files an
            # aborted download into `failed_users` and leaves it in
            # `self.transfers` (transfers.py `_abort_transfer` exempts only
            # FINISHED/FILTERED/PAUSED, so CANCELLED lands in failed), and when
            # the peer re-offers the next queued file of a folder,
            # `_transfer_request_downloads` finds it in `failed_users` and
            # RESTARTS it — so the folder kept downloading through Cancel. Clear
            # runs `_unfail_transfer` + drops it from `self.transfers`, so the
            # re-offer is refused and the download truly stops. (This is why
            # Pause works and Cancel did not: PAUSED is in the exempt set.)
            #
            # It also removes the rows, which is the intended "cancel = stop and
            # remove"; Pause is the keep-for-later path. Partial bytes on disk
            # are left exactly as `transfer.clear` leaves them — untouched.
            self.core.downloads.abort_downloads(
                items["download"], self.TransferStatus.CANCELLED
            )
            self.core.downloads.clear_downloads(items["download"])
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

    @staticmethod
    def _on_missing_volume(folder):
        """True when `folder` is gone because its drive is: the nearest part of
        the path that still exists is the root or /Volumes itself."""
        parent = folder
        while parent and not os.path.exists(parent):
            parent = os.path.dirname(parent)
        return parent in ("", os.sep, "/Volumes")

    def _download_present(self, download, folder):
        """By NAME. Upstream saves a clashing name as `name (1).ext`
        (`avoid_conflict`), so those are tried too; never by size, which Seek's
        own tag writing changes."""
        name = self.core.downloads.get_download_basename(download.virtual_path, folder)
        stem, ext = os.path.splitext(name)
        candidates = [name] + [f"{stem} ({n}){ext}" for n in range(1, 10)]
        return any(
            os.path.isfile(self._follow_move(os.path.join(folder, c))) for c in candidates
        )

    def _cmd_transfer_findMissing(self, _params):
        root = self._download_root()
        missing = []
        for download in list(self.core.downloads.transfers.values()):
            if translate.transfer_state(download.status) != "finished":
                continue
            folder = self._resolve_path(download.folder_path) or root
            if not folder or self._on_missing_volume(folder):
                continue
            if not self._download_present(download, folder):
                record = self.transfers.record_for(
                    "download", download.username, download.virtual_path
                )
                missing.append(record.id)
        return {"transferIds": missing}

    def _cmd_transfer_list(self, _params):
        return {"transfers": self._transfer_snapshot()}

    def _completed_mtime(self, upstream_transfer):
        """The real moment a finished download landed: the mtime of the file on
        disk.

        Upstream keeps NO completion time — Soulseek has none — so after a
        restart the in-memory stamp is gone and there is nothing durable to
        recover it from except the file itself. Stamping `now` instead (what the
        registry does for a live completion) would date every previously
        downloaded file to the moment Seek last started, which on every update is
        exactly the "all my downloads say undated / today" the user sees.

        Uses upstream's own resolver, which finds the actual file even when a
        name clash appended ' (1)' by matching size, and tells us whether it is
        still there. 0.0 when it is gone (moved out, deleted) — which reads as
        undated, honest, rather than a wrong date.
        """
        downloads = self.core.downloads
        if downloads is None:
            return 0.0
        try:
            path, exists = downloads.get_complete_download_file_path(
                upstream_transfer.username, upstream_transfer.virtual_path,
                int(upstream_transfer.size or 0), upstream_transfer.folder_path or None,
            )
            if exists:
                return os.stat(path).st_mtime
        except (OSError, ValueError, AttributeError):
            pass
        return 0.0

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
                # A completed download restored from upstream's list has no
                # finish time — this snapshot never runs it through `observe`.
                # Recover it from the file's mtime so Completed can date it,
                # once (the record is reused across snapshots).
                if (direction == "download" and not record.finished_at
                        and translate.transfer_state(upstream.status) == "finished"):
                    record.finished_at = self._completed_mtime(upstream)
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
        # Organise may have moved it between the request and now.
        path = self._follow_move(path)
        try:
            payload = spectral.analyse(path, request_id=request_id,
                                       transfer_id=transfer_id)
        except Exception as error:
            # The error class, never the path: the log is pasted into public bug
            # reports, and a path is a list of what someone downloads.
            log.warning("spectral analysis failed: %s", type(error).__name__)
            self.bridge.broadcast("analysis.failed", {
                "requestId": request_id, "path": path, "transferId": transfer_id,
                "reason": str(error),
            })
            return
        self.bridge.broadcast("analysis.result", payload)

    # -- checksum sidecars (post-download only) ----------------------------

    def _cmd_analysis_checksums(self, params):
        """Queue a check of one downloaded FOLDER against its `.ffp`/`.md5`.

        The request names a file and we take its folder, because a checksum
        sidecar covers the release rather than a track — and because the file
        the user pressed the button on is the one thing they can point at.

        On the worker pool for the same reason as spectral analysis: a `.md5`
        reads every byte of every file in the folder, which for a 24-bit
        release is a gigabyte of I/O that must not touch the event loop.
        """
        path = self._resolve_local_file(params)
        folder = self._checksum_folder(path)
        transfer_id = params.get("transferId")

        request_id = registries.transfer_id(folder, str(transfer_id or ""))
        self._analysis_pool.submit(
            self._run_checksums, request_id, folder, path, transfer_id,
        )
        return {"requestId": request_id}

    def _checksum_folder(self, path):
        """Where to look for the sidecar: the file's folder, or its parent.

        A multi-disc rip commonly puts ONE fingerprint at the release root and
        the audio in `CD1/`, `CD2/`, and its lines are relative to that root —
        so looking only beside the file finds nothing on exactly the releases
        most likely to carry one.

        The parent is only considered when the file's own folder has none, and
        never when the parent IS the download root: a stray `.md5` sitting
        loose in the downloads folder has nothing to do with this release.
        """
        folder = os.path.dirname(path)
        if checksums.find_sidecars(folder):
            return folder

        parent = os.path.dirname(folder)
        if not parent or parent == folder:
            return folder
        root = self._download_root()
        if root and os.path.realpath(parent) == os.path.realpath(root):
            return folder
        return parent if checksums.find_sidecars(parent) else folder

    def _run_checksums(self, request_id, folder, path, transfer_id):
        """Worker-thread body. Never raises into the pool."""
        try:
            report = checksums.verify_folder(folder)
        except Exception as error:
            log.warning("checksum check failed: %s", type(error).__name__)
            self.bridge.broadcast("checksums.failed", {
                "requestId": request_id, "path": path, "transferId": transfer_id,
                "reason": str(error),
            })
            return
        report["requestId"] = request_id
        report["transferId"] = transfer_id
        self.bridge.broadcast("checksums.result", report)

    # -- the Rekordbox hand-off (see handoff.py) -----------------------------

    #: Most hand-offs remembered. The oldest records go first; the files stay.
    HANDOFF_CAP = 5000

    def _handoff_path(self):
        # Its own file, not seek-state.json: at the cap the record is 1.6 MB,
        # and every save of anything re-reads and rewrites the whole state,
        # which made each finished download cost ~50 ms on the main thread.
        return os.path.join(self.data_folder, "seek-handoff.json")

    def _handoff_sent(self):
        """The ledger, minus any row the validator would drop the event over.

        Unreadable is empty: losing the record loses no file, and sending again
        finds each copy already there."""
        try:
            with open(self._handoff_path(), encoding="utf-8") as handle:
                rows = json.load(handle)
        except FileNotFoundError:
            rows = []
        except (OSError, ValueError):
            log.exception("seek-handoff.json unreadable; starting the record again")
            rows = []
        return [
            row for row in (rows if isinstance(rows, list) else [])
            if isinstance(row, dict)
            and all(isinstance(row.get(k), str) for k in ("transferId", "user", "path", "dest"))
            and isinstance(row.get("sentAt"), (int, float))
        ]

    def _save_handoff(self, rows):
        """Atomic, like `_save_state`. Logged, not raised: the copies happened,
        and an unsaved record is no reason to report them as failed."""
        path = self._handoff_path()
        tmp = f"{path}.tmp"
        try:
            os.makedirs(self.data_folder, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(rows, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except OSError:
            log.exception("could not save the hand-off record")

    def _handoff_present(self):
        """The record's rows whose copy is in the Rekordbox folder now.

        What went where is history; what is THERE is the disk's to say. A new
        folder, or another stick mounted under the same name, holds none of the
        old copies, and calling them Sent would leave nothing to send them with.
        """
        folder = self._resolve_path(self._load_state().get("rekordbox_folder"))
        if not folder:
            return []
        inside = os.path.join(folder, "")
        # ponytail: one stat per row, 5,000 at the cap; list each release
        # folder once instead if a slow drive ever makes this felt.
        return [row for row in self._handoff_sent()
                if row["dest"].startswith(inside) and os.path.isfile(row["dest"])]

    def _cmd_handoff_list(self, _params):
        return {"sent": self._handoff_present()}

    def _cmd_handoff_send(self, params):
        """Find the files here; check the folder and copy on the post worker.

        The files are found on THIS thread because finding one asks the core,
        and the core is not to be read from a worker. The folder is looked at
        on the worker (`handoff.folder_problem`): a sleeping USB drive takes
        seconds to answer, and this thread runs every transfer and search.

        The post worker, not a pool of its own, because Organise moves files
        there: one queue means a copy never races a move of the same file.
        ponytail: a big copy delays artwork and Organise for downloads that
        finish behind it; give the hand-off its own pool if that is ever felt.
        """
        folder = self._resolve_path(self._load_state().get("rekordbox_folder"))
        if not folder:
            raise CommandError("bad_request", "no Rekordbox folder is set")

        jobs = []
        for transfer_id in params["transferIds"]:
            record = self.transfers.get(transfer_id)
            job = {"transferId": transfer_id, "source": None, "outcome": None,
                   "user": record.username if record else "",
                   "path": record.path if record else ""}
            if record is None or record.direction != "download":
                # The resolver would happily answer for an upload, with a path
                # in the download folder that is not that file.
                job["outcome"] = "file_missing"
            else:
                try:
                    job["source"] = self._resolve_local_file({"path": None, "transferId": transfer_id})
                except CommandError as error:
                    job["outcome"] = "not_finished" if error.code == "bad_request" else "file_missing"
            jobs.append(job)
        # Read here, with the files: a folder changed while the copy waits its
        # turn must not change where the files land.
        self._post_pool.submit(self._handoff_now, folder, self._download_root(), jobs)
        return {}

    def _handoff_now(self, folder, root, jobs):
        """Worker-thread body. Never raises into the pool."""
        try:
            results, ledger = self._handoff_copy(folder, root, jobs)
        except Exception:                              # noqa: BLE001 - worker
            log.exception("hand-off failed")
            results, ledger = [{"transferId": job["transferId"], "outcome": handoff.IO_ERROR,
                                "dest": None} for job in jobs], None
        self.bridge.broadcast("handoff.done", {"results": results})
        if ledger is not None:
            self.bridge.broadcast("handoff.state", {"sent": self._handoff_present()})

    def _handoff_copy(self, folder, root, jobs):
        now = time.time()
        results, ledger = [], None
        unavailable = handoff.folder_problem(folder)
        quitting = lambda: self._quitting  # noqa: E731
        for job in jobs:
            outcome, dest = job["outcome"], None
            if outcome is None:
                outcome = unavailable or (handoff.STOPPED if quitting() else None)
            if outcome is None:
                # Organise may have moved it while this job waited its turn.
                source = self._follow_move(job["source"])
                dest = handoff.destination(folder, source, root)
                outcome = handoff.send_file(source, dest, quitting)
                if outcome in (handoff.COPIED, handoff.ALREADY_THERE):
                    # Recorded file by file: a quit, or a kill after the
                    # shell's grace period, keeps every copy that landed.
                    ledger = self._record_handoff({
                        "transferId": job["transferId"], "user": job["user"],
                        "path": job["path"], "dest": dest, "sentAt": now})
                else:
                    dest = None
            results.append({"transferId": job["transferId"], "outcome": outcome, "dest": dest})
        return results, ledger

    def _record_handoff(self, row):
        with _STATE_LOCK:
            kept = [r for r in self._handoff_sent() if r["transferId"] != row["transferId"]]
            ledger = (kept + [row])[-self.HANDOFF_CAP:]
            self._save_handoff(ledger)
        return ledger

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
        # SUPPRESSED. See the note on _on_private_message: upstream nulls the
        # identifying field to tell later handlers it has swallowed this one.
        # `chatrooms._say_chat_room` does it for a room we are not in, for an
        # ignored user, for an ignored IP, and for a plugin that ate the line.
        if msg.room is None:
            return
        self.bridge.broadcast("chat.message", self._chat_line(
            "room", msg.room, msg.user, msg.message,
            outgoing=msg.user == self._own_username(),
            kind=self._chat_kind(getattr(msg, "message_type", None)),
            mentioned=bool(getattr(msg, "mention_type", None)),
        ))

    def _on_room_echo(self, room, text, message_type):
        self.bridge.broadcast("chat.message", self._echo_line("room", room, text, message_type))

    def _echo_line(self, scope, target, text, message_type):
        # A command's reply (upstream's "command" type, and Seek's own refusals)
        # is the app talking, not you: it used to be drawn as a line YOU typed,
        # under your name.
        if message_type == "command":
            return self._chat_line(scope, target, "", text, outgoing=False, kind="local")
        return self._chat_line(
            scope, target, self._own_username(), text,
            outgoing=True, kind=self._chat_kind(message_type or "local"),
        )

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
        # SUPPRESSED — NOT a message with no target.
        #
        # Upstream signals "I have handled this, do not display it" by NULLING
        # the identifying field on the message object in place, and every
        # handler registered after it sees the mutation. `events.emit` runs
        # callbacks in registration order and the core registers its own during
        # init, so ours ALWAYS runs second and always sees it.
        #
        # `privatechat._message_user` does it five ways: a server message it
        # turned into something else, a user on the ignore list, an ignored IP,
        # a plugin that ate the line, and — the one that is not a suppression at
        # all — a message QUEUED pending the sender's IP, which is re-emitted
        # for real from `_get_peer_address` once the address arrives.
        #
        # Without this the message was emitted anyway and only survived being
        # shown because `ChatMessage.target` is non-nullable and the event
        # validator refused it. That is luck, not design, and it points the
        # obvious fix at exactly the wrong thing: making `target` nullable would
        # start rendering messages from people you have ignored.
        #
        # `_on_user_status` and the room join/leave handlers already do this;
        # these two handlers were simply missed.
        if msg.user is None:
            return

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
        self.bridge.broadcast("chat.message", self._echo_line("private", user, text, message_type))

    def _member(self, username):
        """What upstream knows about someone in a room: it records status and
        share counts from the server's room data (chatrooms._update_room_user)."""
        watched = self.core.users.watched.get(username)
        files = getattr(watched, "files", None)
        return {
            "username": username,
            "status": translate.user_status(self.core.users.statuses.get(username)),
            "files": int(files) if files is not None else None,
        }

    def _on_join_room(self, msg):
        # The server can send a join we never asked for; upstream refuses it
        # (chatrooms._join_room) without nulling the room, so check here.
        if msg.room not in (self.core.chatrooms.joined_rooms or {}):
            return
        self.bridge.broadcast("chat.members", {
            "room": msg.room,
            "members": [self._member(u.username) for u in (msg.users or [])],
        })
        self._emit_rooms()

    def _on_leave_room(self, msg):
        self._emit_rooms()

    def _on_user_joined_room(self, msg):
        # Upstream nulls `room` for a room we are not in.
        if not getattr(msg, "room", None) or msg.userdata is None:
            return
        self.bridge.broadcast("chat.member", {
            "room": msg.room, "member": self._member(msg.userdata.username), "present": True,
        })

    def _on_user_left_room(self, msg):
        if not getattr(msg, "room", None) or not msg.username:
            return
        self.bridge.broadcast("chat.member", {
            "room": msg.room, "member": self._member(msg.username), "present": False,
        })

    def _on_room_list(self, msg):
        self._emit_rooms(msg)

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

    # Commands Seek refuses even though upstream has them: each would act behind
    # Seek's back. /quit stops the ENGINE and leaves the window up with nothing
    # behind it; /share and /unshare edit the share list without the consent
    # Seek records for it (`shares.set`).
    _NO_QUIT = ("Seek is quit from its menu — /quit would stop the engine and "
                "leave the window with nothing behind it.")
    _NO_SHARE = ("Shared folders are set in Settings → Folders, so Seek keeps "
                 "track of what you agreed to share.")
    BLOCKED_CHAT_COMMANDS = {
        "quit": _NO_QUIT, "q": _NO_QUIT, "exit": _NO_QUIT,
        "share": _NO_SHARE, "unshare": _NO_SHARE,
    }

    def _cmd_chat_say(self, params):
        self._require_online()
        target = params["target"]
        message = params["message"]
        room = params["scope"] == "room"

        # A line starting with ONE slash is a command, as in Nicotine+
        # (gtkgui/widgets/textentry.py:192-210), and "//" sends a literal slash.
        # Sent verbatim, "/away" or "/msg bob hi" went to everyone in the room.
        # Commands run through upstream's own handler — the `pluginhandler`
        # component is enabled and `core_commands` always loads — and its replies
        # come back as echo events, which `_on_room_echo` / `_on_private_echo`
        # already turn into chat lines.
        # Never for an automatic message: that is the upload greeting, typed
        # once in Settings, and a greeting beginning "/" is just text.
        if (not params.get("automatic") and message.startswith("/")
                and not message.startswith("//")):
            command, _sep, args = message[1:].partition(" ")
            refused = self.BLOCKED_CHAT_COMMANDS.get(command.lower())
            if refused:
                if room:
                    self.core.chatrooms.echo_message(target, refused, "command")
                else:
                    self.core.privatechat.echo_message(target, refused, "command")
                return {}
            if room:
                self.core.pluginhandler.trigger_chatroom_command_event(
                    target, command, args.strip())
            else:
                self.core.privatechat.show_user(target, switch_page=False)
                self.core.pluginhandler.trigger_private_chat_command_event(
                    target, command, args.strip())
            return {}
        if message.startswith("//"):
            message = message[1:]

        if room:
            self.core.chatrooms.send_message(target, message)
        elif params.get("automatic"):
            # Upstream's own method for bot messages: it prefixes
            # "[Automatic Message]" so the recipient can tell. Called rather
            # than pasting that prefix in ourselves, so the wording stays
            # upstream's and cannot drift from what other clients send.
            self.core.privatechat.show_user(target, switch_page=False)
            self.core.privatechat.send_automatic_message(target, message)
        else:
            self.core.privatechat.show_user(target, switch_page=False)
            self.core.privatechat.send_message(target, message)
        return {}

    def _cmd_chat_open(self, params):
        self._require_online()
        self.core.privatechat.show_user(params["username"], switch_page=False)
        return {}

    def _cmd_chat_close(self, params):
        username = params["username"]
        privatechat = self.core.privatechat
        # `remove_user` raises for a name it does not hold, and the app opens
        # a conversation locally even when chat.open failed.
        if username in privatechat.users:
            privatechat.remove_user(username)
        return {}

    def _cmd_chat_closeAll(self, _params):
        self.core.privatechat.remove_all_users()
        return {}

    def _cmd_chat_history(self, params):
        """Earlier lines of a conversation, from upstream's own chat log.

        The engine has always logged every room and private chat to disk
        (`logging.privatechat` / `logging.chatrooms`, on by default), and Seek
        never read any of it back — so every restart showed every conversation
        empty while the words sat in `data/logs/`. Nicotine+ prepends these when
        a chat opens (gtkgui/privatechat.py:397). Lines go out raw, decoded the
        way upstream decodes them (textview.py:461); splitting the timestamp and
        the name off is the frontend's job. Needs no connection: it is a file.
        """
        from pynicotine.logfacility import log

        room = params["scope"] == "room"
        logging_config = self.config.sections["logging"]
        limit = params.get("limit")
        if limit is None:
            limit = logging_config.get("readroomlines" if room else "readprivatelines") or 200
        limit = max(0, min(int(limit), 2000))
        folder = log.room_folder_path if room else log.private_chat_folder_path
        raw = log.read_log(folder, params["target"], limit) if limit else None
        lines = []
        for line in raw or ():
            try:
                lines.append(line.decode("utf-8"))
            except UnicodeDecodeError:
                lines.append(line.decode("latin-1"))
        return {"scope": params["scope"], "target": params["target"], "lines": lines}

    # -- local paths --------------------------------------------------------

    # These exist because `settings.patch` used to write whatever string it was
    # handed. A mistyped download folder is not a cosmetic problem: every
    # transfer then fails with upstream's `download_folder_error`, one file at a
    # time, with nothing on the settings screen suggesting the folder is why.

    # -- show in Finder / open ----------------------------------------------

    def _reveal_target(self, params):
        if params.get("transferId"):
            return self._resolve_local_file({"transferId": params["transferId"], "path": None})
        path = self._follow_move(self._resolve_path(params.get("path")))
        if not path or not os.path.exists(path):
            raise CommandError("not_found", f"no such file or folder: {path}")
        return path

    @staticmethod
    def _system_open(args):
        import subprocess
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True)

    def _cmd_fs_reveal(self, params):
        path = self._reveal_target(params)
        if sys.platform == "darwin":
            self._system_open(["open", "-R", path])
        else:
            self._system_open(["xdg-open", os.path.dirname(path) if os.path.isfile(path) else path])
        return {}

    def _cmd_fs_open(self, params):
        path = self._reveal_target(params)
        if not os.path.isfile(path) or os.path.splitext(path)[1].lower() not in enrich.AUDIO_EXTENSIONS:
            raise CommandError("bad_request", "only audio files are opened from Seek")
        self._system_open(["open" if sys.platform == "darwin" else "xdg-open", path])
        return {}

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

        # Checked before anything else changes, saved after, like stallSeconds.
        rekordbox = patch.get("rekordboxFolder")
        if rekordbox is not None:
            rekordbox = (self._require_writable_dir("the Rekordbox folder", rekordbox)
                         if str(rekordbox).strip() else "")

        # Every folder is checked before any is set: a good download folder
        # beside a bad in-progress one used to take effect in the live config
        # while the reply said the patch was refused.
        download = patch.get("downloadFolder")
        if download is not None:
            download = self._require_writable_dir("the download folder", download)
        incomplete = patch.get("incompleteFolder")
        if incomplete is not None:
            incomplete = self._require_writable_dir("the in-progress folder", incomplete)
        if download is not None:
            transfers["downloaddir"] = download
        if incomplete is not None:
            transfers["incompletedir"] = incomplete
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
            # Applied now; saved below, after the config, so a failed save of
            # this one value cannot strand the rest of the patch.
            self.transfers.stall_seconds = max(1, int(patch["stallSeconds"]))

        mapping = patch.get("portMapping")
        if mapping is not None:
            server["upnp"] = bool(mapping)

        # Upload policy. Upstream reads every one of these at the moment it
        # decides, so they need no restart.
        for wire_key, config_key in (
            ("preferBuddies", "preferfriends"),
            ("fifoQueue", "fifoqueue"),
            ("buddiesUnlimited", "friendsnolimits"),
        ):
            if patch.get(wire_key) is not None:
                transfers[config_key] = bool(patch[wire_key])
        for wire_key, config_key in (
            ("queueLimitFiles", "filelimit"),
            ("queueLimitMb", "queuelimit"),
        ):
            if patch.get(wire_key) is not None:
                transfers[config_key] = max(0, int(patch[wire_key]))

        if patch.get("autoAwayMinutes") is not None:
            server["autoaway"] = max(0, int(patch["autoAwayMinutes"]))
        if patch.get("autoReply") is not None:
            server["autoreply"] = str(patch["autoReply"]).strip()

        self.core.downloads.update_transfer_limits()
        self.core.uploads.update_transfer_limits()
        self._persist_config()

        # Apply now rather than at the next login. Both calls hand the work to a
        # thread of upstream's own, so a slow router never stalls this loop, and
        # `add_port_mapping` is a no-op until the listening port exists.
        portmapper = getattr(self.core, "portmapper", None)
        if mapping is not None and portmapper is not None:
            if mapping:
                portmapper.add_port_mapping()
            else:
                portmapper.remove_port_mapping()
        if patch.get("stallSeconds") is not None:
            # Saved, not just set: it lived only on the registry, so every
            # restart quietly put it back to 45 s.
            self._store(stall_seconds=self.transfers.stall_seconds)
        if rekordbox is not None:
            self._store(rekordbox_folder=rekordbox)
            # Another folder holds other copies: what is Sent changes with it.
            self.bridge.broadcast("handoff.state", {"sent": self._handoff_present()})
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
            "portMapping": bool(server.get("upnp")),
            "autoAwayMinutes": int(server.get("autoaway") or 0),
            "autoReply": str(server.get("autoreply") or ""),
            "preferBuddies": bool(transfers.get("preferfriends")),
            "fifoQueue": bool(transfers.get("fifoqueue")),
            "queueLimitFiles": int(transfers.get("filelimit") or 0),
            "queueLimitMb": int(transfers.get("queuelimit") or 0),
            "buddiesUnlimited": bool(transfers.get("friendsnolimits")),
            "rekordboxFolder": self._resolve_path(self._load_state().get("rekordbox_folder")) or None,
        }


# Returned by a handler whose reply will come from a worker (see `_defer`).
DEFERRED = object()


class CommandError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
