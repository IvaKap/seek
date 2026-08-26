"""
Seek — the upload half of the transfer seam.
SPDX-License-Identifier: GPL-3.0-or-later

Uploads had no commands, no events and no state. The engine has been serving
peers since sharing was first switched on — `stats.get` counts the bytes — and
none of it reached a screen.

Upstream makes this mostly symmetrical: one Transfer class, one status
vocabulary, and four events per direction with matching signatures. The places
it is NOT symmetrical are what these tests are about.

  - ONE ID SPACE, so the id must carry the direction. Without that, a download
    from a peer and an upload to that peer collide as soon as the two virtual
    paths match — and a folder you downloaded into is often a folder you share.
  - PEER RELIABILITY IS A DOWNLOAD MEASURE. It answers "does this peer send me
    things", it feeds `sourceScore`, and an upload finishing says nothing about
    it.
  - THERE IS NO PAUSED UPLOAD. `uploads.py` never sets that status.
"""

import pytest

from seek_sidecar import protocol, registries, translate
from seek_sidecar.core_host import CoreHost
from seek_sidecar.registries import TransferRecord, TransferRegistry, transfer_key


# ------------------------------------------------------------------ the ids


def test_direction_is_part_of_the_id():
    down = transfer_key("download", "peer-alpha", "@@x\\Music\\a.flac")
    up = transfer_key("upload", "peer-alpha", "@@x\\Music\\a.flac")
    assert down != up


def test_the_same_peer_and_path_in_both_directions_are_two_records():
    """The collision this design exists to prevent. Download an album from
    someone into a folder you share, and they can fetch it straight back under
    a path that may match exactly."""
    reg = TransferRegistry()
    down = reg.record_for("download", "peer-alpha", "@@x\\Music\\a.flac")
    up = reg.record_for("upload", "peer-alpha", "@@x\\Music\\a.flac")

    assert down is not up
    assert down.id != up.id
    assert len(reg.records) == 2


def test_a_record_remembers_its_direction():
    reg = TransferRegistry()
    assert reg.record_for("upload", "u", "p").direction == "upload"
    assert reg.record_for("download", "u", "p").direction == "download"


def test_the_same_direction_and_path_is_still_one_record():
    reg = TransferRegistry()
    first = reg.record_for("upload", "u", "p")
    assert reg.record_for("upload", "u", "p") is first


def test_progress_on_one_direction_does_not_touch_the_other():
    """The concrete harm of a shared record: a finishing upload overwriting a
    running download's progress."""
    reg = TransferRegistry()
    down = reg.record_for("download", "peer-alpha", "@@x\\a.flac")
    up = reg.record_for("upload", "peer-alpha", "@@x\\a.flac")

    reg.observe(down, "transferring", 500)
    reg.observe(up, "finished", 9999)

    assert down.last_offset == 500
    assert down.last_emitted_state != "finished"


def test_the_remembered_outcome_is_not_shared_between_directions(host):
    """`transfer_outcomes` is keyed on the transfer id and makes peer
    reliability count each transfer once. If the two directions shared an id,
    an upload would spend the download's one count — so this asserts against
    the persisted map rather than against the record."""
    down = host.transfers.record_for("download", "peer-alpha", "@@x\\a.flac")
    up = host.transfers.record_for("upload", "peer-alpha", "@@x\\a.flac")

    host.state["transfer_outcomes"] = {down.id: "failed"}
    assert up.id not in host.state["transfer_outcomes"]


# ------------------------------------------------- reliability is one-way


class _Host:
    """CoreHost's emit path with the bridge and peer store in memory."""

    def __init__(self):
        self.state = {}
        self.events = []
        self.bridge = self
        self.transfers = TransferRegistry()

    def broadcast(self, name, payload):
        self.events.append((name, payload))

    def _load_state(self):
        return dict(self.state)

    def _save_state(self, **updates):
        self.state.update(updates)
        return dict(self.state)

    OUTCOME_CAP = CoreHost.OUTCOME_CAP
    TERMINAL_OK = CoreHost.TERMINAL_OK
    TERMINAL_BAD = CoreHost.TERMINAL_BAD
    _record_outcome = CoreHost._record_outcome
    _peer_history = CoreHost._peer_history
    _emit_transfer = CoreHost._emit_transfer


class _Upstream:
    def __init__(self, username="peer-alpha", path="@@x\\a.flac", status="Finished"):
        self.username = username
        self.virtual_path = path
        self.folder_path = "/Users/x/Muzik"
        self.size = 1000
        self.current_byte_offset = 1000
        self.status = status
        self.speed = 0
        self.avg_speed = 0
        self.queue_position = 0
        self.time_left = 0
        self.time_elapsed = 5


@pytest.fixture
def host():
    return _Host()


def peers(host):
    return host.state.get("peers") or {}


def test_a_finished_download_counts_towards_peer_reliability(host):
    """Witnessed, not restored — the transfer has to be seen running before it
    finishes. A lone `Finished` is a record reloaded from upstream's list, and
    the guard below refuses to count those."""
    upstream = _Upstream(status="Transferring")
    host._emit_transfer(upstream, "download")
    upstream.status = "Finished"
    host._emit_transfer(upstream, "download")
    assert peers(host).get("peer-alpha", {}).get("ok") == 1


def test_a_finished_upload_counts_towards_nothing(host):
    """Peer reliability answers "does this peer SEND ME THINGS", and it feeds
    `sourceScore`. An upload finishing is a fact about my connection, not
    theirs; an upload failing usually means they cancelled or wandered off.
    Either would move a ranking on evidence that does not bear on it.

    Witnessed, so this proves the DIRECTION rule rather than accidentally
    passing on the first-sighting guard."""
    upstream = _Upstream(status="Transferring")
    host._emit_transfer(upstream, "upload")
    upstream.status = "Finished"
    host._emit_transfer(upstream, "upload")
    assert peers(host) == {}


def test_a_failed_upload_does_not_blame_the_peer(host):
    upstream = _Upstream(status="Transferring")
    host._emit_transfer(upstream, "upload")
    upstream.status = "Connection closed"
    host._emit_transfer(upstream, "upload")
    assert peers(host) == {}


def test_an_upload_is_still_announced(host):
    """Not counted is not the same as not reported — the whole point is that
    uploads become visible."""
    host._emit_transfer(_Upstream(), "upload")
    names = [name for name, _ in host.events]
    assert "transfer.added" in names


def test_the_announced_payload_is_labelled_upload(host):
    host._emit_transfer(_Upstream(), "upload")
    _name, payload = host.events[-1]
    assert payload["direction"] == "upload"
    assert payload["username"] == "peer-alpha"


def test_both_directions_from_one_peer_are_announced_separately(host):
    host._emit_transfer(_Upstream(), "download")
    host._emit_transfer(_Upstream(), "upload")

    payloads = [p for _n, p in host.events if _n in ("transfer.added", "transfer.updated")]
    ids = {p["id"] for p in payloads}
    assert len(ids) == 2, "one id for two transfers — the collision is back"
    assert {p["direction"] for p in payloads} == {"download", "upload"}


def test_a_transfer_already_terminal_on_first_sight_is_not_counted(host):
    """Upstream reloads its saved transfer list on every start, and anything
    whose peer is offline comes back ALREADY failed. Counting that logs one
    fresh failure per restart for a transfer that has simply been sitting
    there — measured at +12 outcomes across one restart before this guard."""
    host._emit_transfer(_Upstream(status="Connection closed"), "download")
    assert peers(host) == {}


def test_a_transfer_that_fails_after_we_saw_it_queued_is_counted(host):
    """The control: a real failure we watched happen still counts, so the
    guard above is not simply switching the feature off."""
    upstream = _Upstream(status="Queued")
    host._emit_transfer(upstream, "download")
    upstream.status = "Connection closed"
    host._emit_transfer(upstream, "download")
    assert peers(host).get("peer-alpha", {}).get("failed") == 1


def test_a_restored_finished_download_is_not_counted_either(host):
    """Same rule both ways. A completed download reloaded from upstream's list
    is not a success that happened this session."""
    host._emit_transfer(_Upstream(status="Finished"), "download")
    assert peers(host) == {}


def test_restarting_does_not_keep_adding_to_a_stuck_transfer(host):
    """The whole point, stated as the scenario. Ten restarts of a download
    whose peer never comes back is still one transfer that has not worked."""
    for _ in range(10):
        fresh = _Host()          # a restart is a fresh registry
        fresh.state = host.state  # the peer store persists
        fresh._emit_transfer(_Upstream(status="User logged off"), "download")
        host.state = fresh.state
    assert peers(host) == {}


# --------------------------------------------------------- what upstream has


def test_uploads_never_report_a_paused_state():
    """`transfer.pause` refuses uploads because there is nothing to refuse it
    with: upstream's uploads.py never sets PAUSED. Pinned against upstream's
    own source so it fails loudly if that ever changes."""
    import os
    import pynicotine

    source = open(
        os.path.join(os.path.dirname(pynicotine.__file__), "uploads.py"),
        encoding="utf-8",
    ).read()
    assert "TransferStatus.PAUSED" not in source
    # The control: downloads do set it, so the check above is meaningful.
    downloads = open(
        os.path.join(os.path.dirname(pynicotine.__file__), "downloads.py"),
        encoding="utf-8",
    ).read()
    assert "TransferStatus.PAUSED" in downloads


def test_the_translated_payload_carries_a_direction():
    reg = TransferRegistry()
    record = reg.record_for("upload", "peer-alpha", "@@x\\a.flac")
    payload = translate.transfer(record, _Upstream())
    assert payload["direction"] == "upload"
    # Through the generated validator, because the server DROPS an invalid
    # event rather than raising — a missing direction would silently make
    # every upload disappear from the UI.
    protocol.validate_struct("Transfer", payload)
