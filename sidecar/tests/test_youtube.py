"""
Seek — the YouTube→Discogs sheets.

Two layers are pinned here. The `discover` primitives (`youtube_video_details`,
`discogs_search_release`, `discogs_release_by_url`, `_iso8601_seconds`) run
against a stub `fetch_json`, so no network is touched and the exact request/
response contract is fixed. The `CoreHost` handlers run against an in-memory
state dict — `CoreHost.__init__` boots pynicotine's core, which cannot run twice
in a process (test_integration.py owns the one instance), so the handlers are
bound to a stub host, exactly as test_wishlist.py does.

The load-bearing behaviours: a match ALWAYS surfaces something Discogs has but
says how far to trust it; the artist/title a row is searched by comes from the
frontend, never re-derived here; refresh appends by videoId without disturbing
existing rows or their ticks; enrichment that finds its sheet deleted stops
rather than burning rate-gated requests; and deleting a sheet takes its rows and
ticks with it.
"""

import pytest

from seek_sidecar import discover
from seek_sidecar.core_host import CoreHost, CommandError, _YT_PENDING


# --------------------------------------------------------------- primitives

def test_iso8601_seconds():
    assert discover._iso8601_seconds("PT8M34S") == 514
    assert discover._iso8601_seconds("PT1H2M3S") == 3723
    assert discover._iso8601_seconds("PT45S") == 45
    assert discover._iso8601_seconds("PT2H") == 7200


@pytest.mark.parametrize("bad", ["", None, "P0D", "8:34", "PT", "garbage"])
def test_iso8601_seconds_unparseable_is_none(bad):
    # A live stream reports P0D; anything we cannot read must be null, not 0,
    # so the UI shows nothing rather than "0 sec".
    assert discover._iso8601_seconds(bad) is None


def test_video_details_batches_and_maps():
    seen = []

    def fetch(url):
        seen.append(url)
        return {"items": [{
            "id": "abc",
            "snippet": {"description": "hi", "publishedAt": "2020-01-02T03:04:05Z"},
            "contentDetails": {"duration": "PT8M34S"},
        }]}

    out = discover.youtube_video_details(["abc"], "KEY", fetch_json=fetch)
    assert out == {"abc": {"description": "hi", "durationSeconds": 514,
                           "publishedAt": "2020-01-02T03:04:05Z"}}
    assert "youtube/v3/videos" in seen[0] and "key=KEY" in seen[0]


def test_video_details_splits_into_pages_of_fifty():
    calls = []

    def fetch(url):
        calls.append(url)
        return {"items": []}

    discover.youtube_video_details([str(i) for i in range(120)], "K", fetch_json=fetch)
    assert len(calls) == 3   # 50 + 50 + 20


def test_video_details_no_ids_makes_no_request():
    def fetch(url):
        raise AssertionError("should not fetch")
    assert discover.youtube_video_details([], "K", fetch_json=fetch) == {}


def test_video_details_needs_a_key():
    with pytest.raises(discover.DiscoverError) as info:
        discover.youtube_video_details(["a"], "", fetch_json=lambda u: {})
    assert info.value.needs == "youtubeApiKey"


def _discogs_stub(search_results, release=None):
    """A fetch_json that answers the search then the release detail."""
    def fetch(url, headers=None, gate=None):
        if "database/search" in url:
            return {"results": search_results}
        if "/releases/" in url:
            return release or {}
        if "/masters/" in url:
            return {"main_release": 999}
        raise AssertionError(url)
    return fetch


RELEASE = {
    "id": 111, "title": "Contented Life / Thought Patterns",
    "artists": [{"name": "Aural Imbalance"}],
    "genres": ["Electronic"], "styles": ["Drum n Bass", "Ambient"],
}


def test_search_confident_match():
    fetch = _discogs_stub(
        [{"id": 111, "title": "Aural Imbalance - Contented Life / Thought Patterns"}],
        RELEASE,
    )
    m = discover.discogs_search_release("Aural Imbalance", "Thought Patterns", "t", fetch_json=fetch)
    assert m["status"] == "matched"
    assert m["discogsId"] == 111
    assert m["artist"] == "Aural Imbalance"
    assert m["album"] == "Contented Life / Thought Patterns"
    assert m["genres"] == ["Electronic"]
    assert m["styles"] == ["Drum n Bass", "Ambient"]
    assert m["releaseUrl"] == "https://www.discogs.com/release/111"


def test_search_takes_the_first_confident_hit_not_merely_the_first():
    # A confidently-wrong first result is the one thing this must not surface as
    # matched: the second result is the real one.
    fetch = _discogs_stub(
        [{"id": 5, "title": "Donald Wilborn - Something Else"},
         {"id": 111, "title": "Aural Imbalance - Thought Patterns"}],
        RELEASE,
    )
    m = discover.discogs_search_release("Aural Imbalance", "Thought Patterns", "t", fetch_json=fetch)
    assert m["status"] == "matched"
    assert m["discogsId"] == 111


def test_search_with_no_confident_hit_is_low_not_matched():
    # Discogs always returns something; a result that does not resemble the
    # query is shown but hedged, never asserted as a match.
    fetch = _discogs_stub([{"id": 5, "title": "Someone Else - Unrelated"}],
                          {"id": 5, "title": "Unrelated", "artists": [{"name": "Someone Else"}]})
    m = discover.discogs_search_release("Aural Imbalance", "Thought Patterns", "t", fetch_json=fetch)
    assert m["status"] == "low"
    assert m["discogsId"] == 5


def test_search_empty_is_none():
    fetch = _discogs_stub([])
    m = discover.discogs_search_release("x", "y", "t", fetch_json=fetch)
    assert m["status"] == "none"
    assert m["discogsId"] is None
    assert m["releaseUrl"] == ""


def test_search_with_no_query_makes_no_request():
    def fetch(url, headers=None, gate=None):
        raise AssertionError("should not fetch")
    m = discover.discogs_search_release("", "", "t", fetch_json=fetch)
    assert m["status"] == "none"


def test_search_needs_a_token():
    with pytest.raises(discover.DiscoverError) as info:
        discover.discogs_search_release("a", "b", "", fetch_json=lambda *a, **k: {})
    assert info.value.needs == "discogsToken"


def test_release_by_url_release():
    fetch = _discogs_stub([], RELEASE)
    m = discover.discogs_release_by_url("https://www.discogs.com/release/111", "t", fetch_json=fetch)
    assert m["status"] == "manual"
    assert m["discogsId"] == 111


def test_release_by_url_follows_a_master_to_its_main_release():
    calls = []

    def fetch(url, headers=None, gate=None):
        calls.append(url)
        if "/masters/222" in url:
            return {"main_release": 999}
        if "/releases/999" in url:
            return {"id": 999, "title": "R", "artists": [{"name": "A"}]}
        raise AssertionError(url)

    m = discover.discogs_release_by_url("https://www.discogs.com/master/222", "t", fetch_json=fetch)
    assert m["discogsId"] == 999
    assert any("/masters/222" in c for c in calls)


def test_release_by_url_refuses_an_artist_url():
    with pytest.raises(discover.DiscoverError):
        discover.discogs_release_by_url("https://www.discogs.com/artist/5", "t",
                                        fetch_json=lambda *a, **k: {})


def test_release_by_url_refuses_a_non_url():
    with pytest.raises(discover.DiscoverError):
        discover.discogs_release_by_url("not a url", "t", fetch_json=lambda *a, **k: {})


# ------------------------------------------------------------- CoreHost sheets

class _Host:
    """CoreHost's YouTube handlers over an in-memory state dict."""

    def __init__(self, lookups=True):
        self.state = {}
        self.broadcasts = []
        self.bridge = self
        self._lookups = lookups
        # Captures what each background worker was asked to do, so a test can
        # run it synchronously and inspect the outcome.
        self.submitted = []

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    def _lookups_allowed(self):
        return self._lookups

    def _load_state(self):
        return dict(self.state)

    def _save_state(self, **updates):
        self.state.update(updates)
        return dict(self.state)

    class _Pool:
        def __init__(self, host):
            self.host = host

        def submit(self, fn, *args):
            self.host.submitted.append((fn, args))

    @property
    def _discover_pool(self):
        return _Host._Pool(self)

    def _youtube_key(self):
        return "KEY"

    def _discogs_token(self):
        return "TOK"

    # The methods under test, bound from the real class.
    _yt_enriching = CoreHost._yt_enriching
    _youtube_sheets = CoreHost._youtube_sheets
    _mutate_youtube = CoreHost._mutate_youtube
    _find_sheet = staticmethod(CoreHost._find_sheet)
    _sheet_view = CoreHost._sheet_view
    _youtube_state = CoreHost._youtube_state
    _youtube_row = CoreHost._youtube_row
    _broadcast_sheet = CoreHost._broadcast_sheet
    _broadcast_youtube_state = CoreHost._broadcast_youtube_state
    _apply_match = CoreHost._apply_match
    _youtube_fetch_failed = CoreHost._youtube_fetch_failed
    _match_one = CoreHost._match_one
    _cmd_youtube_list = CoreHost._cmd_youtube_list
    _cmd_youtube_addSheet = CoreHost._cmd_youtube_addSheet
    _run_add_sheet = CoreHost._run_add_sheet
    _cmd_youtube_refreshSheet = CoreHost._cmd_youtube_refreshSheet
    _run_refresh_sheet = CoreHost._run_refresh_sheet
    _cmd_youtube_removeSheet = CoreHost._cmd_youtube_removeSheet
    _cmd_youtube_setDownloaded = CoreHost._cmd_youtube_setDownloaded
    _cmd_youtube_enrich = CoreHost._cmd_youtube_enrich
    _run_enrich = CoreHost._run_enrich
    _cmd_youtube_rematch = CoreHost._cmd_youtube_rematch
    _run_rematch = CoreHost._run_rematch


def _run_pending(host):
    """Run everything the host handed to the pool, in order.

    `submit` was handed a bound method (`self._run_add_sheet`), so it is called
    with its args alone — the host is already bound in.
    """
    while host.submitted:
        fn, args = host.submitted.pop(0)
        fn(*args)


def _listing(*ids):
    return {
        "playlistId": "PLabc",
        "items": [{"videoId": v, "title": f"Artist {v} - Track {v}",
                   "channel": "Chan", "position": i, "available": True}
                  for i, v in enumerate(ids)],
        "total": len(ids),
        "complete": True,
    }


@pytest.fixture
def patched(monkeypatch):
    """playlist_items / video details / discogs search, all stubbed."""
    monkeypatch.setattr(discover, "playlist_items",
                        lambda pid, key: _listing("a", "b"))
    monkeypatch.setattr(discover, "youtube_video_details",
                        lambda ids, key: {v: {"description": f"d{v}",
                                              "durationSeconds": 100,
                                              "publishedAt": "2020-01-01T00:00:00Z"}
                                          for v in ids})
    monkeypatch.setattr(discover, "discogs_search_release",
                        lambda artist, title, token: {
                            "status": "matched", "discogsId": 1, "artist": artist,
                            "track": title, "album": "Alb", "genres": ["G"],
                            "styles": ["S"], "releaseUrl": "u"})
    return monkeypatch


def test_add_sheet_fetches_and_creates(patched):
    h = _Host()
    reply = h._cmd_youtube_addSheet({"source": "playlist", "sourceId": "PLabc",
                                     "title": "Mine"})
    assert "requestId" in reply
    _run_pending(h)

    state = h._cmd_youtube_list(None)
    assert len(state["sheets"]) == 1
    sheet = state["sheets"][0]
    assert sheet["title"] == "Mine"
    assert sheet["sourceId"] == "PLabc"
    assert [r["video"]["videoId"] for r in sheet["rows"]] == ["a", "b"]
    # Rows start unmatched, and the count of unmatched rows is reported.
    assert all(r["match"]["status"] == "pending" for r in sheet["rows"])
    assert sheet["pending"] == 2
    # Video details were merged in.
    assert sheet["rows"][0]["video"]["durationSeconds"] == 100
    assert sheet["rows"][0]["video"]["url"] == "https://www.youtube.com/watch?v=a"
    assert ("youtube.state", state) != None  # state broadcast happened
    assert any(n == "youtube.state" for n, _ in h.broadcasts)


def test_add_sheet_title_falls_back_to_the_id(patched):
    h = _Host()
    h._cmd_youtube_addSheet({"source": "playlist", "sourceId": "PLabc"})
    _run_pending(h)
    assert h._cmd_youtube_list(None)["sheets"][0]["title"] == "PLabc"


def test_add_sheet_liked_is_refused_without_signin():
    h = _Host()
    with pytest.raises(CommandError) as info:
        h._cmd_youtube_addSheet({"source": "liked", "sourceId": "LL"})
    assert "sign-in" in str(info.value)


def test_add_sheet_needs_an_id():
    h = _Host()
    with pytest.raises(CommandError):
        h._cmd_youtube_addSheet({"source": "playlist", "sourceId": "   "})


def test_add_sheet_refused_when_lookups_off():
    h = _Host(lookups=False)
    with pytest.raises(CommandError):
        h._cmd_youtube_addSheet({"source": "playlist", "sourceId": "PLabc"})


def test_add_sheet_fetch_failure_surfaces_and_adds_nothing(patched, monkeypatch):
    monkeypatch.setattr(discover, "playlist_items",
                        lambda pid, key: (_ for _ in ()).throw(
                            discover.DiscoverError("no key", needs="youtubeApiKey")))
    h = _Host()
    h._cmd_youtube_addSheet({"source": "playlist", "sourceId": "PLabc"})
    _run_pending(h)
    assert h._cmd_youtube_list(None)["sheets"] == []
    fail = [p for n, p in h.broadcasts if n == "discover.parseFailed"]
    assert fail and fail[0]["needs"] == "youtubeApiKey"


def _make_sheet(h, patched):
    h._cmd_youtube_addSheet({"source": "playlist", "sourceId": "PLabc"})
    _run_pending(h)
    return h._cmd_youtube_list(None)["sheets"][0]["id"]


def test_enrich_fills_matches_and_reports_progress(patched):
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_enrich({"sheetId": sid, "queries": [
        {"videoId": "a", "artist": "Artist a", "title": "Track a"},
        {"videoId": "b", "artist": "Artist b", "title": "Track b"},
    ]})
    _run_pending(h)

    rows = h._cmd_youtube_list(None)["sheets"][0]["rows"]
    assert [r["match"]["status"] for r in rows] == ["matched", "matched"]
    assert rows[0]["match"]["artist"] == "Artist a"
    # A youtube.sheet was emitted per match (plus start/finish) for live progress.
    assert sum(1 for n, _ in h.broadcasts if n == "youtube.sheet") >= 2
    assert h._cmd_youtube_list(None)["sheets"][0]["pending"] == 0


def test_enrich_uses_the_frontends_query_not_the_video_title(patched):
    # THE SEAM. The row's title is "Artist a - Track a"; the query the frontend
    # derived is different, and it is that which reaches Discogs.
    captured = []
    patched.setattr(discover, "discogs_search_release",
                    lambda artist, title, token: captured.append((artist, title)) or {
                        "status": "matched", "discogsId": 1, "artist": artist,
                        "track": title, "album": "", "genres": [], "styles": [],
                        "releaseUrl": ""})
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_enrich({"sheetId": sid, "queries": [
        {"videoId": "a", "artist": "Parsed Artist", "title": "Parsed Title"}]})
    _run_pending(h)
    assert captured == [("Parsed Artist", "Parsed Title")]


def test_enrich_stops_if_the_sheet_is_deleted_mid_run(patched):
    # Deleting a sheet mid-enrichment must stop the pass rather than keep
    # spending rate-gated Discogs requests on rows nobody will see.
    calls = []

    def counted(artist, title, token):
        calls.append((artist, title))
        return {"status": "matched", "discogsId": 1, "artist": artist,
                "track": title, "album": "", "genres": [], "styles": [],
                "releaseUrl": ""}
    patched.setattr(discover, "discogs_search_release", counted)

    h = _Host()
    sid = _make_sheet(h, patched)

    # Delete the sheet the moment the first match is applied, so the second row
    # is reached only if the pass ignores the deletion.
    real_apply = h._apply_match

    def apply_then_delete(sheet_id, vid, match):
        ok = real_apply(sheet_id, vid, match)
        h.state["youtube_sheets"] = []   # the sheet vanishes
        return ok
    h._apply_match = apply_then_delete

    h._cmd_youtube_enrich({"sheetId": sid, "queries": [
        {"videoId": "a", "artist": "A", "title": "Ta"},
        {"videoId": "b", "artist": "B", "title": "Tb"}]})
    _run_pending(h)
    # Only the first row was searched; the second was skipped before a request
    # was spent, because the sheet was gone by then.
    assert len(calls) == 1


def test_enrich_records_an_error_when_discogs_fails(patched):
    patched.setattr(discover, "discogs_search_release",
                    lambda a, t, tok: (_ for _ in ()).throw(
                        discover.DiscoverError("no token")))
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_enrich({"sheetId": sid,
                           "queries": [{"videoId": "a", "artist": "A", "title": "T"}]})
    _run_pending(h)
    assert h._cmd_youtube_list(None)["sheets"][0]["rows"][0]["match"]["status"] == "error"


def test_enrich_unknown_sheet_is_refused(patched):
    h = _Host()
    with pytest.raises(CommandError):
        h._cmd_youtube_enrich({"sheetId": "nope", "queries": []})


def test_set_downloaded_persists_and_leaves_the_rest_alone(patched):
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_setDownloaded({"sheetId": sid, "videoId": "b", "downloaded": True})
    rows = {r["video"]["videoId"]: r["downloaded"]
            for r in h._cmd_youtube_list(None)["sheets"][0]["rows"]}
    assert rows == {"a": False, "b": True}


def test_set_downloaded_can_untick(patched):
    # Not just "tick": the value is honoured both ways, so a mis-click is
    # reversible. A handler that hard-coded True would pass the tick test.
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_setDownloaded({"sheetId": sid, "videoId": "a", "downloaded": True})
    h._cmd_youtube_setDownloaded({"sheetId": sid, "videoId": "a", "downloaded": False})
    a_row = h._cmd_youtube_list(None)["sheets"][0]["rows"][0]
    assert a_row["downloaded"] is False


def test_set_downloaded_unknown_row_is_refused(patched):
    h = _Host()
    sid = _make_sheet(h, patched)
    with pytest.raises(CommandError):
        h._cmd_youtube_setDownloaded({"sheetId": sid, "videoId": "zzz", "downloaded": True})


def test_refresh_appends_new_videos_and_keeps_existing_rows(patched, monkeypatch):
    h = _Host()
    sid = _make_sheet(h, patched)          # rows a, b
    # A tick and a match on an existing row must survive a refresh.
    h._cmd_youtube_setDownloaded({"sheetId": sid, "videoId": "a", "downloaded": True})
    h._apply_match(sid, "a", {"status": "matched", "discogsId": 9, "artist": "Keep",
                              "track": "", "album": "", "genres": [], "styles": [],
                              "releaseUrl": ""})

    monkeypatch.setattr(discover, "playlist_items",
                        lambda pid, key: _listing("a", "b", "c"))
    h._cmd_youtube_refreshSheet({"sheetId": sid})
    _run_pending(h)

    sheet = h._cmd_youtube_list(None)["sheets"][0]
    assert [r["video"]["videoId"] for r in sheet["rows"]] == ["a", "b", "c"]
    a_row = sheet["rows"][0]
    assert a_row["downloaded"] is True                 # tick kept
    assert a_row["match"]["artist"] == "Keep"          # match kept
    assert sheet["rows"][2]["match"]["status"] == "pending"   # new row unmatched


def test_refresh_unknown_sheet_is_refused(patched):
    h = _Host()
    with pytest.raises(CommandError):
        h._cmd_youtube_refreshSheet({"sheetId": "nope"})


def test_remove_sheet_takes_its_rows_with_it(patched):
    h = _Host()
    sid = _make_sheet(h, patched)
    state = h._cmd_youtube_removeSheet({"sheetId": sid})
    assert state["sheets"] == []
    assert h.state["youtube_sheets"] == []


def test_remove_unknown_sheet_is_refused(patched):
    h = _Host()
    with pytest.raises(CommandError):
        h._cmd_youtube_removeSheet({"sheetId": "nope"})


def test_rematch_by_search_replaces_one_row(patched):
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_rematch({"sheetId": sid, "videoId": "a",
                            "artist": "Redo", "title": "Again"})
    _run_pending(h)
    row = h._cmd_youtube_list(None)["sheets"][0]["rows"][0]
    assert row["match"]["status"] == "matched"
    assert row["match"]["artist"] == "Redo"


def test_rematch_by_url_uses_the_release_verbatim(patched, monkeypatch):
    monkeypatch.setattr(discover, "discogs_release_by_url",
                        lambda url, tok: {"status": "manual", "discogsId": 7,
                                          "artist": "Manual", "track": "", "album": "",
                                          "genres": [], "styles": [], "releaseUrl": url})
    h = _Host()
    sid = _make_sheet(h, patched)
    h._cmd_youtube_rematch({"sheetId": sid, "videoId": "a",
                            "discogsUrl": "https://www.discogs.com/release/7"})
    _run_pending(h)
    row = h._cmd_youtube_list(None)["sheets"][0]["rows"][0]
    assert row["match"]["status"] == "manual"
    assert row["match"]["discogsId"] == 7


def test_state_is_empty_before_any_sheet():
    h = _Host()
    assert h._cmd_youtube_list(None) == {"sheets": []}


# --- the state lock actually serialises concurrent writes -------------------
#
# The one thing the in-memory stub above cannot prove: enrichment writes matches
# from the worker pool while the main thread may be writing a setting, and the
# file's load→mutate→dump has to be atomic. This drives the REAL file-backed
# _save_state/_mutate_youtube (bound onto a tiny host, no pynicotine) from two
# threads at once, so a dropped lock shows up as lost appends.

import threading


class _FileHost:
    def __init__(self, folder):
        self.data_folder = str(folder)

    _state_path = CoreHost._state_path
    _load_state = CoreHost._load_state
    _save_state = CoreHost._save_state
    _youtube_sheets = CoreHost._youtube_sheets
    _mutate_youtube = CoreHost._mutate_youtube


def test_state_writes_do_not_clobber_each_other_across_threads(tmp_path):
    h = _FileHost(tmp_path)
    per_thread = 60

    def worker(tag):
        for i in range(per_thread):
            h._mutate_youtube(
                lambda sheets, t=tag, n=i: sheets.append({"id": f"{t}-{n}"})
            )

    threads = [threading.Thread(target=worker, args=(t,)) for t in ("A", "B", "C")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    ids = [s["id"] for s in h._youtube_sheets()]
    # Every append survived (no lost read-modify-write) and none was duplicated.
    assert len(ids) == 3 * per_thread
    assert len(set(ids)) == 3 * per_thread


def test_corrupt_state_degrades_to_no_sheets():
    h = _Host()
    h.state["youtube_sheets"] = "not a list"
    assert h._youtube_sheets() == []
