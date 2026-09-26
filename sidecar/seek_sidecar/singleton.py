# Seek — one sidecar at a time.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The Tauri app spawns a sidecar and kills it on a clean exit. But an abrupt
# death — a crash, a `kill -9`, or `tauri dev` rebuilding — orphans the child
# (it reparents to pid 1) with its Soulseek connection and seek-state.json still
# open. The NEXT launch's sidecar then logs in a SECOND time with the same
# account, the server bumps one of them, and sign-in "doesn't work"; two
# processes also end up writing one state file.
#
# So the newest sidecar wins: on startup it evicts any predecessor before it
# binds or signs in. flock is the mechanism because the OS drops the lock the
# instant the holder dies — by ANY signal, with no stale lockfile left to reason
# about. The pid written inside the lockfile only says WHOM to evict; the lock
# itself says WHETHER anyone is still there.

import errno
import logging
import os
import signal
import subprocess
import time

try:
    import fcntl
except ImportError:  # pragma: no cover - Seek ships only to POSIX
    fcntl = None

log = logging.getLogger("seek.singleton")

# How long to let a SIGTERM'd predecessor exit before escalating to SIGKILL.
TAKEOVER_GRACE = 3.0
_POLL = 0.1


class SingletonError(RuntimeError):
    """A live predecessor sidecar could not be evicted."""


def ensure_single_instance(app_folder):
    """Acquire the sidecar singleton lock, evicting an orphan if one holds it.

    Returns the locked file object, which the caller MUST keep referenced for the
    life of the process — closing it releases the lock. Returns None when the
    platform has no flock, leaving the guard a documented no-op. Raises
    SingletonError when a live predecessor refuses to die.
    """
    if fcntl is None:
        log.warning("no fcntl on this platform; single-instance guard disabled")
        return None

    os.makedirs(app_folder, exist_ok=True)
    path = os.path.join(app_folder, "sidecar.lock")
    # O_RDWR|O_CREAT, not "a+": append mode forces every write to EOF, which
    # would defeat the seek(0)+truncate the pid rewrite depends on.
    handle = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o644), "r+",
                       encoding="utf-8")

    if _try_lock(handle):
        _write_pid(handle)
        return handle

    old = _read_pid(handle)
    if old and old != os.getpid() and _process_is_sidecar(old):
        log.warning("another sidecar (pid %s) holds the lock; taking over", old)
        _signal(old, signal.SIGTERM)

    if _wait_for_lock(handle, TAKEOVER_GRACE):
        _write_pid(handle)
        return handle

    # Predecessor ignored SIGTERM. Force it, then try once more.
    if old and _process_is_sidecar(old):
        log.warning("sidecar pid %s ignored SIGTERM; sending SIGKILL", old)
        _signal(old, signal.SIGKILL)
        if _wait_for_lock(handle, 1.0):
            _write_pid(handle)
            return handle

    handle.close()
    raise SingletonError("another sidecar is running and could not be stopped")


def _try_lock(handle):
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError as exc:
        if exc.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
            return False
        raise


def _wait_for_lock(handle, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if _try_lock(handle):
            return True
        time.sleep(_POLL)
    return False


def _write_pid(handle):
    try:
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
    except OSError:
        log.exception("could not record the sidecar pid")


def _read_pid(handle):
    try:
        handle.seek(0)
        return int(handle.read().strip() or "0")
    except (OSError, ValueError):
        return 0


def _process_is_sidecar(pid):
    """True only if pid is a live process that is a Seek sidecar.

    Confirmed by command line (via `ps`, since macOS has no /proc) so a pid that
    has been reused by an unrelated process is never signalled. When `ps` cannot
    answer, err toward NOT killing.
    """
    if pid <= 0:
        return False
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "seek_sidecar" in out or "seek-sidecar" in out


def _signal(pid, sig):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except OSError:
        log.exception("could not signal pid %s", pid)
