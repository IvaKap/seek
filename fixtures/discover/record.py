#!/usr/bin/env python3
# Seek — re-record the discovery fixtures from the real services.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
#   DISCOGS_TOKEN=... python3 fixtures/discover/record.py
#
# The fixtures beside this script are committed so `test_discover.py` never
# touches the network. They go stale when a provider changes shape — which is
# the whole point of `parse_bandcamp` being the fragile path — so this exists to
# refresh them in one command rather than by hand.
#
# THE TOKEN IS READ FROM THE ENVIRONMENT AND NEVER WRITTEN ANYWHERE. It is not
# in the recorded files, it is not in this script, and the Discogs request sends
# it as an Authorization header rather than a query parameter, so it does not
# reach any log or proxy along the way.

import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "Seek/0.1 (unofficial Nicotine+ fork; https://github.com/nicotine-plus/nicotine-plus )"

# Real, load-bearing choices:
#   the YouTube video is a plain fan upload, so its title carries the messy
#   `Artist, Title` shape the parser actually has to survive;
#   the Bandcamp album is a Hyperdub release on the artist's own subdomain,
#   which is how that label's catalogue is really laid out;
#   the Discogs release is the 2007 Untrue CD, which has a full tracklist with
#   durations and a catalogue number.
YOUTUBE_URL = "https://www.youtube.com/watch?v=8k_f2QK77ew"
BANDCAMP_URL = "https://timreaper.bandcamp.com/album/in-full-effect"
DISCOGS_RELEASE = 1125103
DISCOGS_LABEL = 25386          # Hyperdub
BANDCAMP_LABEL = "https://hyperdub.bandcamp.com/music"


def get(url, headers=None, accept="application/json"):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": accept, **(headers or {}),
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read()


def write(name, data):
    path = os.path.join(HERE, name)
    with open(path, "wb") as handle:
        handle.write(data)
    print(f"wrote {os.path.relpath(path)} ({len(data)} bytes)")


def record_youtube():
    endpoint = "https://www.youtube.com/oembed?" + urllib.parse.urlencode({
        "url": YOUTUBE_URL, "format": "json",
    })
    payload = json.loads(get(endpoint))
    write("youtube-oembed-burial.json",
          json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")


def record_bandcamp():
    """Store the structured-data block, not the whole 300 KB page.

    TRIMMED ON PURPOSE, and this is the one fixture that is not byte-for-byte
    what the server sent. The page is 300 KB of player markup around one script
    tag; keeping all of it would make the fixture unreadable in review and add
    nothing, because everything the parser reads is in that tag. The tag itself
    is verbatim, and the wrapper keeps the real `<script type=...>` form so the
    extraction regex is genuinely exercised.
    """
    html = get(BANDCAMP_URL, accept="text/html").decode("utf-8", errors="replace")
    match = re.search(
        r'<script[^>]+type="application/ld\+json"[^>]*>\s*(\{.*?\})\s*</script>',
        html, re.S | re.I,
    )
    if not match:
        sys.exit("no ld+json on the Bandcamp page — the scrape has broken, "
                 "which is exactly what test_discover.py's fallback covers")
    trimmed = (
        "<!-- TRIMMED by fixtures/discover/record.py: the ld+json block below is\n"
        f"     verbatim from {BANDCAMP_URL}\n"
        "     The surrounding 300 KB of player markup is omitted. -->\n"
        "<html><head>\n"
        '<script type="application/ld+json">\n'
        f"{match.group(1)}\n"
        "</script>\n</head><body></body></html>\n"
    )
    write("bandcamp-album-ld.html", trimmed.encode("utf-8"))


def record_discogs():
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    if not token:
        print("DISCOGS_TOKEN not set — skipping the Discogs fixture", file=sys.stderr)
        return
    payload = json.loads(get(
        f"https://api.discogs.com/releases/{DISCOGS_RELEASE}",
        headers={"Authorization": f"Discogs token={token}"},
    ))
    # Nothing here is secret — it is a public catalogue entry — but the response
    # carries per-user fields that have no business in a committed fixture.
    for key in ("num_for_sale", "lowest_price", "community", "estimated_weight"):
        payload.pop(key, None)
    write("discogs-release-burial-untrue.json",
          json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")


def record_discogs_label():
    """One page of a label discography, for the catalogue browser tests."""
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    if not token:
        print("DISCOGS_TOKEN not set — skipping the label fixture", file=sys.stderr)
        return
    payload = json.loads(get(
        f"https://api.discogs.com/labels/{DISCOGS_LABEL}/releases?page=1&per_page=25",
        headers={"Authorization": f"Discogs token={token}"},
    ))
    write("discogs-label-hyperdub.json",
          json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")


def record_bandcamp_label():
    """The label grid, trimmed to its one load-bearing attribute.

    Same trimming rationale as the album fixture: the page is 238 KB of markup
    around one JSON attribute, and that attribute is kept verbatim.
    """
    html = get(BANDCAMP_LABEL, accept="text/html").decode("utf-8", errors="replace")
    match = re.search(r'data-client-items="([^"]+)"', html)
    if not match:
        sys.exit("no data-client-items on the Bandcamp label page — the scrape "
                 "has broken, which test_discover.py's failure path covers")
    trimmed = (
        "<!-- TRIMMED by fixtures/discover/record.py: the data-client-items\n"
        f"     attribute below is verbatim from {BANDCAMP_LABEL} -->\n"
        # The REAL title and og tags, not a convenient invention: the page
        # titles itself "Music | Hyperdub", and a fixture that pretended
        # otherwise hid a bug where every label came out called "Music".
        '<html><head><title>Music | Hyperdub</title>\n'
        '<meta property="og:site_name" content="Hyperdub">\n'
        "</head><body>\n"
        f'<ol class="editable-grid" data-client-items="{match.group(1)}"></ol>\n'
        "</body></html>\n"
    )
    write("bandcamp-label-hyperdub.html", trimmed.encode("utf-8"))


if __name__ == "__main__":
    record_youtube()
    record_bandcamp()
    record_discogs()
    record_discogs_label()
    record_bandcamp_label()
