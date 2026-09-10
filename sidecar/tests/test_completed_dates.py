# Seek — a restored completed download must carry its real finish date.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# THE BUG THIS PINS. Soulseek has no completion time and upstream keeps none, so
# the finish time is stamped in memory when a download lands. On restart (every
# app update) that stamp is gone: `_transfer_snapshot` rebuilds records straight
# from upstream's list without running them through `observe`, so every finished
# download came back with finishedAt=null and Completed filed the lot under
# "Undated" — even ones pulled down days earlier.
#
# The fix reads the finish time back off the file itself (its mtime), the only
# source that survives a restart. These pin that it is used, that a missing file
# reads as undated rather than wrongly dated, and that an in-flight download is
# left alone.

import os
import time

from seek_sidecar.core_host import CoreHost
from seek_sidecar.registries import TransferRegistry


class FakeUpstream:
    def __init__(self, status="Finished", **kw):
        self.username = "peer"
        self.virtual_path = "@@music\\Album\\a.flac"
        self.folder_path = "/dl"
        self.size = 1000
        self.current_byte_offset = 1000
        self.status = status
        self.speed = 0
        self.avg_speed = 0
        self.queue_position = 0
        self.time_left = 0
        self.time_elapsed = 5
        self.__dict__.update(kw)


class FakeDownloads:
    """Upstream's downloads component, reduced to what the snapshot touches."""

    def __init__(self, path, exists):
        self._path = path
        self._exists = exists
        self.transfers = {}

    def get_complete_download_file_path(self, username, virtual_path, size, folder=None):
        return self._path, self._exists


class FakeCore:
    def __init__(self, downloads):
        self.downloads = downloads
        self.uploads = None


class Host:
    METHODS = ("_completed_mtime", "_transfer_snapshot")

    def __init__(self, downloads):
        self.core = FakeCore(downloads)
        self.transfers = TransferRegistry()
        for name in self.METHODS:
            setattr(self, name, getattr(CoreHost, name).__get__(self))


def _aged_file(tmp_path, days):
    f = tmp_path / "a.flac"
    f.write_bytes(b"x")
    when = time.time() - days * 86_400
    os.utime(f, (when, when))
    return str(f), when


# -- _completed_mtime -----------------------------------------------------

def test_reads_the_files_mtime(tmp_path):
    path, when = _aged_file(tmp_path, 3)
    h = Host(FakeDownloads(path, True))
    assert abs(h._completed_mtime(FakeUpstream()) - when) < 2


def test_zero_when_the_file_is_gone(tmp_path):
    h = Host(FakeDownloads(str(tmp_path / "gone.flac"), False))
    assert h._completed_mtime(FakeUpstream()) == 0.0


def test_zero_without_a_downloads_component():
    h = Host(FakeDownloads(None, False))
    h.core.downloads = None
    assert h._completed_mtime(FakeUpstream()) == 0.0


# -- the snapshot ---------------------------------------------------------

def test_snapshot_dates_a_finished_download_from_the_file(tmp_path):
    path, when = _aged_file(tmp_path, 5)
    dl = FakeDownloads(path, True)
    dl.transfers = {"k": FakeUpstream(status="Finished")}
    [payload] = Host(dl)._transfer_snapshot()
    assert payload["state"] == "finished"
    assert payload["finishedAt"] == int(when)          # was None before the fix


def test_snapshot_leaves_an_in_flight_download_undated(tmp_path):
    path, _ = _aged_file(tmp_path, 5)
    dl = FakeDownloads(path, True)
    dl.transfers = {"k": FakeUpstream(status="Transferring")}
    [payload] = Host(dl)._transfer_snapshot()
    assert payload["finishedAt"] is None


def test_snapshot_undated_when_the_file_is_missing(tmp_path):
    dl = FakeDownloads(str(tmp_path / "gone.flac"), False)
    dl.transfers = {"k": FakeUpstream(status="Finished")}
    [payload] = Host(dl)._transfer_snapshot()
    assert payload["finishedAt"] is None
