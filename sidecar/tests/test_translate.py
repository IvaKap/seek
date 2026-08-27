# Seek — upstream -> wire translation.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# These are the tests that encode the RECON.md §4 findings. If upstream ever
# changes the attribute convention, these fail rather than the UI quietly
# rendering blanks.

import pytest

from seek_sidecar import protocol, translate
from seek_sidecar.registries import TransferRegistry


class FakeAttrs:
    """Stand-in for pynicotine.slskmessages.FileAttributes (which uses
    __slots__, so an absent attribute is absent, not None)."""

    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class FakeSearchResponse:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


# ------------------------------------------------------------------ file_ref

def test_lossless_file_carries_no_bitrate():
    """A FLAC advertises duration/sampleRate/bitDepth and NO bitrate. This is
    the convention in FileListMessage.pack_file_info (RECON.md §4) and it is
    what makes the brief's transcode formula inapplicable to lossless."""
    ref = translate.file_ref(
        "x\\a.flac", 30_000_000,
        FakeAttrs(length=240, sample_rate=44100, bit_depth=16),
    )
    assert ref["bitrate"] is None
    assert ref["isVbr"] is None
    assert ref["duration"] == 240
    assert ref["sampleRate"] == 44100
    assert ref["bitDepth"] == 16
    protocol.validate_struct("FileRef", ref)


def test_lossy_file_carries_no_sample_rate_or_bit_depth():
    ref = translate.file_ref(
        "x\\a.mp3", 9_600_000, FakeAttrs(bitrate=320, length=240, vbr=0)
    )
    assert ref["bitrate"] == 320
    assert ref["duration"] == 240
    assert ref["isVbr"] is False
    assert ref["sampleRate"] is None
    assert ref["bitDepth"] is None
    protocol.validate_struct("FileRef", ref)


def test_file_with_no_attributes_at_all_is_all_null():
    """Peers on old clients send zero attributes. Every field must be null, not
    zero — the frontend has to distinguish 'not stated' from 'stated as 0'."""
    ref = translate.file_ref("x\\a.mp3", 5_000_000, FakeAttrs())
    assert ref["bitrate"] is None
    assert ref["duration"] is None
    assert ref["sampleRate"] is None
    assert ref["bitDepth"] is None
    assert ref["isVbr"] is None
    assert ref["size"] == 5_000_000
    protocol.validate_struct("FileRef", ref)


def test_none_attributes_object_is_tolerated():
    ref = translate.file_ref("x\\a.mp3", 1, None)
    assert ref["bitrate"] is None
    protocol.validate_struct("FileRef", ref)


def test_vbr_zero_is_false_not_none():
    """vbr=0 means 'stated, and it is CBR'. Only absence is None."""
    assert translate.file_ref("p", 1, FakeAttrs(vbr=0))["isVbr"] is False
    assert translate.file_ref("p", 1, FakeAttrs(vbr=1))["isVbr"] is True
    assert translate.file_ref("p", 1, FakeAttrs())["isVbr"] is None


def test_dict_attributes_also_work():
    ref = translate.file_ref("p", 1, {"bitrate": 256, "length": 100})
    assert ref["bitrate"] == 256 and ref["duration"] == 100


# ------------------------------------------------------------- search lists

def test_search_list_uses_full_paths_verbatim():
    files = translate.file_refs_from_search([
        (1, "@@abc\\Music\\Artist - Album\\01 Track.flac", 100, None,
         FakeAttrs(length=10, sample_rate=44100, bit_depth=16)),
    ])
    assert files[0]["path"] == "@@abc\\Music\\Artist - Album\\01 Track.flac"


def test_browse_list_rebuilds_full_paths_from_basenames():
    """Browse and folder-contents hand back BASENAMES; search hands back full
    paths. Conflating them enqueues a path that does not exist (RECON.md §6)."""
    files = translate.file_refs_from_folder(
        "@@abc\\Music\\Artist - Album",
        [(1, "01 Track.flac", 100, None, FakeAttrs(length=10))],
    )
    assert files[0]["path"] == "@@abc\\Music\\Artist - Album\\01 Track.flac"


def test_folder_refs_from_contents_handles_a_dict():
    folders = translate.folder_refs_from_contents({
        "A\\B": [(1, "x.mp3", 5, None, FakeAttrs(bitrate=320, length=100))],
    })
    assert folders[0]["path"] == "A\\B"
    assert folders[0]["files"][0]["path"] == "A\\B\\x.mp3"
    assert folders[0]["private"] is False
    protocol.validate_struct("FolderRef", folders[0])


def test_browse_marks_private_folders():
    folders = translate.folder_refs_from_browse(
        [("Pub", [(1, "a.mp3", 1, None, FakeAttrs())])],
        [("Priv", [(1, "b.mp3", 1, None, FakeAttrs())])],
    )
    assert [f["private"] for f in folders] == [False, True]


# -------------------------------------------------------------- peer stats

def test_peer_stats_are_raw_not_normalised():
    """Upstream's GTK client rewrites inqueue to 0 when freeulslots is true.
    That is a display decision and must not happen on the wire."""
    msg = FakeSearchResponse(
        username="realname", search_username="claimed",
        freeulslots=True, ulspeed=1_500_000, inqueue=17,
    )
    peer = translate.peer_stats_from_search(msg)
    assert peer["queueLength"] == 17, "queueLength must not be rewritten"
    assert peer["freeSlots"] is True
    assert peer["advertisedSpeed"] == 1_500_000


def test_peer_identity_uses_connection_name_not_payload_name():
    """msg.search_username is self-reported inside the message; msg.username is
    assigned by the network layer from the authenticated connection."""
    msg = FakeSearchResponse(
        username="realname", search_username="impersonator",
        freeulslots=False, ulspeed=0, inqueue=0,
    )
    assert translate.peer_stats_from_search(msg)["username"] == "realname"


def test_peer_stats_unknown_counts_are_null():
    peer = translate.peer_stats("u", free_slots=False, upload_speed=0, queue_length=0)
    assert peer["files"] is None and peer["folders"] is None
    protocol.validate_struct("PeerStats", peer)


# -------------------------------------------------- connection stats defaults

def test_connection_stats_survives_the_no_argument_reset():
    """slskproto emits set-connection-stats with NO arguments as a reset. A
    handler without defaults raises TypeError inside events.emit, which
    upstream escalates to core.quit() + re-raise."""
    stats = translate.connection_stats()
    assert stats == {"connections": 0, "downloadBandwidth": 0, "uploadBandwidth": 0}
    protocol.validate_struct("ConnectionStats", stats)


def test_connection_stats_with_values():
    stats = translate.connection_stats(12, 340, 56)
    assert stats["connections"] == 12
    assert stats["downloadBandwidth"] == 340


# ------------------------------------------------------------------ states

@pytest.mark.parametrize("upstream,expected", [
    ("Queued", "queued"),
    ("Getting status", "getting_status"),
    ("Transferring", "transferring"),
    ("Paused", "paused"),
    ("Cancelled", "cancelled"),
    ("Filtered", "filtered"),
    ("Finished", "finished"),
    ("User logged off", "user_logged_off"),
    ("Connection closed", "connection_closed"),
    ("Connection timeout", "connection_timeout"),
    ("Download folder error", "download_folder_error"),
    ("Local file error", "local_file_error"),
])
def test_every_upstream_transfer_status_maps(upstream, expected):
    assert translate.transfer_state(upstream) == expected
    assert expected in protocol.ENUM_VALUES["TransferState"]


def test_upstream_status_set_is_covered_completely():
    """If upstream adds a status, this fails rather than silently emitting
    'unknown' forever."""
    from pynicotine.transfers import TransferStatus
    upstream_values = {
        value for key, value in vars(TransferStatus).items()
        if not key.startswith("_") and isinstance(value, str)
    }
    unmapped = {v for v in upstream_values if translate.transfer_state(v) == "unknown"}
    assert not unmapped, f"unmapped upstream TransferStatus values: {unmapped}"


# ------------------------------------------------- refusals, not "unknown"
#
# Upstream writes a peer's refusal STRAIGHT INTO transfer.status
# (downloads.py: `_abort_transfer(download, status=reason)`), and those strings
# are TransferRejectReason values rather than TransferStatus ones. Mapping only
# the closed set turned every refusal into "unknown" and threw away what the
# peer said — which is the single most useful fact about a download that is
# not moving.


@pytest.mark.parametrize("reason", sorted(translate.REJECT_REASONS))
def test_a_peer_refusal_is_rejected_not_unknown(reason):
    assert translate.transfer_state(reason) == "rejected"


def test_free_text_from_a_peer_is_also_a_refusal():
    """`reason.startswith("User limit of")` upstream proves the set is open:
    peers send text nobody enumerated. It is still a refusal, not a mystery."""
    assert translate.transfer_state("User limit of 250 files reached") == "rejected"
    assert translate.transfer_state("Doing A Backflip") == "rejected"


def test_only_an_absent_status_is_unknown():
    """The saved transfer list leaves status unset for rows written before
    upstream had the field (transfers.py, `status = None`). That is the only
    thing genuinely not known."""
    assert translate.transfer_state(None) == "unknown"
    assert translate.transfer_state("") == "unknown"


class _Upstream:
    """The handful of pynicotine Transfer attributes translate.transfer reads."""

    def __init__(self, status):
        self.username = "peer-alpha"
        self.virtual_path = "@@x\\a.flac"
        self.folder_path = "/music"
        self.size = 1000
        self.current_byte_offset = 0
        self.status = status
        self.speed = 0
        self.avg_speed = 0
        self.queue_position = 0
        self.time_left = 0
        self.time_elapsed = 0


def _payload(status):
    record = TransferRegistry().record_for("download", "peer-alpha", "@@x\\a.flac")
    return translate.transfer(record, _Upstream(status))


def test_the_refusal_text_survives_onto_the_wire():
    """The whole point. `error` is the only copy of what the peer said, so a
    transfer that drops it is back to showing nothing useful."""
    out = _payload("File not shared.")
    assert out["state"] == "rejected"
    assert out["error"] == "File not shared."
    # Through the validator: the server DROPS invalid events rather than
    # raising, so a bad shape here would make refusals vanish entirely.
    protocol.validate_struct("Transfer", out)


def test_free_text_refusals_reach_the_wire_intact():
    out = _payload("User limit of 250 files reached")
    assert out["state"] == "rejected"
    assert out["error"] == "User limit of 250 files reached"


def test_a_healthy_transfer_carries_no_error():
    out = _payload("Transferring")
    assert out["state"] == "transferring"
    assert out["error"] is None


@pytest.mark.parametrize("code,expected", [
    (0, "offline"), (1, "away"), (2, "online"), (99, "offline"),
])
def test_user_status_mapping(code, expected):
    assert translate.user_status(code) == expected


# ---------------------------------------------------------------- transfer

class FakeRecord:
    def __init__(self, id="abc123", stalled=False, file=None, direction="download",
                 finished_at=0.0):
        self.id = id
        self.stalled = stalled
        self.file = file
        self.finished_at = finished_at
        # The direction comes from the RECORD, not from the upstream object:
        # pynicotine uses one Transfer class both ways and it does not know
        # which list it is in.
        self.direction = direction


class FakeTransfer:
    def __init__(self, **kwargs):
        self.username = "peer"
        self.virtual_path = "@@x\\a.mp3"
        self.folder_path = "/tmp/dl"
        self.size = 1000
        self.current_byte_offset = 250
        self.status = "Transferring"
        self.speed = 100
        self.avg_speed = 90
        self.queue_position = 0
        self.time_left = 0
        self.time_elapsed = 3
        self.__dict__.update(kwargs)


def test_transfer_payload_is_valid_and_raw():
    payload = translate.transfer(FakeRecord(), FakeTransfer())
    protocol.validate_struct("Transfer", payload)
    assert payload["bytesDone"] == 250
    assert payload["state"] == "transferring"
    assert payload["error"] is None


def test_queue_position_zero_becomes_null():
    """0 means both 'not queued' and 'peer hasn't said'. Null is honest."""
    payload = translate.transfer(FakeRecord(), FakeTransfer(queue_position=0))
    assert payload["queuePosition"] is None
    payload = translate.transfer(FakeRecord(), FakeTransfer(queue_position=4))
    assert payload["queuePosition"] == 4


def test_seconds_left_is_null_when_speed_is_zero():
    """Upstream leaves time_left at 0 when it cannot compute it. Reporting 0
    would render as 'finishing now' on a dead transfer."""
    payload = translate.transfer(
        FakeRecord(), FakeTransfer(speed=0, time_left=0, status="Queued")
    )
    assert payload["secondsLeft"] is None


def test_failure_states_populate_error():
    payload = translate.transfer(
        FakeRecord(), FakeTransfer(status="Connection timeout")
    )
    assert payload["state"] == "connection_timeout"
    assert payload["error"] == "Connection timeout"


def test_finished_is_not_an_error():
    payload = translate.transfer(FakeRecord(), FakeTransfer(status="Finished"))
    assert payload["error"] is None


def test_transfer_carries_the_original_file_ref():
    ref = translate.file_ref("p", 1, FakeAttrs(bitrate=320, length=10))
    payload = translate.transfer(FakeRecord(file=ref), FakeTransfer())
    assert payload["file"]["bitrate"] == 320
    protocol.validate_struct("Transfer", payload)


def test_null_byte_offset_before_start():
    payload = translate.transfer(
        FakeRecord(), FakeTransfer(current_byte_offset=None, status="Queued")
    )
    assert payload["bytesDone"] == 0
    protocol.validate_struct("Transfer", payload)


def test_the_direction_comes_from_the_record_not_the_transfer():
    """Upstream's Transfer class is shared by both directions and carries no
    hint of which it is — only the list it sits in knows. So the record is the
    only honest source, and an upload built from an otherwise identical
    upstream object must come out labelled as one."""
    upstream = FakeTransfer()
    assert translate.transfer(FakeRecord(), upstream)["direction"] == "download"
    assert translate.transfer(
        FakeRecord(direction="upload"), upstream
    )["direction"] == "upload"
