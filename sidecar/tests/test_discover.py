# Seek — discovery provider lookups, against recorded responses.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Every fixture here was recorded from the real service by
# `fixtures/discover/record.py`. Nothing in this file touches the network: the
# fetchers are injected, and a test that reached out would be a test that fails
# on a train.
#
# What these pin, beyond "it parses": that the module emits RAW PROVIDER FACTS.
# `artist` and `title` are populated for Bandcamp and Discogs because those
# providers state them as fields, and left EMPTY for YouTube because YouTube
# does not — filling them there would mean guessing on the Python side of the
# seam, which is the one thing this module must not do.

import json
import os

import pytest

from seek_sidecar import discover
from seek_sidecar.discover import DiscoverError

FIXTURES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "fixtures", "discover",
)


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as handle:
        return handle.read()


def json_fixture(name):
    return json.loads(fixture(name))


def no_image(_url):
    """Thumbnails are a separate request; most tests do not care."""
    return None


# --------------------------------------------------------------- classification

@pytest.mark.parametrize("url,expected", [
    ("https://www.youtube.com/watch?v=8k_f2QK77ew", "youtube"),
    ("https://youtu.be/8k_f2QK77ew", "youtube"),
    ("https://music.youtube.com/watch?v=8k_f2QK77ew", "youtube"),
    ("https://m.youtube.com/watch?v=8k_f2QK77ew", "youtube"),
    ("https://www.discogs.com/release/1125103", "discogs"),
    ("https://timreaper.bandcamp.com/album/in-full-effect", "bandcamp"),
    ("https://bandcamp.com/whatever", "bandcamp"),
    # A label on its own domain is indistinguishable from any other host, which
    # is why an unknown host is not a refusal.
    ("https://music.mysterylabel.co.uk/album/x", None),
    ("ftp://example.com/x", None),
    ("not a url", None),
])
def test_provider_for(url, expected):
    assert discover.provider_for(url) == expected


def test_a_lookalike_host_is_not_bandcamp():
    assert discover.provider_for("https://notbandcamp.com/album/x") is None
    assert discover.provider_for("https://bandcamp.com.evil.example/x") is None


@pytest.mark.parametrize("url,expected", [
    ("https://youtu.be/8k_f2QK77ew", "https://www.youtube.com/watch?v=8k_f2QK77ew"),
    ("https://music.youtube.com/watch?v=8k_f2QK77ew&list=RD",
     "https://www.youtube.com/watch?v=8k_f2QK77ew"),
    ("https://www.youtube.com/shorts/8k_f2QK77ew",
     "https://www.youtube.com/watch?v=8k_f2QK77ew"),
])
def test_youtube_urls_are_normalised_for_oembed(url, expected):
    """oEmbed does not reliably answer for youtu.be or the Music subdomain."""
    assert discover._youtube_oembed_url(url) == expected


# -------------------------------------------------------------------- youtube

def test_youtube_forwards_the_raw_title_and_derives_nothing():
    payload = json_fixture("youtube-oembed-burial.json")
    out = discover.parse_youtube(
        "https://www.youtube.com/watch?v=8k_f2QK77ew",
        fetch_json=lambda *a, **k: payload, fetch_image=no_image,
    )
    assert out["sourceKind"] == "youtube"
    assert out["kind"] == "track"
    assert out["rawTitle"] == "Burial, Archangel"
    assert out["channel"] == "Hyperdub"
    # THE LOAD-BEARING ASSERTION. `Burial, Archangel` plainly contains an artist
    # and a title, and this module still must not split it: that is
    # app/src/domain/parseTitle.ts's job, where it is testable against 40 other
    # title shapes and fixable without re-freezing the sidecar.
    assert out["artist"] == ""
    assert out["title"] == ""


def test_youtube_without_a_title_is_an_error_not_an_empty_card():
    with pytest.raises(DiscoverError):
        discover.parse_youtube(
            "https://www.youtube.com/watch?v=x",
            fetch_json=lambda *a, **k: {"author_name": "Someone"},
            fetch_image=no_image,
        )


def test_youtube_thumbnail_is_inlined_not_linked():
    payload = json_fixture("youtube-oembed-burial.json")
    seen = {}

    def fake_image(url):
        seen["url"] = url
        return "data:image/jpeg;base64,AAAA"

    out = discover.parse_youtube(
        "https://www.youtube.com/watch?v=8k_f2QK77ew",
        fetch_json=lambda *a, **k: payload, fetch_image=fake_image,
    )
    assert seen["url"] == "https://i.ytimg.com/vi/8k_f2QK77ew/hqdefault.jpg"
    # The wire carries the bytes, never the third-party URL: an <img> pointing
    # at i.ytimg.com would be the webview making its own request to Google.
    assert out["artworkUri"].startswith("data:image/")


# ------------------------------------------------------------------- bandcamp

def test_bandcamp_reads_the_structured_data():
    html = fixture("bandcamp-album-ld.html")
    out = discover.parse_bandcamp(
        "https://timreaper.bandcamp.com/album/in-full-effect",
        fetch_text=lambda _url: html, fetch_image=no_image,
    )
    assert out["sourceKind"] == "bandcamp"
    assert out["kind"] == "release"
    assert out["title"] == "In Full Effect"
    assert out["album"] == "In Full Effect"
    # Bandcamp STATES the artist as a field, so unlike YouTube it is filled in.
    assert out["artist"] == "Tim Reaper, Kloke"
    assert out["year"] == 2024
    assert len(out["tracklist"]) == 8
    assert out["tracklist"][0]["position"] == 1
    assert out["tracklist"][0]["title"] == "Continuities"
    # `P00H06M35S` is ISO 8601 with the `T` missing — no standard parser takes it.
    assert out["tracklist"][0]["duration"] == 395


def test_bandcamp_falls_back_to_opengraph_when_the_scrape_breaks():
    """The fragile path degrades instead of failing.

    Bandcamp can change their markup whenever they like. When the structured
    data goes, the card should still show a true title rather than an error.
    """
    html = (
        '<html><head>'
        '<meta property="og:title" content="In Full Effect | Tim Reaper">'
        '<meta property="og:image" content="https://f4.bcbits.com/img/a1_10.jpg">'
        '</head></html>'
    )
    out = discover.parse_bandcamp(
        "https://timreaper.bandcamp.com/album/in-full-effect",
        fetch_text=lambda _url: html, fetch_image=no_image,
    )
    assert out["rawTitle"] == "In Full Effect | Tim Reaper"
    assert out["kind"] == "release"
    # No tracklist is claimed, because none was found.
    assert out["tracklist"] == []


def test_bandcamp_with_no_metadata_at_all_raises():
    with pytest.raises(DiscoverError):
        discover.parse_bandcamp(
            "https://example.com/x",
            fetch_text=lambda _url: "<html><body>nothing</body></html>",
            fetch_image=no_image,
        )


@pytest.mark.parametrize("text,expected", [
    ("P00H06M35S", 395), ("P01H00M00S", 3600), ("P00H00M45S", 45),
    ("", None), ("garbage", None), ("P00H00M00S", None),
])
def test_bandcamp_durations(text, expected):
    assert discover._bc_duration(text) == expected


# -------------------------------------------------------------------- discogs

def test_discogs_release():
    payload = json_fixture("discogs-release-burial-untrue.json")
    out = discover.parse_discogs(
        "https://www.discogs.com/release/1125103", "a-token",
        fetch_json=lambda *a, **k: payload, fetch_image=no_image,
    )
    assert out["sourceKind"] == "discogs"
    assert out["kind"] == "release"
    assert out["artist"] == "Burial"
    assert out["title"] == "Untrue"
    assert out["year"] == 2007
    assert out["label"] == "Hyperdub"
    assert out["catalogNumber"] == "HDBCD002"
    # Genres first, then the styles that actually distinguish records.
    assert out["genres"][0] == "Electronic"
    assert "Dubstep" in out["genres"]
    assert len(out["tracklist"]) == 13
    archangel = next(t for t in out["tracklist"] if t["title"] == "Archangel")
    assert archangel["position"] == 2
    assert archangel["duration"] == 239


def test_discogs_sends_the_token_as_a_header_never_in_the_url():
    """A credential in a query string ends up in every log and proxy en route."""
    payload = json_fixture("discogs-release-burial-untrue.json")
    seen = {}

    def fake_json(url, headers=None, gate=None):
        seen["url"] = url
        seen["headers"] = headers or {}
        return payload

    discover.parse_discogs(
        "https://www.discogs.com/release/1125103", "s3cret-token",
        fetch_json=fake_json, fetch_image=no_image,
    )
    assert "s3cret-token" not in seen["url"]
    assert seen["headers"]["Authorization"] == "Discogs token=s3cret-token"


def test_discogs_without_a_token_says_which_setting_is_missing():
    with pytest.raises(DiscoverError) as raised:
        discover.parse_discogs(
            "https://www.discogs.com/release/1125103", "",
            fetch_json=lambda *a, **k: {}, fetch_image=no_image,
        )
    # Machine-readable, so the UI can link to the right Settings field without
    # reading English out of the developer-facing message.
    assert raised.value.needs == "discogsToken"


def test_discogs_label_is_a_catalogue_not_a_search():
    out = discover.parse_discogs(
        "https://www.discogs.com/label/23604-Hyperdub", "a-token",
        fetch_json=lambda *a, **k: {"name": "Hyperdub", "id": 23604, "images": []},
        fetch_image=no_image,
    )
    assert out["kind"] == "label"
    assert out["title"] == "Hyperdub"
    # A label is something to browse (Phase D4), not a track to search for.
    assert out["artist"] == ""


def test_discogs_artist_disambiguators_are_stripped():
    out = discover.parse_discogs(
        "https://www.discogs.com/artist/1", "a-token",
        fetch_json=lambda *a, **k: {"name": "Burial (2)", "images": []},
        fetch_image=no_image,
    )
    assert out["title"] == "Burial"


@pytest.mark.parametrize("artists,expected", [
    ([{"name": "Burial", "join": "&"}, {"name": "Four Tet"}], "Burial & Four Tet"),
    ([{"name": "A", "join": ","}, {"name": "B"}], "A, B"),
    ([{"name": "Burial (2)", "join": ""}], "Burial"),
    ([{"name": "Solo", "join": "&"}], "Solo"),
    ([], ""),
])
def test_discogs_credits_honour_join_phrases(artists, expected):
    assert discover._discogs_credit({"artists": artists}) == expected


def test_discogs_rejects_a_url_that_names_no_entity():
    with pytest.raises(DiscoverError):
        discover.parse_discogs("https://www.discogs.com/sell/list", "a-token",
                               fetch_json=lambda *a, **k: {}, fetch_image=no_image)


# ---------------------------------------------------------------- dispatch

def test_parse_url_routes_by_provider():
    payload = json_fixture("youtube-oembed-burial.json")
    out = discover.parse_url(
        "https://youtu.be/8k_f2QK77ew",
        fetch_json=lambda *a, **k: payload, fetch_image=no_image,
    )
    assert out["sourceKind"] == "youtube"


def test_parse_url_tries_bandcamp_for_an_unknown_host():
    """This is how a Bandcamp custom domain is recognised at all."""
    html = fixture("bandcamp-album-ld.html")
    out = discover.parse_url(
        "https://music.mysterylabel.co.uk/album/in-full-effect",
        fetch_text=lambda _url: html, fetch_image=no_image,
    )
    assert out["sourceKind"] == "bandcamp"
    assert out["artist"] == "Tim Reaper, Kloke"


@pytest.mark.parametrize("url", ["", "   ", "ftp://example.com/x", "javascript:alert(1)",
                                 "file:///etc/passwd"])
def test_parse_url_refuses_anything_that_is_not_http(url):
    with pytest.raises(DiscoverError):
        discover.parse_url(url, fetch_json=lambda *a, **k: {},
                           fetch_text=lambda _u: "", fetch_image=no_image)


def test_every_provider_fills_every_wire_field():
    """The generated validator rejects a missing key, and a dropped frame is
    invisible from the frontend — it simply never arrives."""
    from seek_sidecar import protocol

    outs = [
        discover.parse_youtube(
            "https://www.youtube.com/watch?v=8k_f2QK77ew",
            fetch_json=lambda *a, **k: json_fixture("youtube-oembed-burial.json"),
            fetch_image=no_image),
        discover.parse_bandcamp(
            "https://timreaper.bandcamp.com/album/in-full-effect",
            fetch_text=lambda _u: fixture("bandcamp-album-ld.html"),
            fetch_image=no_image),
        discover.parse_discogs(
            "https://www.discogs.com/release/1125103", "t",
            fetch_json=lambda *a, **k: json_fixture(
                "discogs-release-burial-untrue.json"),
            fetch_image=no_image),
    ]
    for out in outs:
        out["requestId"] = "req-1"
        protocol.validate_event("discover.parsed", out)


# ------------------------------------------------------------ fingerprinting

def test_fpcalc_is_looked_up_not_assumed_on_path():
    """The sidecar runs from a GUI-launched app whose PATH is not a login
    shell's, and Homebrew's prefix differs by architecture."""
    assert discover.FPCALC_CANDIDATES[0] == "fpcalc"
    assert any(c.startswith("/opt/homebrew") for c in discover.FPCALC_CANDIDATES)


def test_a_missing_fingerprinter_names_itself(monkeypatch):
    """Without chromaprint the feature cannot work, and the message has to say
    which thing is missing rather than failing as a generic error."""
    monkeypatch.setattr(discover, "fpcalc_path", lambda: None)
    with pytest.raises(DiscoverError) as raised:
        discover.fingerprint("/tmp/x.mp3")
    assert "fpcalc" in str(raised.value)
    assert raised.value.needs == "fpcalc"


def test_identify_without_a_key_names_the_setting():
    with pytest.raises(DiscoverError) as raised:
        discover.identify("/tmp/a.mp3", "", fingerprinter=lambda *a: (100.0, "FP"))
    assert raised.value.needs == "acoustidApiKey"


def test_the_acoustid_error_body_is_read_rather_than_discarded():
    """AcoustID answers a rejected key with HTTP 400 and the reason in the body.
    Verified against the live service: discarding it turned a fixable
    "invalid API key" into an opaque "HTTP 400"."""
    seen = {}

    def fake_fetch(url, headers=None, gate=None, accept=None, data=None, read_errors=False):
        seen["read_errors"] = read_errors
        return json.dumps({"status": "error",
                           "error": {"code": 4, "message": "invalid API key"}}).encode(), ""

    with pytest.raises(DiscoverError) as raised:
        discover.identify("/tmp/a.mp3", "bad",
                          fingerprinter=lambda *a: (100.0, "FP"), fetch=fake_fetch)
    assert seen["read_errors"] is True
    assert "invalid API key" in str(raised.value)


def test_a_rejected_key_is_told_apart_from_a_missing_record():
    """AcoustID answers 200 with an error body. A bad key is a configuration
    problem the user can fix; no match is just no match."""
    body = json.dumps({"status": "error",
                       "error": {"code": 4, "message": "invalid API key"}}).encode()
    with pytest.raises(DiscoverError) as raised:
        discover.identify("/tmp/a.mp3", "bad-key",
                          fingerprinter=lambda *a: (100.0, "FP"),
                          fetch=lambda *a, **k: (body, "application/json"))
    assert raised.value.needs == "acoustidApiKey"


def test_no_match_is_an_answer_not_an_error():
    body = json.dumps({"status": "ok", "results": []}).encode()
    out = discover.identify("/tmp/a.mp3", "key",
                            fingerprinter=lambda *a: (235.0, "FP"),
                            fetch=lambda *a, **k: (body, "application/json"))
    assert out["matched"] is False
    assert out["durationSeconds"] == 235.0


def test_the_highest_scoring_result_with_a_recording_wins():
    body = json.dumps({"status": "ok", "results": [
        {"score": 0.99, "id": "x"},                       # no recordings at all
        {"score": 0.42, "recordings": [{"title": "Wrong",
                                        "artists": [{"name": "Nobody"}]}]},
        {"score": 0.91, "recordings": [{
            "title": "Archangel", "id": "mb-1",
            "artists": [{"name": "Burial"}],
            "releasegroups": [{"title": "Untrue"}],
        }]},
    ]}).encode()
    out = discover.identify("/tmp/a.mp3", "key",
                            fingerprinter=lambda *a: (235.0, "FP"),
                            fetch=lambda *a, **k: (body, "application/json"))
    assert (out["matched"], out["artist"], out["title"]) == (True, "Burial", "Archangel")
    assert out["album"] == "Untrue"
    assert out["score"] == 0.91


def test_the_fingerprint_is_posted_not_put_in_the_url():
    """A fingerprint is several kilobytes and will not fit in a query string."""
    seen = {}

    def fake_fetch(url, headers=None, gate=None, accept=None, data=None,
                   read_errors=False):
        seen["url"] = url
        seen["data"] = data
        return json.dumps({"status": "ok", "results": []}).encode(), "application/json"

    discover.identify("/tmp/a.mp3", "the-key",
                      fingerprinter=lambda *a: (235.0, "FINGERPRINT"),
                      fetch=fake_fetch)
    assert "FINGERPRINT" not in seen["url"]
    assert b"FINGERPRINT" in seen["data"]
    assert b"client=the-key" in seen["data"]


def test_meta_is_space_separated_so_it_reaches_acoustid_as_a_list():
    """`urlencode` turns a literal `+` into `%2B`, which AcoustID reads as part
    of the value rather than a separator. Verified against the live service: it
    returned a score of 1.0 with NO recordings attached, and this reported "no
    match" on a perfect match."""
    seen = {}

    def fake_fetch(url, headers=None, gate=None, accept=None, data=None,
                   read_errors=False):
        seen["data"] = data
        return json.dumps({"status": "ok", "results": []}).encode(), ""

    discover.identify("/tmp/a.mp3", "key", fingerprinter=lambda *a: (1.0, "FP"),
                      fetch=fake_fetch)
    assert b"meta=recordings+releasegroups" in seen["data"]
    assert b"%2B" not in seen["data"]


def test_identified_validates_against_the_generated_schema():
    from seek_sidecar import protocol
    body = json.dumps({"status": "ok", "results": []}).encode()
    out = discover.identify("/tmp/a.mp3", "key",
                            fingerprinter=lambda *a: (1.0, "FP"),
                            fetch=lambda *a, **k: (body, "application/json"))
    out["requestId"] = "r1"
    protocol.validate_event("discover.identified", out)


# ----------------------------------------------------------------- related

def test_related_excludes_the_release_it_started_from():
    """A "more like this" list whose first entry is the record you are already
    looking at is a list that has not understood the question."""
    def fake_json(url, headers=None, gate=None):
        if "database/search" in url:
            # The name has to resemble what was asked for, or the guard
            # against fuzzy mismatches refuses it — as it should.
            name = "Burial" if "type=artist" in url else "Hyperdub"
            return {"results": [{"id": 1, "title": name}]}
        return {"pagination": {"pages": 1}, "releases": [
            {"id": 1, "title": "Untrue", "artist": "Burial", "role": "Main"},
            {"id": 2, "title": "Kindred", "artist": "Burial", "role": "Main"},
        ]}

    out = discover.related("Burial", "Untrue", "Hyperdub", "token", fetch_json=fake_json)
    assert [r["title"] for r in out["byArtist"]] == ["Kindred"]
    assert [r["title"] for r in out["byLabel"]] == ["Kindred"]
    assert out["labelName"] == "Hyperdub"


def test_related_drops_compilation_appearances_from_the_artist_list():
    def fake_json(url, headers=None, gate=None):
        if "database/search" in url:
            return {"results": [{"id": 1, "title": "Burial"}]}
        return {"pagination": {"pages": 1}, "releases": [
            {"id": 2, "title": "Kindred", "artist": "Burial", "role": "Main"},
            {"id": 3, "title": "Some Comp", "artist": "VA", "role": "TrackAppearance"},
        ]}

    out = discover.related("Burial", "Untrue", "", "token", fetch_json=fake_json)
    assert [r["title"] for r in out["byArtist"]] == ["Kindred"]


def test_related_without_a_token_names_the_setting():
    with pytest.raises(DiscoverError) as raised:
        discover.related("Burial", "Untrue", "Hyperdub", "")
    assert raised.value.needs == "discogsToken"


def test_related_survives_one_half_failing():
    """No artist discography must not cost the label catalogue too."""
    def fake_json(url, headers=None, gate=None):
        if "artist" in url:
            raise DiscoverError("nope")
        if "database/search" in url:
            return {"results": [{"id": 1, "title": "Hyperdub"}]}
        return {"pagination": {"pages": 1}, "releases": [
            {"id": 2, "title": "Kindred", "artist": "Burial"},
        ]}

    out = discover.related("Burial", "Untrue", "Hyperdub", "token", fetch_json=fake_json)
    assert out["byArtist"] == []
    assert [r["title"] for r in out["byLabel"]] == ["Kindred"]


# --------------------------------------------------------------- tracklists

def _description(text):
    """A page carrying just the description field the extractor reads."""
    return '"attributedDescription":{"content":"' + text.replace("\n", "\\n") + '"}'


def test_a_tracklist_is_read_out_of_a_description():
    page = _description(
        "Tracklist:\n"
        "00:00 Burial - Archangel\n"
        "3:45 Pangaea - Installation\n"
        "[1:02:30] Objekt - Ganzfeld\n"
        "01. 12:00 Actress - Hubble\n"
        "(45:12) - Skee Mask - Rev8617\n"
    )
    out = discover.parse_tracklist("https://youtu.be/x", fetch_text=lambda _u: page)
    assert [l["offsetSeconds"] for l in out["lines"]] == [0, 225, 3750, 720, 2712]
    assert [l["position"] for l in out["lines"]] == [1, 2, 3, 4, 5]
    # THE SEAM: the line is forwarded whole. Splitting 'Burial - Archangel'
    # into an artist and a title is parseTitle.ts's job, and a second splitter
    # here would be a second thing to get wrong.
    assert out["lines"][0]["text"] == "Burial - Archangel"


def test_a_time_range_keeps_only_the_track_name():
    """Full-album uploads write `00:00 - 02:03 New Creator`. Seen in the wild;
    the end of the range is not part of what the track is called."""
    page = _description("00:00 - 02:03 New Creator\n02:03 - 04:08 Mixer\n")
    out = discover.parse_tracklist("https://youtu.be/x", fetch_text=lambda _u: page)
    assert [l["text"] for l in out["lines"]] == ["New Creator", "Mixer"]
    assert [l["offsetSeconds"] for l in out["lines"]] == [0, 123]


def test_a_bare_timestamp_is_not_a_track():
    """`1:15:00` alone used to be reported as a track at 1m15s called '00' —
    the optional-seconds group backtracked. It is a chapter marker, not music."""
    out = discover.parse_tracklist("https://youtu.be/x",
                                   fetch_text=lambda _u: _description("1:15:00\n2:00:00\n"))
    assert out["lines"] == []


def test_links_and_prose_are_not_tracks():
    page = _description(
        "Recorded live in Berlin.\n"
        "00:00 https://example.com/subscribe\n"
        "Follow us everywhere\n"
        "12:00 Real Artist - Real Track\n"
    )
    out = discover.parse_tracklist("https://youtu.be/x", fetch_text=lambda _u: page)
    assert [l["text"] for l in out["lines"]] == ["Real Artist - Real Track"]


def test_no_tracklist_is_an_empty_list_not_an_error():
    """Most videos have no tracklist. That is ordinary, and the caller shows
    the video as a single entry rather than an error."""
    out = discover.parse_tracklist(
        "https://youtu.be/x", fetch_text=lambda _u: _description("Just a song.\n"),
    )
    assert out["lines"] == []


def test_the_video_title_comes_from_the_right_place():
    """An unanchored search for `"title"` walked past videoDetails entirely and
    returned a localised view count off a real page."""
    page = ('"videoDetails":{"videoId":"abc","title":"Boiler Room - Ben UFO",'
            '"lengthSeconds":"3600","author":"Boiler Room"}'
            + _description("00:00 A - B\n"))
    out = discover.parse_tracklist("https://youtu.be/abc", fetch_text=lambda _u: page)
    assert out["videoTitle"] == "Boiler Room - Ben UFO"
    assert out["channel"] == "Boiler Room"


def test_the_overlay_shape_is_read_too():
    page = ('"playerOverlayVideoDetailsRenderer":{"title":{"simpleText":"Burial, Archangel"},'
            '"subtitle":{"runs":[{"text":"Hyperdub"}]}}' + _description(""))
    out = discover.parse_tracklist("https://youtu.be/abc", fetch_text=lambda _u: page)
    assert out["videoTitle"] == "Burial, Archangel"
    assert out["channel"] == "Hyperdub"


def test_a_tracklist_is_only_asked_of_youtube():
    with pytest.raises(DiscoverError):
        discover.parse_tracklist("https://hyperdub.bandcamp.com/music",
                                 fetch_text=lambda _u: "")


def test_a_tracklist_validates_against_the_generated_schema():
    from seek_sidecar import protocol
    out = discover.parse_tracklist(
        "https://youtu.be/x", fetch_text=lambda _u: _description("00:00 A - B\n"),
    )
    out["requestId"] = "req-1"
    protocol.validate_event("discover.tracklistParsed", out)


# ---------------------------------------------------------------- catalogues

def test_discogs_label_catalogue():
    """Field mapping against the real recorded response.

    The fixture was recorded 25 rows at a time, so it honestly reports several
    pages; pagination itself has its own tests below. Here the page count is
    pinned to one so this test is about the SHAPE of a row, not the loop.
    """
    payload = json_fixture("discogs-label-hyperdub.json")
    payload = {**payload, "pagination": {**payload["pagination"], "pages": 1}}
    name, label_id, releases, complete, _img = discover.browse_discogs(
        "label", 25386, "Hyperdub", "a-token",
        fetch_json=lambda *a, **k: payload,
    )
    assert name == "Hyperdub"
    assert label_id == 25386
    assert complete is True
    assert len(releases) == len(payload["releases"])

    first = releases[0]
    assert first["title"]
    assert first["url"].startswith("https://www.discogs.com/")
    # A label's rows carry a format and a catalogue number; an artist's do not.
    assert any(r["catno"] for r in releases)
    assert any(r["format"] for r in releases)
    assert all(r["role"] == "" for r in releases)


def test_discogs_artist_catalogue_keeps_the_role():
    """Burial's 375 entries are mostly compilation appearances, and which of
    those count as 'their discography' is the user's call."""
    payload = {
        "pagination": {"pages": 1},
        "releases": [
            {"id": 11767, "title": "Burial", "artist": "Burial", "year": 2006,
             "type": "master", "role": "Main"},
            {"id": 99, "title": "Some Compilation", "artist": "Various",
             "type": "release", "role": "TrackAppearance"},
        ],
    }
    _name, _id, releases, _complete, _img = discover.browse_discogs(
        "artist", 306157, "Burial", "a-token", fetch_json=lambda *a, **k: payload,
    )
    assert [r["role"] for r in releases] == ["Main", "TrackAppearance"]
    # Masters and releases live at different URLs on Discogs.
    assert releases[0]["url"].endswith("/master/11767")
    assert releases[1]["url"].endswith("/release/99")
    assert all(r["format"] == "" and r["catno"] == "" for r in releases)


def test_a_catalogue_too_big_to_finish_says_so():
    """A truncated list that claims to be whole hides the records you were
    digging for."""
    page = {"pagination": {"pages": 99}, "releases": [
        {"id": 1, "title": "T", "artist": "A"},
    ]}
    _name, _id, releases, complete, _img = discover.browse_discogs(
        "label", 1, "Big", "a-token", fetch_json=lambda *a, **k: page,
    )
    assert complete is False
    assert len(releases) == discover.DISCOGS_MAX_PAGES


def test_a_catalogue_stops_at_the_last_page():
    page = {"pagination": {"pages": 2}, "releases": [{"id": 1, "title": "T", "artist": "A"}]}
    _n, _i, releases, complete, _img = discover.browse_discogs(
        "label", 1, "Small", "a-token", fetch_json=lambda *a, **k: page,
    )
    assert complete is True
    assert len(releases) == 2          # two pages, one release each


def test_a_label_can_be_found_by_name(monkeypatch):
    calls = []

    def fake_json(url, headers=None, gate=None):
        calls.append(url)
        if "database/search" in url:
            return {"results": [{"id": 25386, "title": "Hyperdub"}]}
        return {"pagination": {"pages": 1}, "releases": []}

    name, label_id, _releases, _complete, _img = discover.browse_discogs(
        "label", None, "Hyperdub", "a-token", fetch_json=fake_json,
    )
    assert (name, label_id) == ("Hyperdub", 25386)
    assert "database/search" in calls[0]


def test_a_fuzzy_search_hit_that_is_not_what_was_asked_for_is_refused():
    """Discogs' search always returns SOMETHING. Asking it for
    "A. Aural Imbalance" — a name a path parser produced — really did come back
    with Donald Wilborn, and taking results[0] on trust put thirty of his
    records under a heading reading "More by A. Aural Imbalance"."""
    payload = {"results": [{"id": 999, "title": "Donald Wilborn"}]}
    with pytest.raises(DiscoverError) as raised:
        discover.discogs_find_id("artist", "A. Aural Imbalance", "token",
                                 fetch_json=lambda *a, **k: payload)
    assert "resembles" in str(raised.value)


def test_a_plausible_hit_further_down_the_list_is_taken():
    payload = {"results": [
        {"id": 1, "title": "Something Else"},
        {"id": 2, "title": "Aural Imbalance"},
    ]}
    found_id, name = discover.discogs_find_id(
        "artist", "Aural Imbalance", "token", fetch_json=lambda *a, **k: payload,
    )
    assert (found_id, name) == (2, "Aural Imbalance")


@pytest.mark.parametrize("asked,offered,ok", [
    ("Burial", "Burial", True),
    ("burial", "BURIAL", True),
    ("Aural Imbalance", "Aural Imbalance (2)", True),
    ("Hyperdub", "Hyperdub Records", True),
    ("A. Aural Imbalance", "Donald Wilborn", False),
    ("Burial", "Burial Hex", True),      # containment; a real ambiguity, allowed
    ("Burial", "Massive Attack", False),
])
def test_resemblance(asked, offered, ok):
    assert discover._resembles(asked, offered) is ok


def test_browsing_discogs_without_a_token_names_the_setting():
    with pytest.raises(DiscoverError) as raised:
        discover.browse_discogs("label", 1, "X", "", fetch_json=lambda *a, **k: {})
    assert raised.value.needs == "discogsToken"


@pytest.mark.parametrize("path", ["", "/", "/music", "/merch"])
def test_a_bandcamp_catalogue_page_is_not_a_track(path):
    """A label front page has no MusicAlbum block, and reading it as a track
    made the Dig Bar offer to search Soulseek for the label's name."""
    out = discover.parse_bandcamp(
        f"https://hyperdub.bandcamp.com{path}",
        # The page really does title itself "Music | Hyperdub".
        fetch_text=lambda _u: (
            '<html><head><title>Music | Hyperdub</title>'
            '<meta property="og:site_name" content="Hyperdub">'
            "</head></html>"
        ),
        fetch_image=no_image,
    )
    assert out["kind"] == "label"
    assert out["title"] == "Hyperdub"


def test_bandcamp_label_catalogue():
    html = fixture("bandcamp-label-hyperdub.html")
    name, releases, _img = discover.browse_bandcamp(
        "https://hyperdub.bandcamp.com/music", fetch_text=lambda _u: html,
    )
    # NOT "Music". The page titles itself `Music | Hyperdub`, and reading the
    # first segment named every label on Bandcamp "Music".
    assert name == "Hyperdub"
    assert len(releases) > 50
    assert all(r["url"].startswith("http") for r in releases)
    # Bandcamp publishes neither on a label grid, so neither is invented.
    assert all(r["year"] is None and r["catno"] == "" for r in releases)
    # The `?label=…&tab=music` tracking tail is not part of a record's identity.
    assert all("?" not in r["url"] for r in releases)
    assert any(r["artist"] for r in releases)


def test_a_bandcamp_page_with_no_grid_fails_cleanly():
    with pytest.raises(DiscoverError):
        discover.browse_bandcamp(
            "https://x.bandcamp.com/music",
            fetch_text=lambda _u: "<html><body>redesigned</body></html>",
        )


def test_browse_refuses_what_it_cannot_browse():
    for kind in ("track", "release"):
        with pytest.raises(DiscoverError):
            discover.browse("discogs", kind, entity_id=1)
    with pytest.raises(DiscoverError):
        discover.browse("youtube", "label", name="x")
    # Bandcamp has no ids at all; a name alone cannot address a catalogue.
    with pytest.raises(DiscoverError):
        discover.browse("bandcamp", "label", name="Hyperdub")


def test_a_browsed_catalogue_validates_against_the_generated_schema():
    from seek_sidecar import protocol
    payload = json_fixture("discogs-label-hyperdub.json")
    out = discover.browse(
        "discogs", "label", entity_id=25386, name="Hyperdub",
        discogs_token="t", fetch_json=lambda *a, **k: payload,
    )
    out["requestId"] = "req-1"
    protocol.validate_event("discover.catalog", out)


# ------------------------------------------------------------------- safety

@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "10.0.0.1",
                                  "192.168.1.1", "169.254.1.1", ""])
def test_private_addresses_are_refused(host):
    """The thumbnail URL and the Bandcamp page URL both come from outside, and
    the sidecar must not be turned into a fetcher for the user's own network."""
    assert discover._is_public_host(host) is False


def test_a_thumbnail_on_a_private_address_is_dropped_silently():
    assert discover._image_data_uri("https://127.0.0.1/cover.jpg") is None
    assert discover._image_data_uri("http://example.com/cover.jpg") is None  # not https
    assert discover._image_data_uri(None) is None


# ------------------------------------------------- reachable vs. answered "no"
#
# Added after 0.2.0 shipped with no CA bundle: every lookup failed on TLS, and
# because a transport failure and a 404 were the same event to the frontend, the
# card said "Not a link Seek recognises" about links that were perfectly good.
# The distinction has to survive in the error itself, so these pin it there.


class _Boom:
    """A urlopen that fails the way a network does, before any HTTP happens."""

    def __init__(self, error):
        self.error = error

    def __call__(self, *_args, **_kwargs):
        raise self.error


def test_a_transport_failure_is_marked_unreachable(monkeypatch):
    import ssl
    monkeypatch.setattr(
        discover.urllib.request, "urlopen",
        _Boom(discover.urllib.error.URLError(ssl.SSLError("CERTIFICATE_VERIFY_FAILED"))),
    )
    with pytest.raises(discover.DiscoverError) as caught:
        discover._fetch("https://example.invalid/thing")
    assert caught.value.unreachable is True


def test_dns_failure_is_unreachable(monkeypatch):
    import socket
    monkeypatch.setattr(
        discover.urllib.request, "urlopen",
        _Boom(discover.urllib.error.URLError(socket.gaierror("nodename nor servname"))),
    )
    with pytest.raises(discover.DiscoverError) as caught:
        discover._fetch("https://example.invalid/thing")
    assert caught.value.unreachable is True


def test_a_404_is_not_unreachable(monkeypatch):
    """The server answered. The link names nothing, and searching the text
    instead is the right fallback — which is the opposite advice."""
    monkeypatch.setattr(
        discover.urllib.request, "urlopen",
        _Boom(discover.urllib.error.HTTPError(
            "https://example.com/x", 404, "Not Found", {}, None)),
    )
    with pytest.raises(discover.DiscoverError) as caught:
        discover._fetch("https://example.com/x")
    assert caught.value.unreachable is False


def test_an_auth_failure_is_not_unreachable(monkeypatch):
    """401 reaches the provider fine; the token is the problem, and `needs`
    already carries that."""
    monkeypatch.setattr(
        discover.urllib.request, "urlopen",
        _Boom(discover.urllib.error.HTTPError(
            "https://api.discogs.com/x", 401, "Unauthorized", {}, None)),
    )
    with pytest.raises(discover.DiscoverError) as caught:
        discover._fetch("https://api.discogs.com/x")
    assert caught.value.unreachable is False


def test_unreachable_defaults_off():
    """Every DiscoverError raised for an ordinary parse outcome must not claim
    the network is down."""
    assert discover.DiscoverError("no title").unreachable is False
    assert discover.DiscoverError("needs a token", needs="discogsToken").unreachable is False


# --------------------------------------------- a token that was REFUSED
#
# From a real 0.2.2 report: "i pasted and saved the token, now the search says
# discogs token needed". A 401 has to carry BOTH facts — which credential, and
# that it is present but wrong — or the UI tells someone to supply what they
# already supplied.


def test_a_401_is_marked_unauthorised(monkeypatch):
    monkeypatch.setattr(
        discover.urllib.request, "urlopen",
        _Boom(discover.urllib.error.HTTPError(
            "https://api.discogs.com/x", 401, "Unauthorized", {}, None)),
    )
    with pytest.raises(discover.DiscoverError) as caught:
        discover._fetch("https://api.discogs.com/x")
    assert caught.value.unauthorised is True
    # Not a transport failure: the provider answered.
    assert caught.value.unreachable is False


def test_a_403_is_marked_unauthorised(monkeypatch):
    monkeypatch.setattr(
        discover.urllib.request, "urlopen",
        _Boom(discover.urllib.error.HTTPError(
            "https://api.discogs.com/x", 403, "Forbidden", {}, None)),
    )
    with pytest.raises(discover.DiscoverError) as caught:
        discover._fetch("https://api.discogs.com/x")
    assert caught.value.unauthorised is True


def test_a_refused_discogs_token_names_the_field_too():
    """`_fetch` knows the request was refused; only parse_discogs knows it was
    the DISCOGS token. Both facts have to survive."""
    def refuse(*_args, **_kwargs):
        raise discover.DiscoverError("HTTP 401: not authorised", unauthorised=True)

    with pytest.raises(discover.DiscoverError) as caught:
        discover.parse_discogs(
            "https://www.discogs.com/release/1122550-Aphex-Twin-Windowlicker",
            token="a-wrong-token", fetch_json=refuse,
        )
    assert caught.value.unauthorised is True
    assert caught.value.needs == "discogsToken"


def test_no_token_at_all_is_not_unauthorised():
    """The opposite case, and the one that must keep saying 'add a token'."""
    with pytest.raises(discover.DiscoverError) as caught:
        discover.parse_discogs(
            "https://www.discogs.com/release/1122550-Aphex-Twin-Windowlicker",
            token="",
        )
    assert caught.value.needs == "discogsToken"
    assert caught.value.unauthorised is False


def test_a_404_is_neither():
    monkeypatch_free = discover.DiscoverError("not found")
    assert monkeypatch_free.unauthorised is False
    assert monkeypatch_free.unreachable is False
