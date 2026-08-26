# Seek — artwork and metadata, from MusicBrainz and friends.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Soulseek transmits no artwork and no tags worth the name, so both have to be
# fetched. ONE release lookup serves both: matching (artist, release) against
# MusicBrainz yields an MBID, and that MBID gives the cover art AND the
# canonical track list. Doing it twice would double the request budget for the
# same answer.
#
# WHY THIS LIVES IN THE SIDECAR, not the frontend. MusicBrainz requires a
# descriptive User-Agent, and a browser cannot set that header — it is on the
# forbidden list, so `fetch` silently ignores it. A webview asking MusicBrainz
# directly is an anonymous client hammering a volunteer-run service, which is
# how applications get blocked. It also means the disk cache lives next to the
# process that owns durability.
#
# RATE LIMIT. MusicBrainz permits one request per second, averaged, and means
# it. Every call goes through a single global gate, and the cache is checked
# first so a second look at the same release costs nothing.
#
# PRIVACY. All of this talks to third parties, so it is gated on an explicit
# setting (`external_lookups`). Off means off: no lookup, no cache read that
# would imply one, no silent fallback.

import hashlib
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger("seek.enrich")

# MusicBrainz asks that applications identify themselves with contact details.
# This is a fork of a GPL client; naming it honestly is the price of using the
# service at all.
USER_AGENT = (
    "Seek/0.1 (unofficial Nicotine+ fork; "
    "https://github.com/nicotine-plus/nicotine-plus )"
)

MB_ROOT = "https://musicbrainz.org/ws/2"
CAA_ROOT = "https://coverartarchive.org"
DEEZER_ROOT = "https://api.deezer.com"

TIMEOUT = 12
MB_MIN_INTERVAL = 1.05          # seconds; slightly over 1/s to stay inside it
CACHE_CAP_BYTES = 500 * 1024 * 1024


class EnrichError(Exception):
    pass


class _Gate:
    """One request per interval, process-wide.

    A per-thread limiter would be no limiter at all: the point is the total rate
    seen by MusicBrainz, not the rate of any one caller.
    """

    def __init__(self, interval):
        self._interval = interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self):
        with self._lock:
            delta = time.monotonic() - self._last
            if delta < self._interval:
                time.sleep(self._interval - delta)
            self._last = time.monotonic()


_mb_gate = _Gate(MB_MIN_INTERVAL)

# Public alias. `discover.py` polls other people's services and needs the same
# process-wide limiter; a second implementation of "one request per interval"
# would be a second thing to get wrong.
Gate = _Gate


def _get(url, accept="application/json", gate=None):
    if gate is not None:
        gate.wait()
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": accept,
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise EnrichError("not found") from error
        raise EnrichError(f"HTTP {error.code}") from error
    except Exception as error:                       # noqa: BLE001 - network
        raise EnrichError(str(error)) from error


# ----------------------------------------------------------------- matching

_NOISE = re.compile(
    r"\b(remaster(ed)?|deluxe|expanded|explicit|bonus|reissue|mono|stereo|"
    r"web|vinyl|cd|flac|mp3|24bit|16bit|\d{3,4}kbps)\b",
    re.I,
)
_BRACKETS = re.compile(r"[\[(][^\])]*[\])]")
_PUNCT = re.compile(r"[^\w\s]+")


def normalise(text):
    """Strip the noise a folder name accumulates before it reaches MusicBrainz.

    `Burial - Untrue (2007) [FLAC 16-44]` and `Burial — Untrue [Remastered]`
    must hash to the same cache key and produce the same query, or the cache
    never hits and every rip is a fresh round trip.
    """
    if not text:
        return ""
    out = _BRACKETS.sub(" ", text)
    out = _NOISE.sub(" ", out)
    out = _PUNCT.sub(" ", out)
    return " ".join(out.lower().split())


def cache_key(artist, release):
    raw = f"{normalise(artist)}|{normalise(release)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


# -------------------------------------------------------------------- cache

class ArtCache:
    """Files on disk plus a small JSON index. LRU by last access.

    Deliberately not SQLite: this is a flat key -> bytes store with one eviction
    rule, and a database would be more moving parts for no benefit.
    """

    def __init__(self, folder, cap_bytes=CACHE_CAP_BYTES):
        self.folder = folder
        self.cap = cap_bytes
        self._lock = threading.Lock()
        os.makedirs(folder, exist_ok=True)

    def _index_path(self):
        return os.path.join(self.folder, "index.json")

    def _load(self):
        try:
            with open(self._index_path(), encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return {}

    def _save(self, index):
        try:
            with open(self._index_path(), "w", encoding="utf-8") as handle:
                json.dump(index, handle)
        except OSError:
            log.exception("could not write artwork cache index")

    def get(self, key):
        path = os.path.join(self.folder, f"{key}.img")
        if not os.path.isfile(path):
            return None
        with self._lock:
            index = self._load()
            entry = index.get(key)
            if entry is None:
                return None
            entry["used"] = time.time()
            index[key] = entry
            self._save(index)
        try:
            with open(path, "rb") as handle:
                return handle.read(), entry.get("mime", "image/jpeg")
        except OSError:
            return None

    def put(self, key, data, mime):
        path = os.path.join(self.folder, f"{key}.img")
        try:
            with open(path, "wb") as handle:
                handle.write(data)
        except OSError:
            log.exception("could not write artwork cache entry")
            return
        with self._lock:
            index = self._load()
            index[key] = {"size": len(data), "mime": mime, "used": time.time()}
            self._evict(index)
            self._save(index)

    def _evict(self, index):
        total = sum(e.get("size", 0) for e in index.values())
        if total <= self.cap:
            return
        # Oldest use first, until back under the cap.
        for key, _entry in sorted(index.items(), key=lambda kv: kv[1].get("used", 0)):
            if total <= self.cap:
                break
            total -= index[key].get("size", 0)
            index.pop(key, None)
            try:
                os.remove(os.path.join(self.folder, f"{key}.img"))
            except OSError:
                pass

    def get_meta(self, key):
        path = os.path.join(self.folder, f"{key}.json")
        try:
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return None

    def put_meta(self, key, summary):
        try:
            with open(os.path.join(self.folder, f"{key}.json"), "w",
                      encoding="utf-8") as handle:
                json.dump(summary, handle)
        except OSError:
            log.exception("could not write release summary")

    def stats(self):
        index = self._load()
        return {
            "entries": len(index),
            "bytes": sum(e.get("size", 0) for e in index.values()),
            "capBytes": self.cap,
        }

    def clear(self):
        with self._lock:
            index = self._load()
            for key in list(index):
                try:
                    os.remove(os.path.join(self.folder, f"{key}.img"))
                except OSError:
                    pass
            self._save({})


# ------------------------------------------------------------- musicbrainz

def mb_search_release(artist, release):
    """Best release-group match, or None. One request."""
    artist_q = normalise(artist)
    release_q = normalise(release)
    if not release_q:
        return None

    terms = f'release:"{release_q}"'
    if artist_q:
        terms += f' AND artist:"{artist_q}"'
    url = (
        f"{MB_ROOT}/release/?query={urllib.parse.quote(terms)}"
        "&fmt=json&limit=5"
    )
    body, _ = _get(url, gate=_mb_gate)
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise EnrichError("malformed MusicBrainz response") from error

    releases = payload.get("releases") or []
    if not releases:
        return None

    best = releases[0]
    # MusicBrainz scores 0-100. Below ~70 the match is usually a different
    # record that happens to share a word, and a confident wrong answer is
    # worse here than none at all.
    if int(best.get("score", 0)) < 70:
        return None
    return best


def mb_release_detail(mbid):
    """Full track list for a release. One request."""
    url = (
        f"{MB_ROOT}/release/{mbid}"
        "?inc=artist-credits+recordings+labels&fmt=json"
    )
    body, _ = _get(url, gate=_mb_gate)
    try:
        return json.loads(body)
    except ValueError as error:
        raise EnrichError("malformed MusicBrainz response") from error


def _credit(entity):
    parts = entity.get("artist-credit") or []
    out = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
        else:
            out.append(part.get("name") or (part.get("artist") or {}).get("name") or "")
            out.append(part.get("joinphrase") or "")
    return "".join(out).strip()


def release_summary(detail):
    """Flatten a MusicBrainz release into the fields we actually tag with."""
    media = detail.get("media") or []
    tracks = []
    for disc_index, medium in enumerate(media, start=1):
        for track in medium.get("tracks") or []:
            recording = track.get("recording") or {}
            tracks.append({
                "position": int(track.get("position") or 0),
                "disc": disc_index,
                "title": track.get("title") or recording.get("title") or "",
                "artist": _credit(track) or _credit(recording) or "",
                "lengthMs": int(track.get("length") or recording.get("length") or 0),
            })

    labels = [
        (info.get("label") or {}).get("name", "")
        for info in (detail.get("label-info") or [])
    ]
    return {
        "mbid": detail.get("id") or "",
        "title": detail.get("title") or "",
        "artist": _credit(detail),
        "date": detail.get("date") or "",
        "country": detail.get("country") or "",
        "label": next((l for l in labels if l), ""),
        "trackCount": len(tracks),
        "tracks": tracks,
    }


# ------------------------------------------------------------------ artwork

def caa_front(mbid, size=500):
    """Cover Art Archive front image. No key, but it 404s constantly."""
    url = f"{CAA_ROOT}/release/{mbid}/front-{size}"
    return _get(url, accept="image/*")


def deezer_cover(artist, release):
    """Deezer's public search. No key, fast, good on anything mainstream."""
    query = urllib.parse.quote(f"{normalise(artist)} {normalise(release)}".strip())
    if not query:
        raise EnrichError("nothing to search for")
    body, _ = _get(f"{DEEZER_ROOT}/search/album?q={query}&limit=1")
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise EnrichError("malformed Deezer response") from error
    data = payload.get("data") or []
    if not data:
        raise EnrichError("not found")
    url = data[0].get("cover_medium") or data[0].get("cover")
    if not url:
        raise EnrichError("no cover")
    return _get(url, accept="image/*")


def lookup_release(artist, release, cache):
    """Everything one release lookup can yield: cover art AND the track list.

    Returns (data, mime, source, summary). `summary` may be None when the art
    came from Deezer or when MusicBrainz had no confident match — a cover is
    not proof of a metadata match.

    The cascade only falls through on a miss, so a cache hit costs no requests
    and a MusicBrainz hit costs the two it actually needs. Splitting artwork
    and track-count into separate commands would have paid the 1/sec gate twice
    for a single answer.
    """
    key = cache_key(artist, release)
    hit = cache.get(key)
    if hit is not None:
        return hit[0], hit[1], "cache", cache.get_meta(key)

    summary = None
    try:
        match = mb_search_release(artist, release)
        if match:
            try:
                summary = release_summary(mb_release_detail(match["id"]))
                summary["score"] = int(match.get("score", 0))
                cache.put_meta(key, summary)
            except EnrichError as error:
                # Losing the track list must not lose the cover, but swallowing
                # this silently means completeness never appears and nobody can
                # tell why. MusicBrainz answers 503 when it is being hammered,
                # which is the usual cause.
                log.warning("release detail failed for %s - %s: %s",
                            artist, release, error)
                summary = None
            data, mime = caa_front(match["id"])
            cache.put(key, data, mime or "image/jpeg")
            return data, mime or "image/jpeg", "coverartarchive", summary
    except EnrichError as error:
        log.debug("MusicBrainz/CAA miss for %s - %s: %s", artist, release, error)

    data, mime = deezer_cover(artist, release)
    cache.put(key, data, mime or "image/jpeg")
    return data, mime or "image/jpeg", "deezer", summary


def fetch_artwork(artist, release, cache):
    """Artwork only, for callers that do not care about the track list."""
    data, mime, source, _summary = lookup_release(artist, release, cache)
    return data, mime, source


# ----------------------------------------------------------------- tagging

AUDIO_EXTENSIONS = {".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav",
                    ".aiff", ".aif", ".wv", ".ape"}

# Mutagen's "easy" key names, which are uniform across formats. Anything
# outside this set is format-specific and not worth the branching.
TAG_FIELDS = ("title", "artist", "album", "albumartist", "date",
              "tracknumber", "discnumber", "genre")


def read_tags(path):
    import mutagen                                    # local: optional dep

    audio = mutagen.File(path, easy=True)
    if audio is None:
        raise EnrichError("unsupported or unreadable audio file")
    out = {}
    for field in TAG_FIELDS:
        value = audio.get(field)
        out[field] = (value[0] if isinstance(value, list) and value else value) or ""
    return out


def write_tags(path, tags, art=None):
    """Apply tags, and optionally embed cover art.

    Only the keys present in `tags` are touched — a caller that wants to leave
    a field alone omits it, rather than passing an empty string and silently
    erasing what was there.
    """
    import mutagen
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3
    from mutagen.mp4 import MP4, MP4Cover

    audio = mutagen.File(path, easy=True)
    if audio is None:
        raise EnrichError("unsupported or unreadable audio file")
    for field, value in tags.items():
        if field in TAG_FIELDS and value:
            audio[field] = str(value)
    audio.save()

    if not art:
        return

    data, mime = art
    extension = os.path.splitext(path)[1].lower()
    try:
        if extension == ".flac":
            flac = FLAC(path)
            picture = Picture()
            picture.data = data
            picture.type = 3                          # front cover
            picture.mime = mime or "image/jpeg"
            flac.clear_pictures()
            flac.add_picture(picture)
            flac.save()
        elif extension == ".mp3":
            id3 = ID3(path)
            id3.delall("APIC")
            id3.add(APIC(encoding=3, mime=mime or "image/jpeg", type=3,
                         desc="Cover", data=data))
            id3.save(path)
        elif extension in (".m4a", ".aac"):
            mp4 = MP4(path)
            fmt = MP4Cover.FORMAT_PNG if "png" in (mime or "") else MP4Cover.FORMAT_JPEG
            mp4["covr"] = [MP4Cover(data, imageformat=fmt)]
            mp4.save()
        # Other formats: tags were written, art simply is not embeddable.
    except Exception as error:                        # noqa: BLE001
        raise EnrichError(f"could not embed artwork: {error}") from error


# Characters a filesystem, a DJ controller or a USB stick will object to.
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_component(text, fallback="Unknown"):
    """One path segment that is safe on any filesystem Rekordbox might see.

    Trailing dots and spaces are stripped because Windows silently drops them,
    which turns two distinct folders into one the moment a library moves.
    """
    cleaned = _UNSAFE.sub("_", str(text or "")).strip().strip(".")
    cleaned = " ".join(cleaned.split())
    return cleaned[:120] or fallback


def organised_path(root, summary, filename):
    """`root/Artist/Year - Album/filename`, with a year only when known."""
    artist = safe_component(summary.get("artist"), "Unknown Artist")
    album = safe_component(summary.get("title"), "Unknown Album")
    year = (summary.get("date") or "")[:4]
    folder = f"{year} - {album}" if year.isdigit() else album
    return os.path.join(root, artist, safe_component(folder, album), filename)


def propose_tags(path, summary, current):
    """Work out what SHOULD change, without changing anything.

    Matching is by track number within the release, falling back to a
    normalised title comparison, because a downloaded filename's number is
    usually right even when its title is a mess.
    """
    name = os.path.splitext(os.path.basename(path))[0]

    number = None
    match = re.match(r"\s*(\d{1,3})\b", name)
    if match:
        number = int(match.group(1))
    if number is None and current.get("tracknumber"):
        try:
            number = int(str(current["tracknumber"]).split("/")[0])
        except ValueError:
            number = None

    track = None
    if number:
        track = next((t for t in summary["tracks"] if t["position"] == number), None)
    if track is None:
        target = normalise(name)
        track = next(
            (t for t in summary["tracks"] if target and normalise(t["title"]) in target),
            None,
        )

    proposed = {
        "album": summary["title"],
        "albumartist": summary["artist"],
        "date": (summary["date"] or "")[:4],
    }
    if summary["label"]:
        proposed["label"] = summary["label"]
    if track:
        proposed["title"] = track["title"]
        proposed["artist"] = track["artist"] or summary["artist"]
        proposed["tracknumber"] = str(track["position"])
        proposed["discnumber"] = str(track["disc"])

    # Only report fields that would actually change; a diff full of no-ops is
    # a diff nobody reads.
    changes = {}
    for field, value in proposed.items():
        if not value:
            continue
        if str(current.get(field, "")).strip() != str(value).strip():
            changes[field] = value
    return proposed, changes, track is not None
