# Seek — the diagnostic log a person can attach to a bug report.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHY THIS EXISTS. A user reported "i pasted and saved the token, now the search
# says discogs token needed". Finding the cause took a live sidecar, a
# hand-written websocket client and a raw `app.settings.patch` probe, because
# the app kept no record of anything that had happened to it. The answer — every
# settings save failing on a missing field — would have been the first line of a
# log file.
#
# WHAT THIS IS NOT. It is not telemetry. Nothing is sent, nothing is collected,
# and nothing here ever reaches the network. The file sits on the user's disk
# until they choose to attach it, which is why the About screen can go on saying
# Seek collects nothing.
#
# THE DESIGN CONSTRAINT that shapes everything below: this file is written to be
# EMAILED TO A STRANGER. Every decision assumes the reader has not vetted it.
#
#   * It is attached to the `seek` logger, not the root, so upstream's world
#     stays out of it: no peer handles, no filenames, no search terms. (Upstream
#     does not use `logging` at all — it has its own Logger in
#     pynicotine/logfacility.py — so this is what we get anyway. The narrow
#     attachment states the intent rather than relying on that staying true.)
#   * It lives at `<data>/seek.log`, NOT in `<data>/logs/`. That directory is
#     upstream's and holds `logs/private/<peer>.log` — real chat transcripts.
#     Putting a file we ask people to send next to those invites someone to zip
#     the folder.
#   * The formatter rewrites the user's home directory to `~`, because
#     `core_host` logs three absolute paths on every single launch and the first
#     of them carries the person's real name.
#
# NEVER ADD A STDOUT HANDLER. The Tauri shell reads exactly one line from the
# sidecar's stdout and parses it as the endpoint JSON (lib.rs, spawn_sidecar).
# A second line there does not degrade the log — it stops the app launching.

import logging
import logging.handlers  # noqa: F401  (see FROZEN BUILDS below)
import os

# FROZEN BUILDS. `logging.handlers` is a separate module from `logging`, and
# PyInstaller only bundles what something imports. Nothing did, so it was absent
# from the freeze — verified in PYZ-00.toc. Importing it explicitly is what puts
# it in the bundle; `seek-sidecar.spec` names it in `hiddenimports` as well,
# because the failure mode is the expensive one: works from the venv, crashes
# the shipped app. That is exactly how the missing CA bundle shipped.

log = logging.getLogger("seek.logfile")

#: One megabyte, plus one previous file. Enough to hold a long session and the
#: run before it; small enough to paste into an issue. A cap and one old copy is
#: the same shape as upstream's own `config` / `config.old`.
MAX_BYTES = 1024 * 1024
BACKUPS = 1

LOG_NAME = "seek.log"


class HomeRedactingFormatter(logging.Formatter):
    """Rewrites the user's home directory to `~`.

    `core_host.start` logs the upstream, config and data paths at INFO on every
    launch, so the first three lines of every log would otherwise carry
    `/Users/<their real name>/…`. That is the most likely accidental PII in a
    bug report, and one `str.replace` removes it from every message at once
    rather than auditing every call site for ever.

    Applied at format time, not as a filter on the record: by then the `%s`
    arguments have been merged, so a path passed as an argument is caught just
    the same as one baked into the message.
    """

    def __init__(self, fmt, home=None):
        super().__init__(fmt)
        # Resolved once. Falls back to a sentinel that cannot occur in a path,
        # so a machine with no home directory does not blank every message.
        self._home = (home if home is not None else os.path.expanduser("~")) or "\0"

    def format(self, record):
        return super().format(record).replace(self._home, "~")


def log_path(app_folder):
    """Where the log lives, without creating anything.

    Separate from `attach` so the hello reply can state the path even in the
    unlikely case that attaching failed — telling someone where the log would
    be is more use than telling them nothing.
    """
    return os.path.join(app_folder, "data", LOG_NAME)


def attach(app_folder, verbose=False):
    """Start writing `seek.*` records to `<app_folder>/data/seek.log`.

    Returns the path. Never raises: a diagnostic aid that stops the app from
    starting would be worse than no diagnostic aid, so a failure here is
    reported to stderr and the sidecar carries on without a file.
    """
    path = log_path(app_folder)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8",
        )
    except OSError:
        # stderr still works, and under `tauri dev` someone will see this.
        logging.getLogger("seek.logfile").exception(
            "could not open the log file; continuing without one")
        return path

    handler.setFormatter(HomeRedactingFormatter(
        "%(asctime)s %(levelname)-7s %(name)s  %(message)s"))
    # DEBUG only on request. At INFO the file stays small and carries nothing
    # from the debug-level call sites that log search terms and browsed URLs.
    handler.setLevel(logging.DEBUG if verbose else logging.INFO)

    seek = logging.getLogger("seek")
    # Not the root logger. See the header: this is the line that keeps peer
    # handles, filenames and search terms out of a file people email.
    seek.addHandler(handler)
    # `seek` would otherwise sit at NOTSET and defer to root's level, which
    # `basicConfig` may have set higher than this handler wants.
    seek.setLevel(logging.DEBUG if verbose else logging.INFO)
    return path


#: How much of the log to hand back for a bug report. Sized to be pasteable
#: into a Reddit comment or a GitHub issue without collapsing it behind a
#: "show more" — past that people stop reading, and an unread log is no better
#: than no log.
TAIL_BYTES = 16 * 1024


def tail(path, limit=TAIL_BYTES):
    """The end of the log, plus the size of the whole thing.

    Reads from the END rather than loading the file: it is capped at a megabyte,
    but this runs on the command thread and there is no reason to hold all of it
    in memory to show the last page.

    Returns `(text, total_bytes)`. A missing file is ("", 0) rather than an
    error — "there is no log" is a legitimate answer and a useful one.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > limit:
                handle.seek(size - limit)
                # The seek almost certainly landed mid-line; drop the fragment
                # so the paste does not open on half a word.
                handle.readline()
            body = handle.read()
    except OSError:
        return "", 0
    # errors="replace" rather than strict: a truncated multi-byte character at
    # the seek point must not cost somebody their whole bug report.
    return body.decode("utf-8", errors="replace"), size
