"""
Seek — the label watchlist.
SPDX-License-Identifier: GPL-3.0-or-later

A bookmark with progress on it, and since 0.2.7 a new-release notifier too —
the reasoning, including the one objection that was accepted rather than
answered, is on `WatchedLabel` in shared/schema.py.

The two behaviours worth pinning here are both about not losing things:

  - watching the same catalogue twice must not create a second row, and must
    not reset the progress on the first
  - unwatching must not touch anything SAVED from the catalogue

These drive CoreHost's label handlers directly rather than over the socket.
The socket path is exercised in test_integration.py; what deserves many cases
here is the identity rule, which is the part that can silently duplicate.
"""

import pytest

from seek_sidecar.core_host import CoreHost, CommandError


class _Host:
    """CoreHost's label handlers over a state dict in memory.

    CoreHost.__init__ boots pynicotine's core, which mutates process-global
    singletons and cannot run twice in one process — test_integration.py owns
    the one instance a run is allowed. Only `_load_state`/`_save_state` and the
    broadcast are replaced; every handler under test is the real one.
    """

    def __init__(self):
        self.state = {}
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    def _discogs_token(self):
        return ''

    def _load_state(self):
        return dict(self.state)

    def _save_state(self, **updates):
        self.state.update(updates)
        return dict(self.state)

    LABEL_CAP = CoreHost.LABEL_CAP
    _labels = CoreHost._labels
    _labels_state = CoreHost._labels_state
    _labels_publish = CoreHost._labels_publish
    _find_label = CoreHost._find_label
    _label_identity = staticmethod(CoreHost._label_identity)
    _cmd_labels_list = CoreHost._cmd_labels_list
    _cmd_labels_watch = CoreHost._cmd_labels_watch
    _cmd_labels_unwatch = CoreHost._cmd_labels_unwatch
    _cmd_labels_note = CoreHost._cmd_labels_note
    _cmd_labels_seen = CoreHost._cmd_labels_seen
    NEW_RELEASE_YEARS = CoreHost.NEW_RELEASE_YEARS
    _release_key = staticmethod(CoreHost._release_key)
    _check_one_label = CoreHost._check_one_label


@pytest.fixture
def host():
    return _Host()


def watch(host, **over):
    params = {
        "sourceKind": "discogs", "kind": "label", "name": "Hyperdub",
        "url": "https://www.discogs.com/label/1119", "entityId": 1119,
    }
    params.update(over)
    return host._cmd_labels_watch(params)


# ---------------------------------------------------------------- the basics


def test_nothing_is_watched_to_begin_with(host):
    assert host._cmd_labels_list({}) == {"labels": []}


def test_watching_persists_and_is_queryable(host):
    watch(host)
    labels = host._cmd_labels_list({})["labels"]
    assert len(labels) == 1
    assert labels[0]["name"] == "Hyperdub"
    assert labels[0]["entityId"] == 1119
    assert host.state["watched_labels"][0]["name"] == "Hyperdub"


def test_watching_announces_the_change(host):
    watch(host)
    assert [name for name, _ in host.broadcasts] == ["labels.changed"]


def test_newest_first(host):
    watch(host, name="Hyperdub", entityId=1119)
    watch(host, name="Livity Sound", entityId=52340)
    assert [l["name"] for l in host._cmd_labels_list({})["labels"]] == [
        "Livity Sound", "Hyperdub",
    ]


def test_a_fresh_watch_has_never_been_read(host):
    """Null, not zero. "Never read" and "read and found nothing" are different
    things and the UI words them differently."""
    label = watch(host)["labels"][0]
    assert label["lastSeenAt"] is None
    assert label["releaseCount"] is None
    assert label["ownedCount"] is None
    assert label["wantedCount"] is None


# --------------------------------------------------------------- what to watch


def test_only_a_label_or_an_artist_can_be_watched(host):
    for kind in ("track", "release", "", "playlist"):
        with pytest.raises(CommandError) as error:
            watch(host, kind=kind)
        assert error.value.code == "bad_request"


def test_a_catalogue_with_no_name_is_refused(host):
    for name in ("", "   "):
        with pytest.raises(CommandError):
            watch(host, name=name)


def test_an_artist_can_be_watched_too(host):
    label = watch(host, kind="artist", name="Burial", entityId=1)["labels"][0]
    assert label["kind"] == "artist"


def test_only_providers_with_a_catalogue_can_be_watched(host):
    """The single promise this list makes is that a row can be RE-OPENED.
    `discover.browse` serves discogs and bandcamp and refuses everything else,
    so a youtube or manual row would be a bookmark that permanently fails."""
    for source in ("youtube", "manual", "fingerprint", ""):
        with pytest.raises(CommandError) as error:
            watch(host, sourceKind=source)
        assert error.value.code == "bad_request"


def test_a_bandcamp_catalogue_needs_its_url(host):
    """Bandcamp has no ids — `browse` raises "Bandcamp has no ids; a page URL
    is required" — so a Bandcamp row without one could never be read again."""
    with pytest.raises(CommandError) as error:
        watch(host, sourceKind="bandcamp", url="", entityId=None)
    assert "URL" in str(error.value)

    ok = watch(host, sourceKind="bandcamp",
               url="https://hyperdub.bandcamp.com/music", entityId=None)
    assert len(ok["labels"]) == 1


# ------------------------------------------------------------------ identity


def test_watching_the_same_label_twice_does_not_duplicate_it(host):
    watch(host)
    out = watch(host)
    assert len(out["labels"]) == 1


def test_the_id_identifies_a_catalogue_across_a_rename(host):
    """A label can be renamed on Discogs, and a URL can be written several
    ways. The numeric id survives both."""
    watch(host, name="Hyperdub", url="https://www.discogs.com/label/1119")
    out = watch(host, name="Hyperdub Records", url="https://discogs.com/label/1119/")
    assert len(out["labels"]) == 1
    assert out["labels"][0]["name"] == "Hyperdub Records", "the newer name should win"


def test_a_trailing_slash_or_case_does_not_make_a_second_entry(host):
    watch(host, entityId=None, url="https://bandcamp.example/music")
    out = watch(host, entityId=None, url="https://BandCamp.example/music/")
    assert len(out["labels"]) == 1


def test_without_an_id_or_url_the_name_identifies_it(host):
    watch(host, entityId=None, url="")
    out = watch(host, entityId=None, url="", name="  hyperdub  ")
    assert len(out["labels"]) == 1


def test_two_different_labels_stay_two(host):
    watch(host, name="Hyperdub", entityId=1119)
    out = watch(host, name="Livity Sound", entityId=52340)
    assert len(out["labels"]) == 2


def test_a_label_and_an_artist_of_the_same_name_are_different_catalogues(host):
    """Plenty of one-artist labels share their founder's name, and the two
    catalogues are genuinely different lists."""
    watch(host, kind="label", name="Aphex Twin", entityId=None, url="")
    out = watch(host, kind="artist", name="Aphex Twin", entityId=None, url="")
    assert len(out["labels"]) == 2


def test_the_same_name_on_two_providers_stays_two(host):
    """Hyperdub on Discogs and Hyperdub on Bandcamp are genuinely different
    lists — the Bandcamp one is what the label chose to put up."""
    watch(host, sourceKind="discogs", entityId=None, url="")
    out = watch(host, sourceKind="bandcamp", entityId=None,
                url="https://hyperdub.bandcamp.com/music")
    assert len(out["labels"]) == 2


def test_re_watching_refreshes_the_url_without_losing_progress(host):
    """Watching again is the user re-affirming a choice; it says nothing about
    the catalogue's contents, so it must not discard a reading."""
    first = watch(host, url="")["labels"][0]
    host._cmd_labels_seen({
        "id": first["id"], "releaseCount": 312, "ownedCount": 47, "wantedCount": 9,
    })

    out = watch(host, url="https://www.discogs.com/label/1119")
    label = out["labels"][0]
    assert len(out["labels"]) == 1
    assert label["url"] == "https://www.discogs.com/label/1119"
    assert label["releaseCount"] == 312, "progress was reset by a re-watch"
    assert label["ownedCount"] == 47
    assert label["lastSeenAt"] is not None


def test_re_watching_never_blanks_a_url_it_already_had(host):
    watch(host, url="https://www.discogs.com/label/1119")
    out = watch(host, url="")
    assert out["labels"][0]["url"] == "https://www.discogs.com/label/1119"


# ------------------------------------------------------------------ progress


def test_a_reading_is_recorded_with_its_time(host):
    label = watch(host)["labels"][0]
    out = host._cmd_labels_seen({
        "id": label["id"], "releaseCount": 312, "ownedCount": 47, "wantedCount": 9,
    })
    seen = out["labels"][0]
    assert seen["releaseCount"] == 312
    assert seen["ownedCount"] == 47
    assert seen["wantedCount"] == 9
    assert seen["lastSeenAt"] > 0


def test_a_reading_that_found_nothing_is_zero_not_null(host):
    """Distinguishable from never-read, which is what the UI needs to say
    "you have not opened this yet" rather than "it is empty"."""
    label = watch(host)["labels"][0]
    out = host._cmd_labels_seen({
        "id": label["id"], "releaseCount": 0, "ownedCount": 0, "wantedCount": 0,
    })
    assert out["labels"][0]["releaseCount"] == 0
    assert out["labels"][0]["lastSeenAt"] is not None


def test_negative_counts_are_refused_into_zero(host):
    label = watch(host)["labels"][0]
    out = host._cmd_labels_seen({
        "id": label["id"], "releaseCount": -5, "ownedCount": -1, "wantedCount": -2,
    })
    assert out["labels"][0]["releaseCount"] == 0
    assert out["labels"][0]["ownedCount"] == 0


def test_recording_against_an_unknown_label_is_an_error(host):
    with pytest.raises(CommandError) as error:
        host._cmd_labels_seen({
            "id": "nope", "releaseCount": 1, "ownedCount": 0, "wantedCount": 0,
        })
    assert error.value.code == "not_found"


# ---------------------------------------------------------------------- notes


def test_a_note_is_stored_and_survives(host):
    label = watch(host)["labels"][0]
    note = 'start with the 12" singles'
    out = host._cmd_labels_note({"id": label["id"], "note": note})
    assert out["labels"][0]["note"] == note
    assert host.state["watched_labels"][0]["note"] == note


def test_a_note_can_be_cleared(host):
    label = watch(host)["labels"][0]
    host._cmd_labels_note({"id": label["id"], "note": "something"})
    out = host._cmd_labels_note({"id": label["id"], "note": ""})
    assert out["labels"][0]["note"] == ""


# ------------------------------------------------------------------ unwatch


def test_unwatching_removes_only_that_label(host):
    watch(host, name="Hyperdub", entityId=1119)
    second = watch(host, name="Livity Sound", entityId=52340)["labels"][0]
    out = host._cmd_labels_unwatch({"id": second["id"]})
    assert [l["name"] for l in out["labels"]] == ["Hyperdub"]


def test_unwatching_touches_nothing_saved_from_the_catalogue(host):
    """The want list and the library are not a function of the watchlist.
    Unwatching Hyperdub must not un-want the Hyperdub records you saved."""
    host.state["want_list"] = [{"id": "w1", "artist": "Burial", "title": "Untrue"}]
    label = watch(host)["labels"][0]
    host._cmd_labels_unwatch({"id": label["id"]})
    assert host.state["want_list"] == [{"id": "w1", "artist": "Burial", "title": "Untrue"}]


def test_unwatching_something_unknown_is_an_error(host):
    with pytest.raises(CommandError) as error:
        host._cmd_labels_unwatch({"id": "nope"})
    assert error.value.code == "not_found"


# ---------------------------------------------------------------------- cap


def test_the_list_is_capped(host):
    for n in range(CoreHost.LABEL_CAP + 10):
        watch(host, name=f"Label {n}", entityId=n + 1)
    assert len(host._cmd_labels_list({})["labels"]) == CoreHost.LABEL_CAP
    # Newest kept, oldest dropped.
    assert host._cmd_labels_list({})["labels"][0]["name"] == \
        f"Label {CoreHost.LABEL_CAP + 9}"


# ------------------------------------------------- checking for new releases
#
# The two rules that had to be argued for before this feature could exist at
# all. Both are about what "new" MEANS, and getting either wrong turns the
# badge into noise — which is precisely why the codebase had refused to build
# this until now.


def _stub_browse(monkeypatch, releases, image=None):
    """Stand in for the provider, so no test here touches the network."""
    from seek_sidecar import core_host as module

    def fake_browse(*_args, **_kwargs):
        return {"releases": releases, "imageUri": image}

    monkeypatch.setattr(module.discover_mod, "browse", fake_browse)


def _release(key, year):
    return {"discogsId": key, "url": f"https://x/{key}", "title": "t",
            "artist": "a", "year": year, "format": "", "catno": "", "role": ""}


def test_the_first_check_announces_nothing(host, monkeypatch):
    """It learns the baseline instead.

    Reporting three hundred 'new' releases the first time the button is pressed
    would be perfectly true and completely useless.
    """
    import time
    watch(host)
    label_id = host._labels()[0]["id"]
    _stub_browse(monkeypatch, [_release(1, time.gmtime().tm_year)])

    host._check_one_label(label_id)
    row = host._labels()[0]
    assert row["newCount"] == 0
    assert row["knownIds"] == ["d1"]
    assert row["lastCheckedAt"] is not None


def test_a_release_added_since_the_last_check_counts(host, monkeypatch):
    import time
    year = time.gmtime().tm_year
    watch(host)
    label_id = host._labels()[0]["id"]

    _stub_browse(monkeypatch, [_release(1, year)])
    host._check_one_label(label_id)                  # baseline

    _stub_browse(monkeypatch, [_release(1, year), _release(2, year)])
    host._check_one_label(label_id)
    assert host._labels()[0]["newCount"] == 1


def test_a_record_catalogued_late_is_not_a_new_release(host, monkeypatch):
    """The objection this feature had to answer.

    Discogs is a database, not a release feed. A 1994 record catalogued last
    week is genuinely absent from the previous check and is genuinely not news,
    so being unseen is necessary but not sufficient.
    """
    import time
    year = time.gmtime().tm_year
    watch(host)
    label_id = host._labels()[0]["id"]

    _stub_browse(monkeypatch, [_release(1, year)])
    host._check_one_label(label_id)

    _stub_browse(monkeypatch, [_release(1, year), _release(2, 1994)])
    host._check_one_label(label_id)
    row = host._labels()[0]
    assert row["newCount"] == 0
    # Still remembered, so it never reports as new later either.
    assert "d2" in row["knownIds"]


def test_bandcamp_is_not_judged_on_year(host, monkeypatch):
    """It has none. `browse_bandcamp` sends year=None because Bandcamp does not
    publish one on the catalogue page, so filtering on it there would reject
    every release forever."""
    watch(host, sourceKind="bandcamp", url="https://x.bandcamp.com", entityId=None)
    label_id = host._labels()[0]["id"]

    _stub_browse(monkeypatch, [{"discogsId": 0, "url": "https://x/1", "year": None}])
    host._check_one_label(label_id)

    _stub_browse(monkeypatch, [
        {"discogsId": 0, "url": "https://x/1", "year": None},
        {"discogsId": 0, "url": "https://x/2", "year": None},
    ])
    host._check_one_label(label_id)
    assert host._labels()[0]["newCount"] == 1


def test_opening_the_catalogue_clears_the_badge(host, monkeypatch):
    import time
    year = time.gmtime().tm_year
    watch(host)
    label_id = host._labels()[0]["id"]
    _stub_browse(monkeypatch, [_release(1, year)])
    host._check_one_label(label_id)
    _stub_browse(monkeypatch, [_release(1, year), _release(2, year)])
    host._check_one_label(label_id)
    assert host._labels()[0]["newCount"] == 1

    host._cmd_labels_seen({"id": label_id, "releaseCount": 2,
                           "ownedCount": 0, "wantedCount": 0})
    assert host._labels()[0]["newCount"] == 0


def test_the_logo_is_captured_once(host, monkeypatch):
    """Fetched on the first check and then left alone — a logo does not change,
    and every fetch is a rate-limited request."""
    import time
    watch(host)
    label_id = host._labels()[0]["id"]
    _stub_browse(monkeypatch, [_release(1, time.gmtime().tm_year)], image="data:image/png;base64,AAA")
    host._check_one_label(label_id)
    assert host._labels()[0]["imageUri"] == "data:image/png;base64,AAA"

    # A later check that returns none must not blank it.
    _stub_browse(monkeypatch, [_release(1, time.gmtime().tm_year)], image=None)
    host._check_one_label(label_id)
    assert host._labels()[0]["imageUri"] == "data:image/png;base64,AAA"
