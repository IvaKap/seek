"""
Seek — reading the signed-in user's Discogs wantlist.
SPDX-License-Identifier: GPL-3.0-or-later

The fake responses below are shaped from MEASURED calls to the live Discogs
API against a real account, not from documentation. Five details would have
been guessed wrong, and each has a test:

  - a page PAST the last one answers HTTP 404, not an empty list, so a loop
    that reads until `wants` is empty raises instead of terminating
  - `pagination.pages` is present and correct from the first response, and is
    the only terminator that needs no key-presence check
  - `basic_information.master_id` is 0, not null, for a release with no master
  - real titles carry trailing whitespace ("Aline Brooklyn 001 ")
  - the artists array carries JOIN PHRASES on the artist they follow
    ("Massive Attack" join "Vs", then "Burial"), and names carry Discogs'
    disambiguator ("Kahn (5)")
"""

import pytest

from seek_sidecar import discover


IDENTITY = "https://api.discogs.com/oauth/identity"


def _want(discogs_id=9226618, title="Aline Brooklyn 001 ", artists=None,
          labels=None, formats=None, year=2016, master_id=0, notes=""):
    return {
        "id": discogs_id,
        "date_added": "2025-06-12T16:17:31-07:00",
        "rating": 0,
        "notes": notes,
        "basic_information": {
            "id": discogs_id,
            "master_id": master_id,
            "title": title,
            "year": year,
            "artists": artists if artists is not None else [
                {"name": "Aline Brooklyn", "anv": "", "join": ""},
            ],
            "labels": labels if labels is not None else [
                {"name": "Aline Brooklyn", "catno": "ALN 001"},
            ],
            "formats": formats if formats is not None else [
                {"name": "Vinyl", "qty": "1", "descriptions": ["12\""]},
            ],
        },
    }


def _page(wants, page=1, pages=1, items=None):
    return {
        "pagination": {
            "page": page, "pages": pages,
            "per_page": 100, "items": items if items is not None else len(wants),
            "urls": {},
        },
        "wants": wants,
    }


def _server(pages_map, username="a-collector"):
    """A fetch_json that answers identity and the wantlist pages.

    Crucially it raises DiscoverError("not found") for a page beyond the end,
    because that is what the real endpoint does — `_fetch` turns Discogs'
    HTTP 404 into exactly that.
    """
    calls = []

    def fetch(url, headers=None, gate=None):
        calls.append(url)
        if url.startswith(IDENTITY):
            return {"username": username, "id": 1, "resource_url": ""}
        page = 1
        if "page=" in url:
            page = int(url.split("page=")[1].split("&")[0])
        if page not in pages_map:
            raise discover.DiscoverError("not found")
        return pages_map[page]

    fetch.calls = calls
    return fetch


# ------------------------------------------------------------------ identity


def test_the_username_comes_from_the_token():
    """The user never has to know or type their own Discogs username, and so
    cannot get it wrong."""
    fetch = _server({1: _page([_want()])})
    out = discover.wantlist("tok", fetch_json=fetch)
    assert out["username"] == "a-collector"
    assert any(url.startswith(IDENTITY) for url in fetch.calls)
    assert "a-collector" in fetch.calls[-1]


def test_no_token_is_refused_with_what_is_needed():
    with pytest.raises(discover.DiscoverError) as error:
        discover.wantlist("", fetch_json=lambda *a, **k: {})
    assert error.value.needs == "discogsToken"


def test_a_token_that_names_nobody_is_an_error_not_an_empty_username():
    fetch = _server({1: _page([])}, username="")
    with pytest.raises(discover.DiscoverError):
        discover.wantlist("tok", fetch_json=fetch)


# --------------------------------------------------------------- pagination


def test_reads_a_single_page_wantlist():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(), _want(2)])}))
    assert len(out["items"]) == 2
    assert out["total"] == 2
    assert out["complete"] is True


def test_walks_every_page():
    pages = {
        1: _page([_want(1)], page=1, pages=3, items=3),
        2: _page([_want(2)], page=2, pages=3, items=3),
        3: _page([_want(3)], page=3, pages=3, items=3),
    }
    out = discover.wantlist("tok", fetch_json=_server(pages))
    assert [i["discogsId"] for i in out["items"]] == [1, 2, 3]
    assert out["total"] == 3


def test_it_stops_on_pages_rather_than_on_an_empty_list():
    """THE TRAP. A page past the last one answers HTTP 404, which `_fetch`
    turns into DiscoverError — so a loop reading until `wants` comes back
    empty does not terminate, it raises. Measured against the live endpoint:
    a three-item list at per_page=1 gives pages 1-3, and page 4 is a 404.

    `_server` raises for any page not in the map, so this test fails loudly if
    the loop ever asks for one page too many.
    """
    pages = {
        1: _page([_want(1)], page=1, pages=2, items=2),
        2: _page([_want(2)], page=2, pages=2, items=2),
    }
    fetch = _server(pages)
    out = discover.wantlist("tok", fetch_json=fetch)
    assert len(out["items"]) == 2
    wantlist_calls = [c for c in fetch.calls if "/wants" in c]
    assert len(wantlist_calls) == 2, "asked for a page past the end"


def test_a_long_wantlist_is_reported_incomplete_rather_than_silently_cut():
    cap = discover.WANTLIST_MAX_PAGES
    pages = {
        n: _page([_want(n)], page=n, pages=cap + 5, items=cap + 5)
        for n in range(1, cap + 1)
    }
    out = discover.wantlist("tok", fetch_json=_server(pages))
    assert out["complete"] is False
    assert len(out["items"]) == cap


# --------------------------------------------------------------- field shapes


def test_a_trailing_space_in_a_title_is_trimmed():
    """Measured on a real entry: "Aline Brooklyn 001 "."""
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want()])}))
    assert out["items"][0]["title"] == "Aline Brooklyn 001"


def test_master_id_zero_becomes_null_rather_than_zero():
    """Discogs sends 0, not null, for a release with no master. Two of three
    real entries did. A literal 0 downstream is an id that resolves to
    nothing."""
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(master_id=0)])}))
    assert out["items"][0]["masterId"] is None

    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(master_id=4242)])}))
    assert out["items"][0]["masterId"] == 4242


def test_the_join_phrase_is_honoured():
    """Measured on a real release: Massive Attack `Vs` Burial. The join sits on
    the artist it FOLLOWS. Dropping it makes one collaboration two unrelated
    names, and searching Soulseek for "Massive Attack Burial" finds neither."""
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(artists=[
        {"name": "Massive Attack", "anv": "", "join": "Vs"},
        {"name": "Burial", "anv": "", "join": ""},
    ])])}))
    assert out["items"][0]["artist"] == "Massive Attack Vs Burial"


def test_a_discogs_disambiguator_is_stripped():
    """Measured: `Kahn (5)` & Neek. The number is a database artefact — nobody
    is credited that way, and it would poison the Soulseek query."""
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(artists=[
        {"name": "Kahn (5)", "anv": "", "join": "&"},
        {"name": "Neek", "anv": "", "join": ""},
    ])])}))
    assert out["items"][0]["artist"] == "Kahn & Neek"


def test_a_compilation_keeps_its_various_credit():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(
        artists=[{"name": "Various", "anv": "", "join": ""}])])}))
    assert out["items"][0]["artist"] == "Various"


def test_the_label_and_catalogue_number_come_through():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want()])}))
    item = out["items"][0]
    assert item["label"] == "Aline Brooklyn"
    assert item["catno"] == "ALN 001"
    assert item["format"] == "Vinyl"


def test_an_unlabelled_release_reports_empty_rather_than_failing():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([
        _want(labels=[], formats=[])])}))
    item = out["items"][0]
    assert item["label"] == ""
    assert item["catno"] == ""
    assert item["format"] == ""


def test_a_missing_year_is_null_never_zero():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(year=0)])}))
    assert out["items"][0]["year"] is None


def test_the_url_points_at_the_release_page():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([_want(discogs_id=184863)])}))
    assert out["items"][0]["url"] == "https://www.discogs.com/release/184863"


def test_the_users_own_note_is_carried():
    out = discover.wantlist("tok", fetch_json=_server({1: _page([
        _want(notes="  the repress, not the original  ")])}))
    assert out["items"][0]["notes"] == "the repress, not the original"


def test_a_row_with_neither_title_nor_artist_is_dropped():
    """Nothing could ever be searched for from one, and an entry that renders
    as a blank line is worse than one that is absent."""
    out = discover.wantlist("tok", fetch_json=_server({1: _page([
        _want(title="   ", artists=[]),
        _want(discogs_id=7, title="Real Record"),
    ])}))
    assert [i["discogsId"] for i in out["items"]] == [7]
