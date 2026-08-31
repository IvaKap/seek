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
