# Seek — verifying a download against the checksum sidecar it shipped with.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHY THIS EXISTS
#
# Soulseek transfers carry no hash of any kind (RECON.md §2). There is no
# per-file digest in the protocol, no piece hashing, nothing — so when a
# download completes there is no protocol-level way to know you received what
# the uploader had. Every other check Seek performs is inference: the
# search-time metadata arithmetic is a prediction, and the spectral pass is a
# reading of the audio's shape.
#
# But a great many lossless releases ship a checksum sidecar in the folder, put
# there by whoever ripped or taped it. When one is present it is the ONLY hard
# fact available about the bytes, and Seek was throwing it away — the file
# downloaded with the rest of the folder and then sat there unread.
#
# TWO FORMATS, AND THEY DO NOT MEAN THE SAME THING
#
#   .ffp  `name:md5` — the FLAC STREAMINFO signature, an MD5 of the DECODED
#         audio. Immune to tagging: re-tag a FLAC and this is unchanged. A
#         mismatch means different audio — a re-encode, a different master, a
#         different take.
#
#   .md5  `md5 *name` — md5sum output over the WHOLE FILE. Not immune to
#         anything: editing one tag changes it. A mismatch here is much weaker
#         evidence than a mismatch there, and the frontend has to say so.
#
# The whole reason both are worth carrying is that they fail differently. The
# wording lives in `app/src/domain/checksums.ts`; this module computes and
# reports, and decides nothing.
#
# HOW THE .ffp CHECK IS DONE, AND WHAT IT DOES NOT COVER
#
# The expected value in an .ffp is the STREAMINFO MD5 signature, which every
# FLAC carries in its own header — that is exactly what `metaflac --show-md5sum`
# prints and exactly what made the .ffp. So the check is a header read: 16 bytes
# at a known offset, no decoding, instant, no ffmpeg.
#
# What that cannot see is corruption of the compressed stream: damage a frame
# and the header still carries the original signature. An .ffp match therefore
# says "this is the audio the fingerprint was made from", not "this file
# decodes cleanly". That is the same thing an .ffp has always meant, and the
# distinction is stated rather than papered over.
#
# Everything returned is raw fact. No verdicts, no labels, no sentences.

import hashlib
import logging
import os
import re

log = logging.getLogger("seek.checksums")

#: Extensions we know how to read, lowercased. The value is the `kind` reported
#: on every entry that came out of that file.
SIDECAR_KINDS = {".ffp": "ffp", ".md5": "md5"}

#: A sidecar is a text file listing a few dozen names. Anything past this is not
#: one, and reading it would be someone else's idea of funny.
MAX_SIDECAR_BYTES = 4 << 20

_READ_CHUNK = 1 << 20
_HEX32 = re.compile(r"\A[0-9a-fA-F]{32}\Z")
_EMPTY_SIGNATURE = b"\x00" * 16


# -- reading the actual files ------------------------------------------------

def file_md5(path):
    """MD5 over the whole file, in chunks. What a `.md5` line is compared to."""
    digest = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_READ_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def flac_signature(path):
    """`(hex, issue)` — the STREAMINFO MD5, read from the header.

    Returns `(None, issue)` rather than raising, because "this is not a FLAC"
    and "this FLAC has no signature" are both ordinary findings about somebody
    else's file, not errors in ours.
    """
    with open(path, "rb") as handle:
        magic = handle.read(4)

        # An ID3v2 tag in front of the FLAC magic is rare, wrong, and real.
        # Skipping it is eight lines; not skipping it reports a perfectly good
        # file as "not a FLAC".
        if magic[:3] == b"ID3":
            rest = handle.read(6)
            if len(rest) < 6:
                return None, "not_flac"
            size = 0
            for byte in rest[2:6]:          # syncsafe: seven bits per byte
                size = (size << 7) | (byte & 0x7F)
            handle.seek(10 + size)
            magic = handle.read(4)

        if magic != b"fLaC":
            return None, "not_flac"

        header = handle.read(4)
        # STREAMINFO is block type 0 and the format REQUIRES it to come first,
        # so anything else here means the file is not what it claims.
        if len(header) < 4 or (header[0] & 0x7F) != 0:
            return None, "not_flac"
        if int.from_bytes(header[1:4], "big") < 34:
            return None, "not_flac"

        block = handle.read(34)
        if len(block) < 34:
            return None, "not_flac"
        signature = block[18:34]

    # Encoders are allowed to leave this unset, and some do. That is not a
    # failed check — it is a check that cannot be made, and saying "mismatch"
    # here would accuse a fine file of being a fake.
    if signature == _EMPTY_SIGNATURE:
        return None, "no_signature"
    return signature.hex(), None


# -- reading the sidecars ----------------------------------------------------

def _lines(text):
    for line in text.splitlines():
        line = line.strip().lstrip("\ufeff")
        if line and not line.startswith((";", "#")):
            yield line


def parse_ffp(text):
    """`[(name, md5)], unparsed_count` from `.ffp` content.

    Split on the LAST colon. Some of these carry a Windows path, and `C:\\rip\\
    01.flac:8a2f…` has two.
    """
    out, unparsed = [], 0
    for line in _lines(text):
        name, sep, digest = line.rpartition(":")
        name, digest = name.strip(), digest.strip()
        if not sep or not name or not _HEX32.match(digest):
            unparsed += 1
            continue
        out.append((name, digest.lower()))
    return out, unparsed


def parse_md5(text):
    """`[(name, md5)], unparsed_count` from md5sum output.

    Both of md5sum's own forms: `hash  name` (text) and `hash *name` (binary).
    """
    out, unparsed = [], 0
    for line in _lines(text):
        digest, _, name = line.partition(" ")
        if not name:
            digest, _, name = line.partition("\t")
        name = name.strip().lstrip("*").strip()
        if not name or not _HEX32.match(digest):
            unparsed += 1
            continue
        out.append((name, digest.lower()))
    return out, unparsed


_PARSERS = {"ffp": parse_ffp, "md5": parse_md5}


def _read_text(path):
    """Sidecars are ASCII in practice but not in principle. Never raises."""
    with open(path, "rb") as handle:
        raw = handle.read(MAX_SIDECAR_BYTES + 1)
    if len(raw) > MAX_SIDECAR_BYTES:
        raise ValueError("too large to be a checksum file")
    return raw.decode("utf-8-sig", errors="replace")


def _resolve(folder, name):
    """The local file a sidecar line names, or "" if it is not here.

    THIS INPUT CAME FROM A STRANGER. A sidecar arrives over Soulseek like every
    other file in the folder, and `../../../.ssh/id_rsa:8a2f…` is a path, not a
    filename. We only ever read and report a digest, but reporting the digest of
    a file outside the folder is still telling a stranger something about this
    machine, so the join is clamped and then re-checked.
    """
    rel = name.replace("\\", "/").strip("/")
    if not rel:
        return ""

    folder = os.path.normpath(folder)
    candidate = os.path.normpath(os.path.join(folder, rel))
    inside = candidate.startswith(folder + os.sep)
    if inside and os.path.isfile(candidate):
        return candidate

    # A sidecar written elsewhere often carries the ripper's own directory in
    # front of each name. The basename is inside the folder by construction.
    flat = os.path.join(folder, os.path.basename(rel))
    return flat if os.path.isfile(flat) else ""


# -- the whole folder --------------------------------------------------------

def find_sidecars(folder):
    """Absolute paths of the `.ffp`/`.md5` files in one folder, sorted."""
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return []
    return [
        os.path.join(folder, name) for name in names
        if os.path.splitext(name)[1].lower() in SIDECAR_KINDS
        and os.path.isfile(os.path.join(folder, name))
    ]


def verify_folder(folder):
    """Every checksum claim made in `folder`, checked against what is on disk.

    Raw facts only: expected beside actual, and a reason when actual could not
    be computed. Whether a pair MATCHES is a comparison, and comparisons that
    turn into wording belong in TypeScript.
    """
    folder = os.path.normpath(folder)
    sidecars, entries = [], []

    for path in find_sidecars(folder):
        kind = SIDECAR_KINDS[os.path.splitext(path)[1].lower()]
        try:
            pairs, unparsed = _PARSERS[kind](_read_text(path))
        except (OSError, ValueError) as error:
            log.warning("could not read %s: %s", path, error)
            sidecars.append({
                "path": path, "kind": kind, "entryCount": 0,
                "unparsedLines": 0, "error": str(error),
            })
            continue

        sidecars.append({
            "path": path, "kind": kind, "entryCount": len(pairs),
            "unparsedLines": unparsed, "error": "",
        })

        for name, expected in pairs:
            entries.append(_check(folder, kind, name, expected))

    return {"folderPath": folder, "sidecars": sidecars, "entries": entries}


def _check(folder, kind, name, expected):
    entry = {
        "name": name, "kind": kind, "expected": expected,
        "localPath": "", "actual": None, "issue": None,
    }

    local = _resolve(folder, name)
    if not local:
        # Worth reporting rather than skipping: a fingerprint naming twelve
        # files when eight arrived is how you learn the release is incomplete.
        entry["issue"] = "missing"
        return entry
    entry["localPath"] = local

    try:
        if kind == "ffp":
            actual, issue = flac_signature(local)
            entry["actual"], entry["issue"] = actual, issue
        else:
            entry["actual"] = file_md5(local)
    except OSError as error:
        log.warning("could not hash %s: %s", local, error)
        entry["issue"] = "unreadable"
    return entry
