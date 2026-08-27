"""
GENERATED FILE — DO NOT EDIT.
Source of truth: shared/schema.py
Regenerate:      python3 shared/generate_protocol.py
Verified by:     sidecar/tests/test_protocol_sync.py

Seek — wire protocol, Python side.
Copyright (C) 2026 Seek contributors.
SPDX-License-Identifier: GPL-3.0-or-later

TypedDicts mirror shared/protocol.ts exactly. VALIDATORS is a runtime
description of the same schema, used by validate() to check every frame
the sidecar emits and every command it accepts — TypedDicts are erased at
runtime, so they alone would prove nothing.
"""

from typing import Dict, List, Literal, Optional, Tuple, TypedDict

PROTOCOL_VERSION = 1


# ----------------------------------------------------------------- enums

ChatScope = Literal["room", "private"]
"""Which conversation a chat line belongs to."""

ChatMessageKind = Literal["message", "action", "local", "hilite"]
"""
How the line should read. 'action' is the /me form; 'local' is
client-generated and never touched the network.
"""

ConnectionStatus = Literal["offline", "connecting", "online", "away", "failed"]
"""Sidecar's view of the Soulseek server connection."""

UserStatus = Literal["offline", "away", "online"]
"""Peer presence. Mirrors upstream UserStatus (0/1/2) as strings."""

SearchMode = Literal["global", "rooms", "buddies", "user", "wishlist"]
"""
Which population a search is broadcast to. Mirrors
pynicotine.search.Search.do_search(mode=...).
"""

SearchCloseReason = Literal["timeout", "result_cap", "stopped", "disconnected"]
"""
Why the sidecar stopped accepting results for a search. Soulseek has NO
server-side completion signal (see RECON.md §3) — every value here is a
client-side decision, not a network fact.
"""

TransferDirection = Literal["download", "upload"]
"""
Which way a transfer is going.

Both share one event stream and one id space, because they are the same kind
of thing and the frontend groups them the same way. The id carries the
direction (`registries.transfer_key`) so a download from a peer and an
upload to that peer of a matching virtual path cannot collide — which is not
exotic, since a folder you downloaded into is often a folder you share.
"""

TransferState = Literal[
    "queued",
    "rejected",
    "getting_status",
    "transferring",
    "paused",
    "cancelled",
    "filtered",
    "finished",
    "user_logged_off",
    "connection_closed",
    "connection_timeout",
    "download_folder_error",
    "local_file_error",
    "unknown",
]
"""
pynicotine.transfers.TransferStatus, lowercased and underscored, plus one
state upstream has no name for.

'rejected' is the peer refusing, and it exists because upstream writes the
refusal STRAIGHT INTO `transfer.status` (downloads.py,
`_abort_transfer(download, status=reason)`). Those strings are
TransferRejectReason values - 'File not shared.', 'Banned', 'Pending
shutdown.' - and peers also send free text, e.g. anything starting 'User
limit of'. None of them are TransferStatus values, so mapping only the
closed set turned every refusal into 'unknown' AND discarded what the peer
actually said. That is what a download reading 'unknown' in 0.2.1 meant:
someone told you why and Seek threw it away.

For 'rejected' the reason is carried verbatim in `Transfer.error`. 'unknown'
now means only what it says - upstream had no status at all, which happens
for a restored transfer whose saved row predates the field.
"""

ErrorCode = Literal[
    "bad_request",
    "unknown_command",
    "not_connected",
    "already_queued",
    "not_found",
    "unsupported",
    "internal",
]
"""Machine-readable failure reasons for command replies."""

SpectralAssessment = Literal[
    "likely_lossless",
    "possible_transcode",
    "strong_signs_of_lossy_source",
    "inconclusive",
]
"""
Conclusion of a post-download spectral check. Deliberately hedged: a lowpass
shelf is strong evidence but never proof, and quiet or sparse music
genuinely lacks high-frequency energy. Never render any of these as a
definitive verdict — there is no 'fake' value here on purpose.
"""

ShareConsent = Literal["unset", "granted", "declined"]
"""
Whether the user has decided what to share back to the network.

'declined' is a real, persisted answer, not an absence of one, and the
app is expected to surface it permanently: Soulseek is reciprocal, and
peers deprioritise and ban clients that share nothing. Throttled
transfers and refused queues then look like a bug in Seek rather than
the network working exactly as designed.
"""

LogLevel = Literal["debug", "info", "warning", "error"]
"""Severity of a forwarded sidecar/core log line."""

WantSource = Literal["youtube", "bandcamp", "discogs", "manual", "fingerprint"]
"""
Where the user found a piece of music. 'manual' is a typed entry;
'fingerprint' is an AcoustID identification.
"""

WantStatus = Literal["pending", "searching", "found", "downloaded", "not_found"]
"""
Where a want list entry sits in the seek-evaluate-download loop.

'found' and 'not_found' are decided by the FRONTEND, after a search it
ran, by matching results against the entry. The sidecar only stores the
answer: Soulseek has no completion signal (RECON.md §3), so 'not_found'
is a client-side timeout decision, and whether a result actually IS the
thing you wanted is fuzzy matching over parsed paths, which lives in
app/src/domain/.
"""

DiscoverKind = Literal["track", "release", "artist", "label"]
"""
What a discovery URL actually names. A label or artist URL is not something
to search for directly — it is a catalogue to browse, and the frontend
offers a different action for it.
"""


ENUM_VALUES: Dict[str, Tuple[str, ...]] = {
    "ChatScope": ("room", "private",),
    "ChatMessageKind": ("message", "action", "local", "hilite",),
    "ConnectionStatus": ("offline", "connecting", "online", "away", "failed",),
    "UserStatus": ("offline", "away", "online",),
    "SearchMode": ("global", "rooms", "buddies", "user", "wishlist",),
    "SearchCloseReason": ("timeout", "result_cap", "stopped", "disconnected",),
    "TransferDirection": ("download", "upload",),
    "TransferState": ("queued", "rejected", "getting_status", "transferring", "paused", "cancelled", "filtered", "finished", "user_logged_off", "connection_closed", "connection_timeout", "download_folder_error", "local_file_error", "unknown",),
    "ErrorCode": ("bad_request", "unknown_command", "not_connected", "already_queued", "not_found", "unsupported", "internal",),
    "SpectralAssessment": ("likely_lossless", "possible_transcode", "strong_signs_of_lossy_source", "inconclusive",),
    "ShareConsent": ("unset", "granted", "declined",),
    "LogLevel": ("debug", "info", "warning", "error",),
    "WantSource": ("youtube", "bandcamp", "discogs", "manual", "fingerprint",),
    "WantStatus": ("pending", "searching", "found", "downloaded", "not_found",),
    "DiscoverKind": ("track", "release", "artist", "label",),
}


# --------------------------------------------------------------- structs

class FileRef(TypedDict):
    """
    One file offered by one peer. This is the atom of the whole protocol.

    IMPORTANT (RECON.md §4): the audio attributes below arrive in two
    DISJOINT sets, because that is what FileListMessage.pack_file_info()
    puts on the wire:
      lossless -> duration, sampleRate, bitDepth   (bitrate/isVbr are null)
      lossy    -> bitrate, duration, isVbr         (sampleRate/bitDepth
    null)
    Any or all of them may also be null for peers running clients that send
    no attributes at all. Never assume a field is present.
    """
    # Full virtual path exactly as the peer sent it, backslash-separated.
    # Upstream rewrites '/' to '\\' but performs no other normalisation, and
    # neither do we. This is the identity of the file on that peer.
    path: str
    # File size in bytes.
    size: int
    # Advertised bitrate in kbps (FileAttribute.BITRATE). A CLAIM by the peer,
    # not a measurement. Null for lossless files and for peers that send no
    # attributes.
    bitrate: Optional[int]
    # Length in whole seconds (FileAttribute.LENGTH). Null when absent.
    # Without this, no size-vs-bitrate check is possible at all.
    duration: Optional[int]
    # Sample rate in Hz (FileAttribute.SAMPLE_RATE). In practice only present
    # on lossless files.
    sampleRate: Optional[int]
    # Bits per sample (FileAttribute.BIT_DEPTH). In practice only present on
    # lossless files, and is what upstream uses to decide a file IS lossless
    # when encoding.
    bitDepth: Optional[int]
    # Variable bitrate flag (FileAttribute.VBR). Null on lossless files and
    # when absent. Note upstream discards FileAttribute.ENCODER entirely
    # (RECON.md §4), so no encoder string is available.
    isVbr: Optional[bool]


class PeerStats(TypedDict):
    """
    Per-peer facts. `freeSlots`/`queueLength`/`advertisedSpeed` arrive with
    every search response; `files`/`folders` only arrive from the server via
    user-stats, and are null until then.
    """
    # Connection-authenticated peer name (msg.username).
    username: str
    # Peer has a free upload slot right now (`freeulslots`). Forwarded raw —
    # upstream's GTK client rewrites queueLength to 0 when this is true, and
    # we deliberately do not.
    freeSlots: bool
    # Peer's self-reported average upload speed in BYTES per second
    # (`ulspeed`). A promise, not a measurement — the UI must render it
    # distinctly from an observed transfer speed.
    advertisedSpeed: int
    # Number of files queued on that peer (`inqueue`), as reported.
    queueLength: int
    # Total files the peer shares, per the server. Null unless a user-stats
    # update has been seen.
    files: Optional[int]
    # Total folders the peer shares, per the server. Null unless a user-stats
    # update has been seen.
    folders: Optional[int]
    # Two-letter country code resolved from the peer's IP, when known.
    country: Optional[str]


class FolderRef(TypedDict):
    """
    A folder and its files. Used by browse and folder-contents results. Note
    that `FileRef.path` here is always rebuilt into a FULL path by the
    sidecar — upstream hands back bare basenames for browse/folder-contents
    but full paths for search, and that inconsistency does not reach the
    wire (RECON.md §6).
    """
    # Full folder path, backslash-separated.
    path: str
    # Files directly in this folder.
    files: List["FileRef"]
    # True if the peer returned this folder in their buddy-only share list
    # rather than their public one.
    private: bool


class ErrorInfo(TypedDict):
    """Failure detail on a command reply."""
    # Machine-readable reason.
    code: "ErrorCode"
    # Developer-facing English text. Not for display.
    message: str


class HelloParams(TypedDict):
    """First frame the client sends after the socket opens."""
    # Client's PROTOCOL_VERSION.
    protocolVersion: int
    # Free-form client identifier, for the sidecar log.
    client: str


class HelloResult(TypedDict):
    """
    Sidecar's handshake reply, including a full state snapshot so the
    frontend never has to guess after a reconnect.
    """
    # Sidecar's PROTOCOL_VERSION.
    protocolVersion: int
    # Seek sidecar version string.
    sidecarVersion: str
    # Upstream pynicotine __version__ in use.
    coreVersion: str
    # Current connection state.
    connection: "ConnectionState"
    # Every download the core currently knows about.
    transfers: List["Transfer"]
    # Searches still accepting results.
    searches: List["SearchInfo"]


class ConnectParams(TypedDict):
    """
    Log in to the Soulseek server. The sidecar writes credentials into the
    isolated Seek config and never into the user's own Nicotine+ config.

    Both fields are nullable, and null means 'use whatever is already
    stored'. That is how signing in after an import works: the import has
    already written the credentials, so re-sending them would mean pulling a
    password back out of the sidecar and across the socket just to hand it
    straight back.
    """
    # Soulseek account name, or null to use the stored one.
    username: Optional[str]
    # Soulseek account password, or null to use the stored one. Sent in the
    # clear over the loopback socket when the user types it into the manual
    # sign-in form — the socket is loopback-only and token-gated, and there is
    # no way to authenticate a new account without transmitting it once. It is
    # never echoed back, never logged, and never returned by any command.
    password: Optional[str]


class SearchStartParams(TypedDict):
    """Begin a search."""
    # Raw user query. The sidecar passes it to upstream, which sanitises it;
    # the transmitted form comes back on `search.started`.
    query: str
    # Defaults to 'global'.
    mode: Optional["SearchMode"]
    # Required when mode is 'rooms'.
    room: Optional[str]
    # Required when mode is 'user'. Empty otherwise.
    users: List[str]
    # Stop accepting results after this many files. Null uses the sidecar
    # default. Emits `search.closed` with reason 'result_cap'.
    resultCap: Optional[int]
    # Stop accepting results this long after the last one arrived. Null uses
    # the sidecar default.
    timeoutSeconds: Optional[int]


class SearchStartResult(TypedDict):
    # Upstream search token. Stable for the search's life.
    searchId: int


class SearchStopParams(TypedDict):
    searchId: int


class SearchInfo(TypedDict):
    """A search the sidecar is still accepting results for."""
    searchId: int
    # The term as the user typed it, after upstream trimming.
    query: str
    # What actually went out on the wire. Upstream strips punctuation that
    # stops SoulseekQt from responding, so this often differs.
    termTransmitted: str
    mode: "SearchMode"
    # Unix epoch seconds, float.
    startedAt: float
    # Files accepted so far across all peers.
    resultCount: int


class UserBrowseParams(TypedDict):
    username: str


class UserStatsParams(TypedDict):
    """Ask the server for a peer's stats, and watch them for updates."""
    username: str


class TransferEnqueueParams(TypedDict):
    """Queue one file for download."""
    username: str
    # Full virtual path, exactly as it came from the peer.
    path: str
    # Size in bytes, from the search result.
    size: int
    # The original FileRef, if the client still has it. Passing it lets the
    # sidecar carry the audio attributes into the transfer record so the UI
    # keeps its quality badge while downloading.
    file: Optional["FileRef"]
    # Absolute local folder. Null uses the configured download folder.
    destination: Optional[str]
    # Enqueue in paused state. Defaults false.
    paused: Optional[bool]


class TransferEnqueueResult(TypedDict):
    # Stable opaque id minted by the sidecar.
    transferId: str
    # True if this (user, path) was already known. Upstream's
    # enqueue_download() silently no-ops on duplicates; we surface it.
    alreadyQueued: bool


class TransferFolderParams(TypedDict):
    """
    Queue a whole remote folder. The sidecar performs the two-phase
    request_folder -> folder-contents-response -> enqueue dance (RECON.md
    §5) and reports progress via `folder.contents` then `transfer.added`
    events.
    """
    username: str
    # Full remote folder path.
    folderPath: str
    # Include subfolders. Defaults false.
    recurse: Optional[bool]
    # Absolute local folder. Null uses the default.
    destination: Optional[str]


class TransferFolderResult(TypedDict):
    # Correlates the later `folder.contents` event with this request.
    requestId: str


class OrganiseResult(TypedDict):
    # False when there was no confident match.
    moved: bool
    fromPath: str
    # Empty when nothing moved.
    toPath: str
    # Why not, when it did not move.
    reason: str


class PreviewParams(TypedDict):
    # Absolute local path, or null to use transferId.
    path: Optional[str]
    # A finished transfer.
    transferId: Optional[str]
    # Where to start. Defaults to a little in.
    startSeconds: Optional[int]
    # How long. Clamped to a sane maximum.
    seconds: Optional[int]


class PreviewResult(TypedDict):
    """
    A decoded excerpt, downmixed to mono and resampled down, because this
    crosses a socket and is for judging a track rather than listening to it
    properly.
    """
    requestId: str
    path: str
    # data:audio/wav;base64,...
    dataUri: str
    startSeconds: int
    # Actual length returned; a short file gives less.
    seconds: float
    # Full length of the source file.
    durationSeconds: float


class PreviewFailed(TypedDict):
    requestId: str
    reason: str


class AppSettings(TypedDict):
    # Sign in to Soulseek on launch using the stored account. This is
    # upstream's own `auto_connect_startup` flag, read and written where it
    # actually lives rather than mirrored into Seek's state.
    autoConnect: bool
    # Whether an account is stored at all.
    hasCredentials: bool
    # The stored account name. Never the password.
    username: str
    # Allow MusicBrainz, Cover Art Archive, Deezer and Discogs. Off means off:
    # no request leaves the machine.
    externalLookups: bool
    # Whether a token is stored. Never the value.
    discogsToken: bool
    # Cache cap in megabytes.
    artworkCacheMb: int
    # Default for the metadata panel's embed box.
    embedArtwork: bool
    # Also write cover.jpg beside the tracks.
    writeCoverFile: bool
    # When a track has several sources, queue the best LOSSLESS one rather
    # than the highest overall score. A free fast 320 usually out-scores a
    # queued FLAC; this says which you actually want.
    preferLossless: bool
    # Refuse lossy files below this. 0 disables.
    minBitrate: int
    # Refuse files the physics check flags.
    rejectTranscodes: bool
    # Move completed downloads into Artist/Year - Album/ using the MusicBrainz
    # match. Off by default: moving a user's files without being asked is not
    # a default anyone should inherit.
    autoOrganise: bool
    # Whether a key is stored. NEVER the value — same rule as the Discogs
    # token: a credential does not echo back across the socket once it has
    # been sent.
    acoustidApiKey: bool
    # Whether a key is stored. NEVER the value — same rule as the Discogs
    # token and the AcoustID key. Reading a public playlist needs only this
    # simple API key; the OAuth client YouTube also offers is for a user's
    # PRIVATE data and is deliberately not used, so there is no client secret
    # to hold.
    youtubeApiKey: bool
    # Group a burst of want list additions into a digging session. On by
    # default — it only ever adds a grouping, never changes or hides an entry,
    # and it can be switched off here.
    autoDigSessions: bool


class AppSettingsPatch(TypedDict):
    """
    Every field nullable: null means 'leave this alone'. An absent value and
    an intentionally empty one are different things.
    """
    autoConnect: Optional[bool]
    externalLookups: Optional[bool]
    # Send an empty string to clear it.
    discogsToken: Optional[str]
    artworkCacheMb: Optional[int]
    embedArtwork: Optional[bool]
    writeCoverFile: Optional[bool]
    preferLossless: Optional[bool]
    minBitrate: Optional[int]
    rejectTranscodes: Optional[bool]
    autoOrganise: Optional[bool]
    # The key itself, for writing. Empty clears it.
    acoustidApiKey: Optional[str]
    # The key itself, for writing. Empty clears it.
    youtubeApiKey: Optional[str]
    autoDigSessions: Optional[bool]


class PeerRecord(TypedDict):
    username: str
    # Transfers that finished.
    ok: int
    # Transfers that errored or lost the peer.
    failed: int
    # Unix seconds of the last outcome.
    lastSeen: int


class PeerHistory(TypedDict):
    items: List["PeerRecord"]


class WishParams(TypedDict):
    # The search text to wish for.
    query: str


class LibraryState(TypedDict):
    # Unix seconds. 0 if never scanned.
    scannedAt: int
    # Folders the index was built from.
    roots: List[str]
    releaseCount: int
    trackCount: int
    scanning: bool


class LibraryScanParams(TypedDict):
    # Extra folders to include. The download folder is always scanned; these
    # are added to it.
    roots: List[str]
    # Read tags as well as paths. Much slower over a network volume, but far
    # more accurate. Defaults true.
    readTags: Optional[bool]


class LibraryRelease(TypedDict):
    # Normalised artist|release, matched against search results.
    key: str
    artist: str
    release: str
    # Where it lives on disk.
    folder: str
    trackCount: int
    bytes: int
    # Extension counts as JSON, e.g. {"flac": 12}. Opaque to the sidecar: what
    # the mix MEANS is a presentation question, and presentation is
    # TypeScript's job.
    formats: str
    # 0 when no tag carried a plausible one.
    year: int
    # First genre seen in the folder. Often empty.
    genre: str


class LibraryReleases(TypedDict):
    items: List["LibraryRelease"]


class LibraryGap(TypedDict):
    position: int
    title: str
    artist: str
    # Present on disk.
    have: bool


class LibraryGaps(TypedDict):
    # Echoes the request.
    key: str
    # False when MusicBrainz had no confident match.
    matched: bool
    releaseTitle: str
    releaseArtist: str
    score: int
    # The full official track list, marked.
    tracks: List["LibraryGap"]


class LibraryOwned(TypedDict):
    # Release keys.
    releases: List[str]
    # Track keys.
    tracks: List[str]


class ArtworkParams(TypedDict):
    # May be empty; the release name alone often matches.
    artist: str
    # Release or folder name, as parsed.
    release: str
    # Client-side id echoed back so the row can be found.
    key: str


class RequestAccepted(TypedDict):
    requestId: str


class ArtworkResult(TypedDict):
    """
    A cover image, as a data URI so the webview needs no file access and no
    second request.
    """
    # Echoes ArtworkParams.key.
    key: str
    requestId: str
    # data:image/...;base64,...
    dataUri: str
    # cache | coverartarchive | deezer
    source: str
    # How many tracks MusicBrainz says the release has. 0 when there was no
    # confident match — the SAME lookup that found the cover produced this, so
    # completeness costs no extra requests.
    trackCount: int
    # Release date, or empty.
    date: str
    # Label, or empty.
    label: str
    # Release MBID, or empty.
    mbid: str


class ArtworkFailed(TypedDict):
    key: str
    requestId: str
    # Developer-facing. A miss is normal, not an error.
    reason: str


class ArtworkCacheStats(TypedDict):
    entries: int
    bytes: int
    capBytes: int


class TagChange(TypedDict):
    """
    One field that would change. Named `current`/`proposed` rather than
    from/to because `from` is a Python keyword and the generated dataclass
    would not parse.
    """
    field: str
    # What the file says now. May be empty.
    current: str
    # What MusicBrainz says it should be.
    proposed: str


class MetadataProposal(TypedDict):
    """
    What MusicBrainz thinks this file should be tagged as. NOTHING is
    written until the user applies it — a wrong automatic retag is
    unrecoverable once the original filename is gone.
    """
    requestId: str
    path: str
    transferId: Optional[str]
    # False when MusicBrainz found nothing confident.
    matched: bool
    # MusicBrainz match score, 0-100. Shown so the user can weigh the
    # proposal: a 100 on a well-known release and a 72 on a white label
    # deserve different amounts of trust.
    score: int
    # What was actually searched for, after normalising.
    query: str
    # Release matched but the track did not.
    trackMatched: bool
    releaseTitle: str
    releaseArtist: str
    date: str
    label: str
    mbid: str
    # Only fields that would actually change.
    changes: List["TagChange"]


class MetadataApplyParams(TypedDict):
    path: str
    # The subset the user accepted.
    fields: List["TagChange"]
    # Also write the cover into the file.
    embedArtwork: bool
    # For the artwork lookup, if embedding.
    artist: str
    # For the artwork lookup, if embedding.
    release: str


class MetadataApplyResult(TypedDict):
    path: str
    written: int
    artworkEmbedded: bool


class WantTrack(TypedDict):
    """One track in a release's expected tracklist, as the source gives it."""
    # Track number. 0 when the source does not number it.
    position: int
    title: str
    # Empty unless the source credits the track separately, as it does on a
    # compilation.
    artist: str
    # Seconds. Null when the source does not say.
    duration: Optional[int]


class DiscoverParseUrlParams(TypedDict):
    # The URL to look up. Anything but http/https is refused, and an
    # unrecognised host is still attempted — Bandcamp answers for custom
    # domains, which no host pattern can predict.
    url: str


class DiscoverParsed(TypedDict):
    """
    What a provider says about a URL. Raw provider facts; see the note above
    this struct for why there is no parse here.
    """
    # Correlates with the discover.parseUrl command.
    requestId: str
    # The URL that was looked up, echoed back.
    url: str
    # Which provider answered. Resolved by the sidecar, because it is the only
    # side that can tell a Bandcamp custom domain from any other host: it
    # asked, and Bandcamp replied.
    sourceKind: "WantSource"
    kind: "DiscoverKind"
    # The provider's own title string, unprocessed. For YouTube this is the
    # whole of what is known and the only thing to parse.
    rawTitle: str
    # YouTube's `author_name`, the uploading channel. Load-bearing for
    # parsing: it identifies series branding and it is the fallback artist on
    # VEVO and official artist channels. Empty for the other providers.
    channel: str
    # Populated only when the PROVIDER states it as a field, which Bandcamp
    # and Discogs do. Empty for YouTube, where filling it would mean guessing
    # on the wrong side of the seam.
    artist: str
    # Same rule as `artist`. Empty for YouTube.
    title: str
    # Release title when the URL names a track on one.
    album: Optional[str]
    # When the provider gives one.
    year: Optional[int]
    label: Optional[str]
    # Discogs catalogue number, when available.
    catalogNumber: Optional[str]
    # data:image/...;base64,... — fetched BY THE SIDECAR, not linked. An <img>
    # pointing at i.ytimg.com would be the frontend making its own request to
    # a third party: it would leak the user's IP and it would run with
    # external lookups switched off, which is precisely what that switch
    # exists to prevent. Null when the provider offered no image or the fetch
    # failed, which is normal.
    artworkUri: Optional[str]
    # Seconds, when the provider says.
    duration: Optional[int]
    # Discogs genres followed by its styles, in that order. Empty for the
    # other providers.
    genres: List[str]
    # For releases, when the provider gives one. Discogs does; Bandcamp's
    # oEmbed does not, and its album page is Phase D4.
    tracklist: List["WantTrack"]
    # The canonical URL according to the provider, when it differs from what
    # was pasted.
    providerUrl: Optional[str]


class CatalogEntry(TypedDict):
    """
    One release in a label's or an artist's discography.

    NOTE WHAT IS ABSENT, twice over. There is no `inLibrary` flag, which
    `DISCOVERY.md` asks for: whether you already own a release is a match
    against the library index, and that index lives in the frontend
    (`libraryStore.ts`) with the normalised keys that do the matching.
    And there is no thumbnail. Discogs gives one URL per release, and a
    catalogue of three hundred would mean three hundred rate-limited
    fetches before the grid could draw. The artwork pipeline already
    solves that properly — placeholder first, fetch what scrolls into
    view — and this reuses it rather than inventing a slower second way.
    """
    # 0 when the provider has no numeric id.
    discogsId: int
    title: str
    artist: str
    year: Optional[int]
    # Verbatim from the provider, e.g. 'CD, Album' or '12", 33 ⅓ RPM'. A
    # comma-joined descriptor list, not a tier — deciding what it MEANS is
    # presentation. Empty on an artist discography, which Discogs does not
    # annotate.
    format: str
    # Catalogue number. Empty when the provider has none.
    catno: str
    # 'Main', 'Appearance', 'Remix', … on an artist discography. Empty for a
    # label. Load-bearing: Burial's 375 entries are mostly compilation
    # appearances, and which of those count as 'their discography' is the
    # user's call, not ours.
    role: str
    # Where to see it on the provider's own site.
    url: str


class TracklistLine(TypedDict):
    """
    One timestamped line lifted out of a video description, UNPARSED.

    `text` is whatever followed the timestamp, verbatim. Turning
    'Burial - Archangel' into an artist and a title is the same derivation
    `parseTitle.ts` already does for video titles, against forty other
    shapes — so the line goes across raw and is parsed there rather than
    growing a second, differently-wrong splitter down here.
    """
    # 1-based, in description order.
    position: int
    # Where it starts in the set.
    offsetSeconds: int
    # The line with its timestamp removed.
    text: str


class DiscoverTracklist(TypedDict):
    """
    A tracklist read out of a YouTube description. Best-effort by nature:
    these are typed by hand by whoever uploaded the set.
    """
    requestId: str
    url: str
    # The set's own title, for naming the entries.
    videoTitle: str
    channel: str
    # Empty when the description had no timestamped lines, which is the
    # ordinary outcome for most videos and is not an error.
    lines: List["TracklistLine"]


class FingerprintParams(TypedDict):
    """Identify a local audio file by its acoustic fingerprint."""
    # Absolute local path.
    path: str
    # Only fingerprint the first N seconds. Null uses the default. AcoustID
    # matches on the opening of a track, so more than two minutes buys nothing
    # and costs decode time.
    durationLimit: Optional[int]


class DiscoverIdentified(TypedDict):
    """
    What AcoustID made of a fingerprint.

    `score` is AcoustID's own confidence that the FINGERPRINT matches, not
    a judgement about whether the metadata is right. Render it the way the
    rest of the app renders confidence: as a claim with its evidence, never
    as a fact.
    """
    requestId: str
    path: str
    # False when nothing scored above AcoustID's threshold, which is the
    # ordinary outcome for anything underground.
    matched: bool
    artist: str
    title: str
    album: Optional[str]
    year: Optional[int]
    # MusicBrainz recording id, when one is attached.
    mbid: Optional[str]
    # 0–1, AcoustID's own.
    score: float
    # As decoded, for the record.
    durationSeconds: float


class PlaylistParams(TypedDict):
    # The bare playlist id. discoverUrl.ts pulls it out of the URL, because
    # URL shapes are the frontend's business and Python is not in the guessing
    # seat.
    playlistId: str


class RelatedParams(TypedDict):
    artist: str
    release: str
    # When known, the strongest link there is.
    label: Optional[str]


class DiscoverRelated(TypedDict):
    """
    Music adjacent to one release. Grouped by WHY each thing is related,
    because 'more from this label' and 'more by this artist' are different
    questions and a single mixed list answers neither.
    """
    requestId: str
    # Other releases by the same artist.
    byArtist: List["CatalogEntry"]
    # Other releases on the same label.
    byLabel: List["CatalogEntry"]
    # The label the byLabel list came from.
    labelName: str


class DiscoverBrowseParams(TypedDict):
    """Ask a provider for a whole discography."""
    # 'discogs' or 'bandcamp'.
    sourceKind: "WantSource"
    # 'label' or 'artist'.
    kind: "DiscoverKind"
    # Discogs numeric id, when it is already known.
    id: Optional[int]
    # Name to look up when there is no id.
    name: Optional[str]
    # Page URL. How Bandcamp is addressed — it has no ids.
    url: Optional[str]


class DiscoverPlaylistItem(TypedDict):
    """
    One entry of a YouTube playlist, exactly as YouTube states it.
    Nothing here is parsed: parseTitle.ts turns a title into an artist and a
    track on the frontend, per the standing rule that Python emits raw facts
    and TypeScript derives.
    """
    # From contentDetails.videoId. snippet.resourceId.videoId holds the same
    # value; this one is used throughout so there is one answer to where the
    # id comes from.
    videoId: str
    # snippet.title, verbatim and unparsed.
    title: str
    # snippet.videoOwnerChannelTitle - who UPLOADED the video. NOT
    # snippet.channelTitle, which is whoever owns the playlist. Measured: on a
    # Hyperdub playlist of Untrue the uploader is Hyperdub while the playlist
    # owner is a stranger, and it is the uploader that names the music.
    channel: str
    # Its place in the playlist, from snippet.position.
    position: int
    # False for an entry YouTube will not serve - a deleted or private video,
    # which still occupies a position. Documented to arrive titled 'Deleted
    # video' with no uploader; NOT confirmed against live data, so treat a
    # false here as untested.
    available: bool


class DiscoverPlaylist(TypedDict):
    """The contents of a public YouTube playlist."""
    requestId: str
    playlistId: str
    items: List["DiscoverPlaylistItem"]
    # What YouTube says the playlist holds, from pageInfo.totalResults - the
    # whole playlist, not the page.
    total: int
    # False when the sidecar stopped paginating before the end, same contract
    # as DiscoverCatalog: a truncated list that claims to be whole is worse
    # than one that admits it.
    complete: bool


class DiscogsWant(TypedDict):
    """
    One release from the user's Discogs wantlist.

    Everything here is what Discogs STATES about the release, forwarded as
    given. The single assembly is the artist credit, and that is Discogs'
    own: its artists array carries the join phrases, so
    `[{name: 'Massive Attack', join: 'Vs'}, {name: 'Burial'}]` is the
    credit 'Massive Attack Vs Burial'. Dropping the join would turn one
    collaboration into two unrelated names.
    """
    # The RELEASE id, from basic_information.id.
    discogsId: int
    # The master release, when there is one. Measured: Discogs sends 0 rather
    # than null for a release with no master, so this is null only after that
    # zero is normalised away.
    masterId: Optional[int]
    # Release title, trimmed. Real entries carry trailing whitespace ('Aline
    # Brooklyn 001 ').
    title: str
    # The credit, joined per Discogs' own join phrases.
    artist: str
    # Null when Discogs has no year, never 0.
    year: Optional[int]
    # First label's name. Empty when unlabelled.
    label: str
    # First label's catalogue number. Empty if none.
    catno: str
    # First format name — Vinyl, CD, File. Empty if none.
    format: str
    # The release page, for the want list entry's source.
    url: str
    # ISO 8601 with offset, as Discogs sends it.
    addedAt: str
    # The user's own note on this want. Usually empty.
    notes: str


class DiscoverWantlist(TypedDict):
    """The signed-in Discogs user's wantlist."""
    requestId: str
    # Resolved from the token via /oauth/identity, so the user never has to
    # know or type it.
    username: str
    items: List["DiscogsWant"]
    # What Discogs says the wantlist holds.
    total: int
    # False when the sidecar stopped paginating before the end, same contract
    # as DiscoverCatalog and DiscoverPlaylist.
    complete: bool


class DiscoverCatalog(TypedDict):
    """A label's or artist's discography."""
    requestId: str
    sourceKind: "WantSource"
    kind: "DiscoverKind"
    # The label or artist as the provider names it.
    name: str
    # Discogs id. 0 for Bandcamp.
    id: int
    # The catalogue's own page.
    url: Optional[str]
    releases: List["CatalogEntry"]
    # False when the sidecar stopped paginating before the end. A truncated
    # list that claims to be whole is worse than one that admits it, because
    # the missing records are invisible.
    complete: bool


class DiscoverFailed(TypedDict):
    """
    A discovery lookup did not produce anything. Shared by the URL parse and
    the catalogue browse: the two fail in the same ways.
    """
    requestId: str
    url: str
    # Developer-facing. Not for display — a URL that turns out not to be music
    # is an ordinary outcome, and the UI's answer is to fall back to searching
    # the text, not to show an error.
    reason: str
    # The AppSettings field the user would have to supply for this provider to
    # work, or empty when the failure was not about configuration.
    # Machine-readable ('discogsToken') so the UI can offer the right Settings
    # link without reading English out of `reason`.
    needs: str
    # True when the provider ANSWERED and refused the credential - an HTTP 401
    # or 403. `needs` names which credential, so the pair reads as 'the
    # Discogs token you have is wrong' rather than 'supply a Discogs token'.
    # Telling someone to add a token they already added is what 0.2.2 did, and
    # it is indistinguishable from the app being broken.
    unauthorised: bool
    # True when the provider was never reached at all - DNS, TLS, a refused
    # connection, a timeout. False when it answered and the answer was no.
    # Same distinction `needs` exists for, and the same reason it is a flag: a
    # 404 means this link names nothing and searching the text instead is
    # right, while an unreachable provider means the link may be perfect and
    # the network is not. Telling the user the former when it is the latter is
    # what shipped in 0.2.0.
    unreachable: bool


class WantEntry(TypedDict):
    """
    One thing the user wants to find on Soulseek. The discovery layer's
    atomic unit, analogous to FileRef for search results.
    """
    # Opaque UUID, minted by the sidecar.
    id: str
    # As parsed, or as corrected by the user. May be empty.
    artist: str
    # Track or release title.
    title: str
    # Null for standalone tracks.
    album: Optional[str]
    year: Optional[int]
    label: Optional[str]
    catalogNumber: Optional[str]
    # Where it was found.
    sourceKind: "WantSource"
    # Original URL. Null for manual entries.
    sourceUrl: Optional[str]
    # The provider's unprocessed title, kept so a bad parse can be re-read by
    # a human later. This is why a corrected entry does not lose what it was
    # corrected FROM.
    sourceTitle: Optional[str]
    # data: URI from the source, not the artwork pipeline.
    artworkUri: Optional[str]
    status: "WantStatus"
    # Unix epoch seconds.
    addedAt: float
    # When last searched. Null if never.
    searchedAt: Optional[float]
    # The user's own annotation. Free text.
    notes: Optional[str]
    # Seconds, when the source provided it.
    duration: Optional[int]
    # For releases: the expected tracklist.
    tracklist: List["WantTrack"]
    # The digging session this was added during, if any. Null for entries
    # added on their own and for entries whose session was deleted — deleting
    # a session unlinks its entries rather than throwing away what you wanted.
    sessionId: Optional[str]


class WantList(TypedDict):
    # Newest first.
    entries: List["WantEntry"]


class DigSession(TypedDict):
    """
    A named, timestamped container for a discovery binge.

    NOTE WHAT IS ABSENT: no entry count and no list of sources. Both are
    aggregates over the want list, which the frontend already holds in
    full, and duplicating them here would be two places to get the same
    number wrong. Same reason there is no format tier on FileRef.
    """
    # Opaque UUID, minted by the sidecar.
    id: str
    # EMPTY until the user renames it. An auto-named session shows the day and
    # time it started, and building that string is display formatting — which
    # Python does not do, here or anywhere else. The sidecar stores
    # `createdAt` and the frontend words it, in the user's own locale.
    name: str
    # Unix epoch seconds.
    createdAt: float
    # When an entry was last added to it. What decides whether the session is
    # still collecting.
    lastActiveAt: float
    # No longer collecting. Set by the user, or by the sidecar once the
    # session has gone quiet for long enough.
    closed: bool


class DigSessionList(TypedDict):
    # Newest first.
    sessions: List["DigSession"]


class SessionCreateParams(TypedDict):
    # Null leaves it auto-named — see DigSession.name.
    name: Optional[str]


class Profile(TypedDict):
    """
    Your own Soulseek profile — what a peer sees when they look you up.

    Seek has only ever READ other people's. This is the first thing that
    reports your own, and it deliberately reports the whole response
    upstream would send (`UserInfo._get_user_info_response`) rather than
    just the two editable fields, because the interesting question is not
    'what did I type' but 'what does a stranger see'.
    """
    # The account this describes. Empty when signed out.
    username: str
    # The free text peers see, DECODED. Upstream stores it as a Python repr()
    # and unescapes it on send; nothing outside the sidecar should ever meet
    # the escaped form.
    description: str
    # Local path to the picture file. Empty for none.
    picturePath: str
    # The picture as a data: URI, when the file exists and is small enough to
    # be worth sending. Null when there is no picture, the path does not
    # resolve, or it is over the cap — and those are different things, which
    # `pictureError` separates.
    pictureUri: Optional[str]
    # Why there is a path but no picture. Empty when there is no problem,
    # which includes having no picture at all.
    pictureError: str
    # Size of the picture file. 0 when there is none.
    pictureBytes: int
    # Upstream's own flag for whether the picture is sent at all.
    pictureVisible: bool
    # Files you are sharing. Null when the share index has not been built —
    # which is NOT the same as sharing nothing.
    sharedFiles: Optional[int]
    # Folders you are sharing. Null before a scan.
    sharedFolders: Optional[int]
    # Total upload slots you offer.
    uploadSlots: int
    # Whether a new upload would be accepted right now.
    freeSlots: bool
    # How many files are queued on you.
    queueSize: int


class ProfileParams(TypedDict):
    """
    Change your own profile. Every field is optional; null leaves it alone,
    exactly as a settings patch does.
    """
    # Plain text. The sidecar encodes it.
    description: Optional[str]
    # Local path, or the empty string to remove the picture.
    picturePath: Optional[str]
    pictureVisible: Optional[bool]


class PeerConnection(TypedDict):
    """
    One peer Seek is exchanging data with right now, in either direction.

    NOT a socket. Upstream's socket table lives in the network thread and is
    private to it, and `upstream/` is not modified — so what can be reported
    honestly is who has a transfer active or queued, which is the useful
    half anyway. `ConnectionSnapshot.socketCount` states the real socket
    total beside this so the difference is visible rather than implied.
    """
    username: str
    # Two-letter code, when known.
    country: Optional[str]
    # Files actively coming from them.
    downloading: int
    # Files of theirs you are waiting on.
    downloadQueued: int
    # Files actively going to them.
    uploading: int
    # Files of yours they are waiting on.
    uploadQueued: int


class ConnectionSnapshot(TypedDict):
    """Who Seek is connected to, right now."""
    # Open sockets, as the network thread last reported. Usually far larger
    # than the peer list: most of them carry the DISTRIBUTED SEARCH network,
    # where you relay other people's searches. That is Soulseek working, not a
    # leak.
    socketCount: int
    # Peers with a transfer active or queued.
    peers: List["PeerConnection"]


class TransferCounts(TypedDict):
    """
    One set of transfer counters, as upstream keeps them.

    READ THE SIZE FIELDS CAREFULLY: they count BYTES ACTUALLY MOVED, not
    the size of finished files. Upstream adds each fragment as it arrives
    (transfers.py `_update_transfer_progress`), so a download that got to
    80% and then lost its peer contributed 80% of a file to
    `downloadedSize` and nothing to `completedDownloads`. That is the
    honest figure for bandwidth used, and the wrong one for 'how much
    music do I have' — the library index answers that.
    """
    # Downloads begun.
    startedDownloads: int
    # Downloads that finished.
    completedDownloads: int
    # Bytes received, including from transfers that later failed.
    downloadedSize: int
    # Uploads begun.
    startedUploads: int
    # Uploads that finished.
    completedUploads: int
    # Bytes sent, including from transfers that later failed.
    uploadedSize: int


class TransferStats(TypedDict):
    """
    Transfer counters, session and lifetime.

    Both halves come from upstream's `statistics` component, which Seek has
    had enabled since the beginning and has never surfaced — so the upload
    figures here are the first sight of a side of the app that has been
    running the whole time.

    `session` resets when the sidecar starts; `total` persists in the
    pynicotine config. NOTHING HERE IS DERIVED: no ratio, no completion
    rate, no percentages. Those are arithmetic over these six numbers and
    arithmetic for display is TypeScript's, like every other derivation in
    this project.
    """
    # Unix seconds when counting began. 0 if upstream never set it, which
    # means the totals have no meaningful span and the UI must not word one.
    sinceTimestamp: int
    # Since this sidecar started.
    session: "TransferCounts"
    # All time, as persisted by upstream.
    total: "TransferCounts"


class WatchedLabel(TypedDict):
    """
    A label or artist whose catalogue the user is working through.

    NOT a new-release notifier, and the distinction is the whole design.
    Discogs is a database rather than a release feed, so diffing it
    reports records catalogued decades late as 'new'; Bandcamp has no API
    to poll; and a brand-new release is precisely what Soulseek does not
    have yet, so that notification's happy path ends in an empty search.
    This is a bookmark with progress on it — back catalogue, which is
    where both Soulseek and this app are strong.

    THE COUNTS ARE A SNAPSHOT, and unlike DigSession they are stored
    rather than derived. DigSession omits its counts because the frontend
    holds the whole want list and can recount at will; a catalogue is
    NOT persisted anywhere, so these cannot be recomputed without several
    rate-limited HTTP requests per label. They are therefore written when
    the catalogue is actually read, carry `lastSeenAt`, and must never be
    rendered as current — the UI says when it last looked.
    """
    # Opaque UUID, minted by the sidecar.
    id: str
    # Which provider holds the catalogue. Same vocabulary the want list uses,
    # so one label and the releases saved from it agree.
    sourceKind: "WantSource"
    # 'label' or 'artist'. Others are refused.
    kind: "DiscoverKind"
    # What it is called. Never empty — watching needs one.
    name: str
    # The catalogue page. Empty when it was found by name.
    url: str
    # The provider's numeric id, when known. Re-browsing with it skips the
    # fuzzy name search that `_resembles` exists to guard.
    entityId: Optional[int]
    # Unix epoch seconds.
    addedAt: float
    # When the catalogue was last actually read. Null until the first read —
    # which is not the same as 'never watched'.
    lastSeenAt: Optional[float]
    # Releases in the catalogue at the last read. Null before one.
    releaseCount: Optional[int]
    # Of those, matched in the library index at the last read.
    ownedCount: Optional[int]
    # Of those, already on the want list at the last read.
    wantedCount: Optional[int]
    # The user's own note. Empty unless they wrote one.
    note: str


class WatchedLabelList(TypedDict):
    # Newest first.
    labels: List["WatchedLabel"]


class LabelWatchParams(TypedDict):
    """
    Start watching a catalogue. Idempotent: watching one already on the list
    updates its name, url and id and leaves its counts alone, because those
    describe a reading rather than the choice to watch.
    """
    sourceKind: "WantSource"
    kind: "DiscoverKind"
    name: str
    url: Optional[str]
    entityId: Optional[int]


class LabelIdParams(TypedDict):
    id: str


class LabelNoteParams(TypedDict):
    id: str
    note: str


class LabelSeenParams(TypedDict):
    """
    Record what a catalogue read found. Sent by the frontend after it has
    rendered one, because owned and wanted are matches against the library
    index and the want list — both of which live on that side of the seam.
    """
    id: str
    releaseCount: int
    ownedCount: int
    wantedCount: int


class SessionIdParams(TypedDict):
    id: str


class SessionRenameParams(TypedDict):
    id: str
    name: str


class WantAddParams(TypedDict):
    # Entries to add. `id` and `addedAt` are ignored and minted by the
    # sidecar, so a caller cannot forge either.
    entries: List["WantEntry"]


class WantRemoveParams(TypedDict):
    ids: List[str]


class WantUpdateParams(TypedDict):
    """
    Change fields on one entry. Null means 'leave this alone', so an absent
    value and an intentionally empty one stay different things.
    """
    id: str
    artist: Optional[str]
    title: Optional[str]
    album: Optional[str]
    status: Optional["WantStatus"]
    notes: Optional[str]


class HistoryState(TypedDict):
    """Recent searches, newest first, de-duplicated and capped."""
    items: List[str]


class SavedSearch(TypedDict):
    """
    A query plus the filter set it was run with, as opaque JSON the frontend
    owns. The sidecar stores it and never interprets it — filters are a
    TypeScript concept (AGENTS.md, the seam).
    """
    query: str
    # Serialised filters. Opaque to the sidecar.
    filtersJson: str


class SavedParams(TypedDict):
    query: str
    # Serialised filters.
    filtersJson: str


class SavedState(TypedDict):
    items: List["SavedSearch"]


class BuddyState(TypedDict):
    # Buddy usernames, as upstream holds them.
    items: List[str]


class WishlistState(TypedDict):
    """The wishlist, and how often the server permits it to run."""
    # Queries, newest first.
    items: List[str]
    # Server-dictated seconds between automatic runs. 0 before the server has
    # told us, which it does shortly after login.
    intervalSeconds: int


class TransferIdsParams(TypedDict):
    """Target one or more transfers. Used by pause/resume/cancel/retry/clear."""
    transferIds: List[str]


class TransferListResult(TypedDict):
    transfers: List["Transfer"]


class SettingsPatchParams(TypedDict):
    """
    Shallow-merge a patch into sidecar settings. Only the keys present are
    changed. Unknown keys are rejected rather than silently ignored.
    """
    settings: "Settings"


class SettingsResult(TypedDict):
    settings: "Settings"


class Settings(TypedDict):
    """
    Everything the frontend is allowed to change. Every field is optional in
    a patch; a `settings.get` reply has them all populated.
    """
    # Absolute path for completed downloads.
    downloadFolder: Optional[str]
    # Absolute path for in-progress downloads.
    incompleteFolder: Optional[str]
    # Incoming peer connection port.
    listenPort: Optional[int]
    # Bytes/sec, 0 = unlimited.
    maxDownloadSpeed: Optional[int]
    # Bytes/sec, 0 = unlimited.
    maxUploadSpeed: Optional[int]
    # Concurrent upload slots offered to peers.
    uploadSlots: Optional[int]
    # Connect to the Soulseek server on sidecar start.
    autoConnect: Optional[bool]
    # How long a 'transferring' download may make zero progress before
    # `Transfer.stalled` is set. Seek-specific; upstream has no such concept
    # (RECON.md §5).
    stallSeconds: Optional[int]


class ConnectionState(TypedDict):
    """Current server connection."""
    status: "ConnectionStatus"
    # Our logged-in username. Null when not online.
    username: Optional[str]
    # Our public IP as the server sees it.
    publicAddress: Optional[str]
    # Server rejection text on a failed login (e.g. wrong password). Null
    # otherwise.
    error: Optional[str]


class ConnectionStats(TypedDict):
    """
    Emitted about once a second while the network thread runs. Note upstream
    also emits this event with NO arguments as a reset (RECON.md §3); the
    sidecar normalises that into explicit zeros.
    """
    # Open sockets.
    connections: int
    # Bytes/sec across all downloads.
    downloadBandwidth: int
    # Bytes/sec across all uploads.
    uploadBandwidth: int


class SearchResultEvent(TypedDict):
    """
    A batch of files from ONE peer for ONE search. The sidecar coalesces
    upstream's per-response events into ticks so the frontend is not woken
    hundreds of times a second; `files` may therefore span several upstream
    responses from the same peer.
    """
    searchId: int
    peer: "PeerStats"
    files: List["FileRef"]
    # True if these came from the peer's buddy-only share list.
    private: bool
    # Unix epoch seconds when the sidecar accepted them.
    receivedAt: float


class SearchClosedEvent(TypedDict):
    searchId: int
    reason: "SearchCloseReason"
    # Total files accepted for this search.
    resultCount: int
    # Distinct peers that responded.
    peerCount: int


class SearchFailedEvent(TypedDict):
    searchId: int
    # Currently only ever 'offline' from upstream.
    reason: str


class UserStatusEvent(TypedDict):
    username: str
    status: "UserStatus"
    # Null when the server did not say.
    privileged: Optional[bool]


class UserBrowseResultEvent(TypedDict):
    """A peer's complete share list. Arrives as one message; can be large."""
    username: str
    folders: List["FolderRef"]
    fileCount: int
    # Sum of all file sizes, bytes.
    totalSize: int


class UserBrowseFailedEvent(TypedDict):
    username: str
    reason: str


class FolderContentsEvent(TypedDict):
    """
    Reply to `transfer.enqueueFolder`'s underlying folder request. Emitted
    before the resulting `transfer.added` events.
    """
    # Matches TransferFolderResult.requestId.
    requestId: str
    username: str
    folderPath: str
    folders: List["FolderRef"]
    # How many files were queued as a result.
    enqueued: int


class FolderContentsFailedEvent(TypedDict):
    # Null if the failure was not tied to a request.
    requestId: Optional[str]
    username: str
    folderPath: str
    reason: str


class Transfer(TypedDict):
    """
    One transfer, in either direction. `id` is a stable sidecar-minted
    handle — upstream has no stable transfer id (RECON.md §5).

    NOT ALL FIELDS MEAN THE SAME THING BOTH WAYS. On an upload,
    `localFolder` is where YOUR file already lives rather than where a
    file is being written, and `queuePosition` is a place in someone
    else's queue rather than in yours. `state` is drawn from the same
    vocabulary, but uploads never produce `paused`, `filtered` or
    `download_folder_error` — upstream simply never sets them on that
    side.
    """
    # Stable opaque id. Survives retries.
    id: str
    # 'download' is a file coming to you; 'upload' is one going to a peer who
    # asked for it.
    direction: "TransferDirection"
    username: str
    # Full remote virtual path.
    path: str
    # Absolute local destination folder.
    localFolder: Optional[str]
    # Total bytes, as advertised.
    size: int
    # Bytes written so far. 0 before the transfer starts.
    bytesDone: int
    state: "TransferState"
    # Instantaneous rate in bytes/sec, from the network thread. 0 when not
    # transferring. This is a MEASUREMENT, unlike PeerStats.advertisedSpeed.
    speed: int
    # Bytes/sec over the life of the transfer.
    averageSpeed: int
    # Place in the peer's queue, from PlaceInQueueResponse. Null when the peer
    # has not told us.
    queuePosition: Optional[int]
    # Upstream's own estimate. Null when it cannot be computed (speed 0).
    secondsLeft: Optional[int]
    # Seconds since the transfer started.
    secondsElapsed: int
    # Seek-specific: state is 'transferring' but bytesDone has not moved for
    # `Settings.stallSeconds`. Upstream provides no such signal.
    stalled: bool
    # The originating FileRef when the client supplied one on enqueue, so
    # quality info survives into the transfers view.
    file: Optional["FileRef"]
    # What went wrong, verbatim from upstream or from the peer. Set for every
    # failure state, and for 'rejected' it is the refusal the peer sent - the
    # ONLY place that text survives, so a client that ignores it is back to
    # showing 'unknown'. Never formatted for display: the wording is the
    # frontend's job.
    error: Optional[str]


class TransferRemovedEvent(TypedDict):
    transferIds: List[str]


class FolderFinishedEvent(TypedDict):
    # Absolute local folder that just completed.
    localFolder: str


class SpectralAnalysis(TypedDict):
    """
    Result of decoding a DOWNLOADED file and inspecting its spectrum.

    This is the POST-DOWNLOAD check and it is a different thing from the
    search-time metadata heuristic (docs/PRODUCT.md §6). The metadata check
    is a prediction made before the bytes exist; this is a finding made
    from the bytes themselves. Keep them distinct in the UI — a file that
    passed the prediction and fails this is exactly the moment the app
    earns its keep.

    It exists because RECON.md §4 established the metadata check cannot
    run on lossless files at all: the protocol sends no bitrate for
    FLAC/WAV/AIFF, so there is nothing to contradict. Spectral analysis
    needs no cooperation from the uploader's metadata.

    Everything here is raw measurement. No labels, no colours, no
    percentages formatted for display, no sentence to render.
    """
    # Echoes the analysis.spectral request.
    requestId: str
    # Absolute local path of the analysed file.
    path: str
    # The transfer this file came from, when the request supplied one.
    transferId: Optional[str]
    # Decoded sample rate in Hz.
    sampleRate: int
    # Decoded channel count.
    channels: int
    # Decoded duration.
    durationSeconds: float
    # Which decoder produced the samples ('soundfile' or 'ffmpeg'). Useful
    # when a result looks wrong and you need to know why.
    decodedWith: str
    # sampleRate / 2. The ceiling any content can reach.
    nyquistHz: float
    # Highest frequency still carrying meaningful energy, in Hz. Null when no
    # shelf could be located — which is itself informative, not a failure.
    cutoffHz: Optional[float]
    # How far energy falls across the shelf, in dB. A sharp cliff is what
    # distinguishes an encoder lowpass from natural HF rolloff; a gentle slope
    # means much less.
    shelfDropDb: Optional[float]
    # How wide the transition is. Encoder lowpass filters are abrupt; acoustic
    # rolloff is gradual.
    shelfWidthHz: Optional[float]
    # 0..1, how much the shape supports the assessment. Low confidence on a
    # 'possible transcode' must read as a question, not a charge.
    confidence: float
    assessment: "SpectralAssessment"
    # Whether the container claims to be lossless. A lowpass shelf in a lossy
    # file is expected and uninteresting; the same shelf in a FLAC is the
    # entire point of this check.
    declaredLossless: bool
    # Rough bitrate a lossy source with this cutoff would have had. A hint for
    # the explanation, not a measurement. Null when no cutoff was found.
    impliedSourceKbps: Optional[int]
    # Bin centre frequencies for `spectrumDb`, downsampled for transport.
    # Pairs index-for-index.
    spectrumHz: List[float]
    # Time-averaged magnitude in dB, normalised so the peak is 0. The frontend
    # renders this; the sidecar does not.
    spectrumDb: List[float]
    # Coarse time x frequency grid in dB, FLATTENED row-major as freq-major
    # rows of heatmapTimeBins each (index = f * heatmapTimeBins + t), low
    # frequency first, peak-normalised frequency first, peak-normalised to 0.
    # This is the Spek-style picture and answers a DIFFERENT question from
    # spectrumDb: the averaged curve resolves whether a lowpass cliff exists,
    # this shows where in the track energy sits and whether the ceiling holds
    # throughout. Empty if rendering failed — the verdict never depends on it.
    heatmapDb: List[float]
    # Columns in heatmapDb.
    heatmapTimeBins: int
    # Rows in heatmapDb.
    heatmapFreqBins: int
    # FFT window length in samples.
    fftSize: int
    # How many windows were averaged.
    windowCount: int
    # How much audio was actually inspected. The sidecar samples windows
    # across the file rather than reading all of it.
    analysedSeconds: float


class SpectralRequestParams(TypedDict):
    """
    Analyse a downloaded file. Runs on a worker thread; the reply is
    immediate and the result arrives later as `analysis.result`.
    """
    # Absolute local path. Null means 'use the file for transferId'.
    path: Optional[str]
    # Analyse the completed file for this transfer. Ignored if `path` is
    # given.
    transferId: Optional[str]


class SpectralRequestResult(TypedDict):
    # Correlates the later analysis.result event.
    requestId: str


class AnalysisFailedEvent(TypedDict):
    requestId: str
    path: Optional[str]
    # Developer-facing text. Not for display.
    reason: str


class SharedFolder(TypedDict):
    """One folder offered to the network."""
    # Name peers see. Upstream keys shares on this, and it need not resemble
    # the real path.
    virtualName: str
    # Absolute local path.
    path: str
    # Whether the path is currently readable. External volumes go missing;
    # upstream emits shares-unavailable when they do.
    exists: bool


class ChatMessage(TypedDict):
    """
    One line of chat. Soulseek carries no message ids for room chat, so the
    frontend keys on (room|user, timestamp, sender, text).
    """
    # Which conversation this belongs to.
    scope: "ChatScope"
    # Room name for scope 'room'; the other party's username for scope
    # 'private'.
    target: str
    # Who sent it. Our own name for outgoing lines.
    username: str
    # The raw text. Never formatted by the sidecar.
    message: str
    # True when we sent it. Upstream echoes our own messages back through a
    # different event, and the UI must not show them as if a stranger said
    # them.
    outgoing: bool
    # 'action' is the /me form. 'local' is client-generated text that never
    # touched the network.
    kind: "ChatMessageKind"
    # Our username appears in the text. Upstream computes this.
    mentioned: bool
    # Unix seconds. Private messages carry the server's own timestamp for
    # offline delivery; room messages are stamped on arrival because the
    # protocol sends none.
    timestamp: int


class ChatRoom(TypedDict):
    """A room in the server's list, or one we have joined."""
    name: str
    # As last reported by the server.
    userCount: int
    # We are in it and receiving messages.
    joined: bool
    # Owned/members-only room.
    private: bool


class ChatRoomList(TypedDict):
    """The server's room directory plus whatever we have joined."""
    rooms: List["ChatRoom"]


class ChatRoomMembers(TypedDict):
    """Who is in a room. Emitted on join and as people come and go."""
    room: str
    # Usernames, unsorted — ordering is the UI's job.
    users: List[str]


class ChatJoinParams(TypedDict):
    room: str


class ChatLeaveParams(TypedDict):
    room: str


class ChatSayParams(TypedDict):
    scope: "ChatScope"
    # Room name, or the username for a private message.
    target: str
    message: str


class ChatOpenParams(TypedDict):
    """Open a private conversation without sending anything."""
    username: str


class ShareState(TypedDict):
    """
    Everything the frontend needs to drive sharing and to render the
    persistent 'you are not sharing' indicator.
    """
    consent: "ShareConsent"
    folders: List["SharedFolder"]
    # A rescan is in progress.
    scanning: bool
    # The share index is built and peers can be served.
    ready: bool
    # Files indexed. Null before the first scan.
    fileCount: Optional[int]
    # Folders indexed. Null before the first scan.
    folderCount: Optional[int]
    # Bytes indexed. Null before the first scan.
    totalSize: Optional[int]
    # Unix epoch seconds of the last completed scan.
    lastScanAt: Optional[float]
    # Consent was granted after the sidecar started without the shares
    # component. Sharing begins on next launch.
    restartRequired: bool


class ShareSetParams(TypedDict):
    """
    Set the share configuration. This is the explicit choice — nothing is
    ever shared without one.
    """
    consent: "ShareConsent"
    # Replaces the current list wholesale. Empty is valid and means 'share
    # nothing'; combined with consent 'granted' it is a contradiction the
    # sidecar rejects.
    folders: List["SharedFolder"]


class ShareRescanParams(TypedDict):
    # Rescan even if upstream believes the index is current.
    force: Optional[bool]


class PathCheckParams(TypedDict):
    # A local path, absolute or starting with ~. May not exist.
    path: str


class PathCheck(TypedDict):
    """
    What is actually true of a local path. RAW FACTS ONLY — the sidecar
    does not decide whether a path is acceptable for a given purpose, and
    emits no message. Which of these fields matters, and how to word it,
    is the frontend's call: a download folder must be a writable directory,
    while a shared folder only has to be readable.

    Writability is tested by CREATING A FILE and deleting it, not by
    reading the mode bits. os.access() answers from the permission bits
    alone and is wrong on exactly the cases that matter here: a read-only
    mount and a macOS TCC-protected folder both report the user as having
    write permission, because they do — the refusal comes from the volume
    and from the sandbox, neither of which is in the mode.
    """
    # The path as it was given, unchanged.
    path: str
    # The path after ~ expansion and normalisation. This is what would
    # actually be written to the config.
    resolved: str
    # Something is there.
    exists: bool
    # It exists and is a directory.
    isDirectory: bool
    # A file could be created inside it. False whenever the path is not an
    # existing directory.
    writable: bool
    # The containing directory exists, so this one could be created.
    parentExists: bool
    # A directory could be created here. False unless parentExists.
    parentWritable: bool


class EnsureFolderParams(TypedDict):
    # The folder to create, including any missing parents.
    path: str


class ImportSource(TypedDict):
    """
    What an existing Nicotine+ installation on this machine offers.

    This is the PREVIEW half of the import: it reports what WOULD be read
    so the UI can state it before anything is read for real. It is only
    ever produced in response to an explicit user action, never on start.

    Note what is absent: there is no password field, and there never will
    be. `hasCredentials` says whether one exists; the value itself is
    copied inside the sidecar and never crosses this socket.
    """
    # A readable Nicotine+ config was found.
    available: bool
    # Where the sidecar looked.
    configPath: str
    # Both a username and a password are present.
    hasCredentials: bool
    # The Soulseek username, so the UI can name what it is about to import.
    # Null when absent.
    username: Optional[str]
    # Shares configured in Nicotine+.
    folders: List["SharedFolder"]
    # Nicotine+'s download folder, if it set one.
    downloadFolder: Optional[str]
    # Why the config could not be read, when it could not be.
    error: Optional[str]


class ImportApplyParams(TypedDict):
    """
    Copy selected settings across. Every field is an explicit opt-in; there
    is no 'import everything' shorthand on purpose.
    """
    # Copy the Soulseek username and password.
    credentials: bool
    # Copy the shared-folder list.
    shares: bool
    # Copy the download folder.
    downloadFolder: bool


class ImportResult(TypedDict):
    importedCredentials: bool
    # How many folders were copied.
    importedShares: int
    importedDownloadFolder: bool
    # The username now configured, for confirmation.
    username: Optional[str]


class LogEvent(TypedDict):
    level: "LogLevel"
    message: str
    # Unix epoch seconds.
    at: float


# ------------------------------------------------------ runtime validator

# name -> ((field, base_type, is_array, nullable), ...)
STRUCT_FIELDS: Dict[str, Tuple[Tuple[str, str, bool, bool], ...]] = {
    "FileRef": (
        ("path", "str", False, False),
        ("size", "int", False, False),
        ("bitrate", "int", False, True),
        ("duration", "int", False, True),
        ("sampleRate", "int", False, True),
        ("bitDepth", "int", False, True),
        ("isVbr", "bool", False, True),
    ),
    "PeerStats": (
        ("username", "str", False, False),
        ("freeSlots", "bool", False, False),
        ("advertisedSpeed", "int", False, False),
        ("queueLength", "int", False, False),
        ("files", "int", False, True),
        ("folders", "int", False, True),
        ("country", "str", False, True),
    ),
    "FolderRef": (
        ("path", "str", False, False),
        ("files", "FileRef", True, False),
        ("private", "bool", False, False),
    ),
    "ErrorInfo": (
        ("code", "ErrorCode", False, False),
        ("message", "str", False, False),
    ),
    "HelloParams": (
        ("protocolVersion", "int", False, False),
        ("client", "str", False, False),
    ),
    "HelloResult": (
        ("protocolVersion", "int", False, False),
        ("sidecarVersion", "str", False, False),
        ("coreVersion", "str", False, False),
        ("connection", "ConnectionState", False, False),
        ("transfers", "Transfer", True, False),
        ("searches", "SearchInfo", True, False),
    ),
    "ConnectParams": (
        ("username", "str", False, True),
        ("password", "str", False, True),
    ),
    "SearchStartParams": (
        ("query", "str", False, False),
        ("mode", "SearchMode", False, True),
        ("room", "str", False, True),
        ("users", "str", True, False),
        ("resultCap", "int", False, True),
        ("timeoutSeconds", "int", False, True),
    ),
    "SearchStartResult": (
        ("searchId", "int", False, False),
    ),
    "SearchStopParams": (
        ("searchId", "int", False, False),
    ),
    "SearchInfo": (
        ("searchId", "int", False, False),
        ("query", "str", False, False),
        ("termTransmitted", "str", False, False),
        ("mode", "SearchMode", False, False),
        ("startedAt", "float", False, False),
        ("resultCount", "int", False, False),
    ),
    "UserBrowseParams": (
        ("username", "str", False, False),
    ),
    "UserStatsParams": (
        ("username", "str", False, False),
    ),
    "TransferEnqueueParams": (
        ("username", "str", False, False),
        ("path", "str", False, False),
        ("size", "int", False, False),
        ("file", "FileRef", False, True),
        ("destination", "str", False, True),
        ("paused", "bool", False, True),
    ),
    "TransferEnqueueResult": (
        ("transferId", "str", False, False),
        ("alreadyQueued", "bool", False, False),
    ),
    "TransferFolderParams": (
        ("username", "str", False, False),
        ("folderPath", "str", False, False),
        ("recurse", "bool", False, True),
        ("destination", "str", False, True),
    ),
    "TransferFolderResult": (
        ("requestId", "str", False, False),
    ),
    "OrganiseResult": (
        ("moved", "bool", False, False),
        ("fromPath", "str", False, False),
        ("toPath", "str", False, False),
        ("reason", "str", False, False),
    ),
    "PreviewParams": (
        ("path", "str", False, True),
        ("transferId", "str", False, True),
        ("startSeconds", "int", False, True),
        ("seconds", "int", False, True),
    ),
    "PreviewResult": (
        ("requestId", "str", False, False),
        ("path", "str", False, False),
        ("dataUri", "str", False, False),
        ("startSeconds", "int", False, False),
        ("seconds", "float", False, False),
        ("durationSeconds", "float", False, False),
    ),
    "PreviewFailed": (
        ("requestId", "str", False, False),
        ("reason", "str", False, False),
    ),
    "AppSettings": (
        ("autoConnect", "bool", False, False),
        ("hasCredentials", "bool", False, False),
        ("username", "str", False, False),
        ("externalLookups", "bool", False, False),
        ("discogsToken", "bool", False, False),
        ("artworkCacheMb", "int", False, False),
        ("embedArtwork", "bool", False, False),
        ("writeCoverFile", "bool", False, False),
        ("preferLossless", "bool", False, False),
        ("minBitrate", "int", False, False),
        ("rejectTranscodes", "bool", False, False),
        ("autoOrganise", "bool", False, False),
        ("acoustidApiKey", "bool", False, False),
        ("youtubeApiKey", "bool", False, False),
        ("autoDigSessions", "bool", False, False),
    ),
    "AppSettingsPatch": (
        ("autoConnect", "bool", False, True),
        ("externalLookups", "bool", False, True),
        ("discogsToken", "str", False, True),
        ("artworkCacheMb", "int", False, True),
        ("embedArtwork", "bool", False, True),
        ("writeCoverFile", "bool", False, True),
        ("preferLossless", "bool", False, True),
        ("minBitrate", "int", False, True),
        ("rejectTranscodes", "bool", False, True),
        ("autoOrganise", "bool", False, True),
        ("acoustidApiKey", "str", False, True),
        ("youtubeApiKey", "str", False, True),
        ("autoDigSessions", "bool", False, True),
    ),
    "PeerRecord": (
        ("username", "str", False, False),
        ("ok", "int", False, False),
        ("failed", "int", False, False),
        ("lastSeen", "int", False, False),
    ),
    "PeerHistory": (
        ("items", "PeerRecord", True, False),
    ),
    "WishParams": (
        ("query", "str", False, False),
    ),
    "LibraryState": (
        ("scannedAt", "int", False, False),
        ("roots", "str", True, False),
        ("releaseCount", "int", False, False),
        ("trackCount", "int", False, False),
        ("scanning", "bool", False, False),
    ),
    "LibraryScanParams": (
        ("roots", "str", True, False),
        ("readTags", "bool", False, True),
    ),
    "LibraryRelease": (
        ("key", "str", False, False),
        ("artist", "str", False, False),
        ("release", "str", False, False),
        ("folder", "str", False, False),
        ("trackCount", "int", False, False),
        ("bytes", "int", False, False),
        ("formats", "str", False, False),
        ("year", "int", False, False),
        ("genre", "str", False, False),
    ),
    "LibraryReleases": (
        ("items", "LibraryRelease", True, False),
    ),
    "LibraryGap": (
        ("position", "int", False, False),
        ("title", "str", False, False),
        ("artist", "str", False, False),
        ("have", "bool", False, False),
    ),
    "LibraryGaps": (
        ("key", "str", False, False),
        ("matched", "bool", False, False),
        ("releaseTitle", "str", False, False),
        ("releaseArtist", "str", False, False),
        ("score", "int", False, False),
        ("tracks", "LibraryGap", True, False),
    ),
    "LibraryOwned": (
        ("releases", "str", True, False),
        ("tracks", "str", True, False),
    ),
    "ArtworkParams": (
        ("artist", "str", False, False),
        ("release", "str", False, False),
        ("key", "str", False, False),
    ),
    "RequestAccepted": (
        ("requestId", "str", False, False),
    ),
    "ArtworkResult": (
        ("key", "str", False, False),
        ("requestId", "str", False, False),
        ("dataUri", "str", False, False),
        ("source", "str", False, False),
        ("trackCount", "int", False, False),
        ("date", "str", False, False),
        ("label", "str", False, False),
        ("mbid", "str", False, False),
    ),
    "ArtworkFailed": (
        ("key", "str", False, False),
        ("requestId", "str", False, False),
        ("reason", "str", False, False),
    ),
    "ArtworkCacheStats": (
        ("entries", "int", False, False),
        ("bytes", "int", False, False),
        ("capBytes", "int", False, False),
    ),
    "TagChange": (
        ("field", "str", False, False),
        ("current", "str", False, False),
        ("proposed", "str", False, False),
    ),
    "MetadataProposal": (
        ("requestId", "str", False, False),
        ("path", "str", False, False),
        ("transferId", "str", False, True),
        ("matched", "bool", False, False),
        ("score", "int", False, False),
        ("query", "str", False, False),
        ("trackMatched", "bool", False, False),
        ("releaseTitle", "str", False, False),
        ("releaseArtist", "str", False, False),
        ("date", "str", False, False),
        ("label", "str", False, False),
        ("mbid", "str", False, False),
        ("changes", "TagChange", True, False),
    ),
    "MetadataApplyParams": (
        ("path", "str", False, False),
        ("fields", "TagChange", True, False),
        ("embedArtwork", "bool", False, False),
        ("artist", "str", False, False),
        ("release", "str", False, False),
    ),
    "MetadataApplyResult": (
        ("path", "str", False, False),
        ("written", "int", False, False),
        ("artworkEmbedded", "bool", False, False),
    ),
    "WantTrack": (
        ("position", "int", False, False),
        ("title", "str", False, False),
        ("artist", "str", False, False),
        ("duration", "int", False, True),
    ),
    "DiscoverParseUrlParams": (
        ("url", "str", False, False),
    ),
    "DiscoverParsed": (
        ("requestId", "str", False, False),
        ("url", "str", False, False),
        ("sourceKind", "WantSource", False, False),
        ("kind", "DiscoverKind", False, False),
        ("rawTitle", "str", False, False),
        ("channel", "str", False, False),
        ("artist", "str", False, False),
        ("title", "str", False, False),
        ("album", "str", False, True),
        ("year", "int", False, True),
        ("label", "str", False, True),
        ("catalogNumber", "str", False, True),
        ("artworkUri", "str", False, True),
        ("duration", "int", False, True),
        ("genres", "str", True, False),
        ("tracklist", "WantTrack", True, False),
        ("providerUrl", "str", False, True),
    ),
    "CatalogEntry": (
        ("discogsId", "int", False, False),
        ("title", "str", False, False),
        ("artist", "str", False, False),
        ("year", "int", False, True),
        ("format", "str", False, False),
        ("catno", "str", False, False),
        ("role", "str", False, False),
        ("url", "str", False, False),
    ),
    "TracklistLine": (
        ("position", "int", False, False),
        ("offsetSeconds", "int", False, False),
        ("text", "str", False, False),
    ),
    "DiscoverTracklist": (
        ("requestId", "str", False, False),
        ("url", "str", False, False),
        ("videoTitle", "str", False, False),
        ("channel", "str", False, False),
        ("lines", "TracklistLine", True, False),
    ),
    "FingerprintParams": (
        ("path", "str", False, False),
        ("durationLimit", "int", False, True),
    ),
    "DiscoverIdentified": (
        ("requestId", "str", False, False),
        ("path", "str", False, False),
        ("matched", "bool", False, False),
        ("artist", "str", False, False),
        ("title", "str", False, False),
        ("album", "str", False, True),
        ("year", "int", False, True),
        ("mbid", "str", False, True),
        ("score", "float", False, False),
        ("durationSeconds", "float", False, False),
    ),
    "PlaylistParams": (
        ("playlistId", "str", False, False),
    ),
    "RelatedParams": (
        ("artist", "str", False, False),
        ("release", "str", False, False),
        ("label", "str", False, True),
    ),
    "DiscoverRelated": (
        ("requestId", "str", False, False),
        ("byArtist", "CatalogEntry", True, False),
        ("byLabel", "CatalogEntry", True, False),
        ("labelName", "str", False, False),
    ),
    "DiscoverBrowseParams": (
        ("sourceKind", "WantSource", False, False),
        ("kind", "DiscoverKind", False, False),
        ("id", "int", False, True),
        ("name", "str", False, True),
        ("url", "str", False, True),
    ),
    "DiscoverPlaylistItem": (
        ("videoId", "str", False, False),
        ("title", "str", False, False),
        ("channel", "str", False, False),
        ("position", "int", False, False),
        ("available", "bool", False, False),
    ),
    "DiscoverPlaylist": (
        ("requestId", "str", False, False),
        ("playlistId", "str", False, False),
        ("items", "DiscoverPlaylistItem", True, False),
        ("total", "int", False, False),
        ("complete", "bool", False, False),
    ),
    "DiscogsWant": (
        ("discogsId", "int", False, False),
        ("masterId", "int", False, True),
        ("title", "str", False, False),
        ("artist", "str", False, False),
        ("year", "int", False, True),
        ("label", "str", False, False),
        ("catno", "str", False, False),
        ("format", "str", False, False),
        ("url", "str", False, False),
        ("addedAt", "str", False, False),
        ("notes", "str", False, False),
    ),
    "DiscoverWantlist": (
        ("requestId", "str", False, False),
        ("username", "str", False, False),
        ("items", "DiscogsWant", True, False),
        ("total", "int", False, False),
        ("complete", "bool", False, False),
    ),
    "DiscoverCatalog": (
        ("requestId", "str", False, False),
        ("sourceKind", "WantSource", False, False),
        ("kind", "DiscoverKind", False, False),
        ("name", "str", False, False),
        ("id", "int", False, False),
        ("url", "str", False, True),
        ("releases", "CatalogEntry", True, False),
        ("complete", "bool", False, False),
    ),
    "DiscoverFailed": (
        ("requestId", "str", False, False),
        ("url", "str", False, False),
        ("reason", "str", False, False),
        ("needs", "str", False, False),
        ("unauthorised", "bool", False, False),
        ("unreachable", "bool", False, False),
    ),
    "WantEntry": (
        ("id", "str", False, False),
        ("artist", "str", False, False),
        ("title", "str", False, False),
        ("album", "str", False, True),
        ("year", "int", False, True),
        ("label", "str", False, True),
        ("catalogNumber", "str", False, True),
        ("sourceKind", "WantSource", False, False),
        ("sourceUrl", "str", False, True),
        ("sourceTitle", "str", False, True),
        ("artworkUri", "str", False, True),
        ("status", "WantStatus", False, False),
        ("addedAt", "float", False, False),
        ("searchedAt", "float", False, True),
        ("notes", "str", False, True),
        ("duration", "int", False, True),
        ("tracklist", "WantTrack", True, False),
        ("sessionId", "str", False, True),
    ),
    "WantList": (
        ("entries", "WantEntry", True, False),
    ),
    "DigSession": (
        ("id", "str", False, False),
        ("name", "str", False, False),
        ("createdAt", "float", False, False),
        ("lastActiveAt", "float", False, False),
        ("closed", "bool", False, False),
    ),
    "DigSessionList": (
        ("sessions", "DigSession", True, False),
    ),
    "SessionCreateParams": (
        ("name", "str", False, True),
    ),
    "Profile": (
        ("username", "str", False, False),
        ("description", "str", False, False),
        ("picturePath", "str", False, False),
        ("pictureUri", "str", False, True),
        ("pictureError", "str", False, False),
        ("pictureBytes", "int", False, False),
        ("pictureVisible", "bool", False, False),
        ("sharedFiles", "int", False, True),
        ("sharedFolders", "int", False, True),
        ("uploadSlots", "int", False, False),
        ("freeSlots", "bool", False, False),
        ("queueSize", "int", False, False),
    ),
    "ProfileParams": (
        ("description", "str", False, True),
        ("picturePath", "str", False, True),
        ("pictureVisible", "bool", False, True),
    ),
    "PeerConnection": (
        ("username", "str", False, False),
        ("country", "str", False, True),
        ("downloading", "int", False, False),
        ("downloadQueued", "int", False, False),
        ("uploading", "int", False, False),
        ("uploadQueued", "int", False, False),
    ),
    "ConnectionSnapshot": (
        ("socketCount", "int", False, False),
        ("peers", "PeerConnection", True, False),
    ),
    "TransferCounts": (
        ("startedDownloads", "int", False, False),
        ("completedDownloads", "int", False, False),
        ("downloadedSize", "int", False, False),
        ("startedUploads", "int", False, False),
        ("completedUploads", "int", False, False),
        ("uploadedSize", "int", False, False),
    ),
    "TransferStats": (
        ("sinceTimestamp", "int", False, False),
        ("session", "TransferCounts", False, False),
        ("total", "TransferCounts", False, False),
    ),
    "WatchedLabel": (
        ("id", "str", False, False),
        ("sourceKind", "WantSource", False, False),
        ("kind", "DiscoverKind", False, False),
        ("name", "str", False, False),
        ("url", "str", False, False),
        ("entityId", "int", False, True),
        ("addedAt", "float", False, False),
        ("lastSeenAt", "float", False, True),
        ("releaseCount", "int", False, True),
        ("ownedCount", "int", False, True),
        ("wantedCount", "int", False, True),
        ("note", "str", False, False),
    ),
    "WatchedLabelList": (
        ("labels", "WatchedLabel", True, False),
    ),
    "LabelWatchParams": (
        ("sourceKind", "WantSource", False, False),
        ("kind", "DiscoverKind", False, False),
        ("name", "str", False, False),
        ("url", "str", False, True),
        ("entityId", "int", False, True),
    ),
    "LabelIdParams": (
        ("id", "str", False, False),
    ),
    "LabelNoteParams": (
        ("id", "str", False, False),
        ("note", "str", False, False),
    ),
    "LabelSeenParams": (
        ("id", "str", False, False),
        ("releaseCount", "int", False, False),
        ("ownedCount", "int", False, False),
        ("wantedCount", "int", False, False),
    ),
    "SessionIdParams": (
        ("id", "str", False, False),
    ),
    "SessionRenameParams": (
        ("id", "str", False, False),
        ("name", "str", False, False),
    ),
    "WantAddParams": (
        ("entries", "WantEntry", True, False),
    ),
    "WantRemoveParams": (
        ("ids", "str", True, False),
    ),
    "WantUpdateParams": (
        ("id", "str", False, False),
        ("artist", "str", False, True),
        ("title", "str", False, True),
        ("album", "str", False, True),
        ("status", "WantStatus", False, True),
        ("notes", "str", False, True),
    ),
    "HistoryState": (
        ("items", "str", True, False),
    ),
    "SavedSearch": (
        ("query", "str", False, False),
        ("filtersJson", "str", False, False),
    ),
    "SavedParams": (
        ("query", "str", False, False),
        ("filtersJson", "str", False, False),
    ),
    "SavedState": (
        ("items", "SavedSearch", True, False),
    ),
    "BuddyState": (
        ("items", "str", True, False),
    ),
    "WishlistState": (
        ("items", "str", True, False),
        ("intervalSeconds", "int", False, False),
    ),
    "TransferIdsParams": (
        ("transferIds", "str", True, False),
    ),
    "TransferListResult": (
        ("transfers", "Transfer", True, False),
    ),
    "SettingsPatchParams": (
        ("settings", "Settings", False, False),
    ),
    "SettingsResult": (
        ("settings", "Settings", False, False),
    ),
    "Settings": (
        ("downloadFolder", "str", False, True),
        ("incompleteFolder", "str", False, True),
        ("listenPort", "int", False, True),
        ("maxDownloadSpeed", "int", False, True),
        ("maxUploadSpeed", "int", False, True),
        ("uploadSlots", "int", False, True),
        ("autoConnect", "bool", False, True),
        ("stallSeconds", "int", False, True),
    ),
    "ConnectionState": (
        ("status", "ConnectionStatus", False, False),
        ("username", "str", False, True),
        ("publicAddress", "str", False, True),
        ("error", "str", False, True),
    ),
    "ConnectionStats": (
        ("connections", "int", False, False),
        ("downloadBandwidth", "int", False, False),
        ("uploadBandwidth", "int", False, False),
    ),
    "SearchResultEvent": (
        ("searchId", "int", False, False),
        ("peer", "PeerStats", False, False),
        ("files", "FileRef", True, False),
        ("private", "bool", False, False),
        ("receivedAt", "float", False, False),
    ),
    "SearchClosedEvent": (
        ("searchId", "int", False, False),
        ("reason", "SearchCloseReason", False, False),
        ("resultCount", "int", False, False),
        ("peerCount", "int", False, False),
    ),
    "SearchFailedEvent": (
        ("searchId", "int", False, False),
        ("reason", "str", False, False),
    ),
    "UserStatusEvent": (
        ("username", "str", False, False),
        ("status", "UserStatus", False, False),
        ("privileged", "bool", False, True),
    ),
    "UserBrowseResultEvent": (
        ("username", "str", False, False),
        ("folders", "FolderRef", True, False),
        ("fileCount", "int", False, False),
        ("totalSize", "int", False, False),
    ),
    "UserBrowseFailedEvent": (
        ("username", "str", False, False),
        ("reason", "str", False, False),
    ),
    "FolderContentsEvent": (
        ("requestId", "str", False, False),
        ("username", "str", False, False),
        ("folderPath", "str", False, False),
        ("folders", "FolderRef", True, False),
        ("enqueued", "int", False, False),
    ),
    "FolderContentsFailedEvent": (
        ("requestId", "str", False, True),
        ("username", "str", False, False),
        ("folderPath", "str", False, False),
        ("reason", "str", False, False),
    ),
    "Transfer": (
        ("id", "str", False, False),
        ("direction", "TransferDirection", False, False),
        ("username", "str", False, False),
        ("path", "str", False, False),
        ("localFolder", "str", False, True),
        ("size", "int", False, False),
        ("bytesDone", "int", False, False),
        ("state", "TransferState", False, False),
        ("speed", "int", False, False),
        ("averageSpeed", "int", False, False),
        ("queuePosition", "int", False, True),
        ("secondsLeft", "int", False, True),
        ("secondsElapsed", "int", False, False),
        ("stalled", "bool", False, False),
        ("file", "FileRef", False, True),
        ("error", "str", False, True),
    ),
    "TransferRemovedEvent": (
        ("transferIds", "str", True, False),
    ),
    "FolderFinishedEvent": (
        ("localFolder", "str", False, False),
    ),
    "SpectralAnalysis": (
        ("requestId", "str", False, False),
        ("path", "str", False, False),
        ("transferId", "str", False, True),
        ("sampleRate", "int", False, False),
        ("channels", "int", False, False),
        ("durationSeconds", "float", False, False),
        ("decodedWith", "str", False, False),
        ("nyquistHz", "float", False, False),
        ("cutoffHz", "float", False, True),
        ("shelfDropDb", "float", False, True),
        ("shelfWidthHz", "float", False, True),
        ("confidence", "float", False, False),
        ("assessment", "SpectralAssessment", False, False),
        ("declaredLossless", "bool", False, False),
        ("impliedSourceKbps", "int", False, True),
        ("spectrumHz", "float", True, False),
        ("spectrumDb", "float", True, False),
        ("heatmapDb", "float", True, False),
        ("heatmapTimeBins", "int", False, False),
        ("heatmapFreqBins", "int", False, False),
        ("fftSize", "int", False, False),
        ("windowCount", "int", False, False),
        ("analysedSeconds", "float", False, False),
    ),
    "SpectralRequestParams": (
        ("path", "str", False, True),
        ("transferId", "str", False, True),
    ),
    "SpectralRequestResult": (
        ("requestId", "str", False, False),
    ),
    "AnalysisFailedEvent": (
        ("requestId", "str", False, False),
        ("path", "str", False, True),
        ("reason", "str", False, False),
    ),
    "SharedFolder": (
        ("virtualName", "str", False, False),
        ("path", "str", False, False),
        ("exists", "bool", False, False),
    ),
    "ChatMessage": (
        ("scope", "ChatScope", False, False),
        ("target", "str", False, False),
        ("username", "str", False, False),
        ("message", "str", False, False),
        ("outgoing", "bool", False, False),
        ("kind", "ChatMessageKind", False, False),
        ("mentioned", "bool", False, False),
        ("timestamp", "int", False, False),
    ),
    "ChatRoom": (
        ("name", "str", False, False),
        ("userCount", "int", False, False),
        ("joined", "bool", False, False),
        ("private", "bool", False, False),
    ),
    "ChatRoomList": (
        ("rooms", "ChatRoom", True, False),
    ),
    "ChatRoomMembers": (
        ("room", "str", False, False),
        ("users", "str", True, False),
    ),
    "ChatJoinParams": (
        ("room", "str", False, False),
    ),
    "ChatLeaveParams": (
        ("room", "str", False, False),
    ),
    "ChatSayParams": (
        ("scope", "ChatScope", False, False),
        ("target", "str", False, False),
        ("message", "str", False, False),
    ),
    "ChatOpenParams": (
        ("username", "str", False, False),
    ),
    "ShareState": (
        ("consent", "ShareConsent", False, False),
        ("folders", "SharedFolder", True, False),
        ("scanning", "bool", False, False),
        ("ready", "bool", False, False),
        ("fileCount", "int", False, True),
        ("folderCount", "int", False, True),
        ("totalSize", "int", False, True),
        ("lastScanAt", "float", False, True),
        ("restartRequired", "bool", False, False),
    ),
    "ShareSetParams": (
        ("consent", "ShareConsent", False, False),
        ("folders", "SharedFolder", True, False),
    ),
    "ShareRescanParams": (
        ("force", "bool", False, True),
    ),
    "PathCheckParams": (
        ("path", "str", False, False),
    ),
    "PathCheck": (
        ("path", "str", False, False),
        ("resolved", "str", False, False),
        ("exists", "bool", False, False),
        ("isDirectory", "bool", False, False),
        ("writable", "bool", False, False),
        ("parentExists", "bool", False, False),
        ("parentWritable", "bool", False, False),
    ),
    "EnsureFolderParams": (
        ("path", "str", False, False),
    ),
    "ImportSource": (
        ("available", "bool", False, False),
        ("configPath", "str", False, False),
        ("hasCredentials", "bool", False, False),
        ("username", "str", False, True),
        ("folders", "SharedFolder", True, False),
        ("downloadFolder", "str", False, True),
        ("error", "str", False, True),
    ),
    "ImportApplyParams": (
        ("credentials", "bool", False, False),
        ("shares", "bool", False, False),
        ("downloadFolder", "bool", False, False),
    ),
    "ImportResult": (
        ("importedCredentials", "bool", False, False),
        ("importedShares", "int", False, False),
        ("importedDownloadFolder", "bool", False, False),
        ("username", "str", False, True),
    ),
    "LogEvent": (
        ("level", "LogLevel", False, False),
        ("message", "str", False, False),
        ("at", "float", False, False),
    ),
}

COMMANDS: Dict[str, Tuple[Optional[str], Optional[str]]] = {
    "hello": ("HelloParams", "HelloResult"),
    "connection.connect": ("ConnectParams", None),
    "connection.disconnect": (None, None),
    "search.start": ("SearchStartParams", "SearchStartResult"),
    "search.stop": ("SearchStopParams", None),
    "user.browse": ("UserBrowseParams", None),
    "user.stats": ("UserStatsParams", None),
    "transfer.enqueue": ("TransferEnqueueParams", "TransferEnqueueResult"),
    "transfer.enqueueFolder": ("TransferFolderParams", "TransferFolderResult"),
    "transfer.pause": ("TransferIdsParams", None),
    "transfer.resume": ("TransferIdsParams", None),
    "transfer.cancel": ("TransferIdsParams", None),
    "transfer.retry": ("TransferIdsParams", None),
    "transfer.clear": ("TransferIdsParams", None),
    "transfer.list": (None, "TransferListResult"),
    "analysis.spectral": ("SpectralRequestParams", "SpectralRequestResult"),
    "chat.rooms": (None, None),
    "chat.join": ("ChatJoinParams", None),
    "chat.leave": ("ChatLeaveParams", None),
    "chat.say": ("ChatSayParams", None),
    "chat.open": ("ChatOpenParams", None),
    "wishlist.add": ("WishParams", "WishlistState"),
    "wishlist.remove": ("WishParams", "WishlistState"),
    "wishlist.list": (None, "WishlistState"),
    "artwork.get": ("ArtworkParams", "RequestAccepted"),
    "artwork.stats": (None, "ArtworkCacheStats"),
    "artwork.clear": (None, "ArtworkCacheStats"),
    "metadata.inspect": ("SpectralRequestParams", "RequestAccepted"),
    "metadata.apply": ("MetadataApplyParams", "MetadataApplyResult"),
    "organise.file": ("SpectralRequestParams", "OrganiseResult"),
    "preview.get": ("PreviewParams", "RequestAccepted"),
    "app.settings.get": (None, "AppSettings"),
    "app.settings.patch": ("AppSettingsPatch", "AppSettings"),
    "peers.stats": (None, "PeerHistory"),
    "library.state": (None, "LibraryState"),
    "library.scan": ("LibraryScanParams", "LibraryState"),
    "library.releases": (None, "LibraryReleases"),
    "library.gaps": ("ArtworkParams", "RequestAccepted"),
    "library.owned": (None, "LibraryOwned"),
    "discover.parseUrl": ("DiscoverParseUrlParams", "RequestAccepted"),
    "session.list": (None, "DigSessionList"),
    "session.create": ("SessionCreateParams", "DigSessionList"),
    "session.rename": ("SessionRenameParams", "DigSessionList"),
    "session.close": ("SessionIdParams", "DigSessionList"),
    "session.delete": ("SessionIdParams", "DigSessionList"),
    "profile.get": (None, "Profile"),
    "profile.set": ("ProfileParams", "Profile"),
    "connections.get": (None, "ConnectionSnapshot"),
    "stats.get": (None, "TransferStats"),
    "labels.list": (None, "WatchedLabelList"),
    "labels.watch": ("LabelWatchParams", "WatchedLabelList"),
    "labels.unwatch": ("LabelIdParams", "WatchedLabelList"),
    "labels.note": ("LabelNoteParams", "WatchedLabelList"),
    "labels.seen": ("LabelSeenParams", "WatchedLabelList"),
    "want.list": (None, "WantList"),
    "want.add": ("WantAddParams", "WantList"),
    "want.remove": ("WantRemoveParams", "WantList"),
    "want.update": ("WantUpdateParams", "WantList"),
    "discover.parseTracklist": ("DiscoverParseUrlParams", "RequestAccepted"),
    "discover.fingerprint": ("FingerprintParams", "RequestAccepted"),
    "discover.playlist": ("PlaylistParams", "RequestAccepted"),
    "discover.wantlist": (None, "RequestAccepted"),
    "discover.related": ("RelatedParams", "RequestAccepted"),
    "discover.browse": ("DiscoverBrowseParams", "RequestAccepted"),
    "history.list": (None, "HistoryState"),
    "history.record": ("WishParams", "HistoryState"),
    "history.clear": (None, "HistoryState"),
    "saved.list": (None, "SavedState"),
    "saved.add": ("SavedParams", "SavedState"),
    "saved.remove": ("WishParams", "SavedState"),
    "buddies.list": (None, "BuddyState"),
    "buddies.add": ("UserBrowseParams", "BuddyState"),
    "buddies.remove": ("UserBrowseParams", "BuddyState"),
    "shares.get": (None, "ShareState"),
    "shares.set": ("ShareSetParams", "ShareState"),
    "shares.rescan": ("ShareRescanParams", None),
    "import.inspect": (None, "ImportSource"),
    "import.apply": ("ImportApplyParams", "ImportResult"),
    "settings.get": (None, "SettingsResult"),
    "settings.patch": ("SettingsPatchParams", "SettingsResult"),
    "fs.check": ("PathCheckParams", "PathCheck"),
    "fs.ensureFolder": ("EnsureFolderParams", "PathCheck"),
}

EVENTS: Dict[str, str] = {
    "connection.state": "ConnectionState",
    "connection.stats": "ConnectionStats",
    "search.started": "SearchInfo",
    "search.result": "SearchResultEvent",
    "search.closed": "SearchClosedEvent",
    "search.failed": "SearchFailedEvent",
    "user.stats": "PeerStats",
    "user.status": "UserStatusEvent",
    "user.browse.result": "UserBrowseResultEvent",
    "user.browse.failed": "UserBrowseFailedEvent",
    "folder.contents": "FolderContentsEvent",
    "folder.contents.failed": "FolderContentsFailedEvent",
    "transfer.added": "Transfer",
    "transfer.updated": "Transfer",
    "transfer.removed": "TransferRemovedEvent",
    "folder.finished": "FolderFinishedEvent",
    "analysis.result": "SpectralAnalysis",
    "analysis.failed": "AnalysisFailedEvent",
    "chat.message": "ChatMessage",
    "chat.rooms": "ChatRoomList",
    "chat.members": "ChatRoomMembers",
    "shares.state": "ShareState",
    "wishlist.state": "WishlistState",
    "buddies.state": "BuddyState",
    "library.state": "LibraryState",
    "app.settings": "AppSettings",
    "peers.stats": "PeerHistory",
    "library.gaps": "LibraryGaps",
    "preview.result": "PreviewResult",
    "preview.failed": "PreviewFailed",
    "artwork.result": "ArtworkResult",
    "artwork.failed": "ArtworkFailed",
    "metadata.proposal": "MetadataProposal",
    "want.changed": "WantList",
    "connections.changed": "ConnectionSnapshot",
    "stats.changed": "TransferStats",
    "labels.changed": "WatchedLabelList",
    "session.changed": "DigSessionList",
    "discover.parsed": "DiscoverParsed",
    "discover.parseFailed": "DiscoverFailed",
    "discover.catalog": "DiscoverCatalog",
    "discover.playlistItems": "DiscoverPlaylist",
    "discover.wantlistItems": "DiscoverWantlist",
    "discover.identified": "DiscoverIdentified",
    "discover.relatedResults": "DiscoverRelated",
    "discover.tracklistParsed": "DiscoverTracklist",
    "discover.browseFailed": "DiscoverFailed",
    "log": "LogEvent",
}

COMMAND_NAMES = tuple(COMMANDS)
EVENT_NAMES = tuple(EVENTS)


class SchemaError(ValueError):
    """A payload did not match the generated schema."""


_PRIMITIVE_CHECKS = {
    "str": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "float": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "json": lambda v: True,
}


def _check_value(value, base, path):
    if base in _PRIMITIVE_CHECKS:
        if not _PRIMITIVE_CHECKS[base](value):
            raise SchemaError(
                f"{path}: expected {base}, got {type(value).__name__} ({value!r})"
            )
        return
    if base in ENUM_VALUES:
        if value not in ENUM_VALUES[base]:
            raise SchemaError(
                f"{path}: {value!r} is not a valid {base} "
                f"(expected one of {', '.join(ENUM_VALUES[base])})"
            )
        return
    validate_struct(base, value, path)


def validate_struct(name, value, path=""):
    """Raise SchemaError unless `value` is a valid `name`.

    Checks presence, type, nullability and — crucially — rejects unknown keys.
    A typo in an emitter is otherwise invisible until it reaches TypeScript.
    """
    fields = STRUCT_FIELDS.get(name)
    if fields is None:
        raise SchemaError(f"{path or '<root>'}: unknown struct {name!r}")
    if not isinstance(value, dict):
        raise SchemaError(
            f"{path or name}: expected object, got {type(value).__name__}"
        )

    prefix = f"{path}." if path else f"{name}."
    known = set()

    for field, base, is_array, nullable in fields:
        known.add(field)
        if field not in value:
            raise SchemaError(f"{prefix}{field}: missing")
        item = value[field]
        if item is None:
            if not nullable:
                raise SchemaError(f"{prefix}{field}: null not allowed")
            continue
        if is_array:
            if not isinstance(item, list):
                raise SchemaError(
                    f"{prefix}{field}: expected array, got {type(item).__name__}"
                )
            for i, element in enumerate(item):
                _check_value(element, base, f"{prefix}{field}[{i}]")
            continue
        _check_value(item, base, f"{prefix}{field}")

    extra = set(value) - known
    if extra:
        raise SchemaError(
            f"{prefix.rstrip('.')}: unknown field(s) {', '.join(sorted(extra))}"
        )


def validate_event(name, data):
    """Raise SchemaError unless `data` is a valid payload for event `name`."""
    payload = EVENTS.get(name)
    if payload is None:
        raise SchemaError(f"unknown event {name!r}")
    validate_struct(payload, data, payload)


def validate_command(name, params):
    """Raise SchemaError unless `params` is valid for command `name`."""
    entry = COMMANDS.get(name)
    if entry is None:
        raise SchemaError(f"unknown command {name!r}")
    struct = entry[0]
    if struct is None:
        if params not in (None, {}):
            raise SchemaError(f"{name}: expected no params, got {params!r}")
        return
    validate_struct(struct, params, struct)


def validate_result(name, result):
    """Raise SchemaError unless `result` is valid for command `name`."""
    entry = COMMANDS.get(name)
    if entry is None:
        raise SchemaError(f"unknown command {name!r}")
    struct = entry[1]
    if struct is None:
        if result not in (None, {}):
            raise SchemaError(f"{name}: expected no result, got {result!r}")
        return
    validate_struct(struct, result, struct)

