# Seek — the discovery layer's provider lookups.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# One job: given a URL the user pasted, ask the provider what it is and return
# RAW FACTS. This module does not decide what an artist is called. For Bandcamp
# and Discogs it does not have to — both return structured fields — and for
# YouTube it must not, because YouTube supplies one free-text title written by
# whoever uploaded the video, and reading an artist out of that is a derivation.
# Derivations live in `app/src/domain/parseTitle.ts` (AGENTS.md, "the seam").
#
# WHY THIS LIVES IN THE SIDECAR, same three reasons as enrich.py. A webview
# cannot set a `User-Agent` (it is on fetch's forbidden-header list), Discogs
# wants a descriptive one and an `Authorization` header, and every one of these
# services rate-limits. It also keeps the Discogs token on the side of the seam
# that already owns it: the token never crosses the socket, in either direction.
#
# RATE LIMITS, and they are not guesses:
#   YouTube oEmbed  no documented limit and no key; Google does not meaningfully
#                   throttle it. Ungated.
#   Bandcamp        no API and therefore no documented limit. Gated at 1/sec
#                   anyway: we are reading their public pages as a guest, and
#                   behaving like one is how this keeps working.
#   Discogs         60 requests/minute authenticated. Gated at 1/sec, which is
#                   exactly that ceiling.
#
# NOTE ON BANDCAMP. `DISCOVERY.md` specifies an oEmbed endpoint that does not
# exist — see the long comment on `parse_bandcamp`. Its release pages carry
# schema.org structured data instead, which is more useful and more fragile.
#
# PRIVACY. Everything here is gated by the caller on `externalLookups`. Off means
# off, including the artwork thumbnail — see `_image_data_uri` for why the image
# is fetched here rather than linked for the webview to load.

import base64
import ipaddress
import json
import logging
import os
import re
import shutil
import sys
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from html import unescape

from .enrich import USER_AGENT, Gate

log = logging.getLogger("seek.discover")

YT_OEMBED = "https://www.youtube.com/oembed"
DISCOGS_API = "https://api.discogs.com"

TIMEOUT = 12
# A preview thumbnail. Anything larger is not a thumbnail, and the frame carrying
# it crosses a socket to be drawn at 48 points.
MAX_IMAGE_BYTES = 2 * 1024 * 1024

_bandcamp_gate = Gate(1.05)
_discogs_gate = Gate(1.05)


class DiscoverError(Exception):
    """A lookup failed. Carries the setting that would fix it, when one would."""

    def __init__(self, message, needs=""):
        super().__init__(message)
        self.needs = needs


# ----------------------------------------------------------------- transport

def _is_public_host(host):
    """Refuse loopback, link-local and private addresses.

    Only the providers' own endpoints are ever fetched by URL we constructed, so
    this guards the one input we take from someone else: the thumbnail URL out of
    a provider's JSON response. A response that points an image at
    `http://127.0.0.1:9000/` would otherwise have the sidecar make that request
    on its behalf.
    """
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        address = info[4][0]
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            return False
        if (parsed.is_private or parsed.is_loopback or parsed.is_link_local
                or parsed.is_reserved or parsed.is_multicast):
            return False
    return True


def _fetch(url, headers=None, gate=None, accept="application/json", data=None,
           read_errors=False):
    if gate is not None:
        gate.wait()
    # `data` makes it a POST. AcoustID's lookup takes a form body because a
    # fingerprint is several kilobytes and will not fit in a query string.
    request = urllib.request.Request(url, data=data, headers={
        "User-Agent": USER_AGENT,
        "Accept": accept,
        **(headers or {}),
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        # AcoustID answers a rejected key with HTTP 400 and puts the REASON in
        # the body. Discarding it turned "invalid API key" — which the user can
        # fix in thirty seconds — into an opaque "HTTP 400".
        if read_errors and 400 <= error.code < 500:
            try:
                return error.read(), error.headers.get("Content-Type", "")
            except Exception:                           # noqa: BLE001
                pass
        # 401/403 from Discogs means the token is missing or wrong, which is a
        # different thing from a URL that names nothing.
        if error.code in (401, 403):
            raise DiscoverError(f"HTTP {error.code}: not authorised") from error
        if error.code == 404:
            raise DiscoverError("not found") from error
        raise DiscoverError(f"HTTP {error.code}") from error
    except Exception as error:                          # noqa: BLE001 - network
        raise DiscoverError(str(error)) from error


def _fetch_json(url, headers=None, gate=None):
    body, _mime = _fetch(url, headers=headers, gate=gate)
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise DiscoverError("malformed JSON response") from error
    if not isinstance(payload, dict):
        raise DiscoverError("response was not an object")
    return payload


# A release page is HTML and can be large. Cap it: we want one script tag near
# the top, not an unbounded read from a host we do not control.
MAX_PAGE_BYTES = 4 * 1024 * 1024


def _fetch_page(url):
    """Fetch a page the USER supplied, rather than an endpoint we constructed.

    This is the only place that happens, and it is why `_is_public_host` exists:
    without it, pasting `http://127.0.0.1:9000/` into the search field would have
    the sidecar make that request against the user's own machine and report what
    came back.
    """
    parsed = urllib.parse.urlparse(url)
    if not _is_public_host(parsed.hostname):
        raise DiscoverError("refusing to fetch a non-public address")
    body, _mime = _fetch(url, gate=_bandcamp_gate,
                         accept="text/html,application/xhtml+xml")
    if len(body) > MAX_PAGE_BYTES:
        body = body[:MAX_PAGE_BYTES]
    return body.decode("utf-8", errors="replace")


def _image_data_uri(url):
    """Fetch a thumbnail and inline it, or return None.

    The frontend could put this URL straight in an `<img>`, and that is exactly
    why it does not: a webview loading `i.ytimg.com` is the FRONTEND making a
    third-party request. It would leak the user's IP address to Google whether or
    not external lookups are switched on, and the whole point of that switch is
    that off means off. Inlining costs one small request on a worker thread that
    is already doing one.
    """
    if not url:
        return None
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if parsed.scheme != "https" or not _is_public_host(parsed.hostname):
        log.debug("refusing thumbnail from %s", url)
        return None
    try:
        data, mime = _fetch(url, accept="image/*")
    except DiscoverError as error:
        # A missing thumbnail is an ordinary outcome, not a failure worth
        # surfacing: the card has a placeholder for exactly this.
        log.debug("thumbnail fetch failed for %s: %s", url, error)
        return None
    if not data or len(data) > MAX_IMAGE_BYTES:
        return None
    if not (mime or "").startswith("image/"):
        mime = "image/jpeg"
    return "data:%s;base64,%s" % (mime.split(";")[0], base64.b64encode(data).decode("ascii"))


# ------------------------------------------------------------ classification

_YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com",
             "music.youtube.com", "youtu.be", "www.youtu.be"}
_DISCOGS_HOSTS = {"discogs.com", "www.discogs.com", "api.discogs.com"}
_DISCOGS_PATH = re.compile(r"/(release|master|artist|label)/(\d+)")
_DISCOGS_KIND = {"release": "release", "master": "release",
                 "artist": "artist", "label": "label"}


def provider_for(url):
    """Which provider a URL looks like, from its shape alone.

    None means "unrecognised host", which is NOT the same as "not music":
    Bandcamp custom domains are ordinary domains, and the only way to find out is
    to ask Bandcamp. The caller tries the Bandcamp endpoint for these.
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    if host in _YT_HOSTS:
        return "youtube"
    if host in _DISCOGS_HOSTS:
        return "discogs"
    if host == "bandcamp.com" or host.endswith(".bandcamp.com"):
        return "bandcamp"
    return None


def _blank(url, source_kind, kind="track"):
    """Every field the wire expects, all empty. Emitters fill what they know."""
    return {
        "requestId": "", "url": url, "sourceKind": source_kind, "kind": kind,
        "rawTitle": "", "channel": "", "artist": "", "title": "",
        "album": None, "year": None, "label": None, "catalogNumber": None,
        "artworkUri": None, "duration": None, "genres": [], "tracklist": [],
        "providerUrl": None,
    }


# ------------------------------------------------------------------- youtube

def _youtube_oembed_url(url):
    """Normalise to the /watch form the oEmbed endpoint actually accepts.

    `youtu.be/ID` and `music.youtube.com/watch?v=ID` are both real URLs a user
    will paste and neither is reliably answered by oEmbed as-is.
    """
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    video_id = ""
    if host in ("youtu.be", "www.youtu.be"):
        video_id = parsed.path.lstrip("/").split("/")[0]
    else:
        query = urllib.parse.parse_qs(parsed.query)
        video_id = (query.get("v") or [""])[0]
        if not video_id and parsed.path.startswith(("/shorts/", "/live/", "/embed/")):
            video_id = parsed.path.split("/")[2] if len(parsed.path.split("/")) > 2 else ""
    if not video_id:
        # A playlist URL with no video, or something unrecognised. Hand the URL
        # over untouched and let oEmbed decide.
        return url
    return f"https://www.youtube.com/watch?v={video_id}"


def parse_youtube(url, fetch_json=None, fetch_image=None):
    """YouTube oEmbed. No key required.

    Returns `rawTitle` and `channel` and nothing derived. `artist` and `title`
    stay empty on purpose: this is the provider that cannot answer them.
    """
    fetch_json = fetch_json or _fetch_json
    fetch_image = fetch_image or _image_data_uri

    target = _youtube_oembed_url(url)
    endpoint = "%s?%s" % (YT_OEMBED, urllib.parse.urlencode({
        "url": target, "format": "json",
    }))
    payload = fetch_json(endpoint)

    out = _blank(url, "youtube", "track")
    out["rawTitle"] = str(payload.get("title") or "")
    out["channel"] = str(payload.get("author_name") or "")
    out["artworkUri"] = fetch_image(payload.get("thumbnail_url"))
    if not out["rawTitle"]:
        raise DiscoverError("oEmbed returned no title")
    return out


# ------------------------------------------------------------------ bandcamp

_LD_JSON = re.compile(
    r'<script[^>]+type="application/ld\+json"[^>]*>\s*(\{.*?\})\s*</script>',
    re.S | re.I,
)
# Bandcamp writes durations as `P00H06M35S` — ISO 8601 without the `T`, which
# no standard parser accepts. Read it directly rather than pretending it is ISO.
_BC_DURATION = re.compile(r"^P(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$", re.I)


def _bc_duration(text):
    match = _BC_DURATION.match(str(text or "").strip())
    if not match:
        return None
    hours, minutes, seconds = (match.group(i) for i in (1, 2, 3))
    total = int(hours or 0) * 3600 + int(minutes or 0) * 60 + int(float(seconds or 0))
    return total or None


def _bc_name(value):
    """schema.org fields are a string or an object with a `name`."""
    if isinstance(value, dict):
        return str(value.get("name") or "").strip()
    if isinstance(value, list) and value:
        return _bc_name(value[0])
    return str(value or "").strip()


def parse_bandcamp(url, fetch_text=None, fetch_image=None):
    """Bandcamp, from the page's schema.org structured data.

    THE BRIEF IS WRONG ABOUT THIS ONE. `DISCOVERY.md` specifies an oEmbed
    endpoint at `bandcamp.com/api/oembed/1`; there is no such endpoint. Probed
    2026-08-17: `/api/oembed` answers `{"error":"bad version"}` and every
    `/api/oembed/1*` form answers `{"error":"bad function"}`, for valid and
    invalid target URLs alike. Bandcamp has no public oEmbed.

    What every release page does carry is one `application/ld+json` block of
    schema.org `MusicAlbum` or `MusicRecording`, and it is strictly better than
    oEmbed would have been: artist, title, label, release date, artwork AND the
    full tracklist with durations, in a single request. That makes the album
    tracklist a Phase D1 fact rather than the D4 follow-up the brief planned.

    THIS IS THE FRAGILE PATH, and it is fragile in the way the brief warned
    about for Bandcamp scraping: it is a public HTML page, not an API, and
    Bandcamp can change it whenever they like. So it is isolated here behind one
    function, it never raises past `DiscoverError`, and a page whose shape we no
    longer recognise degrades to the OpenGraph title rather than to nothing.
    """
    fetch_text = fetch_text or _fetch_page
    fetch_image = fetch_image or _image_data_uri

    html = fetch_text(url)
    path = (urllib.parse.urlparse(url).path or "").lower()

    # A catalogue page, not a record: `label.bandcamp.com/music` and the bare
    # domain both list a whole roster. These carry no MusicAlbum block at all,
    # so they have to be recognised before looking for one — otherwise a label
    # front page parses as a nameless "track" and the card offers to search
    # Soulseek for it.
    #
    # Reported as a 'label' whether or not it is one. Bandcamp does not
    # distinguish: an artist page and a label page are both "bands" to it, and
    # the useful action is identical either way. The card words it as
    # "catalogue" for this provider rather than asserting which it is.
    if path in ("", "/", "/music", "/merch", "/community"):
        out = _blank(url, "bandcamp", "label")
        name = _bc_catalogue_name(html, url)
        out["rawTitle"] = name
        out["title"] = name
        out["providerUrl"] = url
        return out

    data = None
    for match in _LD_JSON.finditer(html):
        try:
            candidate = json.loads(match.group(1))
        except ValueError:
            continue
        if isinstance(candidate, dict) and candidate.get("@type") in (
            "MusicAlbum", "MusicRecording", "MusicGroup",
        ):
            data = candidate
            break

    if data is None:
        return _bandcamp_from_opengraph(url, html, path, fetch_image)

    entity = str(data.get("@type") or "")
    kind = "release" if entity == "MusicAlbum" else (
        "artist" if entity == "MusicGroup" else "track"
    )
    out = _blank(url, "bandcamp", kind)
    out["rawTitle"] = _bc_name(data.get("name"))
    out["title"] = out["rawTitle"]
    out["artist"] = _bc_name(data.get("byArtist"))
    out["providerUrl"] = str(data.get("@id") or "") or None
    out["label"] = _bc_name(data.get("publisher")) or None

    published = str(data.get("datePublished") or "")
    year = re.search(r"\b((?:19|20)\d{2})\b", published)
    out["year"] = int(year.group(1)) if year else None

    if kind == "release":
        out["album"] = out["title"]
        listing = (data.get("track") or {})
        items = listing.get("itemListElement") if isinstance(listing, dict) else None
        for element in items or []:
            item = element.get("item") or {}
            out["tracklist"].append({
                "position": int(element.get("position") or 0),
                "title": _bc_name(item.get("name")),
                "artist": _bc_name(item.get("byArtist")),
                "duration": _bc_duration(item.get("duration")),
            })
    elif kind == "track":
        out["album"] = _bc_name(data.get("inAlbum")) or None
        out["duration"] = _bc_duration(data.get("duration"))

    image = data.get("image")
    out["artworkUri"] = fetch_image(image if isinstance(image, str) else _bc_name(image))
    return out


_OG = re.compile(r'<meta[^>]+property="og:([a-z_:]+)"[^>]+content="([^"]*)"', re.I)


def _bandcamp_from_opengraph(url, html, path, fetch_image):
    """Last resort when the structured data is gone or has changed shape.

    OpenGraph gives a title of the form `Album | Artist` and an image, which is
    enough for the preview card to show something true. It gives no tracklist,
    and pretending otherwise would be worse than admitting it.
    """
    tags = {key.lower(): value for key, value in _OG.findall(html)}
    title = tags.get("title", "").strip()
    if not title:
        raise DiscoverError("no Bandcamp metadata on this page")

    kind = "release" if "/album/" in path else "track"
    out = _blank(url, "bandcamp", kind)
    out["rawTitle"] = title
    # `Album | Artist` — but leave the split to the frontend parser rather than
    # inventing a second title grammar down here.
    out["providerUrl"] = tags.get("url") or None
    out["artworkUri"] = fetch_image(tags.get("image"))
    log.info("bandcamp structured data missing for %s; fell back to OpenGraph", url)
    return out


# ------------------------------------------------------------------- discogs

def _strip_disambiguator(name):
    """Discogs numbers same-named artists: `Burial (2)`. That is a database
    artefact, not how anyone is credited, and it would poison a search query."""
    return re.sub(r"\s*\(\d+\)$", "", str(name or "").strip())


def _discogs_credit(entity):
    """Join Discogs' artist array, honouring its join phrases.

    `[{name: A, join: "&"}, {name: B}]` is the credit "A & B". Dropping the join
    would turn a collaboration into two unrelated names, and searching Soulseek
    for "A B" finds neither.
    """
    text = ""
    for artist in entity.get("artists") or []:
        name = _strip_disambiguator(artist.get("name"))
        if not name:
            continue
        if text:
            text += " "
        text += name
        join = str(artist.get("join") or "").strip()
        if join:
            # A comma sits tight against the name it follows; a word does not.
            text += join if join in (",", ";") else f" {join}"
    # A trailing join with nothing after it is Discogs data being untidy.
    return re.sub(r"\s+", " ", text).strip().strip(" ,;&/").strip()


def _duration_seconds(text):
    """`3:45` or `1:02:03` to seconds. None when Discogs left it blank."""
    text = str(text or "").strip()
    if not text or not re.fullmatch(r"\d{1,2}(:\d{2}){1,2}", text):
        return None
    parts = [int(p) for p in text.split(":")]
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + part
    return seconds or None


def _discogs_tracklist(payload):
    out = []
    for entry in payload.get("tracklist") or []:
        # Headings and index tracks have no position and are not tracks.
        if str(entry.get("type_") or "track") != "track":
            continue
        position = str(entry.get("position") or "")
        number = re.search(r"\d+", position)
        out.append({
            "position": int(number.group()) if number else 0,
            "title": str(entry.get("title") or ""),
            "artist": _discogs_credit(entry),
            "duration": _duration_seconds(entry.get("duration")),
        })
    return out


def parse_discogs(url, token, fetch_json=None, fetch_image=None):
    """Discogs release/master/artist/label. Requires the personal access token.

    The token goes in an `Authorization` header, never a query parameter: a
    credential in a URL ends up in every log and proxy between here and there.
    """
    fetch_json = fetch_json or _fetch_json
    fetch_image = fetch_image or _image_data_uri

    match = _DISCOGS_PATH.search(urllib.parse.urlparse(url).path or "")
    if not match:
        raise DiscoverError("not a Discogs release, master, artist or label URL")
    entity, entity_id = match.group(1), match.group(2)

    if not token:
        raise DiscoverError("a Discogs personal access token is required",
                            needs="discogsToken")

    endpoint = {
        "release": f"{DISCOGS_API}/releases/{entity_id}",
        "master": f"{DISCOGS_API}/masters/{entity_id}",
        "artist": f"{DISCOGS_API}/artists/{entity_id}",
        "label": f"{DISCOGS_API}/labels/{entity_id}",
    }[entity]
    payload = fetch_json(
        endpoint,
        headers={"Authorization": f"Discogs token={token}"},
        gate=_discogs_gate,
    )

    kind = _DISCOGS_KIND[entity]
    out = _blank(url, "discogs", kind)
    out["providerUrl"] = payload.get("uri") or None

    if kind in ("artist", "label"):
        # Nothing to search for yet — this is a catalogue, and browsing it is
        # Phase D4. Name it correctly so the card can offer the right action.
        name = re.sub(r"\s*\(\d+\)$", "", str(payload.get("name") or ""))
        out["rawTitle"] = name
        out["artist"] = name if kind == "artist" else ""
        out["title"] = name
        images = payload.get("images") or []
        out["artworkUri"] = fetch_image(
            (images[0].get("uri150") or images[0].get("uri")) if images else None
        )
        return out

    title = str(payload.get("title") or "")
    out["rawTitle"] = title
    out["title"] = title
    out["album"] = title
    out["artist"] = _discogs_credit(payload)
    year = payload.get("year")
    out["year"] = int(year) if isinstance(year, int) and year > 0 else None

    labels = payload.get("labels") or []
    if labels:
        out["label"] = re.sub(r"\s*\(\d+\)$", "",
                              str(labels[0].get("name") or "")) or None
        out["catalogNumber"] = str(labels[0].get("catno") or "") or None

    # Genres first, then styles: Discogs' genres are broad ("Electronic") and its
    # styles are the useful ones ("Dubstep", "Future Jazz"). Order is meaning.
    out["genres"] = [str(g) for g in (payload.get("genres") or [])] \
        + [str(s) for s in (payload.get("styles") or [])]
    out["tracklist"] = _discogs_tracklist(payload)

    images = payload.get("images") or []
    thumb = None
    if images:
        thumb = images[0].get("uri150") or images[0].get("uri")
    out["artworkUri"] = fetch_image(thumb or payload.get("thumb"))
    return out


# ------------------------------------------------------------ fingerprinting

ACOUSTID_LOOKUP = "https://api.acoustid.org/v2/lookup"
# AcoustID matches on the opening of a track. Two minutes is what their own
# tooling submits, and decoding more is time spent for nothing.
FINGERPRINT_SECONDS = 120
# One request per second, matching every other service here. AcoustID document
# no hard limit, which is not the same as not having one.
_acoustid_gate = Gate(1.05)

# chromaprint's CLI. Looked up rather than assumed on PATH: the sidecar runs
# from a GUI-launched app whose PATH is not a login shell's, and Homebrew's
# prefix differs between Apple silicon and Intel.
FPCALC_CANDIDATES = (
    "fpcalc",
    "/opt/homebrew/bin/fpcalc",
    "/usr/local/bin/fpcalc",
    "/usr/bin/fpcalc",
)


def _bundled_fpcalc():
    """A copy shipped beside the frozen sidecar, for a machine without Homebrew.

    Nothing ships one yet, and the reason is worth recording: Homebrew's
    `fpcalc` is NOT portable. `otool -L` on it lists
    `@rpath/libchromaprint.1.dylib` plus four Homebrew ffmpeg dylibs
    (libavformat, libavcodec, libavutil, libswresample), so copying the binary
    alone produces something that dies on any machine without an identical
    Homebrew tree. Shipping it means either relocating that whole dylib set
    with install_name_tool, or taking the statically linked build from
    acoustid.org — which is a licensing and supply-chain decision, not a
    packaging detail, so it is deliberately left to a human.

    This lookup exists so that when such a binary IS added, dropping it beside
    the frozen sidecar is all that is required.
    """
    if not getattr(sys, "frozen", False):
        return None
    beside = os.path.join(os.path.dirname(sys.executable), "fpcalc")
    if os.path.isfile(beside) and os.access(beside, os.X_OK):
        return beside
    return None


def fpcalc_path():
    """Where `fpcalc` is, or None. None means the feature is unavailable."""
    bundled = _bundled_fpcalc()
    if bundled:
        return bundled
    for candidate in FPCALC_CANDIDATES:
        found = shutil.which(candidate) if os.sep not in candidate else (
            candidate if os.path.isfile(candidate) and os.access(candidate, os.X_OK)
            else None
        )
        if found:
            return found
    return None


def fingerprint(path, seconds=FINGERPRINT_SECONDS, binary=None):
    """Acoustic fingerprint of a local file. Returns (duration, fingerprint).

    Shells out to `fpcalc` rather than binding libchromaprint through
    pyacoustid. One fewer dependency, no native extension to build, and the
    thing that has to be shipped is a single binary rather than a Python
    package plus a C library — which is the difference between this being
    bundleable later and not.
    """
    binary = binary or fpcalc_path()
    if not binary:
        raise DiscoverError(
            "fpcalc is not installed — Seek needs chromaprint to fingerprint audio",
            needs="fpcalc",
        )
    if not os.path.isfile(path):
        raise DiscoverError(f"no such file: {path}")

    try:
        proc = subprocess.run(
            [binary, "-json", "-length", str(int(seconds)), path],
            capture_output=True, timeout=90, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DiscoverError(f"fpcalc failed: {error}") from error
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise DiscoverError(f"fpcalc failed: {detail[-1] if detail else proc.returncode}")

    try:
        payload = json.loads(proc.stdout)
        return float(payload["duration"]), str(payload["fingerprint"])
    except (ValueError, KeyError) as error:
        raise DiscoverError("fpcalc produced nothing readable") from error


def _acoustid_best(payload):
    """The highest-scoring result that actually carries a recording."""
    best = None
    for result in payload.get("results") or []:
        recordings = result.get("recordings") or []
        if not recordings:
            continue
        score = float(result.get("score") or 0)
        if best is None or score > best[0]:
            best = (score, recordings[0])
    return best


def identify(path, api_key, seconds=FINGERPRINT_SECONDS,
             fingerprinter=None, fetch=None):
    """Fingerprint a file and ask AcoustID what it is.

    Verified end to end against the live service: a local FLAC fingerprinted
    with fpcalc 1.6.1 came back as Apparat — "Sayulita" at score 1.0, with five
    recordings and their release groups attached.
    """
    fingerprinter = fingerprinter or fingerprint
    fetch = fetch or _fetch

    if not api_key:
        raise DiscoverError("an AcoustID application key is required",
                            needs="acoustidApiKey")

    duration, printed = fingerprinter(path, seconds)
    body = urllib.parse.urlencode({
        "client": api_key,
        "duration": str(int(duration)),
        "fingerprint": printed,
        # SPACE-separated, not `+`-separated. urlencode turns a literal `+`
        # into `%2B`, which AcoustID reads as part of the value rather than as
        # a separator — so it silently returned the match with NO metadata
        # attached and this reported "no match" on a score of 1.0. A space
        # encodes to `+` on the wire, which is what it wants.
        "meta": "recordings releasegroups",
    }).encode("ascii")

    _acoustid_gate.wait()
    raw, _mime = fetch(ACOUSTID_LOOKUP, data=body, read_errors=True)
    try:
        payload = json.loads(raw)
    except ValueError as error:
        raise DiscoverError("malformed AcoustID response") from error

    if payload.get("status") != "ok":
        detail = (payload.get("error") or {}).get("message") or "lookup failed"
        # A rejected key is a configuration problem, not a missing record, and
        # the UI needs to tell those apart to say anything useful.
        needs = "acoustidApiKey" if "key" in detail.lower() else ""
        raise DiscoverError(f"AcoustID: {detail}", needs=needs)

    blank = {
        "requestId": "", "path": path, "matched": False, "artist": "",
        "title": "", "album": None, "year": None, "mbid": None,
        "score": 0.0, "durationSeconds": duration,
    }

    best = _acoustid_best(payload)
    if best is None:
        # No match is the ORDINARY outcome for anything underground, and it is
        # reported as an answer rather than as an error.
        return blank

    score, recording = best
    groups = recording.get("releasegroups") or []
    artists = recording.get("artists") or []
    blank.update({
        "matched": True,
        "score": score,
        "artist": ", ".join(str(a.get("name") or "") for a in artists).strip(", "),
        "title": str(recording.get("title") or ""),
        "album": str(groups[0].get("title") or "") if groups else None,
        "mbid": str(recording.get("id") or "") or None,
    })
    return blank


# ----------------------------------------------------------------- related

def related(artist, release, label, discogs_token, fetch_json=None):
    """Music adjacent to one release.

    Deliberately built from the catalogue calls that already exist rather than
    a new endpoint: "more by this artist" and "more on this label" ARE
    discographies, and the useful answer to "what else is like this" for a
    label-driven collector is the label's other records.
    """
    fetch_json = fetch_json or _fetch_json
    out = {"requestId": "", "byArtist": [], "byLabel": [], "labelName": label or ""}
    if not discogs_token:
        raise DiscoverError("a Discogs personal access token is required",
                            needs="discogsToken")

    if artist:
        try:
            _n, _i, releases, _c = browse_discogs(
                "artist", None, artist, discogs_token, fetch_json,
            )
            out["byArtist"] = [
                r for r in releases
                if r["role"] in ("Main", "") and _fuzzy(r["title"]) != _fuzzy(release)
            ][:24]
        except DiscoverError as error:
            log.debug("related: no artist discography for %s: %s", artist, error)

    if label:
        try:
            name, _i, releases, _c = browse_discogs(
                "label", None, label, discogs_token, fetch_json,
            )
            out["labelName"] = name
            out["byLabel"] = [
                r for r in releases if _fuzzy(r["title"]) != _fuzzy(release)
            ][:24]
        except DiscoverError as error:
            log.debug("related: no label catalogue for %s: %s", label, error)

    return out


def _fuzzy(text):
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


# --------------------------------------------------------------- tracklists

# The description lives in the page's own JSON blob. `shortDescription`, which
# yt-dlp used for years and which DISCOVERY.md assumes, IS NO LONGER THERE —
# probed 2026-08-17 against a real watch page and it is absent; the text is
# under `attributedDescription.content` now. Both are tried, newest first,
# because this is the sort of thing that changes back.
_YT_DESCRIPTION = (
    re.compile(r'"attributedDescription":\{"content":"((?:[^"\\]|\\.)*)"'),
    re.compile(r'"shortDescription":"((?:[^"\\]|\\.)*)"'),
)
# Two shapes, because YouTube ships both depending on the page it feels like
# serving. The classic player response nests title and author inside
# `videoDetails`; the overlay renderer wraps them one level deeper. An
# unanchored `"videoDetails":\{.*?"title"` matched neither reliably — on a real
# page it walked past the object entirely and returned a localised VIEW COUNT.
_YT_TITLE = (
    re.compile(r'"videoDetails":\{"videoId":"[^"]*","title":"((?:[^"\\]|\\.)*)"'),
    re.compile(r'"playerOverlayVideoDetailsRenderer":\{"title":\{"simpleText":"((?:[^"\\]|\\.)*)"'),
)
_YT_AUTHOR = (
    re.compile(r'"videoDetails":\{"videoId":".*?"author":"((?:[^"\\]|\\.)*)"', re.S),
    re.compile(r'"playerOverlayVideoDetailsRenderer":\{.*?"subtitle":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"', re.S),
)


def _first_match(patterns, html):
    for pattern in patterns:
        found = pattern.search(html)
        if found:
            text = _json_string(found.group(1))
            if text:
                return text
    return ""

# `1:23:45`, `23:45`, `[23:45]`, `(23:45)`, optionally after a track number.
#
# TWO patterns rather than one with an optional seconds group. With the group
# optional, a line that is ONLY a timestamp backtracks: `1:15:00` fails to find
# the required trailing text, gives up the `:00`, and reports a track at 1m15s
# called "00". Matching hours-first and falling through is unambiguous.
_TS_PREFIX = r"^\s*(?:\d{1,3}[.)]\s*)?[\[(]?\s*"
_TS_SUFFIX = r"\s*[\])]?\s*[-–—.]?\s*(.*)$"
_TS_HMS = re.compile(_TS_PREFIX + r"(\d{1,3}):([0-5]\d):([0-5]\d)" + _TS_SUFFIX)
_TS_MS = re.compile(_TS_PREFIX + r"(\d{1,3}):([0-5]\d)" + _TS_SUFFIX)
# The tail of `00:00 - 02:03 New Creator`, once the start has been taken.
_TS_RANGE_END = re.compile(r"^\d{1,3}:[0-5]\d(?::[0-5]\d)?\s*[-–—.]?\s*(.+)$")


def _json_string(raw):
    """Decode one JSON string body without parsing the megabyte around it."""
    try:
        return json.loads(f'"{raw}"')
    except ValueError:
        return ""


def parse_tracklist(url, fetch_text=None):
    """Timestamped lines from a YouTube description.

    Deliberately does NOT split 'Burial - Archangel' into an artist and a
    title: that is `parseTitle.ts`'s job, tested against forty title shapes,
    and a second splitter here would be a second thing to get wrong.

    An empty result is the ORDINARY OUTCOME. Most videos have no tracklist,
    and the caller shows the video as a single entry rather than an error.
    """
    fetch_text = fetch_text or _fetch_page
    if provider_for(url) != "youtube":
        raise DiscoverError("not a YouTube URL")

    html = fetch_text(_youtube_oembed_url(url))

    description = ""
    for pattern in _YT_DESCRIPTION:
        found = pattern.search(html)
        if found:
            description = _json_string(found.group(1))
            if description:
                break


    lines = []
    for raw in description.split("\n"):
        match = _TS_HMS.match(raw)
        if match:
            offset = (int(match.group(1)) * 3600 + int(match.group(2)) * 60
                      + int(match.group(3)))
            text = match.group(4)
        else:
            match = _TS_MS.match(raw)
            if not match:
                continue
            offset = int(match.group(1)) * 60 + int(match.group(2))
            text = match.group(3)

        text = text.strip(" -–—·|")
        # `00:00 - 02:03 New Creator` is a time RANGE, and the end of it is not
        # part of the track's name. Seen in the wild on full-album uploads.
        range_end = _TS_RANGE_END.match(text)
        if range_end:
            text = range_end.group(1).strip(" -–—·|")
        if not text:
            continue
        # A line that is only a link is a chapter marker or a social link, not
        # a track. Descriptions are full of both.
        if re.match(r"^https?://\S+$", text):
            continue
        lines.append({
            "position": len(lines) + 1,
            "offsetSeconds": offset,
            "text": text[:300],
        })

    return {
        "requestId": "",
        "url": url,
        "videoTitle": _first_match(_YT_TITLE, html),
        "channel": _first_match(_YT_AUTHOR, html),
        "lines": lines,
    }


# ------------------------------------------------------------- catalogues

# Discogs pages at 100 per request and a big label has hundreds of records.
# Five pages is 500 releases, which is more than any label in this user's world
# and still only five seconds against the 1/sec gate. Past it the catalogue is
# reported INCOMPLETE rather than silently cut: a truncated list that claims to
# be whole hides exactly the records you were digging for.
DISCOGS_PER_PAGE = 100
DISCOGS_MAX_PAGES = 5


def _discogs_auth(token):
    if not token:
        raise DiscoverError("a Discogs personal access token is required",
                            needs="discogsToken")
    return {"Authorization": f"Discogs token={token}"}


def _resembles(asked, offered):
    """Is what Discogs returned plausibly what we asked for?

    Discogs' search is fuzzy and ALWAYS returns something. Asking it for
    "A. Aural Imbalance" — a name a path parser produced — came back with
    Donald Wilborn, and taking `results[0]` on trust put thirty of his records
    under a heading saying "More by A. Aural Imbalance". A confidently wrong
    answer is the one thing this app must not produce, so a result has to look
    like the request or it does not count.
    """
    a, b = _fuzzy(asked), _fuzzy(offered)
    if not a or not b:
        return False
    # Containment either way: "Burial" matches "Burial", and asking for
    # "Aural Imbalance" should still accept "Aural Imbalance" with a suffix.
    return a in b or b in a


def discogs_find_id(kind, name, token, fetch_json=None):
    """Resolve a label or artist name to its Discogs id. One request."""
    fetch_json = fetch_json or _fetch_json
    query = urllib.parse.urlencode({"q": name, "type": kind, "per_page": 5})
    payload = fetch_json(f"{DISCOGS_API}/database/search?{query}",
                         headers=_discogs_auth(token), gate=_discogs_gate)
    for result in payload.get("results") or []:
        title = _strip_disambiguator(result.get("title"))
        if _resembles(name, title):
            return int(result.get("id") or 0), title
    raise DiscoverError(f"Discogs knows no {kind} that resembles {name!r}")


def _catalog_entry(raw, kind):
    """One row of either endpoint. They do NOT return the same fields.

    A label's releases carry a format and a catalogue number; an artist's carry
    a role and neither. Both are forwarded as they arrive — an empty string
    where the provider said nothing, rather than a guess.
    """
    entity = "master" if str(raw.get("type") or "") == "master" else "release"
    discogs_id = int(raw.get("id") or 0)
    return {
        "discogsId": discogs_id,
        "title": str(raw.get("title") or ""),
        "artist": _strip_disambiguator(
            # Discogs marks name variations with a trailing asterisk.
            str(raw.get("artist") or "").rstrip("*").strip()
        ),
        "year": int(raw["year"]) if isinstance(raw.get("year"), int) and raw["year"] else None,
        "format": str(raw.get("format") or "") if kind == "label" else "",
        "catno": str(raw.get("catno") or "") if kind == "label" else "",
        "role": str(raw.get("role") or "") if kind == "artist" else "",
        "url": f"https://www.discogs.com/{entity}/{discogs_id}",
    }


def browse_discogs(kind, entity_id, name, token, fetch_json=None):
    """A label's or an artist's whole discography, paginated.

    Returns (name, id, releases, complete).
    """
    fetch_json = fetch_json or _fetch_json
    headers = _discogs_auth(token)

    if not entity_id:
        if not name:
            raise DiscoverError("no id and no name to look up")
        entity_id, name = discogs_find_id(kind, name, token, fetch_json)
    if not name:
        detail = fetch_json(f"{DISCOGS_API}/{kind}s/{entity_id}",
                            headers=headers, gate=_discogs_gate)
        name = _strip_disambiguator(detail.get("name"))

    releases = []
    complete = True
    for page in range(1, DISCOGS_MAX_PAGES + 1):
        query = urllib.parse.urlencode({"page": page, "per_page": DISCOGS_PER_PAGE})
        payload = fetch_json(
            f"{DISCOGS_API}/{kind}s/{entity_id}/releases?{query}",
            headers=headers, gate=_discogs_gate,
        )
        for raw in payload.get("releases") or []:
            releases.append(_catalog_entry(raw, kind))

        pages = int((payload.get("pagination") or {}).get("pages") or 1)
        if page >= pages:
            break
        if page == DISCOGS_MAX_PAGES:
            complete = False

    return name, int(entity_id), releases, complete


# A wantlist is one person's own list rather than a whole discography, but a
# serious collector's runs to thousands. Same rule as the catalogue above:
# capped, and reported INCOMPLETE rather than silently cut.
WANTLIST_MAX_PAGES = 30


def discogs_identity(token, fetch_json=None):
    """Whose token this is.

    One request, and it removes the only piece of setup this feature would
    otherwise need: the user does not have to know or type their own Discogs
    username, and cannot get it wrong.
    """
    fetch_json = fetch_json or _fetch_json
    payload = fetch_json(f"{DISCOGS_API}/oauth/identity",
                         headers=_discogs_auth(token), gate=_discogs_gate)
    username = str(payload.get("username") or "").strip()
    if not username:
        raise DiscoverError("Discogs did not say who this token belongs to")
    return username


def _want_entry(raw):
    """One row of `/users/{u}/wants`.

    Everything here is what Discogs STATES about the release, forwarded as
    given — the same standing as `_catalog_entry`. The one assembly is the
    artist credit, and it is Discogs' own: the array carries the join phrases
    (`[{name: A, join: "Vs"}, {name: B}]` is "A Vs B"), so `_discogs_credit`
    is applying the provider's statement rather than deriving anything. Both
    of those measured on real releases — Massive Attack `Vs` Burial, and
    `Kahn (5)` & Neek, which is also why the disambiguator strip is needed.
    """
    info = raw.get("basic_information") or {}
    labels = info.get("labels") or []
    formats = info.get("formats") or []
    year = info.get("year")

    return {
        # Measured: `master_id` comes back as 0, not null, for a release with
        # no master. Two of three real entries were 0.
        "discogsId": int(info.get("id") or raw.get("id") or 0),
        "masterId": int(info.get("master_id") or 0) or None,
        # Measured: real titles carry trailing whitespace ("Aline Brooklyn 001 ").
        "title": str(info.get("title") or "").strip(),
        "artist": _discogs_credit(info),
        "year": int(year) if isinstance(year, int) and year else None,
        "label": _strip_disambiguator(str((labels[0] or {}).get("name") or "")) if labels else "",
        "catno": str((labels[0] or {}).get("catno") or "").strip() if labels else "",
        "format": str((formats[0] or {}).get("name") or "").strip() if formats else "",
        "url": f"https://www.discogs.com/release/{int(info.get('id') or 0)}",
        "addedAt": str(raw.get("date_added") or ""),
        "notes": str(raw.get("notes") or "").strip(),
    }


def wantlist(token, fetch_json=None):
    """The signed-in user's Discogs wantlist.

    Returns {"username", "items", "total", "complete"}.

    THE PAGINATION TRAP, measured rather than assumed: asking for a page PAST
    the last one returns **HTTP 404**, not an empty list. A loop that reads
    until `wants` comes back empty therefore does not terminate — it raises.
    `pagination.pages` is the terminator, and it is present and correct from
    the first response. (`pagination.urls` also drops its `next` key on the
    last page, which is a second signal, but `pages` is known up front and
    needs no key-presence check.)
    """
    fetch_json = fetch_json or _fetch_json
    headers = _discogs_auth(token)
    username = discogs_identity(token, fetch_json)

    items = []
    total = 0
    complete = True
    for page in range(1, WANTLIST_MAX_PAGES + 1):
        query = urllib.parse.urlencode({"page": page, "per_page": DISCOGS_PER_PAGE})
        payload = fetch_json(
            f"{DISCOGS_API}/users/{urllib.parse.quote(username)}/wants?{query}",
            headers=headers, gate=_discogs_gate,
        )
        for raw in payload.get("wants") or []:
            entry = _want_entry(raw)
            # A row with neither a title nor an artist is nothing a search
            # could ever be built from.
            if entry["title"] or entry["artist"]:
                items.append(entry)

        pagination = payload.get("pagination") or {}
        total = int(pagination.get("items") or len(items))
        pages = int(pagination.get("pages") or 1)
        if page >= pages:
            break
        if page == WANTLIST_MAX_PAGES:
            complete = False

    return {"username": username, "items": items, "total": total, "complete": complete}


_BC_ITEMS = re.compile(r'data-client-items="([^"]+)"')
_TITLE = re.compile(r"<title>([^<]*)</title>", re.I)


def _bc_catalogue_name(html, url):
    """What the catalogue is called.

    NOT the `<title>`, which on a Bandcamp catalogue page reads
    `Music | Hyperdub` — taking its first segment yields the word "Music" for
    every label on the site. `og:site_name` and `og:title` both carry the band
    name properly; the title tag is the last resort, and then its LAST segment.
    """
    tags = {key.lower(): value for key, value in _OG.findall(html)}
    name = (tags.get("site_name") or tags.get("title") or "").strip()
    if not name:
        title = _TITLE.search(html)
        if title:
            name = unescape(title.group(1)).split("|")[-1].strip()
    return unescape(name) or (urllib.parse.urlparse(url).hostname or "")


def browse_bandcamp(url, fetch_text=None):
    """A Bandcamp label's or artist's catalogue, from its /music page.

    THE FRAGILE PATH, as the brief warns. This is a public HTML page, not an
    API, and Bandcamp can change it whenever they like. It is isolated here
    behind one function, it raises nothing but DiscoverError, and it reports an
    empty catalogue rather than a wrong one.

    Probed 2026-08-17 against hyperdub.bandcamp.com/music: the grid is a JSON
    array in a `data-client-items` attribute, 205 entries, each carrying title,
    artist and page_url. No year and no catalogue number — Bandcamp does not
    publish either here, so those fields go out empty rather than invented.

    Note the catalogue legitimately contains the same record twice when two
    artists share it: Hyperdub lists 'Phoneglow / Eyes Go Blank' under both
    burial.bandcamp.com and kode9.bandcamp.com, and they are two real pages.
    Collapsing them would be a guess about what the user meant.
    """
    fetch_text = fetch_text or _fetch_page
    html = fetch_text(url)

    match = _BC_ITEMS.search(html)
    if not match:
        raise DiscoverError("no catalogue on this page — Bandcamp's markup may "
                            "have changed, or this is not a /music page")
    try:
        items = json.loads(unescape(match.group(1)))
    except ValueError as error:
        raise DiscoverError("catalogue JSON did not parse") from error
    if not isinstance(items, list):
        raise DiscoverError("catalogue was not a list")

    name = _bc_catalogue_name(html, url)

    releases = []
    for item in items:
        if not isinstance(item, dict):
            continue
        page = str(item.get("page_url") or "")
        if page.startswith("/"):
            base = urllib.parse.urlparse(url)
            page = f"{base.scheme}://{base.netloc}{page}"
        releases.append({
            "discogsId": 0,
            "title": str(item.get("title") or ""),
            "artist": str(item.get("artist") or ""),
            "year": None,
            "format": "",
            "catno": "",
            "role": "",
            # Drop the `?label=…&tab=music` tracking tail; it is not part of
            # the record's identity and it makes every URL look distinct.
            "url": page.split("?")[0],
        })
    return name, releases


def browse(source_kind, kind, entity_id=None, name=None, url=None,
           discogs_token="", fetch_json=None, fetch_text=None):
    """Fetch a discography from whichever provider owns it."""
    if kind not in ("label", "artist"):
        raise DiscoverError(f"cannot browse a {kind}")

    if source_kind == "discogs":
        found_name, found_id, releases, complete = browse_discogs(
            kind, entity_id, name, discogs_token, fetch_json,
        )
        return {
            "requestId": "", "sourceKind": "discogs", "kind": kind,
            "name": found_name, "id": found_id,
            "url": f"https://www.discogs.com/{kind}/{found_id}",
            "releases": releases, "complete": complete,
        }

    if source_kind == "bandcamp":
        if not url:
            raise DiscoverError("Bandcamp has no ids; a page URL is required")
        found_name, releases = browse_bandcamp(url, fetch_text)
        return {
            "requestId": "", "sourceKind": "bandcamp", "kind": kind,
            "name": found_name, "id": 0, "url": url,
            "releases": releases, "complete": True,
        }

    raise DiscoverError(f"cannot browse {source_kind}")


# -------------------------------------------------------------------- entry

def parse_url(url, discogs_token="", fetch_json=None, fetch_text=None,
              fetch_image=None):
    """Look a URL up with whichever provider owns it.

    An unrecognised host is tried as Bandcamp, because that is the only way a
    custom domain can identify itself — a label on its own domain serves the
    same page with the same structured data, and no host pattern can predict it.
    """
    url = (url or "").strip()
    if not url:
        raise DiscoverError("no URL given")
    scheme = urllib.parse.urlparse(url).scheme
    if scheme not in ("http", "https"):
        raise DiscoverError(f"unsupported scheme: {scheme or 'none'}")

    provider = provider_for(url)
    if provider == "youtube":
        return parse_youtube(url, fetch_json=fetch_json, fetch_image=fetch_image)
    if provider == "discogs":
        return parse_discogs(url, discogs_token, fetch_json=fetch_json,
                             fetch_image=fetch_image)
    if provider == "bandcamp":
        return parse_bandcamp(url, fetch_text=fetch_text, fetch_image=fetch_image)

    try:
        return parse_bandcamp(url, fetch_text=fetch_text, fetch_image=fetch_image)
    except DiscoverError as error:
        raise DiscoverError(f"no provider recognised this URL ({error})") from error


# --------------------------------------------------------------- youtube ----
#
# Reading a public playlist. Every shape below was MEASURED against the live
# youtube/v3 API rather than taken from documentation, because this project's
# record on guessed external shapes is unbroken and YouTube has already caused
# two of the failures (the description field moved, and an unanchored search
# for "title" returned a localised view count).
#
# Deliberately the simple API key and not the OAuth client YouTube also issues.
# OAuth reaches a user's PRIVATE data; a public playlist needs none of it, so
# Seek holds no client secret that could leak.

#: YouTube caps a page at 50 whatever you ask for. Measured: a 100-item
#: playlist returned 50 and a nextPageToken; a 13-item one returned 13 and NO
#: token at all — the key is absent, not null, so this code uses .get().
PLAYLIST_PAGE = 50

#: Stop after this many pages. A playlist can run to thousands, and the
#: want list is not the place to dump one; `complete` says when we stopped.
PLAYLIST_MAX_PAGES = 20

#: Titles YouTube uses for entries it will not serve. They still occupy a
#: position in the playlist. Documented behaviour, NOT confirmed live — no
#: sampled playlist contained one — so treat this branch as untested.
PLAYLIST_DEAD_TITLES = ("Deleted video", "Private video")


def playlist_items(playlist_id, api_key, fetch_json=None):
    """Every entry of a public playlist, as raw facts.

    Returns the payload for a `discover.playlistItems` event minus its
    requestId. Nothing here parses a title into artist and track: that guess
    belongs to `parseTitle.ts` on the other side of the seam.
    """
    if not playlist_id:
        raise DiscoverError("no playlist id")
    if not api_key:
        raise DiscoverError(
            "a YouTube Data API key is needed to read a playlist",
            needs="youtubeApiKey",
        )

    fetch = fetch_json or _fetch_json
    items = []
    total = 0
    token = ""
    complete = True

    for page in range(PLAYLIST_MAX_PAGES):
        params = {
            "part": "snippet,contentDetails",
            "playlistId": playlist_id,
            "maxResults": str(PLAYLIST_PAGE),
            "key": api_key,
        }
        if token:
            params["pageToken"] = token
        payload = fetch(
            "https://www.googleapis.com/youtube/v3/playlistItems?"
            + urllib.parse.urlencode(params)
        )

        # pageInfo.totalResults is the WHOLE playlist, not this page.
        total = int((payload.get("pageInfo") or {}).get("totalResults") or 0)

        for entry in payload.get("items") or []:
            snippet = entry.get("snippet") or {}
            details = entry.get("contentDetails") or {}
            title = str(snippet.get("title") or "")
            # The uploader, NOT snippet.channelTitle, which names whoever built
            # the playlist. Measured: the two differ, and only the uploader
            # tells you anything about the music.
            channel = str(snippet.get("videoOwnerChannelTitle") or "")
            items.append({
                "videoId": str(details.get("videoId") or ""),
                "title": title,
                "channel": channel,
                "position": int(snippet.get("position") or 0),
                "available": bool(channel) and title not in PLAYLIST_DEAD_TITLES,
            })

        token = str(payload.get("nextPageToken") or "")
        if not token:
            break
    else:
        # Fell out of the loop still holding a token: there is more playlist
        # than we were willing to fetch, and saying so is the whole point.
        complete = not token

    return {
        "playlistId": playlist_id,
        "items": items,
        "total": total,
        "complete": complete,
    }
