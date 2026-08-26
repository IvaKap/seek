# Seek — protocol schema, single source of truth.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This file is the ONLY place the wire protocol is defined. Both
# `shared/protocol.ts` and `sidecar/seek_sidecar/protocol.py` are generated from
# it by `shared/generate_protocol.py`. Never hand-edit either output; edit this
# and regenerate. `sidecar/tests/test_protocol_sync.py` fails the build if the
# checked-in outputs drift from this file.
#
# Design rules (from BRIEF_SEEK.md and AGENTS.md):
#   * The Python side emits RAW STRUCTURED DATA and formats nothing for display.
#     No human-readable sizes, speeds, durations, percentages or labels appear
#     anywhere in this schema. Bytes are bytes, seconds are seconds.
#   * Every field that upstream can fail to provide is nullable, and is null
#     rather than 0/"" so the frontend can distinguish "absent" from "zero".
#   * Nothing here is derived. No format tier, no quality score, no dedup key,
#     no transcode verdict. All of that is `app/src/domain/`.
#
# The type mini-language used below:
#   "str" "int" "float" "bool" "json"   primitives ("json" = opaque any)
#   "Foo"                               reference to a STRUCT or ENUM
#   "T?"                                nullable (T | null)
#   "T[]"                               array of T (arrays are never nullable;
#                                       absent means empty)
# Suffixes compose right-to-left: "Foo[]?" is a nullable array, "Foo?[]" is not
# expressible and is rejected by the generator.

PROTOCOL_VERSION = 1

# --------------------------------------------------------------------------
# Enums — closed string sets. Values are the literal strings sent on the wire.
# --------------------------------------------------------------------------

ENUMS = {
    "ChatScope": (
        "Which conversation a chat line belongs to.",
        ["room", "private"],
    ),
    "ChatMessageKind": (
        "How the line should read. 'action' is the /me form; 'local' is "
        "client-generated and never touched the network.",
        ["message", "action", "local", "hilite"],
    ),
    "ConnectionStatus": (
        "Sidecar's view of the Soulseek server connection.",
        ["offline", "connecting", "online", "away", "failed"],
    ),
    "UserStatus": (
        "Peer presence. Mirrors upstream UserStatus (0/1/2) as strings.",
        ["offline", "away", "online"],
    ),
    "SearchMode": (
        "Which population a search is broadcast to. Mirrors "
        "pynicotine.search.Search.do_search(mode=...).",
        ["global", "rooms", "buddies", "user", "wishlist"],
    ),
    "SearchCloseReason": (
        "Why the sidecar stopped accepting results for a search. Soulseek has "
        "NO server-side completion signal (see RECON.md §3) — every value here "
        "is a client-side decision, not a network fact.",
        ["timeout", "result_cap", "stopped", "disconnected"],
    ),
    "TransferDirection": (
        "Which way a transfer is going.\n"
        "\n"
        "Both share one event stream and one id space, because they are the "
        "same kind of thing and the frontend groups them the same way. The id "
        "carries the direction (`registries.transfer_key`) so a download from "
        "a peer and an upload to that peer of a matching virtual path cannot "
        "collide — which is not exotic, since a folder you downloaded into is "
        "often a folder you share.",
        ["download", "upload"],
    ),
    "TransferState": (
        "Verbatim pass-through of pynicotine.transfers.TransferStatus, "
        "lowercased and underscored. The set is closed upstream; if a new value "
        "appears it is forwarded as 'unknown' and logged.",
        [
            "queued",
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
        ],
    ),
    "ErrorCode": (
        "Machine-readable failure reasons for command replies.",
        [
            "bad_request",
            "unknown_command",
            "not_connected",
            "already_queued",
            "not_found",
            "unsupported",
            "internal",
        ],
    ),
    "SpectralAssessment": (
        "Conclusion of a post-download spectral check. Deliberately hedged: a "
        "lowpass shelf is strong evidence but never proof, and quiet or sparse "
        "music genuinely lacks high-frequency energy. Never render any of these "
        "as a definitive verdict — there is no 'fake' value here on purpose.",
        [
            "likely_lossless",
            "possible_transcode",
            "strong_signs_of_lossy_source",
            "inconclusive",
        ],
    ),
    "ShareConsent": (
        "Whether the user has decided what to share back to the network.\n"
        "\n"
        "'declined' is a real, persisted answer, not an absence of one, and the\n"
        "app is expected to surface it permanently: Soulseek is reciprocal, and\n"
        "peers deprioritise and ban clients that share nothing. Throttled\n"
        "transfers and refused queues then look like a bug in Seek rather than\n"
        "the network working exactly as designed.",
        ["unset", "granted", "declined"],
    ),
    "LogLevel": (
        "Severity of a forwarded sidecar/core log line.",
        ["debug", "info", "warning", "error"],
    ),
    "WantSource": (
        "Where the user found a piece of music. 'manual' is a typed entry; "
        "'fingerprint' is an AcoustID identification.",
        ["youtube", "bandcamp", "discogs", "manual", "fingerprint"],
    ),
    "WantStatus": (
        "Where a want list entry sits in the seek-evaluate-download loop.\n"
        "\n"
        "'found' and 'not_found' are decided by the FRONTEND, after a search it\n"
        "ran, by matching results against the entry. The sidecar only stores the\n"
        "answer: Soulseek has no completion signal (RECON.md §3), so 'not_found'\n"
        "is a client-side timeout decision, and whether a result actually IS the\n"
        "thing you wanted is fuzzy matching over parsed paths, which lives in\n"
        "app/src/domain/.",
        ["pending", "searching", "found", "downloaded", "not_found"],
    ),
    "DiscoverKind": (
        "What a discovery URL actually names. A label or artist URL is not "
        "something to search for directly — it is a catalogue to browse, and "
        "the frontend offers a different action for it.",
        ["track", "release", "artist", "label"],
    ),
}

# --------------------------------------------------------------------------
# Structs
# --------------------------------------------------------------------------

STRUCTS = {
    # ---- core value types --------------------------------------------------
    "FileRef": (
        "One file offered by one peer. This is the atom of the whole protocol.\n"
        "\n"
        "IMPORTANT (RECON.md §4): the audio attributes below arrive in two\n"
        "DISJOINT sets, because that is what FileListMessage.pack_file_info()\n"
        "puts on the wire:\n"
        "  lossless -> duration, sampleRate, bitDepth   (bitrate/isVbr are null)\n"
        "  lossy    -> bitrate, duration, isVbr         (sampleRate/bitDepth null)\n"
        "Any or all of them may also be null for peers running clients that send\n"
        "no attributes at all. Never assume a field is present.",
        [
            (
                "path",
                "str",
                "Full virtual path exactly as the peer sent it, backslash-separated. "
                "Upstream rewrites '/' to '\\\\' but performs no other normalisation, "
                "and neither do we. This is the identity of the file on that peer.",
            ),
            ("size", "int", "File size in bytes."),
            (
                "bitrate",
                "int?",
                "Advertised bitrate in kbps (FileAttribute.BITRATE). A CLAIM by the "
                "peer, not a measurement. Null for lossless files and for peers that "
                "send no attributes.",
            ),
            (
                "duration",
                "int?",
                "Length in whole seconds (FileAttribute.LENGTH). Null when absent. "
                "Without this, no size-vs-bitrate check is possible at all.",
            ),
            (
                "sampleRate",
                "int?",
                "Sample rate in Hz (FileAttribute.SAMPLE_RATE). In practice only "
                "present on lossless files.",
            ),
            (
                "bitDepth",
                "int?",
                "Bits per sample (FileAttribute.BIT_DEPTH). In practice only present "
                "on lossless files, and is what upstream uses to decide a file IS "
                "lossless when encoding.",
            ),
            (
                "isVbr",
                "bool?",
                "Variable bitrate flag (FileAttribute.VBR). Null on lossless files "
                "and when absent. Note upstream discards FileAttribute.ENCODER "
                "entirely (RECON.md §4), so no encoder string is available.",
            ),
        ],
    ),
    "PeerStats": (
        "Per-peer facts. `freeSlots`/`queueLength`/`advertisedSpeed` arrive with "
        "every search response; `files`/`folders` only arrive from the server via "
        "user-stats, and are null until then.",
        [
            ("username", "str", "Connection-authenticated peer name (msg.username)."),
            (
                "freeSlots",
                "bool",
                "Peer has a free upload slot right now (`freeulslots`). Forwarded "
                "raw — upstream's GTK client rewrites queueLength to 0 when this is "
                "true, and we deliberately do not.",
            ),
            (
                "advertisedSpeed",
                "int",
                "Peer's self-reported average upload speed in BYTES per second "
                "(`ulspeed`). A promise, not a measurement — the UI must render it "
                "distinctly from an observed transfer speed.",
            ),
            (
                "queueLength",
                "int",
                "Number of files queued on that peer (`inqueue`), as reported.",
            ),
            (
                "files",
                "int?",
                "Total files the peer shares, per the server. Null unless a "
                "user-stats update has been seen.",
            ),
            (
                "folders",
                "int?",
                "Total folders the peer shares, per the server. Null unless a "
                "user-stats update has been seen.",
            ),
            (
                "country",
                "str?",
                "Two-letter country code resolved from the peer's IP, when known.",
            ),
        ],
    ),
    "FolderRef": (
        "A folder and its files. Used by browse and folder-contents results. "
        "Note that `FileRef.path` here is always rebuilt into a FULL path by the "
        "sidecar — upstream hands back bare basenames for browse/folder-contents "
        "but full paths for search, and that inconsistency does not reach the "
        "wire (RECON.md §6).",
        [
            ("path", "str", "Full folder path, backslash-separated."),
            ("files", "FileRef[]", "Files directly in this folder."),
            (
                "private",
                "bool",
                "True if the peer returned this folder in their buddy-only share "
                "list rather than their public one.",
            ),
        ],
    ),
    # ---- envelope ----------------------------------------------------------
    "ErrorInfo": (
        "Failure detail on a command reply.",
        [
            ("code", "ErrorCode", "Machine-readable reason."),
            ("message", "str", "Developer-facing English text. Not for display."),
        ],
    ),
    # ---- command params / results -----------------------------------------
    "HelloParams": (
        "First frame the client sends after the socket opens.",
        [
            ("protocolVersion", "int", "Client's PROTOCOL_VERSION."),
            ("client", "str", "Free-form client identifier, for the sidecar log."),
        ],
    ),
    "HelloResult": (
        "Sidecar's handshake reply, including a full state snapshot so the "
        "frontend never has to guess after a reconnect.",
        [
            ("protocolVersion", "int", "Sidecar's PROTOCOL_VERSION."),
            ("sidecarVersion", "str", "Seek sidecar version string."),
            ("coreVersion", "str", "Upstream pynicotine __version__ in use."),
            ("connection", "ConnectionState", "Current connection state."),
            ("transfers", "Transfer[]", "Every download the core currently knows about."),
            ("searches", "SearchInfo[]", "Searches still accepting results."),
        ],
    ),
    "ConnectParams": (
        "Log in to the Soulseek server. The sidecar writes credentials into the "
        "isolated Seek config and never into the user's own Nicotine+ config.\n\n"
        "Both fields are nullable, and null means 'use whatever is already "
        "stored'. That is how signing in after an import works: the import has "
        "already written the credentials, so re-sending them would mean pulling "
        "a password back out of the sidecar and across the socket just to hand "
        "it straight back.",
        [
            (
                "username",
                "str?",
                "Soulseek account name, or null to use the stored one.",
            ),
            (
                "password",
                "str?",
                "Soulseek account password, or null to use the stored one. Sent "
                "in the clear over the loopback socket when the user types it "
                "into the manual sign-in form — the socket is loopback-only and "
                "token-gated, and there is no way to authenticate a new account "
                "without transmitting it once. It is never echoed back, never "
                "logged, and never returned by any command.",
            ),
        ],
    ),
    "SearchStartParams": (
        "Begin a search.",
        [
            ("query", "str", "Raw user query. The sidecar passes it to upstream, "
                             "which sanitises it; the transmitted form comes back on "
                             "`search.started`."),
            ("mode", "SearchMode?", "Defaults to 'global'."),
            ("room", "str?", "Required when mode is 'rooms'."),
            ("users", "str[]", "Required when mode is 'user'. Empty otherwise."),
            (
                "resultCap",
                "int?",
                "Stop accepting results after this many files. Null uses the "
                "sidecar default. Emits `search.closed` with reason 'result_cap'.",
            ),
            (
                "timeoutSeconds",
                "int?",
                "Stop accepting results this long after the last one arrived. Null "
                "uses the sidecar default.",
            ),
        ],
    ),
    "SearchStartResult": (
        "",
        [("searchId", "int", "Upstream search token. Stable for the search's life.")],
    ),
    "SearchStopParams": ("", [("searchId", "int", "")]),
    "SearchInfo": (
        "A search the sidecar is still accepting results for.",
        [
            ("searchId", "int", ""),
            ("query", "str", "The term as the user typed it, after upstream trimming."),
            (
                "termTransmitted",
                "str",
                "What actually went out on the wire. Upstream strips punctuation "
                "that stops SoulseekQt from responding, so this often differs.",
            ),
            ("mode", "SearchMode", ""),
            ("startedAt", "float", "Unix epoch seconds, float."),
            ("resultCount", "int", "Files accepted so far across all peers."),
        ],
    ),
    "UserBrowseParams": ("", [("username", "str", "")]),
    "UserStatsParams": (
        "Ask the server for a peer's stats, and watch them for updates.",
        [("username", "str", "")],
    ),
    "TransferEnqueueParams": (
        "Queue one file for download.",
        [
            ("username", "str", ""),
            ("path", "str", "Full virtual path, exactly as it came from the peer."),
            ("size", "int", "Size in bytes, from the search result."),
            (
                "file",
                "FileRef?",
                "The original FileRef, if the client still has it. Passing it lets "
                "the sidecar carry the audio attributes into the transfer record so "
                "the UI keeps its quality badge while downloading.",
            ),
            (
                "destination",
                "str?",
                "Absolute local folder. Null uses the configured download folder.",
            ),
            ("paused", "bool?", "Enqueue in paused state. Defaults false."),
        ],
    ),
    "TransferEnqueueResult": (
        "",
        [
            ("transferId", "str", "Stable opaque id minted by the sidecar."),
            (
                "alreadyQueued",
                "bool",
                "True if this (user, path) was already known. Upstream's "
                "enqueue_download() silently no-ops on duplicates; we surface it.",
            ),
        ],
    ),
    "TransferFolderParams": (
        "Queue a whole remote folder. The sidecar performs the two-phase "
        "request_folder -> folder-contents-response -> enqueue dance (RECON.md §5) "
        "and reports progress via `folder.contents` then `transfer.added` events.",
        [
            ("username", "str", ""),
            ("folderPath", "str", "Full remote folder path."),
            ("recurse", "bool?", "Include subfolders. Defaults false."),
            ("destination", "str?", "Absolute local folder. Null uses the default."),
        ],
    ),
    "TransferFolderResult": (
        "",
        [
            (
                "requestId",
                "str",
                "Correlates the later `folder.contents` event with this request.",
            )
        ],
    ),
    "OrganiseResult": (
        "",
        [
            ("moved", "bool", "False when there was no confident match."),
            ("fromPath", "str", ""),
            ("toPath", "str", "Empty when nothing moved."),
            ("reason", "str", "Why not, when it did not move."),
        ],
    ),
    "PreviewParams": (
        "",
        [
            ("path", "str?", "Absolute local path, or null to use transferId."),
            ("transferId", "str?", "A finished transfer."),
            ("startSeconds", "int?", "Where to start. Defaults to a little in."),
            ("seconds", "int?", "How long. Clamped to a sane maximum."),
        ],
    ),
    "PreviewResult": (
        "A decoded excerpt, downmixed to mono and resampled down, because this "
        "crosses a socket and is for judging a track rather than listening to "
        "it properly.",
        [
            ("requestId", "str", ""),
            ("path", "str", ""),
            ("dataUri", "str", "data:audio/wav;base64,..."),
            ("startSeconds", "int", ""),
            ("seconds", "float", "Actual length returned; a short file gives less."),
            ("durationSeconds", "float", "Full length of the source file."),
        ],
    ),
    "PreviewFailed": ("", [("requestId", "str", ""), ("reason", "str", "")]),
    "AppSettings": (
        "",
        [
            (
                "autoConnect",
                "bool",
                "Sign in to Soulseek on launch using the stored account. This is "
                "upstream's own `auto_connect_startup` flag, read and written "
                "where it actually lives rather than mirrored into Seek's state.",
            ),
            ("hasCredentials", "bool", "Whether an account is stored at all."),
            ("username", "str", "The stored account name. Never the password."),
            (
                "externalLookups",
                "bool",
                "Allow MusicBrainz, Cover Art Archive, Deezer and Discogs. Off "
                "means off: no request leaves the machine.",
            ),
            ("discogsToken", "bool", "Whether a token is stored. Never the value."),
            ("artworkCacheMb", "int", "Cache cap in megabytes."),
            ("embedArtwork", "bool", "Default for the metadata panel's embed box."),
            ("writeCoverFile", "bool", "Also write cover.jpg beside the tracks."),
            (
                "preferLossless",
                "bool",
                "When a track has several sources, queue the best LOSSLESS one "
                "rather than the highest overall score. A free fast 320 usually "
                "out-scores a queued FLAC; this says which you actually want.",
            ),
            ("minBitrate", "int", "Refuse lossy files below this. 0 disables."),
            ("rejectTranscodes", "bool", "Refuse files the physics check flags."),
            (
                "autoOrganise",
                "bool",
                "Move completed downloads into Artist/Year - Album/ using the "
                "MusicBrainz match. Off by default: moving a user's files "
                "without being asked is not a default anyone should inherit.",
            ),
            (
                "acoustidApiKey",
                "bool",
                "Whether a key is stored. NEVER the value — same rule as the "
                "Discogs token: a credential does not echo back across the "
                "socket once it has been sent.",
            ),
            (
                "youtubeApiKey",
                "bool",
                "Whether a key is stored. NEVER the value — same rule as the "
                "Discogs token and the AcoustID key. Reading a public playlist "
                "needs only this simple API key; the OAuth client YouTube also "
                "offers is for a user's PRIVATE data and is deliberately not "
                "used, so there is no client secret to hold.",
            ),
            (
                "autoDigSessions",
                "bool",
                "Group a burst of want list additions into a digging session. "
                "On by default — it only ever adds a grouping, never changes "
                "or hides an entry, and it can be switched off here.",
            ),
        ],
    ),
    "AppSettingsPatch": (
        "Every field nullable: null means 'leave this alone'. An absent value "
        "and an intentionally empty one are different things.",
        [
            ("autoConnect", "bool?", ""),
            ("externalLookups", "bool?", ""),
            ("discogsToken", "str?", "Send an empty string to clear it."),
            ("artworkCacheMb", "int?", ""),
            ("embedArtwork", "bool?", ""),
            ("writeCoverFile", "bool?", ""),
            ("preferLossless", "bool?", ""),
            ("minBitrate", "int?", ""),
            ("rejectTranscodes", "bool?", ""),
            ("autoOrganise", "bool?", ""),
            ("acoustidApiKey", "str?", "The key itself, for writing. Empty clears it."),
            ("youtubeApiKey", "str?", "The key itself, for writing. Empty clears it."),
            ("autoDigSessions", "bool?", ""),
        ],
    ),
    "PeerRecord": (
        "",
        [
            ("username", "str", ""),
            ("ok", "int", "Transfers that finished."),
            ("failed", "int", "Transfers that errored or lost the peer."),
            ("lastSeen", "int", "Unix seconds of the last outcome."),
        ],
    ),
    "PeerHistory": ("", [("items", "PeerRecord[]", "")]),
    "WishParams": ("", [("query", "str", "The search text to wish for.")]),
    "LibraryState": (
        "",
        [
            ("scannedAt", "int", "Unix seconds. 0 if never scanned."),
            ("roots", "str[]", "Folders the index was built from."),
            ("releaseCount", "int", ""),
            ("trackCount", "int", ""),
            ("scanning", "bool", ""),
        ],
    ),
    "LibraryScanParams": (
        "",
        [
            (
                "roots",
                "str[]",
                "Extra folders to include. The download folder is always "
                "scanned; these are added to it.",
            ),
            (
                "readTags",
                "bool?",
                "Read tags as well as paths. Much slower over a network volume, "
                "but far more accurate. Defaults true.",
            ),
        ],
    ),
    "LibraryRelease": (
        "",
        [
            ("key", "str", "Normalised artist|release, matched against search results."),
            ("artist", "str", ""),
            ("release", "str", ""),
            ("folder", "str", "Where it lives on disk."),
            ("trackCount", "int", ""),
            ("bytes", "int", ""),
            (
                "formats",
                "str",
                "Extension counts as JSON, e.g. {\"flac\": 12}. Opaque to the "
                "sidecar: what the mix MEANS is a presentation question, and "
                "presentation is TypeScript's job.",
            ),
            ("year", "int", "0 when no tag carried a plausible one."),
            ("genre", "str", "First genre seen in the folder. Often empty."),
        ],
    ),
    "LibraryReleases": ("", [("items", "LibraryRelease[]", "")]),
    "LibraryGap": (
        "",
        [
            ("position", "int", ""),
            ("title", "str", ""),
            ("artist", "str", ""),
            ("have", "bool", "Present on disk."),
        ],
    ),
    "LibraryGaps": (
        "",
        [
            ("key", "str", "Echoes the request."),
            ("matched", "bool", "False when MusicBrainz had no confident match."),
            ("releaseTitle", "str", ""),
            ("releaseArtist", "str", ""),
            ("score", "int", ""),
            ("tracks", "LibraryGap[]", "The full official track list, marked."),
        ],
    ),
    "LibraryOwned": (
        "",
        [("releases", "str[]", "Release keys."), ("tracks", "str[]", "Track keys.")],
    ),
    "ArtworkParams": (
        "",
        [
            ("artist", "str", "May be empty; the release name alone often matches."),
            ("release", "str", "Release or folder name, as parsed."),
            ("key", "str", "Client-side id echoed back so the row can be found."),
        ],
    ),
    "RequestAccepted": ("", [("requestId", "str", "")]),
    "ArtworkResult": (
        "A cover image, as a data URI so the webview needs no file access and "
        "no second request.",
        [
            ("key", "str", "Echoes ArtworkParams.key."),
            ("requestId", "str", ""),
            ("dataUri", "str", "data:image/...;base64,..."),
            ("source", "str", "cache | coverartarchive | deezer"),
            (
                "trackCount",
                "int",
                "How many tracks MusicBrainz says the release has. 0 when there "
                "was no confident match — the SAME lookup that found the cover "
                "produced this, so completeness costs no extra requests.",
            ),
            ("date", "str", "Release date, or empty."),
            ("label", "str", "Label, or empty."),
            ("mbid", "str", "Release MBID, or empty."),
        ],
    ),
    "ArtworkFailed": (
        "",
        [
            ("key", "str", ""),
            ("requestId", "str", ""),
            ("reason", "str", "Developer-facing. A miss is normal, not an error."),
        ],
    ),
    "ArtworkCacheStats": (
        "",
        [("entries", "int", ""), ("bytes", "int", ""), ("capBytes", "int", "")],
    ),
    "TagChange": (
        "One field that would change. Named `current`/`proposed` rather than "
        "from/to because `from` is a Python keyword and the generated "
        "dataclass would not parse.",
        [
            ("field", "str", ""),
            ("current", "str", "What the file says now. May be empty."),
            ("proposed", "str", "What MusicBrainz says it should be."),
        ],
    ),
    "MetadataProposal": (
        "What MusicBrainz thinks this file should be tagged as. NOTHING is "
        "written until the user applies it — a wrong automatic retag is "
        "unrecoverable once the original filename is gone.",
        [
            ("requestId", "str", ""),
            ("path", "str", ""),
            ("transferId", "str?", ""),
            ("matched", "bool", "False when MusicBrainz found nothing confident."),
            (
                "score",
                "int",
                "MusicBrainz match score, 0-100. Shown so the user can weigh "
                "the proposal: a 100 on a well-known release and a 72 on a "
                "white label deserve different amounts of trust.",
            ),
            ("query", "str", "What was actually searched for, after normalising."),
            ("trackMatched", "bool", "Release matched but the track did not."),
            ("releaseTitle", "str", ""),
            ("releaseArtist", "str", ""),
            ("date", "str", ""),
            ("label", "str", ""),
            ("mbid", "str", ""),
            ("changes", "TagChange[]", "Only fields that would actually change."),
        ],
    ),
    "MetadataApplyParams": (
        "",
        [
            ("path", "str", ""),
            ("fields", "TagChange[]", "The subset the user accepted."),
            ("embedArtwork", "bool", "Also write the cover into the file."),
            ("artist", "str", "For the artwork lookup, if embedding."),
            ("release", "str", "For the artwork lookup, if embedding."),
        ],
    ),
    "MetadataApplyResult": (
        "",
        [("path", "str", ""), ("written", "int", ""), ("artworkEmbedded", "bool", "")],
    ),
    # ---- discovery ---------------------------------------------------------
    #
    # The Dig Bar: a URL in, structured facts out. What is NOT here is the
    # point. There is no parsed artist/title for YouTube and no confidence
    # score, because YouTube supplies exactly one free-text title and a channel
    # name, and turning those into an artist and a title is a DERIVATION.
    # Derivations live in `app/src/domain/parseTitle.ts`, beside the path parser
    # that does the same job for Soulseek paths (AGENTS.md, "the seam").
    #
    # Bandcamp and Discogs do return real structured fields, so `artist` and
    # `title` arrive populated from those two and need no parsing at all. The
    # asymmetry is the providers', not ours, and `sourceKind` says which case
    # the frontend is looking at.
    "WantTrack": (
        "One track in a release's expected tracklist, as the source gives it.",
        [
            ("position", "int", "Track number. 0 when the source does not number it."),
            ("title", "str", ""),
            (
                "artist",
                "str",
                "Empty unless the source credits the track separately, as it "
                "does on a compilation.",
            ),
            ("duration", "int?", "Seconds. Null when the source does not say."),
        ],
    ),
    "DiscoverParseUrlParams": (
        "",
        [
            (
                "url",
                "str",
                "The URL to look up. Anything but http/https is refused, and an "
                "unrecognised host is still attempted — Bandcamp answers for "
                "custom domains, which no host pattern can predict.",
            )
        ],
    ),
    "DiscoverParsed": (
        "What a provider says about a URL. Raw provider facts; see the note "
        "above this struct for why there is no parse here.",
        [
            ("requestId", "str", "Correlates with the discover.parseUrl command."),
            ("url", "str", "The URL that was looked up, echoed back."),
            (
                "sourceKind",
                "WantSource",
                "Which provider answered. Resolved by the sidecar, because it is "
                "the only side that can tell a Bandcamp custom domain from any "
                "other host: it asked, and Bandcamp replied.",
            ),
            ("kind", "DiscoverKind", ""),
            (
                "rawTitle",
                "str",
                "The provider's own title string, unprocessed. For YouTube this "
                "is the whole of what is known and the only thing to parse.",
            ),
            (
                "channel",
                "str",
                "YouTube's `author_name`, the uploading channel. Load-bearing "
                "for parsing: it identifies series branding and it is the "
                "fallback artist on VEVO and official artist channels. Empty "
                "for the other providers.",
            ),
            (
                "artist",
                "str",
                "Populated only when the PROVIDER states it as a field, which "
                "Bandcamp and Discogs do. Empty for YouTube, where filling it "
                "would mean guessing on the wrong side of the seam.",
            ),
            ("title", "str", "Same rule as `artist`. Empty for YouTube."),
            ("album", "str?", "Release title when the URL names a track on one."),
            ("year", "int?", "When the provider gives one."),
            ("label", "str?", ""),
            ("catalogNumber", "str?", "Discogs catalogue number, when available."),
            (
                "artworkUri",
                "str?",
                "data:image/...;base64,... — fetched BY THE SIDECAR, not linked. "
                "An <img> pointing at i.ytimg.com would be the frontend making "
                "its own request to a third party: it would leak the user's IP "
                "and it would run with external lookups switched off, which is "
                "precisely what that switch exists to prevent. Null when the "
                "provider offered no image or the fetch failed, which is normal.",
            ),
            ("duration", "int?", "Seconds, when the provider says."),
            (
                "genres",
                "str[]",
                "Discogs genres followed by its styles, in that order. Empty "
                "for the other providers.",
            ),
            (
                "tracklist",
                "WantTrack[]",
                "For releases, when the provider gives one. Discogs does; "
                "Bandcamp's oEmbed does not, and its album page is Phase D4.",
            ),
            (
                "providerUrl",
                "str?",
                "The canonical URL according to the provider, when it differs "
                "from what was pasted.",
            ),
        ],
    ),
    "CatalogEntry": (
        "One release in a label's or an artist's discography.\n"
        "\n"
        "NOTE WHAT IS ABSENT, twice over. There is no `inLibrary` flag, which\n"
        "`DISCOVERY.md` asks for: whether you already own a release is a match\n"
        "against the library index, and that index lives in the frontend\n"
        "(`libraryStore.ts`) with the normalised keys that do the matching.\n"
        "And there is no thumbnail. Discogs gives one URL per release, and a\n"
        "catalogue of three hundred would mean three hundred rate-limited\n"
        "fetches before the grid could draw. The artwork pipeline already\n"
        "solves that properly — placeholder first, fetch what scrolls into\n"
        "view — and this reuses it rather than inventing a slower second way.",
        [
            ("discogsId", "int", "0 when the provider has no numeric id."),
            ("title", "str", ""),
            ("artist", "str", ""),
            ("year", "int?", ""),
            (
                "format",
                "str",
                "Verbatim from the provider, e.g. 'CD, Album' or '12\", 33 ⅓ RPM'. "
                "A comma-joined descriptor list, not a tier — deciding what it "
                "MEANS is presentation. Empty on an artist discography, which "
                "Discogs does not annotate.",
            ),
            ("catno", "str", "Catalogue number. Empty when the provider has none."),
            (
                "role",
                "str",
                "'Main', 'Appearance', 'Remix', … on an artist discography. "
                "Empty for a label. Load-bearing: Burial's 375 entries are "
                "mostly compilation appearances, and which of those count as "
                "'their discography' is the user's call, not ours.",
            ),
            ("url", "str", "Where to see it on the provider's own site."),
        ],
    ),
    "TracklistLine": (
        "One timestamped line lifted out of a video description, UNPARSED.\n"
        "\n"
        "`text` is whatever followed the timestamp, verbatim. Turning\n"
        "'Burial - Archangel' into an artist and a title is the same derivation\n"
        "`parseTitle.ts` already does for video titles, against forty other\n"
        "shapes — so the line goes across raw and is parsed there rather than\n"
        "growing a second, differently-wrong splitter down here.",
        [
            ("position", "int", "1-based, in description order."),
            ("offsetSeconds", "int", "Where it starts in the set."),
            ("text", "str", "The line with its timestamp removed."),
        ],
    ),
    "DiscoverTracklist": (
        "A tracklist read out of a YouTube description. Best-effort by nature: "
        "these are typed by hand by whoever uploaded the set.",
        [
            ("requestId", "str", ""),
            ("url", "str", ""),
            ("videoTitle", "str", "The set's own title, for naming the entries."),
            ("channel", "str", ""),
            (
                "lines",
                "TracklistLine[]",
                "Empty when the description had no timestamped lines, which is "
                "the ordinary outcome for most videos and is not an error.",
            ),
        ],
    ),
    "FingerprintParams": (
        "Identify a local audio file by its acoustic fingerprint.",
        [
            ("path", "str", "Absolute local path."),
            (
                "durationLimit",
                "int?",
                "Only fingerprint the first N seconds. Null uses the default. "
                "AcoustID matches on the opening of a track, so more than two "
                "minutes buys nothing and costs decode time.",
            ),
        ],
    ),
    "DiscoverIdentified": (
        "What AcoustID made of a fingerprint.\n"
        "\n"
        "`score` is AcoustID's own confidence that the FINGERPRINT matches, not\n"
        "a judgement about whether the metadata is right. Render it the way the\n"
        "rest of the app renders confidence: as a claim with its evidence, never\n"
        "as a fact.",
        [
            ("requestId", "str", ""),
            ("path", "str", ""),
            (
                "matched",
                "bool",
                "False when nothing scored above AcoustID's threshold, which is "
                "the ordinary outcome for anything underground.",
            ),
            ("artist", "str", ""),
            ("title", "str", ""),
            ("album", "str?", ""),
            ("year", "int?", ""),
            ("mbid", "str?", "MusicBrainz recording id, when one is attached."),
            ("score", "float", "0–1, AcoustID's own."),
            ("durationSeconds", "float", "As decoded, for the record."),
        ],
    ),
    "PlaylistParams": (
        "",
        [
            (
                "playlistId",
                "str",
                "The bare playlist id. discoverUrl.ts pulls it out of the URL, "
                "because URL shapes are the frontend's business and Python is "
                "not in the guessing seat.",
            ),
        ],
    ),
    "RelatedParams": (
        "",
        [
            ("artist", "str", ""),
            ("release", "str", ""),
            ("label", "str?", "When known, the strongest link there is."),
        ],
    ),
    "DiscoverRelated": (
        "Music adjacent to one release. Grouped by WHY each thing is related, "
        "because 'more from this label' and 'more by this artist' are different "
        "questions and a single mixed list answers neither.",
        [
            ("requestId", "str", ""),
            ("byArtist", "CatalogEntry[]", "Other releases by the same artist."),
            ("byLabel", "CatalogEntry[]", "Other releases on the same label."),
            ("labelName", "str", "The label the byLabel list came from."),
        ],
    ),
    "DiscoverBrowseParams": (
        "Ask a provider for a whole discography.",
        [
            ("sourceKind", "WantSource", "'discogs' or 'bandcamp'."),
            ("kind", "DiscoverKind", "'label' or 'artist'."),
            ("id", "int?", "Discogs numeric id, when it is already known."),
            ("name", "str?", "Name to look up when there is no id."),
            ("url", "str?", "Page URL. How Bandcamp is addressed — it has no ids."),
        ],
    ),
    "DiscoverPlaylistItem": (
        "One entry of a YouTube playlist, exactly as YouTube states it.\n"
        "Nothing here is parsed: parseTitle.ts turns a title into an artist "
        "and a track on the frontend, per the standing rule that Python emits "
        "raw facts and TypeScript derives.",
        [
            (
                "videoId",
                "str",
                "From contentDetails.videoId. snippet.resourceId.videoId holds "
                "the same value; this one is used throughout so there is one "
                "answer to where the id comes from.",
            ),
            ("title", "str", "snippet.title, verbatim and unparsed."),
            (
                "channel",
                "str",
                "snippet.videoOwnerChannelTitle - who UPLOADED the video. NOT "
                "snippet.channelTitle, which is whoever owns the playlist. "
                "Measured: on a Hyperdub playlist of Untrue the uploader is "
                "Hyperdub while the playlist owner is a stranger, and it is "
                "the uploader that names the music.",
            ),
            ("position", "int", "Its place in the playlist, from snippet.position."),
            (
                "available",
                "bool",
                "False for an entry YouTube will not serve - a deleted or "
                "private video, which still occupies a position. Documented to "
                "arrive titled 'Deleted video' with no uploader; NOT confirmed "
                "against live data, so treat a false here as untested.",
            ),
        ],
    ),
    "DiscoverPlaylist": (
        "The contents of a public YouTube playlist.",
        [
            ("requestId", "str", ""),
            ("playlistId", "str", ""),
            ("items", "DiscoverPlaylistItem[]", ""),
            (
                "total",
                "int",
                "What YouTube says the playlist holds, from "
                "pageInfo.totalResults - the whole playlist, not the page.",
            ),
            (
                "complete",
                "bool",
                "False when the sidecar stopped paginating before the end, "
                "same contract as DiscoverCatalog: a truncated list that "
                "claims to be whole is worse than one that admits it.",
            ),
        ],
    ),
    "DiscogsWant": (
        "One release from the user's Discogs wantlist.\n"
        "\n"
        "Everything here is what Discogs STATES about the release, forwarded as\n"
        "given. The single assembly is the artist credit, and that is Discogs'\n"
        "own: its artists array carries the join phrases, so\n"
        "`[{name: 'Massive Attack', join: 'Vs'}, {name: 'Burial'}]` is the\n"
        "credit 'Massive Attack Vs Burial'. Dropping the join would turn one\n"
        "collaboration into two unrelated names.",
        [
            ("discogsId", "int", "The RELEASE id, from basic_information.id."),
            (
                "masterId",
                "int?",
                "The master release, when there is one. Measured: Discogs sends "
                "0 rather than null for a release with no master, so this is "
                "null only after that zero is normalised away.",
            ),
            (
                "title",
                "str",
                "Release title, trimmed. Real entries carry trailing "
                "whitespace ('Aline Brooklyn 001 ').",
            ),
            ("artist", "str", "The credit, joined per Discogs' own join phrases."),
            ("year", "int?", "Null when Discogs has no year, never 0."),
            ("label", "str", "First label's name. Empty when unlabelled."),
            ("catno", "str", "First label's catalogue number. Empty if none."),
            ("format", "str", "First format name — Vinyl, CD, File. Empty if none."),
            ("url", "str", "The release page, for the want list entry's source."),
            ("addedAt", "str", "ISO 8601 with offset, as Discogs sends it."),
            ("notes", "str", "The user's own note on this want. Usually empty."),
        ],
    ),
    "DiscoverWantlist": (
        "The signed-in Discogs user's wantlist.",
        [
            ("requestId", "str", ""),
            (
                "username",
                "str",
                "Resolved from the token via /oauth/identity, so the user never "
                "has to know or type it.",
            ),
            ("items", "DiscogsWant[]", ""),
            ("total", "int", "What Discogs says the wantlist holds."),
            (
                "complete",
                "bool",
                "False when the sidecar stopped paginating before the end, same "
                "contract as DiscoverCatalog and DiscoverPlaylist.",
            ),
        ],
    ),
    "DiscoverCatalog": (
        "A label's or artist's discography.",
        [
            ("requestId", "str", ""),
            ("sourceKind", "WantSource", ""),
            ("kind", "DiscoverKind", ""),
            ("name", "str", "The label or artist as the provider names it."),
            ("id", "int", "Discogs id. 0 for Bandcamp."),
            ("url", "str?", "The catalogue's own page."),
            ("releases", "CatalogEntry[]", ""),
            (
                "complete",
                "bool",
                "False when the sidecar stopped paginating before the end. A "
                "truncated list that claims to be whole is worse than one that "
                "admits it, because the missing records are invisible.",
            ),
        ],
    ),
    "DiscoverFailed": (
        "A discovery lookup did not produce anything. Shared by the URL parse "
        "and the catalogue browse: the two fail in the same ways.",
        [
            ("requestId", "str", ""),
            ("url", "str", ""),
            (
                "reason",
                "str",
                "Developer-facing. Not for display — a URL that turns out not to "
                "be music is an ordinary outcome, and the UI's answer is to fall "
                "back to searching the text, not to show an error.",
            ),
            (
                "needs",
                "str",
                "The AppSettings field the user would have to supply for this "
                "provider to work, or empty when the failure was not about "
                "configuration. Machine-readable ('discogsToken') so the UI can "
                "offer the right Settings link without reading English out of "
                "`reason`.",
            ),
        ],
    ),
    # ---- want list ---------------------------------------------------------
    #
    # A record of intent, NOT a download queue. The user decides when to search
    # and when to download; nothing here ever starts a transfer on its own.
    # Automatic searching already exists and belongs to the wishlist, where
    # upstream owns the timer and the SERVER dictates the interval.
    "WantEntry": (
        "One thing the user wants to find on Soulseek. The discovery layer's "
        "atomic unit, analogous to FileRef for search results.",
        [
            ("id", "str", "Opaque UUID, minted by the sidecar."),
            ("artist", "str", "As parsed, or as corrected by the user. May be empty."),
            ("title", "str", "Track or release title."),
            ("album", "str?", "Null for standalone tracks."),
            ("year", "int?", ""),
            ("label", "str?", ""),
            ("catalogNumber", "str?", ""),
            ("sourceKind", "WantSource", "Where it was found."),
            ("sourceUrl", "str?", "Original URL. Null for manual entries."),
            (
                "sourceTitle",
                "str?",
                "The provider's unprocessed title, kept so a bad parse can be "
                "re-read by a human later. This is why a corrected entry does "
                "not lose what it was corrected FROM.",
            ),
            ("artworkUri", "str?", "data: URI from the source, not the artwork pipeline."),
            ("status", "WantStatus", ""),
            ("addedAt", "float", "Unix epoch seconds."),
            ("searchedAt", "float?", "When last searched. Null if never."),
            ("notes", "str?", "The user's own annotation. Free text."),
            ("duration", "int?", "Seconds, when the source provided it."),
            ("tracklist", "WantTrack[]", "For releases: the expected tracklist."),
            (
                "sessionId",
                "str?",
                "The digging session this was added during, if any. Null for "
                "entries added on their own and for entries whose session was "
                "deleted — deleting a session unlinks its entries rather than "
                "throwing away what you wanted.",
            ),
        ],
    ),
    "WantList": ("", [("entries", "WantEntry[]", "Newest first.")]),
    "DigSession": (
        "A named, timestamped container for a discovery binge.\n"
        "\n"
        "NOTE WHAT IS ABSENT: no entry count and no list of sources. Both are\n"
        "aggregates over the want list, which the frontend already holds in\n"
        "full, and duplicating them here would be two places to get the same\n"
        "number wrong. Same reason there is no format tier on FileRef.",
        [
            ("id", "str", "Opaque UUID, minted by the sidecar."),
            (
                "name",
                "str",
                "EMPTY until the user renames it. An auto-named session shows "
                "the day and time it started, and building that string is "
                "display formatting — which Python does not do, here or "
                "anywhere else. The sidecar stores `createdAt` and the "
                "frontend words it, in the user's own locale.",
            ),
            ("createdAt", "float", "Unix epoch seconds."),
            (
                "lastActiveAt",
                "float",
                "When an entry was last added to it. What decides whether the "
                "session is still collecting.",
            ),
            (
                "closed",
                "bool",
                "No longer collecting. Set by the user, or by the sidecar once "
                "the session has gone quiet for long enough.",
            ),
        ],
    ),
    "DigSessionList": ("", [("sessions", "DigSession[]", "Newest first.")]),
    "SessionCreateParams": (
        "",
        [("name", "str?", "Null leaves it auto-named — see DigSession.name.")],
    ),
    "Profile": (
        "Your own Soulseek profile — what a peer sees when they look you up.\n"
        "\n"
        "Seek has only ever READ other people's. This is the first thing that\n"
        "reports your own, and it deliberately reports the whole response\n"
        "upstream would send (`UserInfo._get_user_info_response`) rather than\n"
        "just the two editable fields, because the interesting question is not\n"
        "'what did I type' but 'what does a stranger see'.",
        [
            ("username", "str", "The account this describes. Empty when signed out."),
            (
                "description",
                "str",
                "The free text peers see, DECODED. Upstream stores it as a "
                "Python repr() and unescapes it on send; nothing outside the "
                "sidecar should ever meet the escaped form.",
            ),
            ("picturePath", "str", "Local path to the picture file. Empty for none."),
            (
                "pictureUri",
                "str?",
                "The picture as a data: URI, when the file exists and is small "
                "enough to be worth sending. Null when there is no picture, "
                "the path does not resolve, or it is over the cap — and those "
                "are different things, which `pictureError` separates.",
            ),
            (
                "pictureError",
                "str",
                "Why there is a path but no picture. Empty when there is no "
                "problem, which includes having no picture at all.",
            ),
            ("pictureBytes", "int", "Size of the picture file. 0 when there is none."),
            (
                "pictureVisible",
                "bool",
                "Upstream's own flag for whether the picture is sent at all.",
            ),
            (
                "sharedFiles",
                "int?",
                "Files you are sharing. Null when the share index has not been "
                "built — which is NOT the same as sharing nothing.",
            ),
            ("sharedFolders", "int?", "Folders you are sharing. Null before a scan."),
            ("uploadSlots", "int", "Total upload slots you offer."),
            ("freeSlots", "bool", "Whether a new upload would be accepted right now."),
            ("queueSize", "int", "How many files are queued on you."),
        ],
    ),
    "ProfileParams": (
        "Change your own profile. Every field is optional; null leaves it "
        "alone, exactly as a settings patch does.",
        [
            ("description", "str?", "Plain text. The sidecar encodes it."),
            (
                "picturePath",
                "str?",
                "Local path, or the empty string to remove the picture.",
            ),
            ("pictureVisible", "bool?", ""),
        ],
    ),
    "PeerConnection": (
        "One peer Seek is exchanging data with right now, in either direction.\n"
        "\n"
        "NOT a socket. Upstream's socket table lives in the network thread and "
        "is private to it, and `upstream/` is not modified — so what can be "
        "reported honestly is who has a transfer active or queued, which is "
        "the useful half anyway. `ConnectionSnapshot.socketCount` states the "
        "real socket total beside this so the difference is visible rather "
        "than implied.",
        [
            ("username", "str", ""),
            ("country", "str?", "Two-letter code, when known."),
            ("downloading", "int", "Files actively coming from them."),
            ("downloadQueued", "int", "Files of theirs you are waiting on."),
            ("uploading", "int", "Files actively going to them."),
            ("uploadQueued", "int", "Files of yours they are waiting on."),
        ],
    ),
    "ConnectionSnapshot": (
        "Who Seek is connected to, right now.",
        [
            (
                "socketCount",
                "int",
                "Open sockets, as the network thread last reported. Usually far "
                "larger than the peer list: most of them carry the DISTRIBUTED "
                "SEARCH network, where you relay other people's searches. That "
                "is Soulseek working, not a leak.",
            ),
            ("peers", "PeerConnection[]", "Peers with a transfer active or queued."),
        ],
    ),
    "TransferCounts": (
        "One set of transfer counters, as upstream keeps them.\n"
        "\n"
        "READ THE SIZE FIELDS CAREFULLY: they count BYTES ACTUALLY MOVED, not\n"
        "the size of finished files. Upstream adds each fragment as it arrives\n"
        "(transfers.py `_update_transfer_progress`), so a download that got to\n"
        "80% and then lost its peer contributed 80% of a file to\n"
        "`downloadedSize` and nothing to `completedDownloads`. That is the\n"
        "honest figure for bandwidth used, and the wrong one for 'how much\n"
        "music do I have' — the library index answers that.",
        [
            ("startedDownloads", "int", "Downloads begun."),
            ("completedDownloads", "int", "Downloads that finished."),
            ("downloadedSize", "int", "Bytes received, including from transfers that later failed."),
            ("startedUploads", "int", "Uploads begun."),
            ("completedUploads", "int", "Uploads that finished."),
            ("uploadedSize", "int", "Bytes sent, including from transfers that later failed."),
        ],
    ),
    "TransferStats": (
        "Transfer counters, session and lifetime.\n"
        "\n"
        "Both halves come from upstream's `statistics` component, which Seek has\n"
        "had enabled since the beginning and has never surfaced — so the upload\n"
        "figures here are the first sight of a side of the app that has been\n"
        "running the whole time.\n"
        "\n"
        "`session` resets when the sidecar starts; `total` persists in the\n"
        "pynicotine config. NOTHING HERE IS DERIVED: no ratio, no completion\n"
        "rate, no percentages. Those are arithmetic over these six numbers and\n"
        "arithmetic for display is TypeScript's, like every other derivation in\n"
        "this project.",
        [
            (
                "sinceTimestamp",
                "int",
                "Unix seconds when counting began. 0 if upstream never set it, "
                "which means the totals have no meaningful span and the UI must "
                "not word one.",
            ),
            ("session", "TransferCounts", "Since this sidecar started."),
            ("total", "TransferCounts", "All time, as persisted by upstream."),
        ],
    ),
    "WatchedLabel": (
        "A label or artist whose catalogue the user is working through.\n"
        "\n"
        "NOT a new-release notifier, and the distinction is the whole design.\n"
        "Discogs is a database rather than a release feed, so diffing it\n"
        "reports records catalogued decades late as 'new'; Bandcamp has no API\n"
        "to poll; and a brand-new release is precisely what Soulseek does not\n"
        "have yet, so that notification's happy path ends in an empty search.\n"
        "This is a bookmark with progress on it — back catalogue, which is\n"
        "where both Soulseek and this app are strong.\n"
        "\n"
        "THE COUNTS ARE A SNAPSHOT, and unlike DigSession they are stored\n"
        "rather than derived. DigSession omits its counts because the frontend\n"
        "holds the whole want list and can recount at will; a catalogue is\n"
        "NOT persisted anywhere, so these cannot be recomputed without several\n"
        "rate-limited HTTP requests per label. They are therefore written when\n"
        "the catalogue is actually read, carry `lastSeenAt`, and must never be\n"
        "rendered as current — the UI says when it last looked.",
        [
            ("id", "str", "Opaque UUID, minted by the sidecar."),
            (
                "sourceKind",
                "WantSource",
                "Which provider holds the catalogue. Same vocabulary the want "
                "list uses, so one label and the releases saved from it agree.",
            ),
            ("kind", "DiscoverKind", "'label' or 'artist'. Others are refused."),
            ("name", "str", "What it is called. Never empty — watching needs one."),
            ("url", "str", "The catalogue page. Empty when it was found by name."),
            (
                "entityId",
                "int?",
                "The provider's numeric id, when known. Re-browsing with it "
                "skips the fuzzy name search that `_resembles` exists to guard.",
            ),
            ("addedAt", "float", "Unix epoch seconds."),
            (
                "lastSeenAt",
                "float?",
                "When the catalogue was last actually read. Null until the "
                "first read — which is not the same as 'never watched'.",
            ),
            (
                "releaseCount",
                "int?",
                "Releases in the catalogue at the last read. Null before one.",
            ),
            (
                "ownedCount",
                "int?",
                "Of those, matched in the library index at the last read.",
            ),
            (
                "wantedCount",
                "int?",
                "Of those, already on the want list at the last read.",
            ),
            ("note", "str", "The user's own note. Empty unless they wrote one."),
        ],
    ),
    "WatchedLabelList": ("", [("labels", "WatchedLabel[]", "Newest first.")]),
    "LabelWatchParams": (
        "Start watching a catalogue. Idempotent: watching one already on the "
        "list updates its name, url and id and leaves its counts alone, "
        "because those describe a reading rather than the choice to watch.",
        [
            ("sourceKind", "WantSource", ""),
            ("kind", "DiscoverKind", ""),
            ("name", "str", ""),
            ("url", "str?", ""),
            ("entityId", "int?", ""),
        ],
    ),
    "LabelIdParams": ("", [("id", "str", "")]),
    "LabelNoteParams": ("", [("id", "str", ""), ("note", "str", "")]),
    "LabelSeenParams": (
        "Record what a catalogue read found. Sent by the frontend after it has "
        "rendered one, because owned and wanted are matches against the "
        "library index and the want list — both of which live on that side of "
        "the seam.",
        [
            ("id", "str", ""),
            ("releaseCount", "int", ""),
            ("ownedCount", "int", ""),
            ("wantedCount", "int", ""),
        ],
    ),
    "SessionIdParams": ("", [("id", "str", "")]),
    "SessionRenameParams": ("", [("id", "str", ""), ("name", "str", "")]),
    "WantAddParams": (
        "",
        [
            (
                "entries",
                "WantEntry[]",
                "Entries to add. `id` and `addedAt` are ignored and minted by "
                "the sidecar, so a caller cannot forge either.",
            )
        ],
    ),
    "WantRemoveParams": ("", [("ids", "str[]", "")]),
    "WantUpdateParams": (
        "Change fields on one entry. Null means 'leave this alone', so an "
        "absent value and an intentionally empty one stay different things.",
        [
            ("id", "str", ""),
            ("artist", "str?", ""),
            ("title", "str?", ""),
            ("album", "str?", ""),
            ("status", "WantStatus?", ""),
            ("notes", "str?", ""),
        ],
    ),
    "HistoryState": (
        "Recent searches, newest first, de-duplicated and capped.",
        [("items", "str[]", "")],
    ),
    "SavedSearch": (
        "A query plus the filter set it was run with, as opaque JSON the "
        "frontend owns. The sidecar stores it and never interprets it — filters "
        "are a TypeScript concept (AGENTS.md, the seam).",
        [
            ("query", "str", ""),
            ("filtersJson", "str", "Serialised filters. Opaque to the sidecar."),
        ],
    ),
    "SavedParams": (
        "",
        [("query", "str", ""), ("filtersJson", "str", "Serialised filters.")],
    ),
    "SavedState": ("", [("items", "SavedSearch[]", "")]),
    "BuddyState": (
        "",
        [("items", "str[]", "Buddy usernames, as upstream holds them.")],
    ),
    "WishlistState": (
        "The wishlist, and how often the server permits it to run.",
        [
            ("items", "str[]", "Queries, newest first."),
            (
                "intervalSeconds",
                "int",
                "Server-dictated seconds between automatic runs. 0 before the "
                "server has told us, which it does shortly after login.",
            ),
        ],
    ),
    "TransferIdsParams": (
        "Target one or more transfers. Used by pause/resume/cancel/retry/clear.",
        [("transferIds", "str[]", "")],
    ),
    "TransferListResult": ("", [("transfers", "Transfer[]", "")]),
    "SettingsPatchParams": (
        "Shallow-merge a patch into sidecar settings. Only the keys present are "
        "changed. Unknown keys are rejected rather than silently ignored.",
        [("settings", "Settings", "")],
    ),
    "SettingsResult": ("", [("settings", "Settings", "")]),
    "Settings": (
        "Everything the frontend is allowed to change. Every field is optional in "
        "a patch; a `settings.get` reply has them all populated.",
        [
            ("downloadFolder", "str?", "Absolute path for completed downloads."),
            ("incompleteFolder", "str?", "Absolute path for in-progress downloads."),
            ("listenPort", "int?", "Incoming peer connection port."),
            ("maxDownloadSpeed", "int?", "Bytes/sec, 0 = unlimited."),
            ("maxUploadSpeed", "int?", "Bytes/sec, 0 = unlimited."),
            ("uploadSlots", "int?", "Concurrent upload slots offered to peers."),
            (
                "autoConnect",
                "bool?",
                "Connect to the Soulseek server on sidecar start.",
            ),
            (
                "stallSeconds",
                "int?",
                "How long a 'transferring' download may make zero progress before "
                "`Transfer.stalled` is set. Seek-specific; upstream has no such "
                "concept (RECON.md §5).",
            ),
        ],
    ),
    # ---- event payloads ----------------------------------------------------
    "ConnectionState": (
        "Current server connection.",
        [
            ("status", "ConnectionStatus", ""),
            ("username", "str?", "Our logged-in username. Null when not online."),
            ("publicAddress", "str?", "Our public IP as the server sees it."),
            (
                "error",
                "str?",
                "Server rejection text on a failed login (e.g. wrong password). "
                "Null otherwise.",
            ),
        ],
    ),
    "ConnectionStats": (
        "Emitted about once a second while the network thread runs. Note upstream "
        "also emits this event with NO arguments as a reset (RECON.md §3); the "
        "sidecar normalises that into explicit zeros.",
        [
            ("connections", "int", "Open sockets."),
            ("downloadBandwidth", "int", "Bytes/sec across all downloads."),
            ("uploadBandwidth", "int", "Bytes/sec across all uploads."),
        ],
    ),
    "SearchResultEvent": (
        "A batch of files from ONE peer for ONE search. The sidecar coalesces "
        "upstream's per-response events into ticks so the frontend is not woken "
        "hundreds of times a second; `files` may therefore span several upstream "
        "responses from the same peer.",
        [
            ("searchId", "int", ""),
            ("peer", "PeerStats", ""),
            ("files", "FileRef[]", ""),
            (
                "private",
                "bool",
                "True if these came from the peer's buddy-only share list.",
            ),
            ("receivedAt", "float", "Unix epoch seconds when the sidecar accepted them."),
        ],
    ),
    "SearchClosedEvent": (
        "",
        [
            ("searchId", "int", ""),
            ("reason", "SearchCloseReason", ""),
            ("resultCount", "int", "Total files accepted for this search."),
            ("peerCount", "int", "Distinct peers that responded."),
        ],
    ),
    "SearchFailedEvent": (
        "",
        [
            ("searchId", "int", ""),
            ("reason", "str", "Currently only ever 'offline' from upstream."),
        ],
    ),
    "UserStatusEvent": (
        "",
        [
            ("username", "str", ""),
            ("status", "UserStatus", ""),
            ("privileged", "bool?", "Null when the server did not say."),
        ],
    ),
    "UserBrowseResultEvent": (
        "A peer's complete share list. Arrives as one message; can be large.",
        [
            ("username", "str", ""),
            ("folders", "FolderRef[]", ""),
            ("fileCount", "int", ""),
            ("totalSize", "int", "Sum of all file sizes, bytes."),
        ],
    ),
    "UserBrowseFailedEvent": (
        "",
        [("username", "str", ""), ("reason", "str", "")],
    ),
    "FolderContentsEvent": (
        "Reply to `transfer.enqueueFolder`'s underlying folder request. Emitted "
        "before the resulting `transfer.added` events.",
        [
            ("requestId", "str", "Matches TransferFolderResult.requestId."),
            ("username", "str", ""),
            ("folderPath", "str", ""),
            ("folders", "FolderRef[]", ""),
            ("enqueued", "int", "How many files were queued as a result."),
        ],
    ),
    "FolderContentsFailedEvent": (
        "",
        [
            ("requestId", "str?", "Null if the failure was not tied to a request."),
            ("username", "str", ""),
            ("folderPath", "str", ""),
            ("reason", "str", ""),
        ],
    ),
    "Transfer": (
        "One transfer, in either direction. `id` is a stable sidecar-minted "
        "handle — upstream has no stable transfer id (RECON.md §5).\n"
        "\n"
        "NOT ALL FIELDS MEAN THE SAME THING BOTH WAYS. On an upload,\n"
        "`localFolder` is where YOUR file already lives rather than where a\n"
        "file is being written, and `queuePosition` is a place in someone\n"
        "else's queue rather than in yours. `state` is drawn from the same\n"
        "vocabulary, but uploads never produce `paused`, `filtered` or\n"
        "`download_folder_error` — upstream simply never sets them on that\n"
        "side.",
        [
            ("id", "str", "Stable opaque id. Survives retries."),
            (
                "direction",
                "TransferDirection",
                "'download' is a file coming to you; 'upload' is one going to "
                "a peer who asked for it.",
            ),
            ("username", "str", ""),
            ("path", "str", "Full remote virtual path."),
            ("localFolder", "str?", "Absolute local destination folder."),
            ("size", "int", "Total bytes, as advertised."),
            ("bytesDone", "int", "Bytes written so far. 0 before the transfer starts."),
            ("state", "TransferState", ""),
            (
                "speed",
                "int",
                "Instantaneous rate in bytes/sec, from the network thread. 0 when "
                "not transferring. This is a MEASUREMENT, unlike "
                "PeerStats.advertisedSpeed.",
            ),
            ("averageSpeed", "int", "Bytes/sec over the life of the transfer."),
            (
                "queuePosition",
                "int?",
                "Place in the peer's queue, from PlaceInQueueResponse. Null when the "
                "peer has not told us.",
            ),
            (
                "secondsLeft",
                "int?",
                "Upstream's own estimate. Null when it cannot be computed (speed 0).",
            ),
            ("secondsElapsed", "int", "Seconds since the transfer started."),
            (
                "stalled",
                "bool",
                "Seek-specific: state is 'transferring' but bytesDone has not moved "
                "for `Settings.stallSeconds`. Upstream provides no such signal.",
            ),
            (
                "file",
                "FileRef?",
                "The originating FileRef when the client supplied one on enqueue, so "
                "quality info survives into the transfers view.",
            ),
            ("error", "str?", "Upstream failure text, when the state is a failure."),
        ],
    ),
    "TransferRemovedEvent": ("", [("transferIds", "str[]", "")]),
    "FolderFinishedEvent": (
        "",
        [("localFolder", "str", "Absolute local folder that just completed.")],
    ),
    "SpectralAnalysis": (
        "Result of decoding a DOWNLOADED file and inspecting its spectrum.\n"
        "\n"
        "This is the POST-DOWNLOAD check and it is a different thing from the\n"
        "search-time metadata heuristic (docs/PRODUCT.md §6). The metadata check\n"
        "is a prediction made before the bytes exist; this is a finding made\n"
        "from the bytes themselves. Keep them distinct in the UI — a file that\n"
        "passed the prediction and fails this is exactly the moment the app\n"
        "earns its keep.\n"
        "\n"
        "It exists because RECON.md §4 established the metadata check cannot\n"
        "run on lossless files at all: the protocol sends no bitrate for\n"
        "FLAC/WAV/AIFF, so there is nothing to contradict. Spectral analysis\n"
        "needs no cooperation from the uploader's metadata.\n"
        "\n"
        "Everything here is raw measurement. No labels, no colours, no\n"
        "percentages formatted for display, no sentence to render.",
        [
            ("requestId", "str", "Echoes the analysis.spectral request."),
            ("path", "str", "Absolute local path of the analysed file."),
            (
                "transferId",
                "str?",
                "The transfer this file came from, when the request supplied one.",
            ),
            ("sampleRate", "int", "Decoded sample rate in Hz."),
            ("channels", "int", "Decoded channel count."),
            ("durationSeconds", "float", "Decoded duration."),
            (
                "decodedWith",
                "str",
                "Which decoder produced the samples ('soundfile' or 'ffmpeg'). "
                "Useful when a result looks wrong and you need to know why.",
            ),
            ("nyquistHz", "float", "sampleRate / 2. The ceiling any content can reach."),
            (
                "cutoffHz",
                "float?",
                "Highest frequency still carrying meaningful energy, in Hz. Null "
                "when no shelf could be located — which is itself informative, "
                "not a failure.",
            ),
            (
                "shelfDropDb",
                "float?",
                "How far energy falls across the shelf, in dB. A sharp cliff is "
                "what distinguishes an encoder lowpass from natural HF rolloff; "
                "a gentle slope means much less.",
            ),
            (
                "shelfWidthHz",
                "float?",
                "How wide the transition is. Encoder lowpass filters are abrupt; "
                "acoustic rolloff is gradual.",
            ),
            (
                "confidence",
                "float",
                "0..1, how much the shape supports the assessment. Low confidence "
                "on a 'possible transcode' must read as a question, not a charge.",
            ),
            ("assessment", "SpectralAssessment", ""),
            (
                "declaredLossless",
                "bool",
                "Whether the container claims to be lossless. A lowpass shelf in "
                "a lossy file is expected and uninteresting; the same shelf in a "
                "FLAC is the entire point of this check.",
            ),
            (
                "impliedSourceKbps",
                "int?",
                "Rough bitrate a lossy source with this cutoff would have had. "
                "A hint for the explanation, not a measurement. Null when no "
                "cutoff was found.",
            ),
            (
                "spectrumHz",
                "float[]",
                "Bin centre frequencies for `spectrumDb`, downsampled for "
                "transport. Pairs index-for-index.",
            ),
            (
                "spectrumDb",
                "float[]",
                "Time-averaged magnitude in dB, normalised so the peak is 0. The "
                "frontend renders this; the sidecar does not.",
            ),
            (
                "heatmapDb",
                "float[]",
                "Coarse time x frequency grid in dB, FLATTENED row-major as "
                "freq-major rows of heatmapTimeBins each (index = f * "
                "heatmapTimeBins + t), low frequency first, peak-normalised "
                "frequency first, peak-normalised to 0. This is the Spek-style "
                "picture and answers a DIFFERENT question from spectrumDb: the "
                "averaged curve resolves whether a lowpass cliff exists, this "
                "shows where in the track energy sits and whether the ceiling "
                "holds throughout. Empty if rendering failed — the verdict "
                "never depends on it.",
            ),
            ("heatmapTimeBins", "int", "Columns in heatmapDb."),
            ("heatmapFreqBins", "int", "Rows in heatmapDb."),
            ("fftSize", "int", "FFT window length in samples."),
            ("windowCount", "int", "How many windows were averaged."),
            (
                "analysedSeconds",
                "float",
                "How much audio was actually inspected. The sidecar samples "
                "windows across the file rather than reading all of it.",
            ),
        ],
    ),
    "SpectralRequestParams": (
        "Analyse a downloaded file. Runs on a worker thread; the reply is "
        "immediate and the result arrives later as `analysis.result`.",
        [
            (
                "path",
                "str?",
                "Absolute local path. Null means 'use the file for transferId'.",
            ),
            (
                "transferId",
                "str?",
                "Analyse the completed file for this transfer. Ignored if `path` "
                "is given.",
            ),
        ],
    ),
    "SpectralRequestResult": (
        "",
        [("requestId", "str", "Correlates the later analysis.result event.")],
    ),
    "AnalysisFailedEvent": (
        "",
        [
            ("requestId", "str", ""),
            ("path", "str?", ""),
            ("reason", "str", "Developer-facing text. Not for display."),
        ],
    ),
    "SharedFolder": (
        "One folder offered to the network.",
        [
            (
                "virtualName",
                "str",
                "Name peers see. Upstream keys shares on this, and it need not "
                "resemble the real path.",
            ),
            ("path", "str", "Absolute local path."),
            (
                "exists",
                "bool",
                "Whether the path is currently readable. External volumes go "
                "missing; upstream emits shares-unavailable when they do.",
            ),
        ],
    ),
    "ChatMessage": (
        "One line of chat. Soulseek carries no message ids for room chat, so "
        "the frontend keys on (room|user, timestamp, sender, text).",
        [
            ("scope", "ChatScope", "Which conversation this belongs to."),
            (
                "target",
                "str",
                "Room name for scope 'room'; the other party's username for "
                "scope 'private'.",
            ),
            ("username", "str", "Who sent it. Our own name for outgoing lines."),
            ("message", "str", "The raw text. Never formatted by the sidecar."),
            (
                "outgoing",
                "bool",
                "True when we sent it. Upstream echoes our own messages back "
                "through a different event, and the UI must not show them as "
                "if a stranger said them.",
            ),
            (
                "kind",
                "ChatMessageKind",
                "'action' is the /me form. 'local' is client-generated text "
                "that never touched the network.",
            ),
            (
                "mentioned",
                "bool",
                "Our username appears in the text. Upstream computes this.",
            ),
            (
                "timestamp",
                "int",
                "Unix seconds. Private messages carry the server's own "
                "timestamp for offline delivery; room messages are stamped on "
                "arrival because the protocol sends none.",
            ),
        ],
    ),
    "ChatRoom": (
        "A room in the server's list, or one we have joined.",
        [
            ("name", "str", ""),
            ("userCount", "int", "As last reported by the server."),
            ("joined", "bool", "We are in it and receiving messages."),
            ("private", "bool", "Owned/members-only room."),
        ],
    ),
    "ChatRoomList": (
        "The server's room directory plus whatever we have joined.",
        [("rooms", "ChatRoom[]", "")],
    ),
    "ChatRoomMembers": (
        "Who is in a room. Emitted on join and as people come and go.",
        [
            ("room", "str", ""),
            ("users", "str[]", "Usernames, unsorted — ordering is the UI's job."),
        ],
    ),
    "ChatJoinParams": ("", [("room", "str", "")]),
    "ChatLeaveParams": ("", [("room", "str", "")]),
    "ChatSayParams": (
        "",
        [
            ("scope", "ChatScope", ""),
            ("target", "str", "Room name, or the username for a private message."),
            ("message", "str", ""),
        ],
    ),
    "ChatOpenParams": (
        "Open a private conversation without sending anything.",
        [("username", "str", "")],
    ),
    "ShareState": (
        "Everything the frontend needs to drive sharing and to render the "
        "persistent 'you are not sharing' indicator.",
        [
            ("consent", "ShareConsent", ""),
            ("folders", "SharedFolder[]", ""),
            ("scanning", "bool", "A rescan is in progress."),
            (
                "ready",
                "bool",
                "The share index is built and peers can be served.",
            ),
            ("fileCount", "int?", "Files indexed. Null before the first scan."),
            ("folderCount", "int?", "Folders indexed. Null before the first scan."),
            ("totalSize", "int?", "Bytes indexed. Null before the first scan."),
            (
                "lastScanAt",
                "float?",
                "Unix epoch seconds of the last completed scan.",
            ),
            (
                "restartRequired",
                "bool",
                "Consent was granted after the sidecar started without the "
                "shares component. Sharing begins on next launch.",
            ),
        ],
    ),
    "ShareSetParams": (
        "Set the share configuration. This is the explicit choice — nothing is "
        "ever shared without one.",
        [
            ("consent", "ShareConsent", ""),
            (
                "folders",
                "SharedFolder[]",
                "Replaces the current list wholesale. Empty is valid and means "
                "'share nothing'; combined with consent 'granted' it is a "
                "contradiction the sidecar rejects.",
            ),
        ],
    ),
    "ShareRescanParams": (
        "",
        [
            (
                "force",
                "bool?",
                "Rescan even if upstream believes the index is current.",
            )
        ],
    ),
    "PathCheckParams": (
        "",
        [
            (
                "path",
                "str",
                "A local path, absolute or starting with ~. May not exist.",
            )
        ],
    ),
    "PathCheck": (
        "What is actually true of a local path. RAW FACTS ONLY — the sidecar\n"
        "does not decide whether a path is acceptable for a given purpose, and\n"
        "emits no message. Which of these fields matters, and how to word it,\n"
        "is the frontend's call: a download folder must be a writable directory,\n"
        "while a shared folder only has to be readable.\n"
        "\n"
        "Writability is tested by CREATING A FILE and deleting it, not by\n"
        "reading the mode bits. os.access() answers from the permission bits\n"
        "alone and is wrong on exactly the cases that matter here: a read-only\n"
        "mount and a macOS TCC-protected folder both report the user as having\n"
        "write permission, because they do — the refusal comes from the volume\n"
        "and from the sandbox, neither of which is in the mode.",
        [
            ("path", "str", "The path as it was given, unchanged."),
            (
                "resolved",
                "str",
                "The path after ~ expansion and normalisation. This is what "
                "would actually be written to the config.",
            ),
            ("exists", "bool", "Something is there."),
            ("isDirectory", "bool", "It exists and is a directory."),
            (
                "writable",
                "bool",
                "A file could be created inside it. False whenever the path is "
                "not an existing directory.",
            ),
            (
                "parentExists",
                "bool",
                "The containing directory exists, so this one could be created.",
            ),
            (
                "parentWritable",
                "bool",
                "A directory could be created here. False unless parentExists.",
            ),
        ],
    ),
    "EnsureFolderParams": (
        "",
        [("path", "str", "The folder to create, including any missing parents.")],
    ),
    "ImportSource": (
        "What an existing Nicotine+ installation on this machine offers.\n"
        "\n"
        "This is the PREVIEW half of the import: it reports what WOULD be read\n"
        "so the UI can state it before anything is read for real. It is only\n"
        "ever produced in response to an explicit user action, never on start.\n"
        "\n"
        "Note what is absent: there is no password field, and there never will\n"
        "be. `hasCredentials` says whether one exists; the value itself is\n"
        "copied inside the sidecar and never crosses this socket.",
        [
            (
                "available",
                "bool",
                "A readable Nicotine+ config was found.",
            ),
            ("configPath", "str", "Where the sidecar looked."),
            (
                "hasCredentials",
                "bool",
                "Both a username and a password are present.",
            ),
            (
                "username",
                "str?",
                "The Soulseek username, so the UI can name what it is about to "
                "import. Null when absent.",
            ),
            ("folders", "SharedFolder[]", "Shares configured in Nicotine+."),
            (
                "downloadFolder",
                "str?",
                "Nicotine+'s download folder, if it set one.",
            ),
            (
                "error",
                "str?",
                "Why the config could not be read, when it could not be.",
            ),
        ],
    ),
    "ImportApplyParams": (
        "Copy selected settings across. Every field is an explicit opt-in; "
        "there is no 'import everything' shorthand on purpose.",
        [
            ("credentials", "bool", "Copy the Soulseek username and password."),
            ("shares", "bool", "Copy the shared-folder list."),
            ("downloadFolder", "bool", "Copy the download folder."),
        ],
    ),
    "ImportResult": (
        "",
        [
            ("importedCredentials", "bool", ""),
            ("importedShares", "int", "How many folders were copied."),
            ("importedDownloadFolder", "bool", ""),
            (
                "username",
                "str?",
                "The username now configured, for confirmation.",
            ),
        ],
    ),
    "LogEvent": (
        "",
        [
            ("level", "LogLevel", ""),
            ("message", "str", ""),
            ("at", "float", "Unix epoch seconds."),
        ],
    ),
}

# --------------------------------------------------------------------------
# Commands — client -> sidecar. Every command gets exactly one reply.
# --------------------------------------------------------------------------

COMMANDS = {
    "hello": ("Handshake. Must be the first command.", "HelloParams", "HelloResult"),
    "connection.connect": (
        "Log in to the Soulseek server. Omit the credentials (send null) to use "
        "whatever is already stored, which is the path taken after an import.",
        "ConnectParams",
        None,
    ),
    "connection.disconnect": ("Log out.", None, None),
    "search.start": ("Begin a search.", "SearchStartParams", "SearchStartResult"),
    "search.stop": (
        "Stop accepting results. Emits `search.closed` with reason 'stopped'.",
        "SearchStopParams",
        None,
    ),
    "user.browse": ("Request a peer's full share list.", "UserBrowseParams", None),
    "user.stats": ("Request and watch a peer's stats.", "UserStatsParams", None),
    "transfer.enqueue": (
        "Queue one file.",
        "TransferEnqueueParams",
        "TransferEnqueueResult",
    ),
    "transfer.enqueueFolder": (
        "Queue a remote folder.",
        "TransferFolderParams",
        "TransferFolderResult",
    ),
    "transfer.pause": (
        "Pause downloads. DOWNLOADS ONLY — upstream has no paused state for an "
        "upload, and a peer waiting on you is not something to quietly park.",
        "TransferIdsParams", None,
    ),
    "transfer.resume": ("Resume paused downloads.", "TransferIdsParams", None),
    "transfer.cancel": (
        "Cancel transfers, either direction. Cancelling an upload tells the "
        "peer rather than dropping the connection silently.",
        "TransferIdsParams", None,
    ),
    "transfer.retry": ("Retry failed transfers, either direction.", "TransferIdsParams", None),
    "transfer.clear": (
        "Forget downloads entirely (does not delete files).",
        "TransferIdsParams",
        None,
    ),
    "transfer.list": ("Snapshot of every known transfer, both directions.", None, "TransferListResult"),
    "analysis.spectral": (
        "Queue a post-download spectral analysis. Returns immediately.",
        "SpectralRequestParams",
        "SpectralRequestResult",
    ),
    "chat.rooms": (
        "Ask the server for the room list. Answers on the chat.rooms event.",
        None,
        None,
    ),
    "chat.join": ("Join a room and start receiving its messages.", "ChatJoinParams", None),
    "chat.leave": ("Leave a room.", "ChatLeaveParams", None),
    "chat.say": (
        "Send a line to a room or a user. The echo comes back as a "
        "chat.message event with outgoing=true, so the UI renders sent and "
        "received messages through one path.",
        "ChatSayParams",
        None,
    ),
    "chat.open": (
        "Open a private conversation without sending anything.",
        "ChatOpenParams",
        None,
    ),
    "wishlist.add": (
        "Add a query to the wishlist. Upstream re-runs it automatically on the "
        "interval the SERVER dictates — we do not poll, and must not.",
        "WishParams",
        "WishlistState",
    ),
    "wishlist.remove": ("Drop a query from the wishlist.", "WishParams", "WishlistState"),
    "wishlist.list": ("Current wishlist and interval.", None, "WishlistState"),
    "artwork.get": (
        "Ask for a release cover. Replies immediately with a requestId; the "
        "image arrives later as `artwork.result` or `artwork.failed`. Never on "
        "the critical path — rows render with their placeholder first.",
        "ArtworkParams",
        "RequestAccepted",
    ),
    "artwork.stats": ("Cache size and cap.", None, "ArtworkCacheStats"),
    "artwork.clear": ("Empty the artwork cache.", None, "ArtworkCacheStats"),
    "metadata.inspect": (
        "Match a downloaded file against MusicBrainz and report what WOULD "
        "change. Reads the file's current tags; writes nothing. Replies with a "
        "requestId; the proposal arrives as `metadata.proposal`.",
        "SpectralRequestParams",
        "RequestAccepted",
    ),
    "metadata.apply": (
        "Write tags to a downloaded file. Only the fields supplied are touched.",
        "MetadataApplyParams",
        "MetadataApplyResult",
    ),
    "organise.file": (
        "Move one downloaded file into Artist/Year - Album/ beneath the "
        "download folder, using the MusicBrainz match. Never overwrites, never "
        "leaves the download folder, and reports where the file went.",
        "SpectralRequestParams",
        "OrganiseResult",
    ),
    "preview.get": (
        "Decode a short excerpt of a downloaded file and return it as playable "
        "audio. Deliberately an EXCERPT: the brief puts a short preview in "
        "scope and a full player out of it, and shipping whole 50 MB FLACs "
        "over the socket to play them would be neither.",
        "PreviewParams",
        "RequestAccepted",
    ),
    "app.settings.get": (
        "Seek's own preferences. Distinct from `settings.get`, which is "
        "pynicotine's config — these live in Seek's state file because they "
        "are not upstream's concern.",
        None,
        "AppSettings",
    ),
    "app.settings.patch": (
        "Shallow-merge preferences. Only the keys present are changed.",
        "AppSettingsPatch",
        "AppSettings",
    ),
    "peers.stats": (
        "Per-peer transfer outcomes, accumulated from OUR OWN history. The "
        "protocol exposes nothing about how a stranger behaves, so this is the "
        "only honest basis for a reliability score.",
        None,
        "PeerHistory",
    ),
    "library.state": ("Index size and when it was last built.", None, "LibraryState"),
    "library.scan": (
        "Rebuild the index by walking the download folder and any extra roots. "
        "Runs on a worker; progress arrives as `library.state` events.",
        "LibraryScanParams",
        "LibraryState",
    ),
    "library.releases": ("Everything indexed, for the Library screen.", None, "LibraryReleases"),
    "library.gaps": (
        "Which tracks of an owned release are missing, per MusicBrainz. This is "
        "the vision note's 'find albums I do not already have', one release at "
        "a time — a whole-collection sweep would be one rate-limited request "
        "per release and take hours.",
        "ArtworkParams",
        "RequestAccepted",
    ),
    "library.owned": (
        "Every release and track key you own. Sent once and matched "
        "client-side — asking per search result would be thousands of round "
        "trips for a set-membership test.",
        None,
        "LibraryOwned",
    ),
    "discover.parseUrl": (
        "Ask a provider what a music URL is. Replies immediately with a "
        "requestId; the answer arrives as `discover.parsed` or "
        "`discover.parseFailed`, because it costs a rate-limited HTTP request "
        "and a command handler runs on pynicotine's main thread. Same shape as "
        "`artwork.get` for the same reason.",
        "DiscoverParseUrlParams",
        "RequestAccepted",
    ),
    "session.list": ("Every digging session, newest first.", None, "DigSessionList"),
    "session.create": (
        "Start a session explicitly. Entries added while it is active join it.",
        "SessionCreateParams",
        "DigSessionList",
    ),
    "session.rename": ("Give a session a name of your own.", "SessionRenameParams", "DigSessionList"),
    "session.close": (
        "Stop a session collecting. Its entries stay in it and stay in the "
        "want list; only the grouping of NEW entries is affected.",
        "SessionIdParams",
        "DigSessionList",
    ),
    "session.delete": (
        "Forget the session. Its entries are UNLINKED, never deleted — the "
        "session is a grouping of things you wanted, not the things themselves.",
        "SessionIdParams",
        "DigSessionList",
    ),
    "profile.get": ("Your own Soulseek profile, as peers see it.", None, "Profile"),
    "profile.set": ("Change your own profile.", "ProfileParams", "Profile"),
    "connections.get": ("Who Seek is exchanging data with right now.", None, "ConnectionSnapshot"),
    "stats.get": ("Transfer counters, session and lifetime.", None, "TransferStats"),
    "labels.list": ("Every watched catalogue, newest first.", None, "WatchedLabelList"),
    "labels.watch": (
        "Watch a label or artist catalogue so it survives the card being "
        "dismissed. Idempotent.",
        "LabelWatchParams",
        "WatchedLabelList",
    ),
    "labels.unwatch": (
        "Stop watching. Nothing saved FROM the catalogue is touched — the want "
        "list and the library are not a function of the watchlist.",
        "LabelIdParams",
        "WatchedLabelList",
    ),
    "labels.note": ("Set the user's own note on a watched catalogue.", "LabelNoteParams", "WatchedLabelList"),
    "labels.seen": (
        "Record the counts from a catalogue read, with the time.",
        "LabelSeenParams",
        "WatchedLabelList",
    ),
    "want.list": ("The whole want list.", None, "WantList"),
    "want.add": (
        "Add entries. Every mutation returns the full list, like history and "
        "saved searches do — the list is small, and partial patches invite "
        "exactly the stale UI this avoids.",
        "WantAddParams",
        "WantList",
    ),
    "want.remove": ("Drop entries by id.", "WantRemoveParams", "WantList"),
    "want.update": (
        "Change one entry. Returns the full list for the same reason as add.",
        "WantUpdateParams",
        "WantList",
    ),
    "discover.parseTracklist": (
        "Try to read a tracklist out of a YouTube video's description. Low "
        "confidence by design — a DJ set's tracklist is typed by a human into "
        "a free-text box, and half of them are not there at all.",
        "DiscoverParseUrlParams",
        "RequestAccepted",
    ),
    "discover.fingerprint": (
        "Identify a local audio file. Replies immediately; the answer arrives "
        "as `discover.identified`. Needs the `fpcalc` binary from chromaprint "
        "and an AcoustID application key — without either it fails saying which.",
        "FingerprintParams",
        "RequestAccepted",
    ),
    "discover.playlist": (
        "Read a public YouTube playlist. Replies immediately with a requestId; "
        "the contents arrive as discover.playlistItems, because a long "
        "playlist costs several rate-limited HTTP requests. Needs a YouTube "
        "Data API key in Settings - without one it fails saying so.",
        "PlaylistParams",
        "RequestAccepted",
    ),
    "discover.wantlist": (
        "Read the signed-in user's Discogs wantlist. Replies immediately with a "
        "requestId; the contents arrive as `discover.wantlistItems`, because a "
        "long wantlist costs several rate-limited HTTP requests and a command "
        "handler runs on pynicotine's main thread. Needs a Discogs token in "
        "Settings — the username is resolved from it.",
        None,
        "RequestAccepted",
    ),
    "discover.related": (
        "Find music adjacent to a release. Replies immediately; results arrive "
        "as `discover.relatedResults`.",
        "RelatedParams",
        "RequestAccepted",
    ),
    "discover.browse": (
        "Fetch a whole discography. Replies immediately with a requestId; the "
        "catalogue arrives as `discover.catalog`, because it costs several "
        "rate-limited requests and a command handler runs on pynicotine's "
        "main thread.",
        "DiscoverBrowseParams",
        "RequestAccepted",
    ),
    "history.list": ("Recent searches, newest first.", None, "HistoryState"),
    "history.record": ("Note that a search was run.", "WishParams", "HistoryState"),
    "history.clear": ("Forget the search history.", None, "HistoryState"),
    "saved.list": ("Saved searches.", None, "SavedState"),
    "saved.add": ("Save a search, with its filters.", "SavedParams", "SavedState"),
    "saved.remove": ("Drop a saved search.", "WishParams", "SavedState"),
    "buddies.list": ("The buddy list.", None, "BuddyState"),
    "buddies.add": ("Add a buddy.", "UserBrowseParams", "BuddyState"),
    "buddies.remove": ("Remove a buddy.", "UserBrowseParams", "BuddyState"),
    "shares.get": ("Read the current share configuration.", None, "ShareState"),
    "shares.set": (
        "Record the user's sharing choice and folder list.",
        "ShareSetParams",
        "ShareState",
    ),
    "shares.rescan": ("Rebuild the share index.", "ShareRescanParams", None),
    "import.inspect": (
        "Report what an existing Nicotine+ install offers, WITHOUT importing "
        "anything. User-triggered only.",
        None,
        "ImportSource",
    ),
    "import.apply": (
        "Copy selected settings from Nicotine+ into Seek.",
        "ImportApplyParams",
        "ImportResult",
    ),
    "settings.get": ("Read all settings.", None, "SettingsResult"),
    "settings.patch": ("Shallow-merge a settings patch.", "SettingsPatchParams", "SettingsResult"),
    "fs.check": (
        "Report what is true of a local path, so the UI can say what is wrong "
        "with one BEFORE it is saved. Reads nothing but the path itself.",
        "PathCheckParams",
        "PathCheck",
    ),
    "fs.ensureFolder": (
        "Create a folder and any missing parents, then report the result. "
        "Succeeds silently if it already exists. Never deletes or overwrites.",
        "EnsureFolderParams",
        "PathCheck",
    ),
}

# --------------------------------------------------------------------------
# Events — sidecar -> client, unsolicited.
# --------------------------------------------------------------------------

EVENTS = {
    "connection.state": ("Server connection changed.", "ConnectionState"),
    "connection.stats": ("Per-second network counters.", "ConnectionStats"),
    "search.started": ("A search was accepted and broadcast.", "SearchInfo"),
    "search.result": ("A batch of results from one peer.", "SearchResultEvent"),
    "search.closed": ("The sidecar stopped accepting results.", "SearchClosedEvent"),
    "search.failed": ("The search could not be sent.", "SearchFailedEvent"),
    "user.stats": ("A peer's server-side stats changed.", "PeerStats"),
    "user.status": ("A peer's presence changed.", "UserStatusEvent"),
    "user.browse.result": ("A peer's share list arrived.", "UserBrowseResultEvent"),
    "user.browse.failed": ("A share list request failed.", "UserBrowseFailedEvent"),
    "folder.contents": ("Remote folder contents arrived.", "FolderContentsEvent"),
    "folder.contents.failed": ("A folder request failed.", "FolderContentsFailedEvent"),
    "transfer.added": ("A transfer entered the list, either direction.", "Transfer"),
    "transfer.updated": (
        "A download changed — progress tick OR state change. Upstream emits one "
        "event for both (RECON.md §3); the sidecar throttles progress-only "
        "updates but never throttles a state change.",
        "Transfer",
    ),
    "transfer.removed": ("Transfers left the list, either direction.", "TransferRemovedEvent"),
    "folder.finished": ("Every file in a local folder finished.", "FolderFinishedEvent"),
    "analysis.result": (
        "A spectral analysis finished. Post-download only.",
        "SpectralAnalysis",
    ),
    "analysis.failed": ("A spectral analysis could not run.", "AnalysisFailedEvent"),
    "chat.message": ("A chat line, incoming or echoed.", "ChatMessage"),
    "chat.rooms": ("The room list changed.", "ChatRoomList"),
    "chat.members": ("A room's membership changed.", "ChatRoomMembers"),
    "shares.state": ("Share configuration or scan state changed.", "ShareState"),
    "wishlist.state": ("The wishlist or its interval changed.", "WishlistState"),
    "buddies.state": ("The buddy list changed.", "BuddyState"),
    "library.state": ("Index changed, or a scan progressed.", "LibraryState"),
    "app.settings": ("Preferences changed.", "AppSettings"),
    "peers.stats": ("A transfer outcome updated a peer's record.", "PeerHistory"),
    "library.gaps": ("Which tracks of a release are missing.", "LibraryGaps"),
    "preview.result": ("A decoded excerpt is ready to play.", "PreviewResult"),
    "preview.failed": ("The excerpt could not be decoded.", "PreviewFailed"),
    "artwork.result": ("A cover image arrived.", "ArtworkResult"),
    "artwork.failed": ("No cover could be found.", "ArtworkFailed"),
    "metadata.proposal": ("A MusicBrainz match for a downloaded file.", "MetadataProposal"),
    "want.changed": ("The want list was added to, edited or pruned.", "WantList"),
    "connections.changed": (
        "The set of peers with a transfer active or queued changed. Emitted on "
        "CHANGE rather than on the once-a-second tick that detects it — the "
        "list is usually identical from one second to the next, and a snapshot "
        "nobody asked for is not worth a frame.",
        "ConnectionSnapshot",
    ),
    "stats.changed": (
        "Transfer counters moved. RATE LIMITED by the sidecar: upstream emits "
        "its own `update-stat` once per fragment per transfer, which is several "
        "a second with a few downloads running, and a statistics screen has no "
        "use for that resolution.",
        "TransferStats",
    ),
    "labels.changed": ("The watched catalogue list changed.", "WatchedLabelList"),
    "session.changed": (
        "A digging session was created, renamed, closed or deleted.",
        "DigSessionList",
    ),
    "discover.parsed": ("A provider answered about a URL.", "DiscoverParsed"),
    "discover.parseFailed": (
        "No provider recognised the URL, or the lookup failed.",
        "DiscoverFailed",
    ),
    "discover.catalog": ("A label's or artist's discography arrived.", "DiscoverCatalog"),
    "discover.playlistItems": (
        "A YouTube playlist's contents arrived.", "DiscoverPlaylist",
    ),
    "discover.wantlistItems": (
        "A Discogs wantlist arrived.", "DiscoverWantlist",
    ),
    "discover.identified": ("An AcoustID match, or the absence of one.", "DiscoverIdentified"),
    "discover.relatedResults": ("Music adjacent to a release.", "DiscoverRelated"),
    "discover.tracklistParsed": (
        "Timestamped lines from a video description.",
        "DiscoverTracklist",
    ),
    "discover.browseFailed": ("The discography could not be fetched.", "DiscoverFailed"),
    "log": ("A forwarded log line.", "LogEvent"),
}
