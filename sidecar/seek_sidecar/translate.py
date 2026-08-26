# Seek — upstream objects -> wire structs.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The ONLY place that knows both pynicotine's shapes and shared/protocol.ts.
# Everything here is a pure function of its arguments so it can be tested
# without a network, a core, or a socket.
#
# Nothing in this module formats anything for display: no human-readable sizes,
# speeds or durations, no derived quality, no ranking. See BRIEF_SEEK.md
# §Architecture "Rules".

from .protocol import validate_struct  # noqa: F401  (re-exported for tests)

# pynicotine.slskmessages.UserStatus -> our enum
_USER_STATUS = {0: "offline", 1: "away", 2: "online"}

# pynicotine.transfers.TransferStatus -> our enum. Upstream's set is closed;
# anything unrecognised becomes "unknown" rather than crashing the bridge.
_TRANSFER_STATE = {
    "Queued": "queued",
    "Getting status": "getting_status",
    "Transferring": "transferring",
    "Paused": "paused",
    "Cancelled": "cancelled",
    "Filtered": "filtered",
    "Finished": "finished",
    "User logged off": "user_logged_off",
    "Connection closed": "connection_closed",
    "Connection timeout": "connection_timeout",
    "Download folder error": "download_folder_error",
    "Local file error": "local_file_error",
}

# Statuses that mean "this transfer failed", so `Transfer.error` is populated.
FAILED_STATES = frozenset({
    "user_logged_off", "connection_closed", "connection_timeout",
    "download_folder_error", "local_file_error",
})


def user_status(value):
    """Upstream UserStatus int -> enum string."""
    return _USER_STATUS.get(value, "offline")


# Reject reasons a PEER sends, which upstream assigns straight to
# `transfer.status` (downloads.py: `_abort_transfer(download, status=reason)`).
# They are not TransferStatus values, so they used to fall through to "unknown"
# and the text was dropped on the floor — see TransferState in the schema.
#
# Two of them, "Queued" and "Cancelled", collide with real TransferStatus values
# and were therefore the only refusals that ever displayed correctly. That is a
# coincidence of spelling, not a design, and it is why the bug looked
# intermittent rather than total.
#
# Not an exhaustive list, deliberately: `reason.startswith("User limit of")`
# upstream proves peers send free text, so anything unrecognised is 'rejected'
# too, carrying whatever they said.
REJECT_REASONS = frozenset({
    "Complete", "File read error.", "File not shared.", "Banned",
    "Pending shutdown.", "Too many files", "Too many megabytes",
    "Disallowed extension",
})


def transfer_state(value):
    """Upstream TransferStatus string -> enum string.

    `None` is the only thing that is genuinely unknown: upstream's saved
    transfer list leaves the status unset for rows written before it had the
    field (transfers.py, `status = None` when `num_attributes < 4`). Everything
    else is a statement by somebody, even when we have no name for it.
    """
    if value in _TRANSFER_STATE:
        return _TRANSFER_STATE[value]
    if value is None or value == "":
        return "unknown"
    return "rejected"


def _attr(attributes, name):
    """Read one field off a pynicotine FileAttributes object.

    Upstream hands back a `FileAttributes` instance with __slots__, but a few
    code paths (and every hand-written test) use a plain dict, so accept both.
    Missing and absent are both None — never 0, so the frontend can tell
    "not stated" from "stated as zero".
    """
    if attributes is None:
        return None
    if isinstance(attributes, dict):
        return attributes.get(name)
    return getattr(attributes, name, None)


def file_ref(path, size, attributes):
    """Build a FileRef from a path, a size and a pynicotine FileAttributes.

    Note what is NOT here: no extension (upstream discards the wire's ext field
    as obsolete, so it is always None), no format, no tier, no transcode
    verdict. Those are all derived in TypeScript.

    The two attribute sets are disjoint in practice — lossless files carry
    duration/sampleRate/bitDepth and no bitrate; lossy files carry
    bitrate/duration/vbr and no sampleRate/bitDepth (RECON.md §4). This function
    does not enforce that, because a peer can send anything and we forward what
    we were actually given.
    """
    vbr = _attr(attributes, "vbr")

    return {
        "path": path,
        "size": int(size or 0),
        "bitrate": _int_or_none(_attr(attributes, "bitrate")),
        "duration": _int_or_none(_attr(attributes, "length")),
        "sampleRate": _int_or_none(_attr(attributes, "sample_rate")),
        "bitDepth": _int_or_none(_attr(attributes, "bit_depth")),
        # The VBR flag is an integer 0/1 on the wire; None means not stated,
        # which is NOT the same as false.
        "isVbr": None if vbr is None else bool(vbr),
    }


def _int_or_none(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def file_refs_from_search(file_list):
    """FileSearchResponse.list -> [FileRef].

    Each entry is `(code, name, size, ext, attrs)` where `name` is the FULL
    virtual path (unlike browse/folder-contents, where it is a basename).
    """
    out = []
    for entry in file_list or ():
        # Upstream yields 5-tuples; tolerate longer ones, as its own consumers do.
        _code, name, size, _ext, attributes = entry[:5]
        out.append(file_ref(name, size, attributes))
    return out


def file_refs_from_folder(folder_path, file_list):
    """Browse / folder-contents file list -> [FileRef] with FULL paths.

    `name` is a bare basename in these messages. Upstream rebuilds the full path
    as `"\\".join([folder_path, basename])` (userbrowse.py:338); we do the same,
    so the frontend never has to know which message a file came from.
    """
    out = []
    for entry in file_list or ():
        _code, name, size, _ext, attributes = entry[:5]
        out.append(file_ref("\\".join([folder_path, name]), size, attributes))
    return out


def peer_stats(username, *, free_slots, upload_speed, queue_length,
               files=None, folders=None, country=None):
    """Build PeerStats.

    `free_slots`/`queue_length` are forwarded RAW. Upstream's GTK client
    rewrites queue_length to 0 whenever free_slots is true (gtkgui/search.py:942)
    — that is a display decision and it does not belong on the wire.
    """
    return {
        "username": username,
        "freeSlots": bool(free_slots),
        "advertisedSpeed": int(upload_speed or 0),
        "queueLength": int(queue_length or 0),
        "files": None if files is None else int(files),
        "folders": None if folders is None else int(folders),
        "country": country or None,
    }


def peer_stats_from_search(msg, *, country=None, files=None, folders=None):
    """FileSearchResponse -> PeerStats.

    Uses `msg.username` (the connection-authenticated name assigned by
    slskproto.py:719), NOT `msg.search_username`, which is self-reported inside
    the message payload and must never be trusted for identity.
    """
    return peer_stats(
        msg.username,
        free_slots=msg.freeulslots,
        upload_speed=msg.ulspeed,
        queue_length=msg.inqueue,
        files=files,
        folders=folders,
        country=country,
    )


def folder_refs_from_browse(public_list, private_list):
    """SharedFileListResponse.list / .privatelist -> [FolderRef]."""
    out = []
    for entries, is_private in ((public_list or (), False), (private_list or (), True)):
        for folder_path, files in entries:
            out.append({
                "path": folder_path,
                "files": file_refs_from_folder(folder_path, files),
                "private": is_private,
            })
    return out


def folder_refs_from_contents(folder_map):
    """FolderContentsResponse.list (a dict) -> [FolderRef].

    Note this one is a dict, while browse hands back a list of pairs. Upstream
    is genuinely inconsistent here (RECON.md §6).
    """
    out = []
    for folder_path, files in (folder_map or {}).items():
        out.append({
            "path": folder_path,
            "files": file_refs_from_folder(folder_path, files),
            "private": False,
        })
    return out


def connection_stats(total_conns=0, download_bandwidth=0, upload_bandwidth=0):
    """set-connection-stats -> ConnectionStats.

    Upstream emits this event with keyword args once a second AND with NO
    arguments at all as a reset (slskproto.py:1264, 1624, 2957). The defaults
    here are what make the no-argument form safe; without them the call raises
    TypeError inside events.emit, which upstream escalates by calling
    core.quit() and re-raising (events.py:275).
    """
    return {
        "connections": int(total_conns or 0),
        "downloadBandwidth": int(download_bandwidth or 0),
        "uploadBandwidth": int(upload_bandwidth or 0),
    }


def transfer(record, upstream_transfer):
    """(SidecarTransfer, pynicotine Transfer) -> wire Transfer.

    `record` supplies the stable id, the direction and the stall verdict;
    `upstream_transfer` supplies everything upstream actually tracks. Every
    field read below is on the shared Transfer class, so this works unchanged
    for an upload — pynicotine uses one type for both and keeps them in
    separate lists.
    """
    t = upstream_transfer
    state = transfer_state(t.status)
    size = int(t.size or 0)
    done = int(t.current_byte_offset or 0)

    # Upstream leaves time_left at 0 both when the transfer is instantaneous and
    # when speed is 0 and it simply cannot know. Only report a number when it
    # could actually have been computed.
    speed = int(t.speed or 0)
    seconds_left = int(t.time_left) if (speed > 0 and t.time_left) else None

    # queue_position is 0 both for "not queued" and "peer hasn't told us".
    queue_position = int(t.queue_position or 0) or None

    return {
        "id": record.id,
        # From the RECORD, not from the upstream object: pynicotine's Transfer
        # is the same class both ways and does not know which list it is in.
        "direction": record.direction,
        "username": t.username,
        "path": t.virtual_path,
        "localFolder": t.folder_path or None,
        "size": size,
        "bytesDone": done,
        "state": state,
        "speed": speed,
        "averageSpeed": int(t.avg_speed or 0),
        "queuePosition": queue_position,
        "secondsLeft": seconds_left,
        "secondsElapsed": int(t.time_elapsed or 0),
        "stalled": bool(record.stalled),
        "file": record.file,
        # For 'rejected' this is the only surviving copy of what the peer
        # said. Dropping it is what made every refusal read "unknown".
        "error": t.status if (state in FAILED_STATES or state == "rejected") else None,
    }
