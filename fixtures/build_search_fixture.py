#!/usr/bin/env python3
# Seek — recorded search session generator.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
#   python3 fixtures/build_search_fixture.py
#
# Writes fixtures/search-burial.ndjson: one Soulseek search for "burial",
# replayed as protocol frames. Deterministic (seeded), and every frame is run
# through seek_sidecar.protocol.validate_event before it is written, so the
# fixture cannot drift from shared/protocol.ts.
#
# PROVENANCE: hand-authored, not captured live. Reaching the real Soulseek
# network requires a registered account, and this build has no credentials.
# The path conventions, format distribution, peer-stat ranges, size arithmetic
# and arrival timing below are modelled on real Soulseek behaviour, but no byte
# of this came off the wire. See fixtures/README.md.

import hashlib
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "sidecar"))

from seek_sidecar import protocol  # noqa: E402

SEED = 20260810
QUERY = "burial"
OUT = os.path.join(ROOT, "fixtures", "search-burial.ndjson")
SEARCH_ID = 1_842_337
EPOCH = 1_770_000_000.0  # fixed wall-clock origin so timestamps are stable

rng = random.Random(SEED)


# ---------------------------------------------------------------- the catalogue
#
# (artist, release, year, label, catalogue, [(track_no, title, seconds), ...])
# Durations are real running times. Everything downstream derives from them.

RELEASES = [
    ("Burial", "Untrue", 2007, "Hyperdub", "HDBLP002", [
        (1, "Untitled", 46), (2, "Archangel", 236), (3, "Near Dark", 214),
        (4, "Ghost Hardware", 261), (5, "Endorphin", 173), (6, "Etched Headplate", 274),
        (7, "In McDonalds", 130), (8, "Untrue", 130), (9, "Shell Of Light", 267),
        (10, "Dog Shelter", 149), (11, "Homeless", 314), (12, "UK", 71),
        (13, "Raver", 291),
    ]),
    ("Burial", "Burial", 2006, "Hyperdub", "HDBLP001", [
        (1, "Untitled", 65), (2, "Distant Lights", 285), (3, "Spaceape", 233),
        (4, "Wounder", 176), (5, "Night Bus", 132), (6, "Broken Home", 296),
        (7, "Prayer", 208), (8, "Pirates", 250), (9, "Gutted", 291),
        (10, "Forgive", 188), (11, "Southern Comfort", 285), (12, "U Hurt Me", 264),
        (13, "Untitled", 85),
    ]),
    ("Burial", "Kindred", 2012, "Hyperdub", "HDB067", [
        (1, "Kindred", 692), (2, "Loner", 620), (3, "Ashtray Wasp", 700),
    ]),
    ("Burial", "Rival Dealer", 2013, "Hyperdub", "HDB075", [
        (1, "Rival Dealer", 618), (2, "Hiders", 269), (3, "Come Down To Us", 793),
    ]),
    ("Burial", "Street Halo", 2011, "Hyperdub", "HDB055", [
        (1, "Street Halo", 380), (2, "NYC", 447), (3, "Stolen Dog", 351),
    ]),
    ("Burial", "Truant / Rough Sleeper", 2012, "Hyperdub", "HDB071", [
        (1, "Truant", 692), (2, "Rough Sleeper", 819),
    ]),
    ("Burial & Four Tet", "Moth / Wolf Cub", 2009, "Text Records", "TEXT005", [
        (1, "Moth", 613), (2, "Wolf Cub", 519),
    ]),
    ("Burial", "Antidawn", 2022, "Hyperdub", "HDB135", [
        (1, "Strange Neighbourhood", 618), (2, "Antidawn", 452),
        (3, "Shadow Paradise", 386), (4, "Upstairs Flat", 512), (5, "New Love", 289),
    ]),
]

# Compilations that contain a Burial track — the reason a search returns folders
# that are not "a Burial release" at all. These break naive artist grouping.
COMPILATIONS = [
    ("VA", "Hyperdub 5: Five Years Of Hyperdub", 2009, "Hyperdub", "HDBCD009", [
        (4, "Burial - Fostercare", 344),
        (7, "Kode9 & The Spaceape - Bad", 251),
        (11, "Zomby - Tarantula", 198),
        (14, "Ikonika - Fish", 224),
    ]),
    ("VA", "Box Of Dub 2", 2008, "Soul Jazz Records", "SJRLP180", [
        (3, "Burial - Versus", 305),
        (6, "Pinch - Brighter Day", 288),
        (9, "Kode9 - 9 Samurai", 262),
    ]),
    ("VA", "FabricLive 100", 2018, "Fabric", "FABRIC199", [
        (2, "Burial - Shadow Paradise", 386),
        (5, "Kode9 - Sine Of The Dub", 240),
        (8, "The Bug - Skeng", 199),
    ]),
]

# Search-term false positives. Soulseek matches every query word against the
# whole path, so "burial" pulls in things that are not the artist at all.
NOISE = [
    ("Deathspell Omega", "Burial At Sea", 2003, "Norma Evangelium Diaboli", "NED004", [
        (1, "Burial At Sea Pt. I", 421), (2, "Burial At Sea Pt. II", 388),
    ]),
    ("Gravediggaz", "6 Feet Deep", 1994, "Gee Street", "GEE1004", [
        (5, "Here Comes The Gravediggaz", 205), (9, "Burial Ground Rhythm", 231),
    ]),
    ("Miles Davis", "Live-Evil", 1971, "Columbia", "G30954", [
        (3, "Medley: Gemini / Double Image (Burial Mix)", 632),
    ]),
]

ALL_RELEASES = (
    [(r, "album") for r in RELEASES]
    + [(r, "compilation") for r in COMPILATIONS]
    + [(r, "noise") for r in NOISE]
)

# How widely shared each release is. Sharing is heavily power-law in practice —
# the two canonical albums are on almost every peer, the 2022 record and the
# false-positive hits are on a handful. This is what produces the "same track
# from 40 people" case the dedup layer has to collapse.
POPULARITY = {
    "Untrue": 190, "Burial": 150, "Kindred": 46, "Rival Dealer": 38,
    "Street Halo": 34, "Truant / Rough Sleeper": 30, "Moth / Wolf Cub": 42,
    "Antidawn": 20,
    "Hyperdub 5: Five Years Of Hyperdub": 22, "Box Of Dub 2": 14,
    "FabricLive 100": 16,
    "Burial At Sea": 8, "6 Feet Deep": 7, "Live-Evil": 5,
}


def weighted_sample(items, k):
    """Sample without replacement, weighted by POPULARITY."""
    pool = list(items)
    weights = [POPULARITY.get(entry[0][1], 10) for entry in pool]
    chosen = []
    for _ in range(min(k, len(pool))):
        pick = rng.choices(range(len(pool)), weights=weights)[0]
        chosen.append(pool.pop(pick))
        weights.pop(pick)
    return chosen


# --------------------------------------------------------------------- formats
#
# (label, extension, lossless, nominal_kbps, weight). `nominal_kbps` is the
# ADVERTISED figure; actual byte size is computed separately so we can make a
# peer lie.

FORMATS = [
    ("FLAC", "flac", True, None, 30),
    ("320", "mp3", False, 320, 26),
    ("V0", "mp3", False, 245, 14),
    ("256", "mp3", False, 256, 8),
    ("192", "mp3", False, 192, 7),
    ("V2", "mp3", False, 190, 5),
    ("128", "mp3", False, 128, 4),
    ("AIFF", "aiff", True, None, 3),
    ("WAV", "wav", True, None, 3),
]
FORMAT_WEIGHTS = [f[4] for f in FORMATS]


def flac_size(seconds, sample_rate, bit_depth):
    """Bytes for a plausible FLAC: raw PCM times a realistic compression ratio."""
    raw_bps = sample_rate * bit_depth * 2  # stereo
    ratio = rng.uniform(0.54, 0.71)
    return int(raw_bps * ratio * seconds / 8)


def pcm_size(seconds, sample_rate, bit_depth):
    return int(sample_rate * bit_depth * 2 * seconds / 8) + 44


def lossy_size(seconds, kbps):
    """Bytes for a lossy file at an actual (not necessarily advertised) rate."""
    return int(kbps * 1000 * seconds / 8) + rng.randint(2_000, 40_000)  # tags


# ----------------------------------------------------------------- path styles
#
# Each peer sticks to one naming convention, which is what makes the same
# release look like eight different things across the result list.


def fs_safe(name):
    """No filesystem allows '/' in a path component, so a release like
    'Moth / Wolf Cub' is always renamed on disk before it is ever shared. Peers
    pick different substitutions; that inconsistency is itself realistic."""
    if "/" not in name:
        return name
    return name.replace(" / ", rng.choice([" - ", "_", " & ", "-"])).replace("/", "-")


def style_standard(a, rel, year, fmt, cat, label, tn, title, ext, root):
    folder = f"{a} - {rel} ({year}) [{fmt}]"
    return f"{root}\\{folder}\\{tn:02d} - {title}.{ext}", f"{root}\\{folder}"


def style_scene(a, rel, year, fmt, cat, label, tn, title, ext, root):
    def scrub(s):
        return "".join(c if c.isalnum() else "_" for c in s).strip("_")
    folder = f"{scrub(a)}-{scrub(rel)}-{year}-{fmt.upper()}-XXL"
    fn = f"{tn:02d}-{scrub(a).lower()}-{scrub(title).lower()}"
    return f"{root}\\{folder}\\{fn}.{ext}", f"{root}\\{folder}"


def style_catalogue(a, rel, year, fmt, cat, label, tn, title, ext, root):
    folder = f"[{cat}] {a} - {rel}"
    return f"{root}\\{folder}\\{tn:02d}. {title}.{ext}", f"{root}\\{folder}"


def style_vinyl(a, rel, year, fmt, cat, label, tn, title, ext, root):
    side = "ABCD"[(tn - 1) // 3 % 4]
    pos = f"{side}{((tn - 1) % 3) + 1}"
    folder = f"{a} - {rel} [{cat}]"
    return f"{root}\\{folder}\\{pos} {title}.{ext}", f"{root}\\{folder}"


def style_artist_tree(a, rel, year, fmt, cat, label, tn, title, ext, root):
    folder = f"{root}\\{a}\\{year} - {rel}"
    return f"{folder}\\{tn:02d} {title}.{ext}", folder


def style_label_tree(a, rel, year, fmt, cat, label, tn, title, ext, root):
    folder = f"{root}\\{label}\\{cat} - {a} - {rel}"
    return f"{folder}\\{tn:02d}. {a} - {title}.{ext}", folder


def style_bare(a, rel, year, fmt, cat, label, tn, title, ext, root):
    """Folder carries everything, file is just a number. The hard case."""
    folder = f"{root}\\{a} - {rel} ({year}) [{cat}] [{fmt}]"
    return f"{folder}\\{tn:02d}.{ext}", folder


def style_shouty(a, rel, year, fmt, cat, label, tn, title, ext, root):
    folder = f"!!! {a.upper()} - {rel.upper()} ({year}) WEB {fmt} !!!"
    return f"{root}\\{folder}\\{tn:02d}. {title}.{ext}", f"{root}\\{folder}"


def style_flat(a, rel, year, fmt, cat, label, tn, title, ext, root):
    """No release folder at all — everything dumped in one directory."""
    folder = f"{root}\\{'Dubstep' if year > 2005 else 'Metal'}"
    return f"{folder}\\{a} - {title}.{ext}", folder


STYLES = [
    style_standard, style_standard, style_standard,  # weighted: most common
    style_scene, style_scene,
    style_catalogue, style_vinyl, style_artist_tree,
    style_label_tree, style_bare, style_shouty, style_flat,
]

# Every root is backslash-separated: upstream rewrites '/' to '\' on the way in
# (slskmessages.py `_parse_result_list`), so a forward slash can never reach the
# frontend even from a macOS or Linux peer.
ROOTS = [
    "@@ilqxr\\Music", "@@vhtnp\\Shared", "D:\\Soulseek\\Complete",
    "C:\\Users\\dan\\Music", "\\\\NAS\\music\\electronic", "Music",
    "@@qq7ym\\soulseek share", "E:\\DJ\\_incoming", "Volumes\\Ext\\Music",
    "@@kk2vd\\downloads\\sorted", "share\\_dubstep_uk",
]

# Extra files real folders contain and real searches therefore return. They have
# NO audio attributes at all — every attribute field is null.
SIDECAR_FILES = [
    ("folder.jpg", 180_000, 900_000),
    ("cover.jpg", 220_000, 1_400_000),
    ("{release}.cue", 1_200, 4_000),
    ("{release}.log", 3_000, 14_000),
    ("{release}.m3u", 300, 1_800),
    ("00-{release}.nfo", 900, 6_000),
]


# ----------------------------------------------------------------------- peers

FIRST = ["dubplate", "hyperdub", "southlondon", "nightbus", "rinse", "warpfan",
         "vinyl", "sublow", "croydon", "fwd", "tempa", "keysound", "deep",
         "ghost", "shell", "raver", "archangel", "kode", "spaceape", "hessle",
         "livity", "ilian", "ostgut", "berghain", "perlon", "basicchannel",
         "chainreact", "tresor", "metalheadz", "goldie", "photek", "source",
         "hyph", "mngo", "wilder"]
LAST = ["_uk", "77", "2003", "_ldn", "x", "_dj", "99", "_ffm", "_nyc", "",
        "_bln", "01", "_rec", "42", "_mp3"]
COUNTRIES = ["GB", "GB", "GB", "DE", "DE", "US", "US", "NL", "FR", "JP",
             "PL", "RU", "CA", "SE", "IT", "BR", None, None]


def make_peers(n):
    peers = []
    seen = set()
    while len(peers) < n:
        name = rng.choice(FIRST) + rng.choice(LAST)
        if name in seen:
            continue
        seen.add(name)

        archetype = rng.choices(
            ["fast_free", "fast_busy", "modest", "slow", "hoarder", "tiny"],
            weights=[14, 20, 26, 18, 12, 10],
        )[0]

        if archetype == "fast_free":
            speed = rng.randint(1_400_000, 9_000_000)
            free, queue = True, 0
            files = rng.randint(20_000, 90_000)
        elif archetype == "fast_busy":
            speed = rng.randint(900_000, 5_000_000)
            free, queue = False, rng.randint(3, 64)
            files = rng.randint(15_000, 120_000)
        elif archetype == "modest":
            speed = rng.randint(180_000, 900_000)
            free = rng.random() < 0.35
            queue = 0 if free else rng.randint(1, 22)
            files = rng.randint(3_000, 40_000)
        elif archetype == "slow":
            speed = rng.randint(11_000, 160_000)
            free = rng.random() < 0.2
            queue = 0 if free else rng.randint(2, 40)
            files = rng.randint(800, 12_000)
        elif archetype == "hoarder":
            speed = rng.randint(300_000, 2_200_000)
            free, queue = False, rng.randint(40, 310)
            files = rng.randint(300_000, 1_400_000)
        else:  # tiny
            speed = rng.randint(40_000, 500_000)
            free = rng.random() < 0.6
            queue = 0 if free else rng.randint(1, 6)
            files = rng.randint(60, 900)

        peers.append({
            "username": name,
            "freeSlots": free,
            "advertisedSpeed": speed,
            "queueLength": queue,
            "files": files,
            "folders": max(1, files // rng.randint(9, 26)),
            "country": rng.choice(COUNTRIES),
            "_style": rng.choice(STYLES),
            "_root": rng.choice(ROOTS),
            "_archetype": archetype,
            # How reliably this peer fills in file attributes. Most clients in
            # the wild (Nicotine+, SoulseekQt, slskd) fill them in; a minority of
            # old or odd clients send nothing at all. Big sharers are excluded
            # from the attributeless bucket — someone with 400k files is running
            # a maintained client, and letting a hoarder be attributeless skews
            # the whole result set toward "unknown".
            "_attr_quality": (
                rng.choices(["full", "partial"], weights=[85, 15])[0]
                if archetype in ("hoarder", "fast_free", "fast_busy")
                else rng.choices(["full", "partial", "none"], weights=[64, 18, 18])[0]
            ),
        })
    return peers


# ---------------------------------------------------------------- file records

def build_file(peer, release, kind, track, fmt_choice, liar):
    artist, rel_title, year, label, cat, _tracks = release
    tn, title, seconds = track
    fmt_label, ext, lossless, nominal_kbps, _w = fmt_choice

    path, folder = peer["_style"](
        fs_safe(artist), fs_safe(rel_title), year, fmt_label, cat, label,
        tn, fs_safe(title), ext, peer["_root"]
    )

    bitrate = duration = sample_rate = bit_depth = None
    is_vbr = None

    if lossless:
        sr, bd = rng.choice([(44100, 16), (44100, 16), (44100, 16),
                             (48000, 24), (96000, 24), (44100, 24)])
        if liar == "fake_lossless":
            # A lossy file re-encoded to FLAC. Advertises full lossless
            # attributes; the byte size implies ~250 kbps, which no real
            # 44.1/16 lossless file can be.
            size = lossy_size(seconds, rng.choice([245, 256, 320]))
            sr, bd = 44100, 16
        elif ext == "flac":
            size = flac_size(seconds, sr, bd)
        else:
            size = pcm_size(seconds, sr, bd)
        duration, sample_rate, bit_depth = seconds, sr, bd
    else:
        advertised = nominal_kbps
        actual = nominal_kbps
        if liar == "upscale":
            # Advertises 320, was actually encoded at 128-192 and re-encoded.
            advertised = 320
            actual = rng.choice([128, 160, 192])
        size = lossy_size(seconds, actual)
        bitrate = advertised
        duration = seconds
        is_vbr = fmt_label.startswith("V")

    # Peers whose clients send poor or no attributes. A liar is exempt: a file
    # with no advertised bitrate is not a lie, it is an unknown, and stripping
    # the attributes off a deliberately-planted transcode would quietly delete
    # the case this fixture exists to exercise.
    if liar is None:
        if peer["_attr_quality"] == "none":
            bitrate = duration = sample_rate = bit_depth = None
            is_vbr = None
        elif peer["_attr_quality"] == "partial" and rng.random() < 0.45:
            duration = None
            if rng.random() < 0.5:
                bitrate = None

    return {
        "path": path,
        "size": size,
        "bitrate": bitrate,
        "duration": duration,
        "sampleRate": sample_rate,
        "bitDepth": bit_depth,
        "isVbr": is_vbr,
    }, folder


def build_sidecar_file(peer, release, folder):
    _artist, rel_title, *_ = release
    template, lo, hi = rng.choice(SIDECAR_FILES)
    name = template.replace("{release}", rel_title.replace("/", "-"))
    return {
        "path": f"{folder}\\{name}",
        "size": rng.randint(lo, hi),
        "bitrate": None, "duration": None, "sampleRate": None,
        "bitDepth": None, "isVbr": None,
    }


# --------------------------------------------------------------------- timing
#
# Real Soulseek arrival: nothing for ~400 ms, a heavy burst between 1 and 7 s as
# the distributed network floods, then a long thinning tail. A peer with many
# matches sends several responses, not one.

def peer_arrival_ms():
    r = rng.random()
    if r < 0.06:
        return rng.randint(380, 950)          # the fast few
    if r < 0.62:
        return rng.randint(950, 6_500)        # the flood
    if r < 0.88:
        return rng.randint(6_500, 15_000)     # thinning
    return rng.randint(15_000, 31_000)        # stragglers


def main():
    peers = make_peers(46)
    frames = []  # (offset_ms, frame)

    started = {
        "searchId": SEARCH_ID,
        "query": QUERY,
        "termTransmitted": QUERY,
        "mode": "global",
        "startedAt": EPOCH,
        "resultCount": 0,
    }
    frames.append((0, {"ev": "search.started", "data": started}))

    total_files = 0
    total_liars = 0
    responding = 0

    for peer in peers:
        # Which releases does this peer have? Hoarders have almost everything.
        if peer["_archetype"] == "hoarder":
            k = rng.randint(7, len(ALL_RELEASES))
        elif peer["_archetype"] == "tiny":
            k = rng.randint(1, 2)
        else:
            k = rng.randint(1, 6)
        chosen = weighted_sample(ALL_RELEASES, k)

        peer_files = []
        for release, kind in chosen:
            _artist, _rel, _year, _label, _cat, tracks = release

            fmt_choice = rng.choices(FORMATS, weights=FORMAT_WEIGHTS)[0]

            # Partial rips are common but not the norm — most people share the
            # whole folder they downloaded.
            if rng.random() < 0.18 and len(tracks) > 3:
                keep = rng.randint(max(2, len(tracks) // 2), len(tracks))
                picked = sorted(rng.sample(tracks, keep))
            else:
                picked = tracks

            liar_mode = None
            if fmt_choice[0] == "320" and rng.random() < 0.13:
                liar_mode = "upscale"
            elif fmt_choice[2] and fmt_choice[1] == "flac" and rng.random() < 0.07:
                liar_mode = "fake_lossless"

            folder = None
            for track in picked:
                rec, folder = build_file(peer, release, kind, track, fmt_choice, liar_mode)
                peer_files.append(rec)
                if liar_mode:
                    total_liars += 1

            if folder and rng.random() < 0.45:
                peer_files.append(build_sidecar_file(peer, release, folder))

        if not peer_files:
            continue
        responding += 1

        # Upstream sorts each response's file list by name; mirror that.
        peer_files.sort(key=lambda f: f["path"])

        # Split into 1-3 responses, as a real peer would.
        base = peer_arrival_ms()
        n_resp = 1 if len(peer_files) <= 12 else rng.randint(2, 3)
        chunk = max(1, len(peer_files) // n_resp)
        offset = base
        for i in range(0, len(peer_files), chunk):
            batch = peer_files[i:i + chunk]
            if not batch:
                continue
            data = {
                "searchId": SEARCH_ID,
                "peer": {k: peer[k] for k in
                         ("username", "freeSlots", "advertisedSpeed",
                          "queueLength", "files", "folders", "country")},
                "files": batch,
                "private": False,
                "receivedAt": round(EPOCH + offset / 1000.0, 3),
            }
            frames.append((offset, {"ev": "search.result", "data": data}))
            total_files += len(batch)
            offset += rng.randint(120, 2_400)

    frames.sort(key=lambda item: item[0])

    close_ms = max(offset for offset, _ in frames) + 4_000
    frames.append((close_ms, {"ev": "search.closed", "data": {
        "searchId": SEARCH_ID,
        "reason": "timeout",
        "resultCount": total_files,
        "peerCount": responding,
    }}))

    # Validate every single frame against the generated schema before writing.
    for _offset, frame in frames:
        protocol.validate_event(frame["ev"], frame["data"])

    with open(OUT, "w", encoding="utf-8") as handle:
        for offset, frame in frames:
            handle.write(json.dumps(
                {"offsetMs": offset, "frame": frame},
                ensure_ascii=False, separators=(",", ":"),
            ) + "\n")

    digest = hashlib.sha256(open(OUT, "rb").read()).hexdigest()[:16]
    span = close_ms / 1000.0
    print(f"wrote {os.path.relpath(OUT, ROOT)}")
    print(f"  frames        {len(frames)}")
    print(f"  files         {total_files}")
    print(f"  peers         {responding} of {len(peers)}")
    print(f"  liars         {total_liars}")
    print(f"  span          {span:.1f}s")
    print(f"  sha256[:16]   {digest}")


if __name__ == "__main__":
    main()
