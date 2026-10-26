"""
Seek — the Rekordbox hand-off: copy finished downloads into a folder the DJ
imports into Rekordbox.

Rekordbox has no watch folder of its own (through 7.2 there is no automatic
import from a folder; Pioneer's forum answer is that it is not possible). So
this is the honest version: one folder, kept tidy, that the DJ points Rekordbox's
own Import Folder at. Seek never opens, reads or writes the Rekordbox database.

Pure file work, like `checksums.py`: no core, no socket. It answers with raw
outcome codes and the TypeScript side words them.

Three rules, because these are a person's files:
  * COPY, never move. The download folder keeps every file, so Verify, the
    checksum check and Show in Finder go on working on the original.
  * Never overwrite. A name already taken by a different file is a reason to
    stop. The same-sized file is taken to be this one, sent before.
  * Never let half a file appear. The copy is written under a hidden temporary
    name and renamed into place, so an import that runs mid-copy sees nothing
    rather than a truncated track.
"""

import fcntl
import hashlib
import os
import shutil

#: Outcomes `send_file` can return. The first two mean the file is there.
COPIED = "copied"
ALREADY_THERE = "already_there"
EXISTS_DIFFERENT = "exists_different"
FILE_MISSING = "file_missing"
IO_ERROR = "io_error"
#: Seek quit mid-copy. Nothing was left behind; sending again starts over.
STOPPED = "stopped"
#: The Rekordbox folder is not there, or cannot be written (`folder_problem`).
FOLDER_UNAVAILABLE = "folder_unavailable"

#: Read and written this much at a time, so a quit is heard between chunks.
CHUNK = 1024 * 1024


def folder_problem(folder):
    """FOLDER_UNAVAILABLE when `folder` is not a folder Seek can write into.

    Asked on the copy's worker, never the engine's main thread: on a USB drive
    that has gone to sleep the first look waits for it to spin up, and on the
    main thread that froze every transfer and search for the seconds it took.
    An unplugged stick fails here; it is never recreated on the internal disk.
    """
    if os.path.isdir(folder) and os.access(folder, os.W_OK):
        return None
    return FOLDER_UNAVAILABLE


def destination(folder, source, download_root=None):
    """Where `source` goes inside `folder`.

    Its place under the download folder is kept, so `Artist/Album/CD1/01.flac`
    lands at `<folder>/Artist/Album/CD1/01.flac`. Keeping only the last folder
    would put two multi-disc releases' `CD1/01.flac` at the same name. A file
    outside the download folder (one sent to a "Download to" folder, or a
    download folder changed since) keeps just its own folder's name.
    """
    real = os.path.realpath(source)
    if download_root:
        root = os.path.realpath(download_root)
        if os.path.commonpath([root, real]) == root and real != root:
            return os.path.join(folder, os.path.relpath(real, root))
    parent = os.path.basename(os.path.dirname(real))
    return os.path.join(folder, parent, os.path.basename(real))


def _flush(path):
    """Make `path` reach the device, not just the cache.

    A DJ pulls the USB stick the moment Seek says "copied". Without this the
    name and the size can land on the stick while the bytes do not, leaving a
    full-length track of zeros that every later send reports as already there.
    On macOS plain fsync stops at the drive's own cache; F_FULLFSYNC does not.
    """
    fd = os.open(path, os.O_RDONLY)
    try:
        try:
            fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
        except (AttributeError, OSError):
            os.fsync(fd)
    finally:
        os.close(fd)


def partial_name(dest):
    """The hidden name a copy is written under. Short and fixed-length: the
    file's own name plus a suffix ran past the 255-byte limit for any name of
    242 bytes or more, and such a file could never be sent."""
    digest = hashlib.sha1(os.path.basename(dest).encode("utf-8", "surrogateescape")).hexdigest()
    return os.path.join(os.path.dirname(dest), f".seek-partial-{digest[:16]}")


def _missing_parents(folder):
    """The folders `os.makedirs(folder)` would create, deepest first."""
    missing = []
    while folder and not os.path.isdir(folder):
        missing.append(folder)
        parent = os.path.dirname(folder)
        if parent == folder:
            break
        folder = parent
    return missing


def _copy(source, partial, stopping):
    """Copy bytes and times; STOPPED if asked to stop between chunks."""
    with open(source, "rb") as reader, open(partial, "wb") as writer:
        while chunk := reader.read(CHUNK):
            if stopping():
                return STOPPED
            writer.write(chunk)
    shutil.copystat(source, partial)
    return None


def send_file(source, dest, stopping=lambda: False):
    """Copy one file to `dest`. Returns an outcome code; never raises OSError.

    `stopping` is asked between chunks; when it says yes the copy is abandoned
    and cleaned up, so quitting Seek mid-copy neither waits for a whole album
    nor leaves a hidden partial on the stick.
    """
    if not os.path.isfile(source):
        # Gone since it was found: moved or deleted, not a failing drive.
        return FILE_MISSING
    try:
        if os.path.lexists(dest):
            if os.path.isfile(dest) and os.path.getsize(dest) == os.path.getsize(source):
                return ALREADY_THERE
            return EXISTS_DIFFERENT
        made = _missing_parents(os.path.dirname(dest))
        partial = partial_name(dest)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                stopped = _copy(source, partial, stopping)
            except FileNotFoundError:
                if not os.path.isfile(source):
                    return FILE_MISSING
                raise
            if stopped:
                return stopped
            _flush(partial)
            # ponytail: check-then-rename leaves a microsecond window for another
            # program writing this exact name; os.link would close it but fails
            # on exFAT, which is what a DJ's USB stick usually is.
            if os.path.lexists(dest):
                return EXISTS_DIFFERENT
            os.replace(partial, dest)
            try:
                _flush(os.path.dirname(dest))  # and the rename itself
            except OSError:
                pass   # some volumes refuse a folder flush; the file is there
        finally:
            if os.path.lexists(partial):
                os.unlink(partial)
            if not os.path.lexists(dest):
                # Folders made for a copy that did not land would sit empty
                # in the Rekordbox folder; only ones this call made, and only
                # while empty.
                for folder in made:
                    try:
                        os.rmdir(folder)
                    except OSError:
                        break
    except OSError:
        return IO_ERROR
    return COPIED
