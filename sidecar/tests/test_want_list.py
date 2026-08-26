# Seek — want list CRUD and persistence.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The want list is the one piece of discovery state the sidecar OWNS, so these
# exercise the handlers directly against a temporary state file rather than
# going through the socket (test_integration.py does that end to end).
#
# What they pin, besides CRUD: that the sidecar mints ids and timestamps rather
# than trusting a client's, that a round trip through the file preserves the
# list, and that the sidecar never decides whether something was FOUND.

import json
import os

import pytest

from seek_sidecar.core_host import CommandError


class FakeBridge:
    def __init__(self):
        self.events = []

    def broadcast(self, name, data):
        self.events.append((name, data))


class Host:
    """The want-list and session handlers, unbound from pynicotine.

    `CoreHost.__init__` boots upstream; none of that is involved in storing a
    list of intentions, so the methods are borrowed onto a bare object with the
    state helpers they actually use. Shared with test_dig_sessions.py, which
    exercises the same handlers from the other side — want.add is where a
    session gets created, so the two cannot be tested wholly apart.
    """

    METHODS = (
        "_state_path", "_load_state", "_save_state", "_want_entries",
        "_want_state", "_want_publish", "_cmd_want_list", "_cmd_want_add",
        "_cmd_want_remove", "_cmd_want_update", "_sessions", "_session_state",
        "_sessions_publish", "_active_session", "_new_session",
        "_assign_sessions", "_cmd_session_list", "_cmd_session_create",
        "_find_session", "_cmd_session_rename", "_cmd_session_close",
        "_cmd_session_delete",
    )
    CONSTANTS = ("WANT_CAP", "WANT_DEFAULTS", "SESSION_BURST",
                 "SESSION_WINDOW", "SESSION_IDLE")

    def __init__(self, folder, auto=True):
        from seek_sidecar.core_host import CoreHost
        self.data_folder = folder
        self.bridge = FakeBridge()
        self._auto = auto
        for name in self.METHODS:
            setattr(self, name, getattr(CoreHost, name).__get__(self))
        for const in self.CONSTANTS:
            setattr(self, const, getattr(CoreHost, const))

    def _app_settings(self):
        """Only the one key the want list path reads. Settings themselves are
        covered by test_integration.py against the real config."""
        return {"autoDigSessions": self._auto}

    # -- helpers shared with test_dig_sessions ----------------------------

    def add(self, n=1, prefix="t"):
        return self._cmd_want_add({"entries": [
            entry(title=f"{prefix}{i}", sourceUrl=f"https://x.test/{prefix}{i}")
            for i in range(n)
        ]})

    def sessions(self):
        return self._cmd_session_list({})["sessions"]

    def entries(self):
        return self._cmd_want_list({})["entries"]


@pytest.fixture
def host(tmp_path):
    return Host(str(tmp_path))


def entry(**over):
    base = {
        "id": "", "artist": "Burial", "title": "Archangel", "album": None,
        "year": None, "label": None, "catalogNumber": None,
        "sourceKind": "youtube", "sourceUrl": None, "sourceTitle": None,
        "artworkUri": None, "status": "pending", "addedAt": 0.0,
        "searchedAt": None, "notes": None, "duration": None, "tracklist": [],
        "sessionId": None,
    }
    base.update(over)
    return base


def test_starts_empty(host):
    assert host._cmd_want_list({}) == {"entries": []}


def test_add_mints_an_id_and_a_timestamp(host):
    state = host._cmd_want_add({"entries": [entry(id="forged", addedAt=1.0)]})
    [stored] = state["entries"]
    assert stored["id"] and stored["id"] != "forged"
    # A client that could set the id could overwrite someone else's entry by
    # guessing one, and a client clock is not a clock we control.
    assert stored["addedAt"] > 1.0
    assert stored["status"] == "pending"


def test_add_fires_want_changed(host):
    host._cmd_want_add({"entries": [entry()]})
    assert [name for name, _ in host.bridge.events] == ["want.changed"]


def test_newest_first(host):
    host._cmd_want_add({"entries": [entry(title="First")]})
    host._cmd_want_add({"entries": [entry(title="Second")]})
    assert [e["title"] for e in host._cmd_want_list({})["entries"]] == ["Second", "First"]


def test_the_same_url_twice_is_one_intention(host):
    url = "https://www.youtube.com/watch?v=8k_f2QK77ew"
    host._cmd_want_add({"entries": [entry(sourceUrl=url)]})
    state = host._cmd_want_add({"entries": [entry(sourceUrl=url, title="Renamed")]})
    assert len(state["entries"]) == 1


def test_the_same_artist_and_title_twice_is_one_intention(host):
    host._cmd_want_add({"entries": [entry()]})
    state = host._cmd_want_add({"entries": [entry(artist="burial", title="ARCHANGEL")]})
    assert len(state["entries"]) == 1


def test_a_duplicate_add_does_not_fire_an_event(host):
    host._cmd_want_add({"entries": [entry()]})
    host.bridge.events.clear()
    host._cmd_want_add({"entries": [entry()]})
    # Nothing changed, so nothing should claim it did.
    assert host.bridge.events == []


def test_entries_with_no_artist_or_title_are_not_deduped_together(host):
    """Two unparseable entries are two different intentions."""
    host._cmd_want_add({"entries": [entry(artist="", title="", sourceUrl=None)]})
    state = host._cmd_want_add({"entries": [entry(artist="", title="", sourceUrl=None)]})
    assert len(state["entries"]) == 2


def test_remove(host):
    state = host._cmd_want_add({"entries": [entry(), entry(title="Other")]})
    keep = state["entries"][0]["id"]
    drop = state["entries"][1]["id"]
    state = host._cmd_want_remove({"ids": [drop]})
    assert [e["id"] for e in state["entries"]] == [keep]


def test_remove_with_no_ids_is_a_no_op(host):
    host._cmd_want_add({"entries": [entry()]})
    assert len(host._cmd_want_remove({"ids": []})["entries"]) == 1


def test_update_changes_only_what_was_sent(host):
    state = host._cmd_want_add({"entries": [entry(notes="keep me")]})
    entry_id = state["entries"][0]["id"]
    state = host._cmd_want_update({
        "id": entry_id, "artist": "Burial & Four Tet", "title": None,
        "album": None, "status": None, "notes": None,
    })
    [stored] = state["entries"]
    assert stored["artist"] == "Burial & Four Tet"
    assert stored["title"] == "Archangel"       # untouched
    assert stored["notes"] == "keep me"         # null means leave alone


def test_update_stamps_searched_at_only_when_a_search_starts(host):
    state = host._cmd_want_add({"entries": [entry()]})
    entry_id = state["entries"][0]["id"]
    assert state["entries"][0]["searchedAt"] is None

    state = host._cmd_want_update({
        "id": entry_id, "status": "searching",
        "artist": None, "title": None, "album": None, "notes": None,
    })
    stamped = state["entries"][0]["searchedAt"]
    assert stamped is not None

    state = host._cmd_want_update({
        "id": entry_id, "status": "found",
        "artist": None, "title": None, "album": None, "notes": None,
    })
    # Reaching 'found' is not a new search, so the timestamp must not move.
    assert state["entries"][0]["searchedAt"] == stamped


def test_update_of_an_unknown_id_is_an_error_not_a_silent_no_op(host):
    with pytest.raises(CommandError):
        host._cmd_want_update({
            "id": "nope", "artist": None, "title": None, "album": None,
            "status": None, "notes": None,
        })


def test_round_trips_through_the_state_file(host, tmp_path):
    host._cmd_want_add({"entries": [entry(sourceUrl="https://x.test/1")]})

    on_disk = json.load(open(os.path.join(str(tmp_path), "seek-state.json")))
    assert len(on_disk["want_list"]) == 1

    fresh = Host(str(tmp_path))
    assert fresh._cmd_want_list({})["entries"][0]["title"] == "Archangel"


def test_it_shares_the_state_file_with_everything_else(host, tmp_path):
    """The want list must not clobber history, saved searches or consent."""
    host._save_state(history=["burial"], share_consent="granted")
    host._cmd_want_add({"entries": [entry()]})

    state = host._load_state()
    assert state["history"] == ["burial"]
    assert state["share_consent"] == "granted"
    assert len(state["want_list"]) == 1


def test_an_entry_written_by_an_older_build_is_still_emittable(host):
    """The state file outlives the schema.

    An entry persisted before digging sessions existed has no `sessionId`, and
    the generated validator refuses to emit a struct with a missing key — so
    `want.changed` would be dropped and the frontend would quietly stop hearing
    about the list. This is the regression test for that: read it back, and it
    must come out complete.
    """
    from seek_sidecar import protocol

    ancient = {
        "id": "old1", "artist": "Burial", "title": "Archangel",
        "sourceKind": "youtube", "status": "pending", "addedAt": 1.0,
    }
    host._save_state(want_list=[ancient])

    state = host._cmd_want_list({})
    assert state["entries"][0]["sessionId"] is None
    protocol.validate_event("want.changed", state)


def test_garbage_in_the_state_file_is_skipped_not_crashed_on(host):
    host._save_state(want_list=["not an entry", {}, {"id": "ok", "title": "T"}])
    assert [e["id"] for e in host._cmd_want_list({})["entries"]] == ["ok"]


def test_every_entry_validates_against_the_generated_schema(host):
    from seek_sidecar import protocol
    state = host._cmd_want_add({"entries": [entry()]})
    protocol.validate_event("want.changed", state)
