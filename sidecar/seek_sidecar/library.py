# Seek — what you already own.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The vision note §13: knowing the collection is what turns a downloader into a
# collection tool. Two things fall out of it immediately — "you already have
# this" while searching, and eventually "which releases am I missing".
#
# DESIGN NOTES.
#
# Tags first, path second. A downloaded file's tags are often wrong or absent
# (that is why the metadata repair exists), but when they are present they beat
# any guess from a filename. So read tags where cheap, and fall back to the
# folder/filename shape the rest of the app already parses.
#
# The index is a flat JSON file, not SQLite. It is a few MB for a large
# collection, written once per scan and read once at startup, and a database
# would be more moving parts for a workload with no queries beyond "is this key
# present".
#
# Scanning is IO-bound and can take minutes over a network volume, so it runs on
# a worker thread and reports progress. It must never block the protocol loop.

import json
import logging
import os
import re
import threading
import time

log = logging.getLogger("seek.library")

AUDIO_EXTENSIONS = {".flac", ".wav", ".wave", ".aiff", ".aif", ".alac", ".ape",
                    ".wv", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wma"}

# Folder noise, the same shapes the frontend's parser strips. Kept in step with
# enrich.normalise deliberately: a library key and an artwork cache key that
# disagree would mean "you have this" and the cover never lining up.
_BRACKETS = re.compile(r"[\[(][^\])]*[\])]")
_NOISE = re.compile(
    r"\b(remaster(ed)?|deluxe|expanded|explicit|bonus|reissue|mono|stereo|"
    r"web|vinyl|cd|flac|mp3|wav|aiff|24bit|16bit|\d{3,4}kbps|va)\b",
    re.I,
)
_PUNCT = re.compile(r"[^\w\s]+")
_TRACK_PREFIX = re.compile(r"^\s*(?:[a-d]?\d{1,3})\s*[-._)\]]+\s*", re.I)


def normalise(text):
    if not text:
        return ""
    out = _BRACKETS.sub(" ", text)
    out = _NOISE.sub(" ", out)
    out = _PUNCT.sub(" ", out)
    return " ".join(out.lower().split())


def dedupe_roots(roots):
    """The folders to walk, with overlaps removed.

    Overlap is not an edge case now that folders can be ADDED to the scan: the
    download folder is always included, and the obvious thing to add is the
    music folder that contains it. `os.walk` would then visit those files twice
    and `trackCount += 1` would run twice for each — a library reporting twice
    the records you own, from a perfectly reasonable pair of folders.

    So: resolve each (symlinks and `..` included, or two spellings of one folder
    read as two folders), drop anything that is not a real directory, and drop
    any root that lives inside another. Shortest first, so the parent is the one
    that survives and its subtree is still covered.
    """
    resolved = []
    for root in roots:
        if not root:
            continue
        try:
            real = os.path.realpath(root)
        except OSError:
            continue
        if os.path.isdir(real):
            resolved.append(real)

    kept = []
    for root in sorted(set(resolved), key=len):
        # `startswith` alone is wrong: "/a/music" would swallow "/a/music-old".
        # The separator is what makes it containment rather than a prefix.
        if any(root == k or root.startswith(k + os.sep) for k in kept):
            continue
        kept.append(root)
    return kept


def release_key(artist, release):
    """The key search results are matched against. Artist may be empty."""
    return f"{normalise(artist)}|{normalise(release)}".strip("|")


def track_key(artist, title):
    return f"{normalise(artist)}|{normalise(title)}".strip("|")


_YEAR = re.compile(r"(1[89]\d{2}|20\d{2})")
# A folder segment that is ONLY a year, or only a catalogue number.
_YEAR_ONLY = re.compile(r"^\(?(1[89]\d{2}|20\d{2})\)?$")
_CATALOGUE_ONLY = re.compile(r"^[\[(]?[A-Z]{2,6}[\s\-]?\d{1,4}[\])]?$", re.I)


def _year_from(value):
    """A four-digit year from whatever a tag happens to contain.

    Date tags in the wild are `2019`, `2019-05-17`, `17/05/2019` and worse, so
    match a plausible year anywhere rather than trying to parse a date.
    """
    if not value:
        return 0
    found = _YEAR.search(str(value))
    return int(found.group(1)) if found else 0


def _read_tags(path):
    try:
        import mutagen
        audio = mutagen.File(path, easy=True)
        if audio is None:
            return {}
        out = {}
        for field in ("artist", "album", "albumartist", "title", "tracknumber",
                      "date", "genre"):
            value = audio.get(field)
            out[field] = (value[0] if isinstance(value, list) and value else value) or ""
        return out
    except Exception:                                  # noqa: BLE001 - per file
        return {}


def _from_path(path, roots=()):
    """Fallback when a file carries no usable tags.

    The folder is the release and the filename is the track — the same
    assumption the search grouper makes, so the two agree by construction.

    EXCEPT at a scan root. A file sitting loose in the download folder has no
    release folder, and taking the root's own name collapses every loose file
    into one enormous fake release named after the folder you scanned. Those
    files get no release at all unless their tags supply one.
    """
    parent = os.path.dirname(path)
    if any(os.path.normpath(parent) == os.path.normpath(r) for r in roots if r):
        stem = os.path.splitext(os.path.basename(path))[0]
        title = _TRACK_PREFIX.sub("", stem)
        artist = ""
        if " - " in title:
            left, right = title.split(" - ", 1)
            artist, title = left.strip(), right.strip()
        return artist, "", title

    folder = os.path.basename(os.path.dirname(path))
    stem = os.path.splitext(os.path.basename(path))[0]
    title = _TRACK_PREFIX.sub("", stem)

    artist = ""
    release = folder
    # `Artist - Album` is the overwhelmingly common folder shape.
    if " - " in folder:
        left, right = folder.split(" - ", 1)
        left, right = left.strip(), right.strip()
        # ...but `1998 - Album` and `[CAT001] - Album` are year and catalogue
        # prefixes, not artists. Taking them literally fills the collection
        # statistics with years masquerading as the most-represented artists,
        # which is how that chart read before this check existed.
        if _YEAR_ONLY.match(left) or _CATALOGUE_ONLY.match(left):
            release = right
        else:
            artist, release = left, right
    # `Artist - Title` inside the filename, when the folder gave us nothing.
    if not artist and " - " in title:
        left, right = title.split(" - ", 1)
        artist, title = left.strip(), right.strip()
    return artist, release, title


class Library:
    def __init__(self, index_path):
        self.index_path = index_path
        self._lock = threading.Lock()
        self._data = {"scannedAt": 0, "roots": [], "releases": {}, "tracks": {}}
        self._scanning = False
        self.load()

    # -- persistence -------------------------------------------------------

    def load(self):
        try:
            with open(self.index_path, encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict) and "releases" in data:
                self._data = data
        except (OSError, ValueError):
            pass

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.index_path), exist_ok=True)
            with open(self.index_path, "w", encoding="utf-8") as handle:
                json.dump(self._data, handle)
        except OSError:
            log.exception("could not write library index")

    # -- queries -----------------------------------------------------------

    def state(self):
        with self._lock:
            return {
                "scannedAt": int(self._data.get("scannedAt", 0)),
                "roots": list(self._data.get("roots", [])),
                "releaseCount": len(self._data.get("releases", {})),
                "trackCount": len(self._data.get("tracks", {})),
                "scanning": self._scanning,
            }

    def releases(self, limit=2000):
        with self._lock:
            items = list(self._data.get("releases", {}).values())
        items.sort(key=lambda r: (r.get("artist", ""), r.get("release", "")))
        return items[:limit]

    def owned_keys(self):
        """Every release and track key, for the frontend to match against.

        Sent once and matched client-side: doing it per result would be
        thousands of round trips for a lookup that is a set membership test.
        """
        with self._lock:
            return {
                "releases": list(self._data.get("releases", {}).keys()),
                "tracks": list(self._data.get("tracks", {}).keys()),
            }

    def has_track(self, artist, title):
        """Is this track on disk?

        Tries artist+title first, then title alone. MusicBrainz credits a track
        to the performing artist while a rip is often tagged to the album
        artist, so requiring both to match would report a complete album as
        almost entirely missing.
        """
        with self._lock:
            tracks = self._data.get("tracks", {})
        if not title:
            return False
        if track_key(artist, title) in tracks:
            return True
        return track_key("", title) in tracks

    # -- scanning ----------------------------------------------------------

    def scan(self, roots, progress=None, read_tags=True):
        """Walk `roots` and rebuild the index. Blocking; call on a worker."""
        with self._lock:
            if self._scanning:
                return self.state()
            self._scanning = True

        # Before anything is walked: two spellings of one folder, or a folder
        # nested in another, would each be counted twice.
        roots = dedupe_roots(roots)

        releases = {}
        tracks = {}
        seen = 0
        try:
            for root in roots:
                for folder, _dirs, files in os.walk(root):
                    for name in files:
                        if os.path.splitext(name)[1].lower() not in AUDIO_EXTENSIONS:
                            continue
                        path = os.path.join(folder, name)
                        seen += 1
                        if progress and seen % 250 == 0:
                            progress(seen)

                        tags = _read_tags(path) if read_tags else {}
                        p_artist, p_release, p_title = _from_path(path, roots)

                        artist = tags.get("albumartist") or tags.get("artist") or p_artist
                        release = tags.get("album") or p_release
                        title = tags.get("title") or p_title

                        rkey = release_key(artist, release)
                        if rkey:
                            entry = releases.setdefault(rkey, {
                                "key": rkey, "artist": artist, "release": release,
                                "folder": folder, "trackCount": 0, "bytes": 0,
                                "formats": {}, "year": 0, "genre": "",
                            })
                            entry["trackCount"] += 1
                            try:
                                entry["bytes"] += os.path.getsize(path)
                            except OSError:
                                pass

                            extension = os.path.splitext(name)[1].lower().lstrip(".")
                            entry["formats"][extension] = (
                                entry["formats"].get(extension, 0) + 1
                            )
                            # First plausible year wins. A release folder with
                            # disagreeing tags is common; averaging them would
                            # invent a year nothing actually claims.
                            if not entry["year"]:
                                year = _year_from(tags.get("date"))
                                if year:
                                    entry["year"] = year
                            if not entry["genre"] and tags.get("genre"):
                                entry["genre"] = str(tags["genre"])[:60]

                        tkey = track_key(artist, title)
                        if tkey:
                            tracks[tkey] = {"path": path, "release": rkey}
        finally:
            with self._lock:
                self._data = {
                    "scannedAt": int(time.time()),
                    "roots": list(roots),
                    "releases": releases,
                    "tracks": tracks,
                }
                self._scanning = False
            self.save()

        return self.state()
