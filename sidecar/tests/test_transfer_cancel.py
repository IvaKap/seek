"""
Seek — cancelling a download has to actually stop it.

THE BUG THIS PINS. Cancelling a folder download aborted every file, and then the
peer's next queued file started downloading anyway — so Cancel did not cancel.
The cause is upstream: `_abort_transfer(CANCELLED)` files a download into
`failed_users` and leaves it in `self.transfers` (transfers.py exempts only
FINISHED/FILTERED/PAUSED), and when the peer re-offers the next file
`_transfer_request_downloads` finds it in `failed_users` and restarts it. The
fix is to also `clear_downloads`, which unfails and drops it, so the re-offer is
refused.

These drive `_cmd_transfer_cancel` over a stub core that records which upstream
calls it makes. `CoreHost.__init__` boots pynicotine's core (one instance per
process, owned by test_integration.py), so the handler is bound to a stub host,
as the other command tests do.
"""

import pytest

from seek_sidecar.core_host import CoreHost
from seek_sidecar.registries import TransferRegistry


class _Upstream:
    def __init__(self, username, path):
        self.username = username
        self.virtual_path = path


class _Component:
    """Enough of core.downloads / core.uploads to resolve ids and record calls."""

    def __init__(self):
        self.transfers = {}          # username+path -> upstream transfer
        self.aborted = []            # [(‹transfers›, status)]
        self.cleared = []            # [‹transfers›]
        self.abort_uploads_calls = []
        self.clear_uploads_calls = []

    def add(self, username, path):
        up = _Upstream(username, path)
        self.transfers[username + path] = up
        return up

    def abort_downloads(self, items, status):
        self.aborted.append((list(items), status))

    def clear_downloads(self, items):
        self.cleared.append(list(items))

    def abort_uploads(self, items, denied_message=None, status=None):
        self.abort_uploads_calls.append((list(items), denied_message, status))

    def clear_uploads(self, items):
        self.clear_uploads_calls.append(list(items))


class _Core:
    def __init__(self, downloads, uploads):
        self.downloads = downloads
        self.uploads = uploads


class _Host:
    def __init__(self):
        self.transfers = TransferRegistry()
        self.downloads = _Component()
        self.uploads = _Component()
        self.core = _Core(self.downloads, self.uploads)

    # The TransferStatus enum CoreHost.__init__ imports from pynicotine.
    from pynicotine.transfers import TransferStatus  # noqa: PLC0415

    _component_for = CoreHost._component_for
    _find_upstream_transfer = CoreHost._find_upstream_transfer
    _iter_upstream_transfers = CoreHost._iter_upstream_transfers
    _cmd_transfer_cancel = CoreHost._cmd_transfer_cancel
    _cmd_transfer_pause = CoreHost._cmd_transfer_pause


def _download(host, username, path):
    """Mint a wire id for a download and give it an upstream object."""
    record = host.transfers.record_for("download", username, path)
    host.downloads.add(username, path)
    return record.id


def _upload(host, username, path):
    record = host.transfers.record_for("upload", username, path)
    host.uploads.add(username, path)
    return record.id


def test_cancel_aborts_and_clears_downloads():
    # The whole fix: cancel must clear as well as abort, or the peer's re-offer
    # of the next queued file resurrects it out of failed_users.
    host = _Host()
    ids = [_download(host, "peer", f"folder\\{i}.flac") for i in range(3)]

    host._cmd_transfer_cancel({"transferIds": ids})

    assert len(host.downloads.aborted) == 1
    aborted, status = host.downloads.aborted[0]
    assert status == host.TransferStatus.CANCELLED
    assert len(aborted) == 3
    # ...and cleared, which is the half that was missing.
    assert len(host.downloads.cleared) == 1
    assert len(host.downloads.cleared[0]) == 3


def test_cancel_clears_every_file_of_a_folder():
    # 64 queued files, one Cancel: all 64 abort AND all 64 clear, so none can be
    # re-offered.
    host = _Host()
    ids = [_download(host, "peer", f"big\\{i:02d}.flac") for i in range(64)]
    host._cmd_transfer_cancel({"transferIds": ids})
    assert len(host.downloads.aborted[0][0]) == 64
    assert len(host.downloads.cleared[0]) == 64


def test_cancel_does_not_clear_uploads():
    # An upload cancel tells the peer via UploadDenied and does NOT clear — a
    # cleared upload would drop the record of someone taking a file from you,
    # and clearing is not how an upload is stopped.
    host = _Host()
    up = _upload(host, "peer", "shared\\x.flac")
    host._cmd_transfer_cancel({"transferIds": [up]})
    assert host.uploads.abort_uploads_calls, "the upload was aborted"
    assert host.uploads.clear_uploads_calls == [], "an upload must not be cleared on cancel"
    assert host.downloads.cleared == []


def test_pause_still_only_aborts_never_clears():
    # The control: pause is the keep-for-later path and must NOT clear, or a
    # paused download would vanish instead of waiting.
    host = _Host()
    d = _download(host, "peer", "folder\\1.flac")
    host._cmd_transfer_pause({"transferIds": [d]})
    assert host.downloads.aborted[0][1] == host.TransferStatus.PAUSED
    assert host.downloads.cleared == []


def test_cancel_ignores_an_unknown_id():
    host = _Host()
    host._cmd_transfer_cancel({"transferIds": ["nope"]})
    assert host.downloads.aborted == []
    assert host.downloads.cleared == []
