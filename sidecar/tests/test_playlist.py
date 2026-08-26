"""
Seek — reading a public YouTube playlist.
SPDX-License-Identifier: GPL-3.0-or-later

The fake responses below are shaped from a MEASURED call to the live
youtube/v3 API, not from documentation. Four details in here are the ones that
would have been guessed wrong, and each has a test:

  - nextPageToken is ABSENT on a single-page playlist, not null
  - snippet carries channelTitle (playlist owner) AND videoOwnerChannelTitle
    (uploader), and only the uploader names the music
  - the id comes from contentDetails.videoId
  - pageInfo.totalResults counts the whole playlist, not the page
"""

import pytest

from seek_sidecar import discover


def _entry(pos, title, video_id, uploader="Hyperdub"):
    snippet = {
        "title": title,
        "position": pos,
        "channelTitle": "some playlist collector",   # the WRONG one to read
        "resourceId": {"videoId": video_id},
        "playlistId": "PL123",
    }
    if uploader is not None:
        snippet["videoOwnerChannelTitle"] = uploader
    return {"snippet": snippet, "contentDetails": {"videoId": video_id}}


def _single_page(n=3):
    """A short playlist. Note the ABSENT nextPageToken — that is the point."""
    return {
        "kind": "youtube#playlistItemListResponse",
        "pageInfo": {"totalResults": n, "resultsPerPage": 50},
        "items": [_entry(i, f"Burial, Track {i}", f"vid{i}") for i in range(n)],
    }


def test_reads_a_single_page_playlist():
    out = discover.playlist_items("PL123", "key", fetch_json=lambda url: _single_page())
    assert out["playlistId"] == "PL123"
    assert out["total"] == 3
    assert out["complete"] is True
    assert [i["title"] for i in out["items"]] == [
        "Burial, Track 0", "Burial, Track 1", "Burial, Track 2",
    ]


def test_the_channel_is_the_uploader_not_the_playlist_owner():
    """The trap. snippet.channelTitle is whoever BUILT the playlist, which
    says nothing about the music; videoOwnerChannelTitle is who uploaded it."""
    out = discover.playlist_items("PL123", "key", fetch_json=lambda url: _single_page(1))
    assert out["items"][0]["channel"] == "Hyperdub"
    assert out["items"][0]["channel"] != "some playlist collector"


def test_takes_the_id_from_content_details():
    out = discover.playlist_items("PL123", "key", fetch_json=lambda url: _single_page(1))
    assert out["items"][0]["videoId"] == "vid0"


def test_an_absent_next_page_token_ends_it_rather_than_looping():
    """A missing key, not a null one — .get() or this never terminates."""
    calls = []

    def fetch(url):
        calls.append(url)
        return _single_page(2)

    discover.playlist_items("PL123", "key", fetch_json=fetch)
    assert len(calls) == 1


def test_follows_pagination_and_reports_the_real_total():
    pages = [
        {
            "pageInfo": {"totalResults": 60, "resultsPerPage": 50},
            "items": [_entry(i, f"A {i}", f"v{i}") for i in range(50)],
            "nextPageToken": "TOKEN",
        },
        {
            "pageInfo": {"totalResults": 60, "resultsPerPage": 50},
            "items": [_entry(i, f"B {i}", f"w{i}") for i in range(10)],
        },
    ]
    seen = []

    def fetch(url):
        seen.append(url)
        return pages[len(seen) - 1]

    out = discover.playlist_items("PL123", "key", fetch_json=fetch)
    assert len(seen) == 2
    assert "pageToken=TOKEN" in seen[1]
    assert len(out["items"]) == 60
    # totalResults is the WHOLE playlist, so it must not be the page size.
    assert out["total"] == 60
    assert out["complete"] is True


def test_says_so_when_it_stops_paginating_early():
    """A truncated list that claims to be whole is worse than one that admits
    it — the same contract DiscoverCatalog already keeps."""
    def fetch(url):
        return {
            "pageInfo": {"totalResults": 10_000, "resultsPerPage": 50},
            "items": [_entry(0, "x", "v")],
            "nextPageToken": "ALWAYS-MORE",
        }

    out = discover.playlist_items("PL123", "key", fetch_json=fetch)
    assert out["complete"] is False
    assert out["total"] == 10_000


def test_an_entry_youtube_will_not_serve_is_marked_unavailable():
    """Documented, NOT confirmed against live data — no sampled playlist held
    one. The branch exists so a dead entry cannot masquerade as a track."""
    def fetch(url):
        return {
            "pageInfo": {"totalResults": 1, "resultsPerPage": 50},
            "items": [_entry(0, "Deleted video", "", uploader=None)],
        }

    out = discover.playlist_items("PL123", "key", fetch_json=fetch)
    assert out["items"][0]["available"] is False


def test_missing_key_says_which_setting_would_fix_it():
    with pytest.raises(discover.DiscoverError) as caught:
        discover.playlist_items("PL123", "", fetch_json=lambda url: {})
    assert caught.value.needs == "youtubeApiKey"


def test_no_playlist_id_is_refused():
    with pytest.raises(discover.DiscoverError):
        discover.playlist_items("", "key", fetch_json=lambda url: {})
