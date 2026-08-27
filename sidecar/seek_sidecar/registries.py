# Seek — search and transfer bookkeeping.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Two registries that hold everything upstream does not:
#
#   SearchRegistry   — result batching, result caps, idle timeouts, and the
#                      close reason. Soulseek has no completion signal, so
#                      "this search is over" is entirely a decision made here
#                      (RECON.md §3).
#   TransferRegistry — stable transfer ids and stall detection. Upstream has
#                      neither (RECON.md §5).
#
# Both are pure bookkeeping: no pynicotine imports, no sockets, no clock except
# the one passed in. That is what makes them testable without a network.

import hashlib
import time
from collections import OrderedDict

DEFAULT_RESULT_CAP = 5_000
DEFAULT_IDLE_TIMEOUT = 30.0
DEFAULT_BATCH_INTERVAL = 0.25
DEFAULT_STALL_SECONDS = 45


def transfer_id(username, virtual_path):
    """Stable opaque handle for a (user, path) pair.

    Upstream keys its transfer dict on `username + virtual_path` — bare string
    concatenation with no separator (transfers.py:396), which is ambiguous in
    principle. We hash with an explicit NUL separator so the ambiguity cannot
    exist, and so the frontend gets an opaque handle rather than something it
    might be tempted to parse.
    """
    digest = hashlib.sha1(
        username.encode("utf-8") + b"\x00" + virtual_path.encode("utf-8")
    )
    return digest.hexdigest()[:16]


def transfer_key(direction, username, virtual_path):
    """Stable opaque handle for one transfer, IN ONE DIRECTION.

    Direction is part of the key and has to be. Without it a download from a
    peer and an upload to that same peer collide the moment the two virtual
    paths match — which is not exotic: download an album from someone into a
    folder you share, and they can fetch it straight back under a path that
    differs only by your share's virtual name, or not at all. One registry
    record would then serve both, so a finishing upload would overwrite a
    running download's progress, and the two would share one entry in the
    persisted `transfer_outcomes` map, which exists to make peer reliability
    count each transfer once.

    `transfer_id` above stays as it is because it is not really about
    transfers: most of its callers mint request ids for lookups.
    """
    return transfer_id(f"{direction}\x00{username}", virtual_path)


class PendingBatch:
    """Results accumulated for one peer within one search, awaiting a flush."""

    __slots__ = ("peer", "files", "private", "first_at")

    def __init__(self, peer, private, now):
        self.peer = peer
        self.files = []
        self.private = private
        self.first_at = now


class Search:
    """One live search."""

    __slots__ = ("token", "query", "term_transmitted", "mode", "started_at",
                 "result_cap", "idle_timeout", "result_count", "peers",
                 "last_result_at", "closed", "_batches")

    def __init__(self, token, query, term_transmitted, mode, now,
                 result_cap=DEFAULT_RESULT_CAP, idle_timeout=DEFAULT_IDLE_TIMEOUT):
        self.token = token
        self.query = query
        self.term_transmitted = term_transmitted
        self.mode = mode
        self.started_at = now
        self.result_cap = result_cap
        self.idle_timeout = idle_timeout
        self.result_count = 0
        self.peers = set()
        self.last_result_at = now
        self.closed = None
        self._batches = OrderedDict()  # (username, private) -> PendingBatch

    def info(self):
        return {
            "searchId": self.token,
            "query": self.query,
            "termTransmitted": self.term_transmitted,
            "mode": self.mode,
            "startedAt": self.started_at,
            "resultCount": self.result_count,
        }


class SearchRegistry:
    """Batches incoming results and decides when a search stops listening.

    Batching matters: a busy search produces hundreds of upstream events per
    second, and waking the frontend for each one would blow the brief's frame
    budget before a single row is drawn. Results are coalesced per (peer,
    visibility) and flushed on an interval.
    """

    def __init__(self, batch_interval=DEFAULT_BATCH_INTERVAL, clock=time.monotonic):
        self.searches = {}
        self.batch_interval = batch_interval
        self._clock = clock
        self._last_flush = clock()

    # -- lifecycle ---------------------------------------------------------

    def add(self, token, query, term_transmitted, mode,
            result_cap=None, idle_timeout=None):
        search = Search(
            token, query, term_transmitted, mode, self._clock(),
            result_cap=result_cap or DEFAULT_RESULT_CAP,
            idle_timeout=idle_timeout or DEFAULT_IDLE_TIMEOUT,
        )
        self.searches[token] = search
        return search

    def get(self, token):
        return self.searches.get(token)

    def close(self, token, reason):
        """Mark a search closed. Returns the SearchClosedEvent payload, or None
        if the search is unknown or already closed."""
        search = self.searches.get(token)
        if search is None or search.closed is not None:
            return None
        search.closed = reason
        return {
            "searchId": token,
            "reason": reason,
            "resultCount": search.result_count,
            "peerCount": len(search.peers),
        }

    def remove(self, token):
        return self.searches.pop(token, None)

    # -- ingest ------------------------------------------------------------

    def accept(self, token, peer, files, private=False):
        """Queue a batch of results. Returns the close reason if this batch
        pushed the search over its cap, else None.

        Files beyond the cap are dropped rather than partially accepted, so the
        reported resultCount always matches what the frontend actually received.
        """
        search = self.searches.get(token)
        if search is None or search.closed is not None or not files:
            return None

        remaining = search.result_cap - search.result_count
        if remaining <= 0:
            return "result_cap"
        if len(files) > remaining:
            files = files[:remaining]

        key = (peer["username"], private)
        batch = search._batches.get(key)
        if batch is None:
            batch = search._batches[key] = PendingBatch(peer, private, self._clock())
        else:
            # Refresh the peer's stats — the newest response wins.
            batch.peer = peer
        batch.files.extend(files)

        search.result_count += len(files)
        search.peers.add(peer["username"])
        search.last_result_at = self._clock()

        if search.result_count >= search.result_cap:
            return "result_cap"
        return None

    # -- flush -------------------------------------------------------------

    def due(self, now=None):
        now = self._clock() if now is None else now
        return (now - self._last_flush) >= self.batch_interval

    def flush(self, now=None):
        """Drain every pending batch into SearchResultEvent payloads."""
        now = self._clock() if now is None else now
        self._last_flush = now
        events = []
        for search in self.searches.values():
            if not search._batches:
                continue
            batches, search._batches = search._batches, OrderedDict()
            for batch in batches.values():
                events.append({
                    "searchId": search.token,
                    "peer": batch.peer,
                    "files": batch.files,
                    "private": batch.private,
                    "receivedAt": time.time(),
                })
        return events

    def expired(self, now=None):
        """Searches whose idle timeout has elapsed. Returns [(token, reason)]."""
        now = self._clock() if now is None else now
        out = []
        for search in self.searches.values():
            if search.closed is not None:
                continue
            if (now - search.last_result_at) >= search.idle_timeout:
                out.append((search.token, "timeout"))
        return out

    def close_all(self, reason):
        out = []
        for token in list(self.searches):
            payload = self.close(token, reason)
            if payload is not None:
                out.append(payload)
        return out


class TransferRecord:
    """Sidecar-side state for one transfer, in either direction."""

    __slots__ = ("id", "direction", "username", "path", "file", "last_offset",
                 "last_progress_at", "stalled", "last_emitted_state",
                 "finished_at")

    def __init__(self, direction, username, path, file=None, now=0.0):
        self.id = transfer_key(direction, username, path)
        #: "download" or "upload". Decides which upstream component owns this
        #: transfer, and whether it counts towards peer reliability at all.
        self.direction = direction
        self.username = username
        self.path = path
        self.file = file
        self.last_offset = 0
        self.last_progress_at = now
        self.stalled = False
        self.last_emitted_state = None
        #: Wall-clock epoch seconds when this first read 'finished', 0 while it
        #: has not. WALL clock, not the monotonic one the stall timer uses: this
        #: one is compared against a threshold in DAYS and has to survive being
        #: read by a human, and monotonic time has no meaning across a restart.
        self.finished_at = 0.0


class TransferRegistry:
    """Stable ids, the FileRef carried over from search, and stall detection.

    Stall detection is a Seek invention. Upstream has no stall event, no timer
    and no status for it — the only related signals are the
    `Connection timeout` / `Connection closed` statuses, which arrive after the
    socket has already given up. A download that is nominally "Transferring"
    but has moved zero bytes for a while is invisible upstream, and it is
    exactly the thing a user staring at the Transfers view needs to be told.
    """

    def __init__(self, stall_seconds=DEFAULT_STALL_SECONDS, clock=time.monotonic):
        self.records = {}          # id -> TransferRecord
        self.stall_seconds = stall_seconds
        self._clock = clock

    def record_for(self, direction, username, path, file=None):
        """Get or create the record for a (direction, user, path)."""
        key = transfer_key(direction, username, path)
        record = self.records.get(key)
        if record is None:
            record = self.records[key] = TransferRecord(
                direction, username, path, file, self._clock()
            )
        elif file is not None and record.file is None:
            # A re-enqueue that supplies attributes we didn't have before.
            record.file = file
        return record

    def since_progress(self, record):
        """Seconds since this transfer's byte offset last moved.

        Only meaningful beside `stalled`, which is the flag that says the
        offset was SUPPOSED to be moving. For a queued or paused transfer this
        is simply time since the last observation of it, which is not a stall
        and must not be read as one.

        Exists because `stalled` is a boolean and the question a stalled
        download actually raises is *how long*. Without it the frontend cannot
        tell a peer that hiccuped ten seconds ago from one that has been silent
        since yesterday, and cannot offer to sweep the second kind away.
        """
        return max(0, int(self._clock() - record.last_progress_at))

    def get(self, transfer_id_):
        return self.records.get(transfer_id_)

    def forget(self, transfer_id_):
        return self.records.pop(transfer_id_, None)

    def mark_finished(self, record, state):
        """Stamp the completion time the first time a transfer reads finished.

        First time only: upstream re-emits a finished transfer on every list
        refresh, and re-stamping would keep pushing the age back to zero, so an
        age-based clear would never fire for anything.

        Note what this CANNOT know. After a sidecar restart the records are
        rebuilt from upstream's restored list and every finished transfer is
        stamped now, because nothing durable records when it actually landed.
        That errs late — a completed download survives one threshold longer than
        it should — which is the right direction for the only setting here that
        forgets something.
        """
        if state == "finished":
            if not record.finished_at:
                record.finished_at = time.time()
        elif record.finished_at:
            # Retried, or upstream changed its mind. It is not finished now.
            record.finished_at = 0.0

    def observe(self, record, state, byte_offset):
        """Feed a progress observation in. Returns True if `stalled` flipped.

        Only `transferring` can stall. Any other state clears the flag — a
        paused or queued download is not stalled, it is paused or queued, and
        conflating them would be a lie in the UI.
        """
        now = self._clock()
        offset = int(byte_offset or 0)
        self.mark_finished(record, state)

        if state != "transferring":
            record.last_offset = offset
            record.last_progress_at = now
            if record.stalled:
                record.stalled = False
                return True
            return False

        if offset != record.last_offset:
            record.last_offset = offset
            record.last_progress_at = now
            if record.stalled:
                record.stalled = False
                return True
            return False

        stalled = (now - record.last_progress_at) >= self.stall_seconds
        if stalled != record.stalled:
            record.stalled = stalled
            return True
        return False

    def sweep(self):
        """Re-evaluate stall state for transfers that have stopped ticking.

        Needed because a fully stalled transfer produces NO events at all — the
        network thread stops emitting progress, so nothing would ever call
        observe() again. Without this sweep a stall is undetectable by
        construction.
        """
        now = self._clock()
        flipped = []
        for record in self.records.values():
            if record.last_emitted_state != "transferring" or record.stalled:
                continue
            if (now - record.last_progress_at) >= self.stall_seconds:
                record.stalled = True
                flipped.append(record)
        return flipped
