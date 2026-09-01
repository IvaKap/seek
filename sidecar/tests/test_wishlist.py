"""
Seek — wishlist searches have to be adopted, or their results are thrown away.

THE BUG THIS PINS. `SearchRegistry.accept()` drops any token it does not know,
and `searches.add()` was called from exactly one place: `search.start`, a search
the user ran by hand. Upstream mints its own token for a wish and emits NO event
when the timer fires it — `add-search` comes from `do_search`, the manual path,
only. So every automatic wishlist result was discarded at the door. You could
add a wish, upstream would re-run it forever, and Seek would never show one hit.

Adoption happens on the first RESULT rather than at add time, because a wish
keeps one token across every re-run and there is no start to hook.

These drive `_adopt_wishlist_search` directly. CoreHost.__init__ boots
pynicotine's core, which cannot run twice in a process — test_integration.py
owns the one instance a run is allowed — so the registry here is the real one
and only `core.search` and the bridge are stubbed.
"""

import pytest

from seek_sidecar.core_host import CoreHost
from seek_sidecar.registries import SearchRegistry


class _Upstream:
    """The shape pynicotine files under `core.search.searches[token]`."""

    def __init__(self, token, term, mode):
        self.token = token
        self.term = term
        self.term_transmitted = term
        self.mode = mode


class _Search:
    def __init__(self):
        self.searches = {}


class _Core:
    def __init__(self):
        self.search = _Search()


class _Host:
    def __init__(self):
        self.core = _Core()
        self.searches = SearchRegistry()
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    _adopt_wishlist_search = CoreHost._adopt_wishlist_search


def _peer(name="a-peer"):
    return {"username": name, "freeSlots": True, "advertisedSpeed": 1, "queueLength": 0}


def _files(n=1):
    return [{"path": f"x\\{i}.flac", "size": 1, "bitrate": None,
             "duration": None, "sampleRate": None, "bitDepth": None,
             "isVbr": None} for i in range(n)]


def test_a_wishlist_token_is_adopted_on_its_first_result():
    h = _Host()
    h.core.search.searches[77] = _Upstream(77, "drexciya", "wishlist")

    assert h.searches.get(77) is None, "precondition: unknown to the registry"
    h._adopt_wishlist_search(77)

    search = h.searches.get(77)
    assert search is not None
    assert search.query == "drexciya"
    assert search.mode == "wishlist"


def test_adoption_announces_the_search_so_the_app_can_see_it():
    h = _Host()
    h.core.search.searches[77] = _Upstream(77, "drexciya", "wishlist")
    h._adopt_wishlist_search(77)

    assert [n for n, _ in h.broadcasts] == ["search.started"]
    payload = h.broadcasts[0][1]
    assert payload["searchId"] == 77
    assert payload["query"] == "drexciya"
    # The mode is the only thing telling the app this was not something the
    # user just typed, which is what stops it hijacking the open tab.
    assert payload["mode"] == "wishlist"


def test_results_are_kept_once_adopted():
    h = _Host()
    h.core.search.searches[77] = _Upstream(77, "drexciya", "wishlist")

    # Before: the door is shut and the batch is silently discarded.
    assert h.searches.accept(77, _peer(), _files(3)) is None
    assert h.searches.get(77) is None

    h._adopt_wishlist_search(77)
    h.searches.accept(77, _peer(), _files(3))
    assert h.searches.get(77).result_count == 3


def test_a_search_the_user_ran_is_never_touched():
    h = _Host()
    # Same token, but upstream says it is an ordinary search.
    h.core.search.searches[5] = _Upstream(5, "burial", "global")
    h._adopt_wishlist_search(5)
    assert h.searches.get(5) is None
    assert h.broadcasts == []


def test_an_open_search_is_left_exactly_as_it_was():
    h = _Host()
    h.core.search.searches[9] = _Upstream(9, "shackleton", "wishlist")
    h._adopt_wishlist_search(9)
    h.searches.accept(9, _peer(), _files(2))

    # A second response for a live search must not restart it — that would
    # throw away everything already collected in this run.
    h._adopt_wishlist_search(9)
    assert h.searches.get(9).result_count == 2
    assert len(h.broadcasts) == 1


def test_a_re_run_starts_a_fresh_search_rather_than_growing_the_old_one():
    h = _Host()
    h.core.search.searches[9] = _Upstream(9, "shackleton", "wishlist")
    h._adopt_wishlist_search(9)
    h.searches.accept(9, _peer(), _files(4))
    h.searches.close(9, "timeout")

    # The timer fires again on the SAME token. Carrying the old results
    # forward would walk the result cap up until the search closed itself and
    # started dropping again — which is the original bug wearing a hat.
    h._adopt_wishlist_search(9)
    assert h.searches.get(9).closed is None
    assert h.searches.get(9).result_count == 0
    assert len(h.broadcasts) == 2


def test_a_token_upstream_has_never_heard_of_is_ignored():
    h = _Host()
    h._adopt_wishlist_search(1234)
    assert h.searches.get(1234) is None
    assert h.broadcasts == []


@pytest.mark.parametrize("mode", ["global", "rooms", "buddies", "user", None])
def test_only_the_wishlist_mode_is_adopted(mode):
    h = _Host()
    up = _Upstream(3, "x", mode)
    if mode is None:
        del up.mode
    h.core.search.searches[3] = up
    h._adopt_wishlist_search(3)
    assert h.searches.get(3) is None


# --- per-wish filters -------------------------------------------------------
#
# Stored in seek-state.json, keyed by the wish text. Upstream has its own filter
# slots and they are deliberately unused — the reasoning is on `WishFilters` in
# shared/schema.py, and the short version is that only its GTK client ever reads
# them back, and they have no room for the two filters most worth carrying on an
# unattended run: the transcode check and buddy-only results.

from seek_sidecar.core_host import CommandError


class _WishHost:
    """CoreHost's wishlist handlers over an in-memory state dict."""

    def __init__(self, wishes=()):
        self.state = {}
        self.broadcasts = []
        self.bridge = self
        self.core = _Core()
        self.core.search.wishlist = {w: _Upstream(i, w, "wishlist")
                                     for i, w in enumerate(wishes)}
        self.core.search.wishlist_interval = 720
        self.core.search.remove_wish = self.core.search.wishlist.pop

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    def _load_state(self):
        return dict(self.state)

    def _save_state(self, **updates):
        self.state.update(updates)
        return dict(self.state)

    _wish_filters = CoreHost._wish_filters
    # Bound here rather than on _SeenHost: `wishlist.remove` drops a wish's
    # seen-set too, so every host that can remove one needs it.
    _wish_seen = CoreHost._wish_seen
    _wishlist_state = CoreHost._wishlist_state
    _cmd_wishlist_list = CoreHost._cmd_wishlist_list
    _cmd_wishlist_filters = CoreHost._cmd_wishlist_filters
    _cmd_wishlist_remove = CoreHost._cmd_wishlist_remove


FILTERS = {
    "formats": ["FLAC"], "losslessOnly": True, "minBitrate": None,
    "durationMin": None, "durationMax": None, "sizeMin": None, "sizeMax": None,
    "excludeTranscodes": True, "freeSlotsOnly": False, "minSpeed": None,
    "maxQueue": None, "include": "", "exclude": "", "hidePrivate": True,
}


def test_a_wish_carries_no_filters_until_it_is_given_some():
    h = _WishHost(["drexciya"])
    state = h._cmd_wishlist_list(None)
    assert state["items"] == [{"query": "drexciya", "filters": None}]


def test_filters_are_stored_against_the_wish():
    h = _WishHost(["drexciya"])
    state = h._cmd_wishlist_filters({"query": "drexciya", "filters": FILTERS})
    assert state["items"][0]["filters"]["formats"] == ["FLAC"]
    assert state["items"][0]["filters"]["excludeTranscodes"] is True
    # Seek's own state file, never pynicotine's config.
    assert h.state["wish_filters"]["drexciya"]["losslessOnly"] is True


def test_setting_filters_announces_the_new_state():
    h = _WishHost(["drexciya"])
    h._cmd_wishlist_filters({"query": "drexciya", "filters": FILTERS})
    assert [n for n, _ in h.broadcasts] == ["wishlist.state"]


def test_clearing_removes_the_entry_rather_than_storing_an_empty_one():
    h = _WishHost(["drexciya"])
    h._cmd_wishlist_filters({"query": "drexciya", "filters": FILTERS})
    h._cmd_wishlist_filters({"query": "drexciya", "filters": None})
    # "No filters" and "an all-defaults filter set" render and behave the same,
    # so keeping both would invite code that has to ask which it is looking at.
    assert h.state["wish_filters"] == {}
    assert h._cmd_wishlist_list(None)["items"][0]["filters"] is None


def test_filters_only_attach_to_a_wish_that_exists():
    h = _WishHost(["drexciya"])
    with pytest.raises(CommandError):
        h._cmd_wishlist_filters({"query": "never wished for", "filters": FILTERS})


def test_an_empty_query_is_refused():
    h = _WishHost(["drexciya"])
    with pytest.raises(CommandError):
        h._cmd_wishlist_filters({"query": "   ", "filters": FILTERS})


def test_each_wish_keeps_its_own_filters():
    h = _WishHost(["drexciya", "shackleton"])
    h._cmd_wishlist_filters({"query": "drexciya", "filters": FILTERS})
    items = {i["query"]: i["filters"] for i in h._cmd_wishlist_list(None)["items"]}
    assert items["drexciya"] is not None
    assert items["shackleton"] is None


def test_removing_a_wish_takes_its_filters_with_it():
    h = _WishHost(["drexciya"])
    h._cmd_wishlist_filters({"query": "drexciya", "filters": FILTERS})
    assert h.state["wish_filters"]

    h._cmd_wishlist_remove({"query": "drexciya"})

    # Left behind, re-adding the same text months later would silently inherit
    # filters the user last saw on a different wish for a different reason.
    assert h.state["wish_filters"] == {}


def test_removing_a_wish_that_had_no_filters_is_harmless():
    h = _WishHost(["drexciya", "shackleton"])
    h._cmd_wishlist_filters({"query": "drexciya", "filters": FILTERS})
    h._cmd_wishlist_remove({"query": "shackleton"})
    # The one that DID have filters must be untouched.
    assert h.state["wish_filters"]["drexciya"]["losslessOnly"] is True


# -- what a wish has already shown you ---------------------------------------
#
# Upstream keeps ONE token per wish and re-runs it forever, so the same peers
# holding the same files come back every run. Without this record a wish
# announces the same news for weeks and its badge stops meaning anything.

from seek_sidecar.core_host import WISH_SEEN_CAP


class _SeenHost(_WishHost):
    _cmd_wishlist_seen = CoreHost._cmd_wishlist_seen
    _cmd_wishlist_seenList = CoreHost._cmd_wishlist_seenList


def test_a_wish_has_seen_nothing_to_begin_with():
    h = _SeenHost(["drexciya"])
    assert h._cmd_wishlist_seenList(None) == {"items": []}


def test_marking_results_seen_remembers_them():
    h = _SeenHost(["drexciya"])
    assert h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1", "b2"]}) == {"count": 2}
    assert h._cmd_wishlist_seenList(None) == {
        "items": [{"query": "drexciya", "ids": ["a1", "b2"]}]
    }
    # Seek's own state file, never pynicotine's config.
    assert h.state["wish_seen"]["drexciya"] == ["a1", "b2"]


def test_marking_is_additive_across_runs():
    h = _SeenHost(["drexciya"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1"]})
    result = h._cmd_wishlist_seen({"query": "drexciya", "ids": ["b2", "c3"]})
    assert result == {"count": 3}
    assert h.state["wish_seen"]["drexciya"] == ["a1", "b2", "c3"]


def test_the_same_result_twice_is_remembered_once():
    # The ordinary case: a peer still offering the same file next run.
    h = _SeenHost(["drexciya"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1", "b2"]})
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1", "b2", "c3"]})
    assert h.state["wish_seen"]["drexciya"] == ["a1", "b2", "c3"]


def test_a_repeat_inside_one_call_is_also_collapsed():
    h = _SeenHost(["drexciya"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1", "a1", "a1"]})
    assert h.state["wish_seen"]["drexciya"] == ["a1"]


def test_the_set_is_capped_and_drops_the_oldest():
    h = _SeenHost(["drexciya"])
    h._cmd_wishlist_seen({"query": "drexciya",
                          "ids": [f"id{i}" for i in range(WISH_SEEN_CAP + 20)]})
    kept = h.state["wish_seen"]["drexciya"]
    assert len(kept) == WISH_SEEN_CAP
    # The NEWEST survive: what falls out is what stopped appearing.
    assert kept[-1] == f"id{WISH_SEEN_CAP + 19}"
    assert "id0" not in kept


def test_re_marking_keeps_a_still_offered_result_inside_the_window():
    # A file a peer still has is re-marked every time you look, so the window
    # holds what is current rather than what happened to arrive first.
    h = _SeenHost(["drexciya"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["keeper"]})
    h._cmd_wishlist_seen({"query": "drexciya",
                          "ids": [f"filler{i}" for i in range(WISH_SEEN_CAP - 1)]})
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["keeper", "newcomer"]})
    kept = h.state["wish_seen"]["drexciya"]
    assert len(kept) == WISH_SEEN_CAP
    assert "keeper" in kept


def test_each_wish_keeps_its_own_seen_set():
    h = _SeenHost(["drexciya", "shackleton"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1"]})
    items = {i["query"]: i["ids"] for i in h._cmd_wishlist_seenList(None)["items"]}
    assert items == {"drexciya": ["a1"]}


def test_seen_only_attaches_to_a_wish_that_exists():
    h = _SeenHost(["drexciya"])
    with pytest.raises(CommandError):
        h._cmd_wishlist_seen({"query": "never wished for", "ids": ["a1"]})


def test_an_empty_query_is_refused_for_seen():
    h = _SeenHost(["drexciya"])
    with pytest.raises(CommandError):
        h._cmd_wishlist_seen({"query": "  ", "ids": ["a1"]})


def test_marking_nothing_is_harmless():
    h = _SeenHost(["drexciya"])
    assert h._cmd_wishlist_seen({"query": "drexciya", "ids": []}) == {"count": 0}
    # And leaves nothing behind for the frontend to skip over: a wish with an
    # empty set has nothing to say, so it is not in the list at all.
    assert h._cmd_wishlist_seenList(None) == {"items": []}


def test_removing_a_wish_forgets_what_it_had_shown_you():
    # Left behind, re-adding the same text later would start life believing it
    # had already shown you results you have never seen — the badge would then
    # stay silent on the first run, which is the exact opposite of the point.
    h = _SeenHost(["drexciya"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1", "b2"]})
    h._cmd_wishlist_remove({"query": "drexciya"})
    assert h.state["wish_seen"] == {}


def test_removing_one_wish_leaves_the_others_alone():
    h = _SeenHost(["drexciya", "shackleton"])
    h._cmd_wishlist_seen({"query": "drexciya", "ids": ["a1"]})
    h._cmd_wishlist_seen({"query": "shackleton", "ids": ["b2"]})
    h._cmd_wishlist_remove({"query": "shackleton"})
    assert h.state["wish_seen"] == {"drexciya": ["a1"]}


def test_a_corrupt_state_file_does_not_take_the_wishlist_down():
    # seek-state.json is on disk and editable; a wrong shape must degrade to
    # "nothing seen yet" rather than raising inside a command handler.
    h = _SeenHost(["drexciya"])
    h.state["wish_seen"] = "not a dict"
    assert h._wish_seen() == {}
    h.state["wish_seen"] = {"drexciya": "not a list"}
    assert h._wish_seen() == {}
