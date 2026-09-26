# Seek — the sidecar single-instance guard.
# SPDX-License-Identifier: GPL-3.0-or-later

import fcntl
import os
import subprocess
import sys

import pytest

from seek_sidecar import singleton


def _lock_pid(folder):
    with open(os.path.join(folder, "sidecar.lock"), encoding="utf-8") as f:
        return int(f.read().strip())


def test_acquires_and_actually_holds_the_lock(tmp_path):
    handle = singleton.ensure_single_instance(str(tmp_path))
    assert handle is not None
    assert _lock_pid(str(tmp_path)) == os.getpid()

    # A second, independent open of the same file cannot take the lock while we
    # hold it — proving the lock is real, not just a pid written to a file.
    other = os.open(os.path.join(str(tmp_path), "sidecar.lock"), os.O_RDWR)
    try:
        with pytest.raises(OSError):
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(other)
    handle.close()


def test_reclaims_a_stale_lockfile_from_a_dead_pid(tmp_path):
    # A clean previous exit leaves the lockfile behind with an old pid but no
    # holder. The lock is free, so we take it without trying to signal anything.
    with open(os.path.join(str(tmp_path), "sidecar.lock"), "w", encoding="utf-8") as f:
        f.write("999999")  # a pid that is not running
    handle = singleton.ensure_single_instance(str(tmp_path))
    assert handle is not None
    assert _lock_pid(str(tmp_path)) == os.getpid()
    handle.close()


# Runs a real predecessor that grabs the lock and then waits. The `-c` body
# mentions seek_sidecar so the takeover's `ps` identity check matches it.
_PREDECESSOR = (
    "import sys, time\n"
    "from seek_sidecar import singleton\n"
    "h = singleton.ensure_single_instance(sys.argv[1])\n"
    "assert h is not None\n"
    "print('ready', flush=True)\n"
    "time.sleep(60)\n"
)


def test_takes_over_a_live_orphaned_predecessor(tmp_path):
    child = subprocess.Popen(
        [sys.executable, "-c", _PREDECESSOR, str(tmp_path)],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert child.stdout.readline().strip() == "ready"  # it now holds the lock

        handle = singleton.ensure_single_instance(str(tmp_path))  # evicts it
        assert handle is not None

        child.wait(timeout=5)          # SIGTERM'd, so it exits
        assert child.returncode is not None
        assert _lock_pid(str(tmp_path)) == os.getpid()
        handle.close()
    finally:
        if child.poll() is None:
            child.kill()
