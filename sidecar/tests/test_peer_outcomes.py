"""
Seek — peer reliability counts TRANSFERS, not state transitions.
SPDX-License-Identifier: GPL-3.0-or-later

The bug these pin was found by building the statistics screen, which was the
first thing to add the per-peer counters up. On a real config they summed to
1,792 failures against 381 downloads ever started — impossible on its face.

The cause: a transfer OSCILLATES. A queued download whose peer goes offline
reads `user_logged_off`, returns to `queued` when they come back, and fails
again on the next disconnect, for as long as it sits in the queue. The old
guard was "the state changed since last time", which is true on every one of
those cycles. Four peers holding stuck transfers had accumulated 524, 522, 438
and 161 "failures" between them.

It was not cosmetic. `reliabilityFrom` feeds the source score, so those peers
sank to the bottom of every ranking on evidence that did not exist, and the
peer chip reported "0 of 524 with you" — a claim about the user's own history
that was untrue.
"""

import pytest

from seek_sidecar.core_host import CoreHost
from seek_sidecar.registries import TransferRecord


class _Host:
    """CoreHost's outcome recorder over a state dict in memory.

    CoreHost.__init__ boots pynicotine's core, which cannot run twice in one
    process — test_integration.py owns the one instance a run is allowed.
    Everything under test here is the real method.
    """

    def __init__(self):
        self.state = {}
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append(name)

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


@pytest.fixture
def host():
    return _Host()


@pytest.fixture
def record():
    return TransferRecord("download", "peer-alpha", "@@x\\Music\\track.flac")


def peers(host):
    return host.state.get("peers") or {}


def counts(host, username="peer-alpha"):
    entry = peers(host).get(username) or {}
    return entry.get("ok", 0), entry.get("failed", 0)


# ------------------------------------------------------------- the basic case


def test_a_finished_transfer_counts_once(host, record):
    host._record_outcome(record, "finished")
    assert counts(host) == (1, 0)


def test_a_failed_transfer_counts_once(host, record):
    host._record_outcome(record, "connection_closed")
    assert counts(host) == (0, 1)


def test_a_state_that_is_not_terminal_counts_nothing(host, record):
    for state in ("queued", "transferring", "getting_status", "paused"):
        host._record_outcome(record, state)
    assert peers(host) == {}


def test_two_different_transfers_from_one_peer_count_twice(host):
    first = TransferRecord("download", "peer-alpha", "@@x\\a.flac")
    second = TransferRecord("download", "peer-alpha", "@@x\\b.flac")
    host._record_outcome(first, "connection_closed")
    host._record_outcome(second, "connection_closed")
    assert counts(host) == (0, 2)


# ------------------------------------------------------------ the oscillation


def test_one_transfer_cycling_forever_counts_one_failure(host, record):
    """THE BUG. A queued download whose peer keeps going offline and coming
    back cycles through a terminal-bad state every time. Two hundred cycles is
    still one transfer that has not worked."""
    for _ in range(200):
        host._record_outcome(record, "user_logged_off")
        host._record_outcome(record, "queued")
        host._record_outcome(record, "connection_timeout")
        host._record_outcome(record, "queued")

    assert counts(host) == (0, 1)


def test_switching_between_two_kinds_of_failure_still_counts_one(host, record):
    """The peer going offline and then the connection timing out are two
    different bad states, and were two separate counts under the old guard."""
    for state in ("user_logged_off", "connection_closed", "connection_timeout",
                  "local_file_error", "download_folder_error"):
        host._record_outcome(record, state)
    assert counts(host) == (0, 1)


def test_a_finished_transfer_repainted_many_times_counts_once(host, record):
    for _ in range(50):
        host._record_outcome(record, "finished")
    assert counts(host) == (1, 0)


# ------------------------------------------------------------------- retries


def test_a_retry_that_works_moves_the_count_rather_than_adding_to_it(host, record):
    """A retry that succeeds is not a failure AND a success. It is a success."""
    host._record_outcome(record, "connection_closed")
    assert counts(host) == (0, 1)

    host._record_outcome(record, "finished")
    assert counts(host) == (1, 0), "the failure should have been taken back"


def test_a_transfer_that_fails_after_finishing_is_not_re_counted(host, record):
    """Nothing after `finished` can un-finish it. Upstream repaints a completed
    transfer on all sorts of occasions."""
    host._record_outcome(record, "finished")
    host._record_outcome(record, "connection_closed")
    assert counts(host) == (1, 0)


def test_taking_a_failure_back_never_goes_negative(host, record):
    """Defensive: the stored count and the record's memory can disagree if the
    state file was edited or predates this field."""
    host.state["peers"] = {"peer-alpha": {"ok": 0, "failed": 0, "lastSeen": 0}}
    host.state["transfer_outcomes"] = {record.id: "failed"}
    host._record_outcome(record, "finished")
    assert counts(host) == (1, 0)


# -------------------------------------------------------------- bookkeeping


def test_each_peer_is_counted_separately(host):
    a = TransferRecord("download", "peer-beta", "@@x\\a.flac")
    b = TransferRecord("download", "peer-alpha", "@@x\\b.flac")
    host._record_outcome(a, "finished")
    host._record_outcome(b, "connection_closed")
    assert counts(host, "peer-beta") == (1, 0)
    assert counts(host, "peer-alpha") == (0, 1)


def test_a_transfer_with_no_username_is_ignored(host):
    record = TransferRecord("download", "", "@@x\\a.flac")
    host._record_outcome(record, "finished")
    assert peers(host) == {}


def test_the_change_is_announced_once_per_real_outcome(host, record):
    for _ in range(20):
        host._record_outcome(record, "connection_closed")
        host._record_outcome(record, "queued")
    assert host.broadcasts.count("peers.stats") == 1


def test_last_seen_is_stamped(host, record):
    host._record_outcome(record, "finished")
    assert peers(host)["peer-alpha"]["lastSeen"] > 0


def test_existing_history_is_added_to_rather_than_replaced(host):
    host.state["peers"] = {"peer-alpha": {"ok": 9, "failed": 10, "lastSeen": 1}}
    host._record_outcome(TransferRecord("download", "peer-alpha", "@@x\\new.flac"), "finished")
    assert counts(host) == (10, 10)
