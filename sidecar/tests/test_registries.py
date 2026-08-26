# Seek — search batching, close reasons, stable ids, stall detection.
# SPDX-License-Identifier: GPL-3.0-or-later

from seek_sidecar import protocol
from seek_sidecar.registries import SearchRegistry, TransferRegistry, transfer_id


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def peer(username="u", **kwargs):
    base = {"username": username, "freeSlots": True, "advertisedSpeed": 1,
            "queueLength": 0, "files": None, "folders": None, "country": None}
    base.update(kwargs)
    return base


def files(n, prefix="f"):
    return [{"path": f"{prefix}{i}.mp3", "size": 100, "bitrate": 320,
             "duration": 10, "sampleRate": None, "bitDepth": None,
             "isVbr": False} for i in range(n)]


# ------------------------------------------------------------------ searches

def test_results_are_batched_per_peer_not_per_response():
    """Three responses from one peer collapse into one frame. Without this the
    frontend is woken hundreds of times a second during the burst."""
    clock = Clock()
    reg = SearchRegistry(batch_interval=0.25, clock=clock)
    reg.add(7, "q", "q", "global")
    for _ in range(3):
        reg.accept(7, peer("alice"), files(4))

    clock.advance(0.3)
    events = reg.flush()
    assert len(events) == 1
    assert len(events[0]["files"]) == 12
    protocol.validate_event("search.result", events[0])


def test_different_peers_get_different_frames():
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    reg.accept(7, peer("alice"), files(2))
    reg.accept(7, peer("bob"), files(2))
    events = reg.flush()
    assert {e["peer"]["username"] for e in events} == {"alice", "bob"}


def test_public_and_private_results_stay_separate():
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    reg.accept(7, peer("alice"), files(2), private=False)
    reg.accept(7, peer("alice"), files(2), private=True)
    events = reg.flush()
    assert sorted(e["private"] for e in events) == [False, True]


def test_newest_peer_stats_win_within_a_batch():
    """A peer's queue can change between responses; the frontend should see the
    most recent figure, not the first."""
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    reg.accept(7, peer("alice", queueLength=1), files(1))
    reg.accept(7, peer("alice", queueLength=9), files(1))
    assert reg.flush()[0]["peer"]["queueLength"] == 9


def test_flush_empties_the_buffer():
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    reg.accept(7, peer(), files(3))
    assert len(reg.flush()) == 1
    assert reg.flush() == []


def test_result_cap_closes_the_search_and_drops_the_overflow():
    """Files past the cap are dropped whole, so resultCount always equals what
    the frontend actually received."""
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global", result_cap=10)
    assert reg.accept(7, peer(), files(6)) is None
    assert reg.accept(7, peer("bob"), files(6)) == "result_cap"

    search = reg.get(7)
    assert search.result_count == 10
    assert sum(len(e["files"]) for e in reg.flush()) == 10


def test_accepting_after_close_is_a_no_op():
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    reg.close(7, "stopped")
    reg.accept(7, peer(), files(5))
    assert reg.get(7).result_count == 0


def test_idle_timeout_expires_a_quiet_search():
    clock = Clock()
    reg = SearchRegistry(clock=clock)
    reg.add(7, "q", "q", "global", idle_timeout=30)
    reg.accept(7, peer(), files(1))

    clock.advance(29)
    assert reg.expired() == []
    clock.advance(2)
    assert reg.expired() == [(7, "timeout")]


def test_a_straggler_resets_the_idle_clock():
    """Soulseek results genuinely arrive minutes late; a late peer must extend
    the window rather than being dropped."""
    clock = Clock()
    reg = SearchRegistry(clock=clock)
    reg.add(7, "q", "q", "global", idle_timeout=30)
    clock.advance(25)
    reg.accept(7, peer(), files(1))
    clock.advance(25)
    assert reg.expired() == []


def test_close_payload_counts_peers_and_results():
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    reg.accept(7, peer("a"), files(3))
    reg.accept(7, peer("b"), files(2))
    payload = reg.close(7, "timeout")
    assert payload == {"searchId": 7, "reason": "timeout",
                       "resultCount": 5, "peerCount": 2}
    protocol.validate_event("search.closed", payload)


def test_closing_twice_yields_nothing_the_second_time():
    reg = SearchRegistry(clock=Clock())
    reg.add(7, "q", "q", "global")
    assert reg.close(7, "stopped") is not None
    assert reg.close(7, "timeout") is None


def test_close_all_on_disconnect():
    reg = SearchRegistry(clock=Clock())
    reg.add(1, "a", "a", "global")
    reg.add(2, "b", "b", "global")
    payloads = reg.close_all("disconnected")
    assert {p["searchId"] for p in payloads} == {1, 2}
    assert all(p["reason"] == "disconnected" for p in payloads)


def test_search_info_validates():
    reg = SearchRegistry(clock=Clock())
    search = reg.add(7, "burial untrue", "burial untrue", "global")
    protocol.validate_event("search.started", search.info())


# ----------------------------------------------------------------- transfers

def test_transfer_id_is_stable_and_separator_safe():
    """Upstream keys on `username + virtual_path` with NO separator, so
    ('ab','c') and ('a','bc') collide. Ours must not."""
    assert transfer_id("alice", "\\x") == transfer_id("alice", "\\x")
    assert transfer_id("ab", "c") != transfer_id("a", "bc")


def test_record_is_reused_for_the_same_pair():
    reg = TransferRegistry(clock=Clock())
    a = reg.record_for("download", "u", "p")
    b = reg.record_for("download", "u", "p")
    assert a is b


def test_reenqueue_backfills_a_missing_file_ref():
    reg = TransferRegistry(clock=Clock())
    first = reg.record_for("download", "u", "p")
    assert first.file is None
    ref = {"path": "p", "size": 1, "bitrate": 320, "duration": 10,
           "sampleRate": None, "bitDepth": None, "isVbr": False}
    assert reg.record_for("download", "u", "p", ref).file == ref


def test_stall_is_detected_after_the_threshold():
    clock = Clock()
    reg = TransferRegistry(stall_seconds=45, clock=clock)
    record = reg.record_for("download", "u", "p")

    reg.observe(record, "transferring", 100)
    clock.advance(44)
    assert reg.observe(record, "transferring", 100) is False
    assert record.stalled is False

    clock.advance(2)
    assert reg.observe(record, "transferring", 100) is True
    assert record.stalled is True


def test_progress_clears_a_stall():
    clock = Clock()
    reg = TransferRegistry(stall_seconds=10, clock=clock)
    record = reg.record_for("download", "u", "p")
    reg.observe(record, "transferring", 0)
    clock.advance(11)
    reg.observe(record, "transferring", 0)
    assert record.stalled is True

    assert reg.observe(record, "transferring", 500) is True
    assert record.stalled is False


def test_paused_is_not_stalled():
    """A paused download has made no progress by definition. Calling it stalled
    would be a lie in the UI."""
    clock = Clock()
    reg = TransferRegistry(stall_seconds=5, clock=clock)
    record = reg.record_for("download", "u", "p")
    reg.observe(record, "transferring", 10)
    clock.advance(60)
    reg.observe(record, "paused", 10)
    assert record.stalled is False


def test_queued_is_not_stalled():
    clock = Clock()
    reg = TransferRegistry(stall_seconds=5, clock=clock)
    record = reg.record_for("download", "u", "p")
    clock.advance(60)
    reg.observe(record, "queued", 0)
    assert record.stalled is False


def test_sweep_finds_a_transfer_that_stopped_emitting_entirely():
    """The case observe() cannot catch: a fully stalled transfer produces NO
    further events, so nothing would ever call observe() again. Without the
    sweep a stall is undetectable by construction."""
    clock = Clock()
    reg = TransferRegistry(stall_seconds=30, clock=clock)
    record = reg.record_for("download", "u", "p")
    reg.observe(record, "transferring", 100)
    record.last_emitted_state = "transferring"

    assert reg.sweep() == []
    clock.advance(31)
    assert [r.id for r in reg.sweep()] == [record.id]
    assert record.stalled is True

    # Already reported — must not be reported again every second.
    assert reg.sweep() == []


def test_sweep_ignores_non_transferring_records():
    clock = Clock()
    reg = TransferRegistry(stall_seconds=1, clock=clock)
    record = reg.record_for("download", "u", "p")
    record.last_emitted_state = "queued"
    clock.advance(60)
    assert reg.sweep() == []


def test_forget_removes_the_record():
    reg = TransferRegistry(clock=Clock())
    record = reg.record_for("download", "u", "p")
    assert reg.forget(record.id) is record
    assert reg.get(record.id) is None
