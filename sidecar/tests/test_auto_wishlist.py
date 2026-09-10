# Seek — auto-download persistence: the wish `auto` flag and the claim ledger.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# These exercise the handlers directly against a temporary state file, the way
# test_want_list.py does. What they pin: that the sidecar STORES this state and
# nothing more (it never decides what to download or whether a claim is done),
# that a round trip through the file survives a restart, and that removing a
# wish takes its auto flag and any claim with it — the same cleanup the filters
# and seen-sets already get, for the same reason.

import pytest

from seek_sidecar.core_host import CommandError, CoreHost


class FakeBridge:
    def __init__(self):
        self.events = []

    def broadcast(self, name, data):
        self.events.append((name, data))


class FakeSearch:
    """The shape the wishlist handlers touch on `core.search`."""

    def __init__(self):
        self.wishlist = []            # add appends; the state reverses for display
        self.wishlist_interval = 720

    def add_wish(self, query):
        if query not in self.wishlist:
            self.wishlist.append(query)

    def remove_wish(self, query):
        self.wishlist = [q for q in self.wishlist if q != query]


class FakeCore:
    def __init__(self):
        self.search = FakeSearch()


class Host:
    METHODS = (
        "_state_path", "_load_state", "_save_state",
        "_wish_filters", "_wish_seen", "_wish_auto", "_wishlist_state",
        "_auto_claims", "_cmd_wishlist_add", "_cmd_wishlist_auto",
        "_cmd_wishlist_remove", "_cmd_wishlist_claims", "_cmd_wishlist_claimsList",
    )

    def __init__(self, folder):
        self.data_folder = str(folder)
        self.bridge = FakeBridge()
        self.core = FakeCore()
        for name in self.METHODS:
            setattr(self, name, getattr(CoreHost, name).__get__(self))


@pytest.fixture
def host(tmp_path):
    h = Host(tmp_path)
    h._cmd_wishlist_add({"query": "burial untrue"})
    return h


def _item(state, query):
    return next(i for i in state["items"] if i["query"] == query)


# -- the auto flag --------------------------------------------------------

def test_auto_defaults_off(host):
    assert _item(host._wishlist_state(), "burial untrue")["auto"] is False


def test_auto_enables_and_reflects(host):
    state = host._cmd_wishlist_auto({"query": "burial untrue", "auto": True})
    assert _item(state, "burial untrue")["auto"] is True
    # Broadcast so other views update, like every other wishlist mutation.
    assert host.bridge.events[-1][0] == "wishlist.state"


def test_auto_off_removes_the_key_not_stores_false(host):
    host._cmd_wishlist_auto({"query": "burial untrue", "auto": True})
    host._cmd_wishlist_auto({"query": "burial untrue", "auto": False})
    # Off is absence — nothing lingers in the state file (mirrors filters).
    assert host._load_state().get("wish_auto") in (None, [])
    assert _item(host._wishlist_state(), "burial untrue")["auto"] is False


def test_auto_on_unknown_wish_is_rejected(host):
    with pytest.raises(CommandError):
        host._cmd_wishlist_auto({"query": "not a wish", "auto": True})


def test_auto_survives_a_restart(host, tmp_path):
    host._cmd_wishlist_auto({"query": "burial untrue", "auto": True})
    fresh = Host(tmp_path)
    fresh.core.search.add_wish("burial untrue")   # upstream re-registers the wish
    assert _item(fresh._wishlist_state(), "burial untrue")["auto"] is True


# -- the claim ledger -----------------------------------------------------

def _claim(status="downloading"):
    return {"query": "burial untrue", "user": "aphex", "transferId": "t1",
            "path": "@user\\music\\01.flac", "status": status}


def test_claims_round_trip(host):
    host._cmd_wishlist_claims({"items": [_claim()]})
    assert host._cmd_wishlist_claimsList({})["items"] == [_claim()]


def test_claims_stored_verbatim_but_trimmed_to_known_fields(host):
    dirty = {**_claim(), "evil": "x" * 10_000, "size": 999}
    stored = host._cmd_wishlist_claims({"items": [dirty]})["items"]
    assert stored == [_claim()]           # extra fields dropped
    assert "evil" not in stored[0]


def test_claims_replace_wholesale(host):
    host._cmd_wishlist_claims({"items": [_claim()]})
    host._cmd_wishlist_claims({"items": []})
    assert host._cmd_wishlist_claimsList({})["items"] == []


def test_claims_survive_a_restart(host, tmp_path):
    host._cmd_wishlist_claims({"items": [_claim("awaiting-review")]})
    fresh = Host(tmp_path)
    assert fresh._cmd_wishlist_claimsList({})["items"] == [_claim("awaiting-review")]


# -- removing a wish takes its auto flag and claim with it ----------------

def test_remove_cleans_up_auto_and_claim(host):
    host._cmd_wishlist_auto({"query": "burial untrue", "auto": True})
    host._cmd_wishlist_claims({"items": [_claim()]})
    host._cmd_wishlist_remove({"query": "burial untrue"})
    assert host._load_state().get("wish_auto") in (None, [])
    assert host._cmd_wishlist_claimsList({})["items"] == []


def test_remove_leaves_other_wishes_claims(host):
    host.core.search.add_wish("other")
    host._cmd_wishlist_claims({"items": [
        _claim(), {"query": "other", "transferId": "t2", "path": "p", "status": "downloading"},
    ]})
    host._cmd_wishlist_remove({"query": "burial untrue"})
    remaining = host._cmd_wishlist_claimsList({})["items"]
    assert [c["query"] for c in remaining] == ["other"]
