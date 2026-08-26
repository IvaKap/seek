# Seek — digging sessions: auto-grouping, lifecycle, and unlinking.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The interesting behaviour here is the RULE, not the CRUD: one link saved on
# its own is not a digging session, three inside ten minutes is, and a session
# stops collecting after half an hour of quiet. Getting that wrong in the
# generous direction turns every single addition into a "session" and the
# feature becomes noise attached to a timestamp.

import time

import pytest

from seek_sidecar.core_host import CommandError
from .test_want_list import Host, entry


@pytest.fixture
def host(tmp_path):
    return Host(str(tmp_path))


# ------------------------------------------------------------- the rule

def test_one_saved_link_is_not_a_session(host):
    host.add(1)
    assert host.sessions() == []
    assert host.entries()[0]["sessionId"] is None


def test_two_are_not_either(host):
    host.add(2)
    assert host.sessions() == []


def test_three_inside_the_window_open_a_session(host):
    host.add(3)
    [session] = host.sessions()
    assert session["closed"] is False
    assert all(e["sessionId"] == session["id"] for e in host.entries())


def test_the_burst_may_arrive_as_separate_adds(host):
    """Three separate pastes are still one digging binge."""
    host.add(1, "a")
    host.add(1, "b")
    assert host.sessions() == []
    host.add(1, "c")
    assert len(host.sessions()) == 1
    assert all(e["sessionId"] for e in host.entries())


def test_entries_older_than_the_window_do_not_count_towards_a_burst(host):
    host.add(2, "old")
    # Backdate them well outside the ten-minute window.
    entries = host._want_entries()
    for e in entries:
        e["addedAt"] = time.time() - host.SESSION_WINDOW - 60
    host._save_state(want_list=entries)

    host.add(1, "new")
    # One recent entry is not a binge, however many stale ones sit behind it.
    assert host.sessions() == []


def test_later_additions_join_the_open_session(host):
    host.add(3)
    [session] = host.sessions()
    host.add(1, "later")
    assert len(host.sessions()) == 1
    assert host.entries()[0]["sessionId"] == session["id"]


def test_a_session_stops_collecting_after_a_long_silence(host):
    host.add(3)
    sessions = host._sessions()
    sessions[0]["lastActiveAt"] = time.time() - host.SESSION_IDLE - 60
    host._save_state(dig_sessions=sessions)

    host.add(1, "much-later")
    [stale] = [s for s in host.sessions() if s["closed"]]
    assert stale is not None
    # The straggler did not join a session that had already gone quiet.
    assert host.entries()[0]["sessionId"] is None


def test_listing_closes_a_session_that_has_gone_quiet(host):
    host.add(3)
    sessions = host._sessions()
    sessions[0]["lastActiveAt"] = time.time() - host.SESSION_IDLE - 1
    host._save_state(dig_sessions=sessions)
    assert host.sessions()[0]["closed"] is True


def test_the_session_is_backdated_to_the_start_of_the_binge(host):
    """It began when the digging did, not when the third link confirmed it."""
    host.add(3)
    [session] = host.sessions()
    earliest = min(e["addedAt"] for e in host.entries())
    assert session["createdAt"] == pytest.approx(earliest)


def test_auto_grouping_can_be_switched_off(tmp_path):
    host = Host(str(tmp_path), auto=False)
    host.add(5)
    assert host.sessions() == []
    assert all(e["sessionId"] is None for e in host.entries())


# ------------------------------------------------------------- lifecycle

def test_an_explicit_session_collects_immediately(host):
    host._cmd_session_create({"name": "Saturday crate dig"})
    host.add(1)
    [session] = host.sessions()
    assert session["name"] == "Saturday crate dig"
    # No burst needed: the user said this is a session.
    assert host.entries()[0]["sessionId"] == session["id"]


def test_creating_a_session_closes_the_one_before_it(host):
    host.add(3)
    host._cmd_session_create({"name": None})
    sessions = host.sessions()
    assert len(sessions) == 2
    assert sessions[0]["closed"] is False
    assert sessions[1]["closed"] is True


def test_an_auto_session_has_no_name(host):
    """Wording a timestamp is display formatting, and that is not Python's."""
    host.add(3)
    assert host.sessions()[0]["name"] == ""


def test_rename(host):
    host.add(3)
    session_id = host.sessions()[0]["id"]
    state = host._cmd_session_rename({"id": session_id, "name": "Hyperdub hole"})
    assert state["sessions"][0]["name"] == "Hyperdub hole"


def test_close_stops_new_entries_joining(host):
    host.add(3)
    session_id = host.sessions()[0]["id"]
    host._cmd_session_close({"id": session_id})
    host.add(1, "after")
    assert host.entries()[0]["sessionId"] is None


def test_delete_unlinks_entries_rather_than_deleting_them(host):
    host.add(3)
    session_id = host.sessions()[0]["id"]
    host._cmd_session_delete({"id": session_id})

    assert host.sessions() == []
    entries = host.entries()
    # THE POINT: a session is a grouping of things you wanted, not the things.
    assert len(entries) == 3
    assert all(e["sessionId"] is None for e in entries)


def test_operations_on_an_unknown_session_are_errors(host):
    for handler in (host._cmd_session_close, host._cmd_session_delete):
        with pytest.raises(CommandError):
            handler({"id": "nope"})
    with pytest.raises(CommandError):
        host._cmd_session_rename({"id": "nope", "name": "x"})


# ------------------------------------------------------- events and disk

def test_auto_creation_announces_itself(host):
    host.add(3)
    assert "session.changed" in [name for name, _ in host.bridge.events]


def test_delete_announces_both_lists_because_both_changed(host):
    host.add(3)
    host.bridge.events.clear()
    host._cmd_session_delete({"id": host.sessions()[0]["id"]})
    names = [name for name, _ in host.bridge.events]
    assert "want.changed" in names and "session.changed" in names


def test_sessions_survive_a_restart(host, tmp_path):
    host.add(3)
    host._cmd_session_rename({"id": host.sessions()[0]["id"], "name": "Kept"})

    fresh = Host(str(tmp_path))
    [session] = fresh.sessions()
    assert session["name"] == "Kept"
    assert all(e["sessionId"] == session["id"] for e in fresh.entries())


def test_the_session_list_validates_against_the_generated_schema(host):
    from seek_sidecar import protocol
    host.add(3)
    protocol.validate_event("session.changed", host._session_state())
