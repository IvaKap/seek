/*
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: shared/schema.py
 * Regenerate:      python3 shared/generate_protocol.py
 * Verified by:     sidecar/tests/test_protocol_sync.py
 *
 * Seek — wire protocol between the Python sidecar and the app.
 * Copyright (C) 2026 Seek contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Transport: localhost WebSocket, newline-delimited JSON, one frame per
 * message. The sidecar emits RAW data only — no formatting, no derived
 * fields, no ranking. Grouping, dedup, quality scoring and all display
 * formatting belong to app/src/domain/.
 */

export const PROTOCOL_VERSION = 1;

/* ---------------------------------------------------------------- enums */

/** Which conversation a chat line belongs to. */
export type ChatScope = 'room' | 'private';

/**
 * How the line should read. 'action' is the /me form; 'local' is
 * client-generated and never touched the network.
 */
export type ChatMessageKind = 'message' | 'action' | 'local' | 'hilite';

/** Sidecar's view of the Soulseek server connection. */
export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'away' | 'failed';

/** Peer presence. Mirrors upstream UserStatus (0/1/2) as strings. */
export type UserStatus = 'offline' | 'away' | 'online';

/**
 * Which population a search is broadcast to. Mirrors
 * pynicotine.search.Search.do_search(mode=...).
 */
export type SearchMode = 'global' | 'rooms' | 'buddies' | 'user' | 'wishlist';

/**
 * Why the sidecar stopped accepting results for a search. Soulseek has NO
 * server-side completion signal (see RECON.md §3) — every value here is a
 * client-side decision, not a network fact.
 */
export type SearchCloseReason = 'timeout' | 'result_cap' | 'stopped' | 'disconnected';

/**
 * Which way a transfer is going.
 *
 * Both share one event stream and one id space, because they are the same kind
 * of thing and the frontend groups them the same way. The id carries the
 * direction (`registries.transfer_key`) so a download from a peer and an
 * upload to that peer of a matching virtual path cannot collide — which is not
 * exotic, since a folder you downloaded into is often a folder you share.
 */
export type TransferDirection = 'download' | 'upload';

/**
 * pynicotine.transfers.TransferStatus, lowercased and underscored, plus one
 * state upstream has no name for.
 *
 * 'rejected' is the peer refusing, and it exists because upstream writes the
 * refusal STRAIGHT INTO `transfer.status` (downloads.py,
 * `_abort_transfer(download, status=reason)`). Those strings are
 * TransferRejectReason values - 'File not shared.', 'Banned', 'Pending
 * shutdown.' - and peers also send free text, e.g. anything starting 'User
 * limit of'. None of them are TransferStatus values, so mapping only the
 * closed set turned every refusal into 'unknown' AND discarded what the peer
 * actually said. That is what a download reading 'unknown' in 0.2.1 meant:
 * someone told you why and Seek threw it away.
 *
 * For 'rejected' the reason is carried verbatim in `Transfer.error`. 'unknown'
 * now means only what it says - upstream had no status at all, which happens
 * for a restored transfer whose saved row predates the field.
 */
export type TransferState =
  | 'queued'
  | 'rejected'
  | 'getting_status'
  | 'transferring'
  | 'paused'
  | 'cancelled'
  | 'filtered'
  | 'finished'
  | 'user_logged_off'
  | 'connection_closed'
  | 'connection_timeout'
  | 'download_folder_error'
  | 'local_file_error'
  | 'unknown';

/** Machine-readable failure reasons for command replies. */
export type ErrorCode =
  | 'bad_request'
  | 'unknown_command'
  | 'not_connected'
  | 'already_queued'
  | 'not_found'
  | 'unsupported'
  | 'internal';

/**
 * Conclusion of a post-download spectral check. Deliberately hedged: a lowpass
 * shelf is strong evidence but never proof, and quiet or sparse music
 * genuinely lacks high-frequency energy. Never render any of these as a
 * definitive verdict — there is no 'fake' value here on purpose.
 */
export type SpectralAssessment =
  | 'likely_lossless'
  | 'possible_transcode'
  | 'strong_signs_of_lossy_source'
  | 'inconclusive';

/**
 * Whether the user has decided what to share back to the network.
 *
 * 'declined' is a real, persisted answer, not an absence of one, and the
 * app is expected to surface it permanently: Soulseek is reciprocal, and
 * peers deprioritise and ban clients that share nothing. Throttled
 * transfers and refused queues then look like a bug in Seek rather than
 * the network working exactly as designed.
 */
export type ShareConsent = 'unset' | 'granted' | 'declined';

/** Severity of a forwarded sidecar/core log line. */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * Where the user found a piece of music. 'manual' is a typed entry;
 * 'fingerprint' is an AcoustID identification.
 */
export type WantSource = 'youtube' | 'bandcamp' | 'discogs' | 'manual' | 'fingerprint';

/**
 * Where a want list entry sits in the seek-evaluate-download loop.
 *
 * 'found' and 'not_found' are decided by the FRONTEND, after a search it
 * ran, by matching results against the entry. The sidecar only stores the
 * answer: Soulseek has no completion signal (RECON.md §3), so 'not_found'
 * is a client-side timeout decision, and whether a result actually IS the
 * thing you wanted is fuzzy matching over parsed paths, which lives in
 * app/src/domain/.
 */
export type WantStatus = 'pending' | 'searching' | 'found' | 'downloaded' | 'not_found';

/**
 * What a discovery URL actually names. A label or artist URL is not something
 * to search for directly — it is a catalogue to browse, and the frontend
 * offers a different action for it.
 */
export type DiscoverKind = 'track' | 'release' | 'artist' | 'label';

/* -------------------------------------------------------------- structs */

/**
 * One file offered by one peer. This is the atom of the whole protocol.
 *
 * IMPORTANT (RECON.md §4): the audio attributes below arrive in two
 * DISJOINT sets, because that is what FileListMessage.pack_file_info()
 * puts on the wire:
 *   lossless -> duration, sampleRate, bitDepth   (bitrate/isVbr are null)
 *   lossy    -> bitrate, duration, isVbr         (sampleRate/bitDepth null)
 * Any or all of them may also be null for peers running clients that send
 * no attributes at all. Never assume a field is present.
 */
export interface FileRef {
  /**
   * Full virtual path exactly as the peer sent it, backslash-separated.
   * Upstream rewrites '/' to '\\' but performs no other normalisation, and
   * neither do we. This is the identity of the file on that peer.
   */
  path: string;

  /** File size in bytes. */
  size: number;

  /**
   * Advertised bitrate in kbps (FileAttribute.BITRATE). A CLAIM by the peer,
   * not a measurement. Null for lossless files and for peers that send no
   * attributes.
   */
  bitrate: number | null;

  /**
   * Length in whole seconds (FileAttribute.LENGTH). Null when absent. Without
   * this, no size-vs-bitrate check is possible at all.
   */
  duration: number | null;

  /**
   * Sample rate in Hz (FileAttribute.SAMPLE_RATE). In practice only present on
   * lossless files.
   */
  sampleRate: number | null;

  /**
   * Bits per sample (FileAttribute.BIT_DEPTH). In practice only present on
   * lossless files, and is what upstream uses to decide a file IS lossless
   * when encoding.
   */
  bitDepth: number | null;

  /**
   * Variable bitrate flag (FileAttribute.VBR). Null on lossless files and when
   * absent. Note upstream discards FileAttribute.ENCODER entirely (RECON.md
   * §4), so no encoder string is available.
   */
  isVbr: boolean | null;
}

/**
 * Per-peer facts. `freeSlots`/`queueLength`/`advertisedSpeed` arrive with
 * every search response; `files`/`folders` only arrive from the server via
 * user-stats, and are null until then.
 */
export interface PeerStats {
  /** Connection-authenticated peer name (msg.username). */
  username: string;

  /**
   * Peer has a free upload slot right now (`freeulslots`). Forwarded raw —
   * upstream's GTK client rewrites queueLength to 0 when this is true, and we
   * deliberately do not.
   */
  freeSlots: boolean;

  /**
   * Peer's self-reported average upload speed in BYTES per second (`ulspeed`).
   * A promise, not a measurement — the UI must render it distinctly from an
   * observed transfer speed.
   */
  advertisedSpeed: number;

  /** Number of files queued on that peer (`inqueue`), as reported. */
  queueLength: number;

  /**
   * Total files the peer shares, per the server. Null unless a user-stats
   * update has been seen.
   */
  files: number | null;

  /**
   * Total folders the peer shares, per the server. Null unless a user-stats
   * update has been seen.
   */
  folders: number | null;

  /** Two-letter country code resolved from the peer's IP, when known. */
  country: string | null;
}

/**
 * A folder and its files. Used by browse and folder-contents results. Note
 * that `FileRef.path` here is always rebuilt into a FULL path by the sidecar —
 * upstream hands back bare basenames for browse/folder-contents but full paths
 * for search, and that inconsistency does not reach the wire (RECON.md §6).
 */
export interface FolderRef {
  /** Full folder path, backslash-separated. */
  path: string;

  /** Files directly in this folder. */
  files: FileRef[];

  /**
   * True if the peer returned this folder in their buddy-only share list
   * rather than their public one.
   */
  private: boolean;
}

/** Failure detail on a command reply. */
export interface ErrorInfo {
  /** Machine-readable reason. */
  code: ErrorCode;

  /** Developer-facing English text. Not for display. */
  message: string;
}

/** First frame the client sends after the socket opens. */
export interface HelloParams {
  /** Client's PROTOCOL_VERSION. */
  protocolVersion: number;

  /** Free-form client identifier, for the sidecar log. */
  client: string;
}

/**
 * Sidecar's handshake reply, including a full state snapshot so the frontend
 * never has to guess after a reconnect.
 */
export interface HelloResult {
  /** Sidecar's PROTOCOL_VERSION. */
  protocolVersion: number;

  /** Seek sidecar version string. */
  sidecarVersion: string;

  /** Upstream pynicotine __version__ in use. */
  coreVersion: string;

  /** Current connection state. */
  connection: ConnectionState;

  /** Every download the core currently knows about. */
  transfers: Transfer[];

  /** Searches still accepting results. */
  searches: SearchInfo[];
}

/**
 * Log in to the Soulseek server. The sidecar writes credentials into the
 * isolated Seek config and never into the user's own Nicotine+ config.
 *
 * Both fields are nullable, and null means 'use whatever is already stored'.
 * That is how signing in after an import works: the import has already written
 * the credentials, so re-sending them would mean pulling a password back out
 * of the sidecar and across the socket just to hand it straight back.
 */
export interface ConnectParams {
  /** Soulseek account name, or null to use the stored one. */
  username: string | null;

  /**
   * Soulseek account password, or null to use the stored one. Sent in the
   * clear over the loopback socket when the user types it into the manual
   * sign-in form — the socket is loopback-only and token-gated, and there is
   * no way to authenticate a new account without transmitting it once. It is
   * never echoed back, never logged, and never returned by any command.
   */
  password: string | null;
}

/** Begin a search. */
export interface SearchStartParams {
  /**
   * Raw user query. The sidecar passes it to upstream, which sanitises it; the
   * transmitted form comes back on `search.started`.
   */
  query: string;

  /** Defaults to 'global'. */
  mode: SearchMode | null;

  /** Required when mode is 'rooms'. */
  room: string | null;

  /** Required when mode is 'user'. Empty otherwise. */
  users: string[];

  /**
   * Stop accepting results after this many files. Null uses the sidecar
   * default. Emits `search.closed` with reason 'result_cap'.
   */
  resultCap: number | null;

  /**
   * Stop accepting results this long after the last one arrived. Null uses the
   * sidecar default.
   */
  timeoutSeconds: number | null;
}

export interface SearchStartResult {
  /** Upstream search token. Stable for the search's life. */
  searchId: number;
}

export interface SearchStopParams {
  searchId: number;
}

/** A search the sidecar is still accepting results for. */
export interface SearchInfo {
  searchId: number;

  /** The term as the user typed it, after upstream trimming. */
  query: string;

  /**
   * What actually went out on the wire. Upstream strips punctuation that stops
   * SoulseekQt from responding, so this often differs.
   */
  termTransmitted: string;
  mode: SearchMode;

  /** Unix epoch seconds, float. */
  startedAt: number;

  /** Files accepted so far across all peers. */
  resultCount: number;
}

export interface UserBrowseParams {
  username: string;
}

/** Ask the server for a peer's stats, and watch them for updates. */
export interface UserStatsParams {
  username: string;
}

/** Queue one file for download. */
export interface TransferEnqueueParams {
  username: string;

  /** Full virtual path, exactly as it came from the peer. */
  path: string;

  /** Size in bytes, from the search result. */
  size: number;

  /**
   * The original FileRef, if the client still has it. Passing it lets the
   * sidecar carry the audio attributes into the transfer record so the UI
   * keeps its quality badge while downloading.
   */
  file: FileRef | null;

  /** Absolute local folder. Null uses the configured download folder. */
  destination: string | null;

  /** Enqueue in paused state. Defaults false. */
  paused: boolean | null;
}

export interface TransferEnqueueResult {
  /** Stable opaque id minted by the sidecar. */
  transferId: string;

  /**
   * True if this (user, path) was already known. Upstream's enqueue_download()
   * silently no-ops on duplicates; we surface it.
   */
  alreadyQueued: boolean;
}

/**
 * Queue a whole remote folder. The sidecar performs the two-phase
 * request_folder -> folder-contents-response -> enqueue dance (RECON.md §5)
 * and reports progress via `folder.contents` then `transfer.added` events.
 */
export interface TransferFolderParams {
  username: string;

  /** Full remote folder path. */
  folderPath: string;

  /** Include subfolders. Defaults false. */
  recurse: boolean | null;

  /** Absolute local folder. Null uses the default. */
  destination: string | null;
}

export interface TransferFolderResult {
  /** Correlates the later `folder.contents` event with this request. */
  requestId: string;
}

export interface OrganiseResult {
  /** False when there was no confident match. */
  moved: boolean;
  fromPath: string;

  /** Empty when nothing moved. */
  toPath: string;

  /** Why not, when it did not move. */
  reason: string;
}

export interface PreviewParams {
  /** Absolute local path, or null to use transferId. */
  path: string | null;

  /** A finished transfer. */
  transferId: string | null;

  /** Where to start. Defaults to a little in. */
  startSeconds: number | null;

  /** How long. Clamped to a sane maximum. */
  seconds: number | null;
}

/**
 * A decoded excerpt, downmixed to mono and resampled down, because this
 * crosses a socket and is for judging a track rather than listening to it
 * properly.
 */
export interface PreviewResult {
  requestId: string;
  path: string;

  /** data:audio/wav;base64,... */
  dataUri: string;
  startSeconds: number;

  /** Actual length returned; a short file gives less. */
  seconds: number;

  /** Full length of the source file. */
  durationSeconds: number;
}

export interface PreviewFailed {
  requestId: string;
  reason: string;
}

export interface AppSettings {
  /**
   * Sign in to Soulseek on launch using the stored account. This is upstream's
   * own `auto_connect_startup` flag, read and written where it actually lives
   * rather than mirrored into Seek's state.
   */
  autoConnect: boolean;

  /** Whether an account is stored at all. */
  hasCredentials: boolean;

  /** The stored account name. Never the password. */
  username: string;

  /**
   * Allow MusicBrainz, Cover Art Archive, Deezer and Discogs. Off means off:
   * no request leaves the machine.
   */
  externalLookups: boolean;

  /** Whether a token is stored. Never the value. */
  discogsToken: boolean;

  /** Cache cap in megabytes. */
  artworkCacheMb: number;

  /** Default for the metadata panel's embed box. */
  embedArtwork: boolean;

  /** Also write cover.jpg beside the tracks. */
  writeCoverFile: boolean;

  /**
   * When a track has several sources, queue the best LOSSLESS one rather than
   * the highest overall score. A free fast 320 usually out-scores a queued
   * FLAC; this says which you actually want.
   */
  preferLossless: boolean;

  /** Refuse lossy files below this. 0 disables. */
  minBitrate: number;

  /** Refuse files the physics check flags. */
  rejectTranscodes: boolean;

  /**
   * Move completed downloads into Artist/Year - Album/ using the MusicBrainz
   * match. Off by default: moving a user's files without being asked is not a
   * default anyone should inherit.
   */
  autoOrganise: boolean;

  /**
   * Whether a key is stored. NEVER the value — same rule as the Discogs token:
   * a credential does not echo back across the socket once it has been sent.
   */
  acoustidApiKey: boolean;

  /**
   * Whether a key is stored. NEVER the value — same rule as the Discogs token
   * and the AcoustID key. Reading a public playlist needs only this simple API
   * key; the OAuth client YouTube also offers is for a user's PRIVATE data and
   * is deliberately not used, so there is no client secret to hold.
   */
  youtubeApiKey: boolean;

  /**
   * Group a burst of want list additions into a digging session. On by default
   * — it only ever adds a grouping, never changes or hides an entry, and it
   * can be switched off here.
   */
  autoDigSessions: boolean;
}

/**
 * Every field nullable: null means 'leave this alone'. An absent value and an
 * intentionally empty one are different things.
 */
export interface AppSettingsPatch {
  autoConnect: boolean | null;
  externalLookups: boolean | null;

  /** Send an empty string to clear it. */
  discogsToken: string | null;
  artworkCacheMb: number | null;
  embedArtwork: boolean | null;
  writeCoverFile: boolean | null;
  preferLossless: boolean | null;
  minBitrate: number | null;
  rejectTranscodes: boolean | null;
  autoOrganise: boolean | null;

  /** The key itself, for writing. Empty clears it. */
  acoustidApiKey: string | null;

  /** The key itself, for writing. Empty clears it. */
  youtubeApiKey: string | null;
  autoDigSessions: boolean | null;
}

export interface PeerRecord {
  username: string;

  /** Transfers that finished. */
  ok: number;

  /** Transfers that errored or lost the peer. */
  failed: number;

  /** Unix seconds of the last outcome. */
  lastSeen: number;
}

export interface PeerHistory {
  items: PeerRecord[];
}

export interface WishParams {
  /** The search text to wish for. */
  query: string;
}

export interface LibraryState {
  /** Unix seconds. 0 if never scanned. */
  scannedAt: number;

  /** Folders the index was built from. */
  roots: string[];
  releaseCount: number;
  trackCount: number;
  scanning: boolean;
}

export interface LibraryScanParams {
  /**
   * Extra folders to include. The download folder is always scanned; these are
   * added to it.
   */
  roots: string[];

  /**
   * Read tags as well as paths. Much slower over a network volume, but far
   * more accurate. Defaults true.
   */
  readTags: boolean | null;
}

export interface LibraryRelease {
  /** Normalised artist|release, matched against search results. */
  key: string;
  artist: string;
  release: string;

  /** Where it lives on disk. */
  folder: string;
  trackCount: number;
  bytes: number;

  /**
   * Extension counts as JSON, e.g. {"flac": 12}. Opaque to the sidecar: what
   * the mix MEANS is a presentation question, and presentation is TypeScript's
   * job.
   */
  formats: string;

  /** 0 when no tag carried a plausible one. */
  year: number;

  /** First genre seen in the folder. Often empty. */
  genre: string;
}

export interface LibraryReleases {
  items: LibraryRelease[];
}

export interface LibraryGap {
  position: number;
  title: string;
  artist: string;

  /** Present on disk. */
  have: boolean;
}

export interface LibraryGaps {
  /** Echoes the request. */
  key: string;

  /** False when MusicBrainz had no confident match. */
  matched: boolean;
  releaseTitle: string;
  releaseArtist: string;
  score: number;

  /** The full official track list, marked. */
  tracks: LibraryGap[];
}

export interface LibraryOwned {
  /** Release keys. */
  releases: string[];

  /** Track keys. */
  tracks: string[];
}

export interface ArtworkParams {
  /** May be empty; the release name alone often matches. */
  artist: string;

  /** Release or folder name, as parsed. */
  release: string;

  /** Client-side id echoed back so the row can be found. */
  key: string;
}

export interface RequestAccepted {
  requestId: string;
}

/**
 * A cover image, as a data URI so the webview needs no file access and no
 * second request.
 */
export interface ArtworkResult {
  /** Echoes ArtworkParams.key. */
  key: string;
  requestId: string;

  /** data:image/...;base64,... */
  dataUri: string;

  /** cache | coverartarchive | deezer */
  source: string;

  /**
   * How many tracks MusicBrainz says the release has. 0 when there was no
   * confident match — the SAME lookup that found the cover produced this, so
   * completeness costs no extra requests.
   */
  trackCount: number;

  /** Release date, or empty. */
  date: string;

  /** Label, or empty. */
  label: string;

  /** Release MBID, or empty. */
  mbid: string;
}

export interface ArtworkFailed {
  key: string;
  requestId: string;

  /** Developer-facing. A miss is normal, not an error. */
  reason: string;
}

export interface ArtworkCacheStats {
  entries: number;
  bytes: number;
  capBytes: number;
}

/**
 * One field that would change. Named `current`/`proposed` rather than from/to
 * because `from` is a Python keyword and the generated dataclass would not
 * parse.
 */
export interface TagChange {
  field: string;

  /** What the file says now. May be empty. */
  current: string;

  /** What MusicBrainz says it should be. */
  proposed: string;
}

/**
 * What MusicBrainz thinks this file should be tagged as. NOTHING is written
 * until the user applies it — a wrong automatic retag is unrecoverable once
 * the original filename is gone.
 */
export interface MetadataProposal {
  requestId: string;
  path: string;
  transferId: string | null;

  /** False when MusicBrainz found nothing confident. */
  matched: boolean;

  /**
   * MusicBrainz match score, 0-100. Shown so the user can weigh the proposal:
   * a 100 on a well-known release and a 72 on a white label deserve different
   * amounts of trust.
   */
  score: number;

  /** What was actually searched for, after normalising. */
  query: string;

  /** Release matched but the track did not. */
  trackMatched: boolean;
  releaseTitle: string;
  releaseArtist: string;
  date: string;
  label: string;
  mbid: string;

  /** Only fields that would actually change. */
  changes: TagChange[];
}

export interface MetadataApplyParams {
  path: string;

  /** The subset the user accepted. */
  fields: TagChange[];

  /** Also write the cover into the file. */
  embedArtwork: boolean;

  /** For the artwork lookup, if embedding. */
  artist: string;

  /** For the artwork lookup, if embedding. */
  release: string;
}

export interface MetadataApplyResult {
  path: string;
  written: number;
  artworkEmbedded: boolean;
}

/** One track in a release's expected tracklist, as the source gives it. */
export interface WantTrack {
  /** Track number. 0 when the source does not number it. */
  position: number;
  title: string;

  /**
   * Empty unless the source credits the track separately, as it does on a
   * compilation.
   */
  artist: string;

  /** Seconds. Null when the source does not say. */
  duration: number | null;
}

export interface DiscoverParseUrlParams {
  /**
   * The URL to look up. Anything but http/https is refused, and an
   * unrecognised host is still attempted — Bandcamp answers for custom
   * domains, which no host pattern can predict.
   */
  url: string;
}

/**
 * What a provider says about a URL. Raw provider facts; see the note above
 * this struct for why there is no parse here.
 */
export interface DiscoverParsed {
  /** Correlates with the discover.parseUrl command. */
  requestId: string;

  /** The URL that was looked up, echoed back. */
  url: string;

  /**
   * Which provider answered. Resolved by the sidecar, because it is the only
   * side that can tell a Bandcamp custom domain from any other host: it asked,
   * and Bandcamp replied.
   */
  sourceKind: WantSource;
  kind: DiscoverKind;

  /**
   * The provider's own title string, unprocessed. For YouTube this is the
   * whole of what is known and the only thing to parse.
   */
  rawTitle: string;

  /**
   * YouTube's `author_name`, the uploading channel. Load-bearing for parsing:
   * it identifies series branding and it is the fallback artist on VEVO and
   * official artist channels. Empty for the other providers.
   */
  channel: string;

  /**
   * Populated only when the PROVIDER states it as a field, which Bandcamp and
   * Discogs do. Empty for YouTube, where filling it would mean guessing on the
   * wrong side of the seam.
   */
  artist: string;

  /** Same rule as `artist`. Empty for YouTube. */
  title: string;

  /** Release title when the URL names a track on one. */
  album: string | null;

  /** When the provider gives one. */
  year: number | null;
  label: string | null;

  /** Discogs catalogue number, when available. */
  catalogNumber: string | null;

  /**
   * data:image/...;base64,... — fetched BY THE SIDECAR, not linked. An <img>
   * pointing at i.ytimg.com would be the frontend making its own request to a
   * third party: it would leak the user's IP and it would run with external
   * lookups switched off, which is precisely what that switch exists to
   * prevent. Null when the provider offered no image or the fetch failed,
   * which is normal.
   */
  artworkUri: string | null;

  /** Seconds, when the provider says. */
  duration: number | null;

  /**
   * Discogs genres followed by its styles, in that order. Empty for the other
   * providers.
   */
  genres: string[];

  /**
   * For releases, when the provider gives one. Discogs does; Bandcamp's oEmbed
   * does not, and its album page is Phase D4.
   */
  tracklist: WantTrack[];

  /**
   * The canonical URL according to the provider, when it differs from what was
   * pasted.
   */
  providerUrl: string | null;
}

/**
 * One release in a label's or an artist's discography.
 *
 * NOTE WHAT IS ABSENT, twice over. There is no `inLibrary` flag, which
 * `DISCOVERY.md` asks for: whether you already own a release is a match
 * against the library index, and that index lives in the frontend
 * (`libraryStore.ts`) with the normalised keys that do the matching.
 * And there is no thumbnail. Discogs gives one URL per release, and a
 * catalogue of three hundred would mean three hundred rate-limited
 * fetches before the grid could draw. The artwork pipeline already
 * solves that properly — placeholder first, fetch what scrolls into
 * view — and this reuses it rather than inventing a slower second way.
 */
export interface CatalogEntry {
  /** 0 when the provider has no numeric id. */
  discogsId: number;
  title: string;
  artist: string;
  year: number | null;

  /**
   * Verbatim from the provider, e.g. 'CD, Album' or '12", 33 ⅓ RPM'. A
   * comma-joined descriptor list, not a tier — deciding what it MEANS is
   * presentation. Empty on an artist discography, which Discogs does not
   * annotate.
   */
  format: string;

  /** Catalogue number. Empty when the provider has none. */
  catno: string;

  /**
   * 'Main', 'Appearance', 'Remix', … on an artist discography. Empty for a
   * label. Load-bearing: Burial's 375 entries are mostly compilation
   * appearances, and which of those count as 'their discography' is the user's
   * call, not ours.
   */
  role: string;

  /** Where to see it on the provider's own site. */
  url: string;
}

/**
 * One timestamped line lifted out of a video description, UNPARSED.
 *
 * `text` is whatever followed the timestamp, verbatim. Turning
 * 'Burial - Archangel' into an artist and a title is the same derivation
 * `parseTitle.ts` already does for video titles, against forty other
 * shapes — so the line goes across raw and is parsed there rather than
 * growing a second, differently-wrong splitter down here.
 */
export interface TracklistLine {
  /** 1-based, in description order. */
  position: number;

  /** Where it starts in the set. */
  offsetSeconds: number;

  /** The line with its timestamp removed. */
  text: string;
}

/**
 * A tracklist read out of a YouTube description. Best-effort by nature: these
 * are typed by hand by whoever uploaded the set.
 */
export interface DiscoverTracklist {
  requestId: string;
  url: string;

  /** The set's own title, for naming the entries. */
  videoTitle: string;
  channel: string;

  /**
   * Empty when the description had no timestamped lines, which is the ordinary
   * outcome for most videos and is not an error.
   */
  lines: TracklistLine[];
}

/** Identify a local audio file by its acoustic fingerprint. */
export interface FingerprintParams {
  /** Absolute local path. */
  path: string;

  /**
   * Only fingerprint the first N seconds. Null uses the default. AcoustID
   * matches on the opening of a track, so more than two minutes buys nothing
   * and costs decode time.
   */
  durationLimit: number | null;
}

/**
 * What AcoustID made of a fingerprint.
 *
 * `score` is AcoustID's own confidence that the FINGERPRINT matches, not
 * a judgement about whether the metadata is right. Render it the way the
 * rest of the app renders confidence: as a claim with its evidence, never
 * as a fact.
 */
export interface DiscoverIdentified {
  requestId: string;
  path: string;

  /**
   * False when nothing scored above AcoustID's threshold, which is the
   * ordinary outcome for anything underground.
   */
  matched: boolean;
  artist: string;
  title: string;
  album: string | null;
  year: number | null;

  /** MusicBrainz recording id, when one is attached. */
  mbid: string | null;

  /** 0–1, AcoustID's own. */
  score: number;

  /** As decoded, for the record. */
  durationSeconds: number;
}

export interface PlaylistParams {
  /**
   * The bare playlist id. discoverUrl.ts pulls it out of the URL, because URL
   * shapes are the frontend's business and Python is not in the guessing seat.
   */
  playlistId: string;
}

export interface RelatedParams {
  artist: string;
  release: string;

  /** When known, the strongest link there is. */
  label: string | null;
}

/**
 * Music adjacent to one release. Grouped by WHY each thing is related, because
 * 'more from this label' and 'more by this artist' are different questions and
 * a single mixed list answers neither.
 */
export interface DiscoverRelated {
  requestId: string;

  /** Other releases by the same artist. */
  byArtist: CatalogEntry[];

  /** Other releases on the same label. */
  byLabel: CatalogEntry[];

  /** The label the byLabel list came from. */
  labelName: string;
}

/** Ask a provider for a whole discography. */
export interface DiscoverBrowseParams {
  /** 'discogs' or 'bandcamp'. */
  sourceKind: WantSource;

  /** 'label' or 'artist'. */
  kind: DiscoverKind;

  /** Discogs numeric id, when it is already known. */
  id: number | null;

  /** Name to look up when there is no id. */
  name: string | null;

  /** Page URL. How Bandcamp is addressed — it has no ids. */
  url: string | null;
}

/**
 * One entry of a YouTube playlist, exactly as YouTube states it.
 * Nothing here is parsed: parseTitle.ts turns a title into an artist and a
 * track on the frontend, per the standing rule that Python emits raw facts and
 * TypeScript derives.
 */
export interface DiscoverPlaylistItem {
  /**
   * From contentDetails.videoId. snippet.resourceId.videoId holds the same
   * value; this one is used throughout so there is one answer to where the id
   * comes from.
   */
  videoId: string;

  /** snippet.title, verbatim and unparsed. */
  title: string;

  /**
   * snippet.videoOwnerChannelTitle - who UPLOADED the video. NOT
   * snippet.channelTitle, which is whoever owns the playlist. Measured: on a
   * Hyperdub playlist of Untrue the uploader is Hyperdub while the playlist
   * owner is a stranger, and it is the uploader that names the music.
   */
  channel: string;

  /** Its place in the playlist, from snippet.position. */
  position: number;

  /**
   * False for an entry YouTube will not serve - a deleted or private video,
   * which still occupies a position. Documented to arrive titled 'Deleted
   * video' with no uploader; NOT confirmed against live data, so treat a false
   * here as untested.
   */
  available: boolean;
}

/** The contents of a public YouTube playlist. */
export interface DiscoverPlaylist {
  requestId: string;
  playlistId: string;
  items: DiscoverPlaylistItem[];

  /**
   * What YouTube says the playlist holds, from pageInfo.totalResults - the
   * whole playlist, not the page.
   */
  total: number;

  /**
   * False when the sidecar stopped paginating before the end, same contract as
   * DiscoverCatalog: a truncated list that claims to be whole is worse than
   * one that admits it.
   */
  complete: boolean;
}

/**
 * One release from the user's Discogs wantlist.
 *
 * Everything here is what Discogs STATES about the release, forwarded as
 * given. The single assembly is the artist credit, and that is Discogs'
 * own: its artists array carries the join phrases, so
 * `[{name: 'Massive Attack', join: 'Vs'}, {name: 'Burial'}]` is the
 * credit 'Massive Attack Vs Burial'. Dropping the join would turn one
 * collaboration into two unrelated names.
 */
export interface DiscogsWant {
  /** The RELEASE id, from basic_information.id. */
  discogsId: number;

  /**
   * The master release, when there is one. Measured: Discogs sends 0 rather
   * than null for a release with no master, so this is null only after that
   * zero is normalised away.
   */
  masterId: number | null;

  /**
   * Release title, trimmed. Real entries carry trailing whitespace ('Aline
   * Brooklyn 001 ').
   */
  title: string;

  /** The credit, joined per Discogs' own join phrases. */
  artist: string;

  /** Null when Discogs has no year, never 0. */
  year: number | null;

  /** First label's name. Empty when unlabelled. */
  label: string;

  /** First label's catalogue number. Empty if none. */
  catno: string;

  /** First format name — Vinyl, CD, File. Empty if none. */
  format: string;

  /** The release page, for the want list entry's source. */
  url: string;

  /** ISO 8601 with offset, as Discogs sends it. */
  addedAt: string;

  /** The user's own note on this want. Usually empty. */
  notes: string;
}

/** The signed-in Discogs user's wantlist. */
export interface DiscoverWantlist {
  requestId: string;

  /**
   * Resolved from the token via /oauth/identity, so the user never has to know
   * or type it.
   */
  username: string;
  items: DiscogsWant[];

  /** What Discogs says the wantlist holds. */
  total: number;

  /**
   * False when the sidecar stopped paginating before the end, same contract as
   * DiscoverCatalog and DiscoverPlaylist.
   */
  complete: boolean;
}

/** A label's or artist's discography. */
export interface DiscoverCatalog {
  requestId: string;
  sourceKind: WantSource;
  kind: DiscoverKind;

  /** The label or artist as the provider names it. */
  name: string;

  /** Discogs id. 0 for Bandcamp. */
  id: number;

  /** The catalogue's own page. */
  url: string | null;
  releases: CatalogEntry[];

  /**
   * False when the sidecar stopped paginating before the end. A truncated list
   * that claims to be whole is worse than one that admits it, because the
   * missing records are invisible.
   */
  complete: boolean;
}

/**
 * A discovery lookup did not produce anything. Shared by the URL parse and the
 * catalogue browse: the two fail in the same ways.
 */
export interface DiscoverFailed {
  requestId: string;
  url: string;

  /**
   * Developer-facing. Not for display — a URL that turns out not to be music
   * is an ordinary outcome, and the UI's answer is to fall back to searching
   * the text, not to show an error.
   */
  reason: string;

  /**
   * The AppSettings field the user would have to supply for this provider to
   * work, or empty when the failure was not about configuration.
   * Machine-readable ('discogsToken') so the UI can offer the right Settings
   * link without reading English out of `reason`.
   */
  needs: string;

  /**
   * True when the provider was never reached at all - DNS, TLS, a refused
   * connection, a timeout. False when it answered and the answer was no. Same
   * distinction `needs` exists for, and the same reason it is a flag: a 404
   * means this link names nothing and searching the text instead is right,
   * while an unreachable provider means the link may be perfect and the
   * network is not. Telling the user the former when it is the latter is what
   * shipped in 0.2.0.
   */
  unreachable: boolean;
}

/**
 * One thing the user wants to find on Soulseek. The discovery layer's atomic
 * unit, analogous to FileRef for search results.
 */
export interface WantEntry {
  /** Opaque UUID, minted by the sidecar. */
  id: string;

  /** As parsed, or as corrected by the user. May be empty. */
  artist: string;

  /** Track or release title. */
  title: string;

  /** Null for standalone tracks. */
  album: string | null;
  year: number | null;
  label: string | null;
  catalogNumber: string | null;

  /** Where it was found. */
  sourceKind: WantSource;

  /** Original URL. Null for manual entries. */
  sourceUrl: string | null;

  /**
   * The provider's unprocessed title, kept so a bad parse can be re-read by a
   * human later. This is why a corrected entry does not lose what it was
   * corrected FROM.
   */
  sourceTitle: string | null;

  /** data: URI from the source, not the artwork pipeline. */
  artworkUri: string | null;
  status: WantStatus;

  /** Unix epoch seconds. */
  addedAt: number;

  /** When last searched. Null if never. */
  searchedAt: number | null;

  /** The user's own annotation. Free text. */
  notes: string | null;

  /** Seconds, when the source provided it. */
  duration: number | null;

  /** For releases: the expected tracklist. */
  tracklist: WantTrack[];

  /**
   * The digging session this was added during, if any. Null for entries added
   * on their own and for entries whose session was deleted — deleting a
   * session unlinks its entries rather than throwing away what you wanted.
   */
  sessionId: string | null;
}

export interface WantList {
  /** Newest first. */
  entries: WantEntry[];
}

/**
 * A named, timestamped container for a discovery binge.
 *
 * NOTE WHAT IS ABSENT: no entry count and no list of sources. Both are
 * aggregates over the want list, which the frontend already holds in
 * full, and duplicating them here would be two places to get the same
 * number wrong. Same reason there is no format tier on FileRef.
 */
export interface DigSession {
  /** Opaque UUID, minted by the sidecar. */
  id: string;

  /**
   * EMPTY until the user renames it. An auto-named session shows the day and
   * time it started, and building that string is display formatting — which
   * Python does not do, here or anywhere else. The sidecar stores `createdAt`
   * and the frontend words it, in the user's own locale.
   */
  name: string;

  /** Unix epoch seconds. */
  createdAt: number;

  /**
   * When an entry was last added to it. What decides whether the session is
   * still collecting.
   */
  lastActiveAt: number;

  /**
   * No longer collecting. Set by the user, or by the sidecar once the session
   * has gone quiet for long enough.
   */
  closed: boolean;
}

export interface DigSessionList {
  /** Newest first. */
  sessions: DigSession[];
}

export interface SessionCreateParams {
  /** Null leaves it auto-named — see DigSession.name. */
  name: string | null;
}

/**
 * Your own Soulseek profile — what a peer sees when they look you up.
 *
 * Seek has only ever READ other people's. This is the first thing that
 * reports your own, and it deliberately reports the whole response
 * upstream would send (`UserInfo._get_user_info_response`) rather than
 * just the two editable fields, because the interesting question is not
 * 'what did I type' but 'what does a stranger see'.
 */
export interface Profile {
  /** The account this describes. Empty when signed out. */
  username: string;

  /**
   * The free text peers see, DECODED. Upstream stores it as a Python repr()
   * and unescapes it on send; nothing outside the sidecar should ever meet the
   * escaped form.
   */
  description: string;

  /** Local path to the picture file. Empty for none. */
  picturePath: string;

  /**
   * The picture as a data: URI, when the file exists and is small enough to be
   * worth sending. Null when there is no picture, the path does not resolve,
   * or it is over the cap — and those are different things, which
   * `pictureError` separates.
   */
  pictureUri: string | null;

  /**
   * Why there is a path but no picture. Empty when there is no problem, which
   * includes having no picture at all.
   */
  pictureError: string;

  /** Size of the picture file. 0 when there is none. */
  pictureBytes: number;

  /** Upstream's own flag for whether the picture is sent at all. */
  pictureVisible: boolean;

  /**
   * Files you are sharing. Null when the share index has not been built —
   * which is NOT the same as sharing nothing.
   */
  sharedFiles: number | null;

  /** Folders you are sharing. Null before a scan. */
  sharedFolders: number | null;

  /** Total upload slots you offer. */
  uploadSlots: number;

  /** Whether a new upload would be accepted right now. */
  freeSlots: boolean;

  /** How many files are queued on you. */
  queueSize: number;
}

/**
 * Change your own profile. Every field is optional; null leaves it alone,
 * exactly as a settings patch does.
 */
export interface ProfileParams {
  /** Plain text. The sidecar encodes it. */
  description: string | null;

  /** Local path, or the empty string to remove the picture. */
  picturePath: string | null;
  pictureVisible: boolean | null;
}

/**
 * One peer Seek is exchanging data with right now, in either direction.
 *
 * NOT a socket. Upstream's socket table lives in the network thread and is
 * private to it, and `upstream/` is not modified — so what can be reported
 * honestly is who has a transfer active or queued, which is the useful half
 * anyway. `ConnectionSnapshot.socketCount` states the real socket total beside
 * this so the difference is visible rather than implied.
 */
export interface PeerConnection {
  username: string;

  /** Two-letter code, when known. */
  country: string | null;

  /** Files actively coming from them. */
  downloading: number;

  /** Files of theirs you are waiting on. */
  downloadQueued: number;

  /** Files actively going to them. */
  uploading: number;

  /** Files of yours they are waiting on. */
  uploadQueued: number;
}

/** Who Seek is connected to, right now. */
export interface ConnectionSnapshot {
  /**
   * Open sockets, as the network thread last reported. Usually far larger than
   * the peer list: most of them carry the DISTRIBUTED SEARCH network, where
   * you relay other people's searches. That is Soulseek working, not a leak.
   */
  socketCount: number;

  /** Peers with a transfer active or queued. */
  peers: PeerConnection[];
}

/**
 * One set of transfer counters, as upstream keeps them.
 *
 * READ THE SIZE FIELDS CAREFULLY: they count BYTES ACTUALLY MOVED, not
 * the size of finished files. Upstream adds each fragment as it arrives
 * (transfers.py `_update_transfer_progress`), so a download that got to
 * 80% and then lost its peer contributed 80% of a file to
 * `downloadedSize` and nothing to `completedDownloads`. That is the
 * honest figure for bandwidth used, and the wrong one for 'how much
 * music do I have' — the library index answers that.
 */
export interface TransferCounts {
  /** Downloads begun. */
  startedDownloads: number;

  /** Downloads that finished. */
  completedDownloads: number;

  /** Bytes received, including from transfers that later failed. */
  downloadedSize: number;

  /** Uploads begun. */
  startedUploads: number;

  /** Uploads that finished. */
  completedUploads: number;

  /** Bytes sent, including from transfers that later failed. */
  uploadedSize: number;
}

/**
 * Transfer counters, session and lifetime.
 *
 * Both halves come from upstream's `statistics` component, which Seek has
 * had enabled since the beginning and has never surfaced — so the upload
 * figures here are the first sight of a side of the app that has been
 * running the whole time.
 *
 * `session` resets when the sidecar starts; `total` persists in the
 * pynicotine config. NOTHING HERE IS DERIVED: no ratio, no completion
 * rate, no percentages. Those are arithmetic over these six numbers and
 * arithmetic for display is TypeScript's, like every other derivation in
 * this project.
 */
export interface TransferStats {
  /**
   * Unix seconds when counting began. 0 if upstream never set it, which means
   * the totals have no meaningful span and the UI must not word one.
   */
  sinceTimestamp: number;

  /** Since this sidecar started. */
  session: TransferCounts;

  /** All time, as persisted by upstream. */
  total: TransferCounts;
}

/**
 * A label or artist whose catalogue the user is working through.
 *
 * NOT a new-release notifier, and the distinction is the whole design.
 * Discogs is a database rather than a release feed, so diffing it
 * reports records catalogued decades late as 'new'; Bandcamp has no API
 * to poll; and a brand-new release is precisely what Soulseek does not
 * have yet, so that notification's happy path ends in an empty search.
 * This is a bookmark with progress on it — back catalogue, which is
 * where both Soulseek and this app are strong.
 *
 * THE COUNTS ARE A SNAPSHOT, and unlike DigSession they are stored
 * rather than derived. DigSession omits its counts because the frontend
 * holds the whole want list and can recount at will; a catalogue is
 * NOT persisted anywhere, so these cannot be recomputed without several
 * rate-limited HTTP requests per label. They are therefore written when
 * the catalogue is actually read, carry `lastSeenAt`, and must never be
 * rendered as current — the UI says when it last looked.
 */
export interface WatchedLabel {
  /** Opaque UUID, minted by the sidecar. */
  id: string;

  /**
   * Which provider holds the catalogue. Same vocabulary the want list uses, so
   * one label and the releases saved from it agree.
   */
  sourceKind: WantSource;

  /** 'label' or 'artist'. Others are refused. */
  kind: DiscoverKind;

  /** What it is called. Never empty — watching needs one. */
  name: string;

  /** The catalogue page. Empty when it was found by name. */
  url: string;

  /**
   * The provider's numeric id, when known. Re-browsing with it skips the fuzzy
   * name search that `_resembles` exists to guard.
   */
  entityId: number | null;

  /** Unix epoch seconds. */
  addedAt: number;

  /**
   * When the catalogue was last actually read. Null until the first read —
   * which is not the same as 'never watched'.
   */
  lastSeenAt: number | null;

  /** Releases in the catalogue at the last read. Null before one. */
  releaseCount: number | null;

  /** Of those, matched in the library index at the last read. */
  ownedCount: number | null;

  /** Of those, already on the want list at the last read. */
  wantedCount: number | null;

  /** The user's own note. Empty unless they wrote one. */
  note: string;
}

export interface WatchedLabelList {
  /** Newest first. */
  labels: WatchedLabel[];
}

/**
 * Start watching a catalogue. Idempotent: watching one already on the list
 * updates its name, url and id and leaves its counts alone, because those
 * describe a reading rather than the choice to watch.
 */
export interface LabelWatchParams {
  sourceKind: WantSource;
  kind: DiscoverKind;
  name: string;
  url: string | null;
  entityId: number | null;
}

export interface LabelIdParams {
  id: string;
}

export interface LabelNoteParams {
  id: string;
  note: string;
}

/**
 * Record what a catalogue read found. Sent by the frontend after it has
 * rendered one, because owned and wanted are matches against the library index
 * and the want list — both of which live on that side of the seam.
 */
export interface LabelSeenParams {
  id: string;
  releaseCount: number;
  ownedCount: number;
  wantedCount: number;
}

export interface SessionIdParams {
  id: string;
}

export interface SessionRenameParams {
  id: string;
  name: string;
}

export interface WantAddParams {
  /**
   * Entries to add. `id` and `addedAt` are ignored and minted by the sidecar,
   * so a caller cannot forge either.
   */
  entries: WantEntry[];
}

export interface WantRemoveParams {
  ids: string[];
}

/**
 * Change fields on one entry. Null means 'leave this alone', so an absent
 * value and an intentionally empty one stay different things.
 */
export interface WantUpdateParams {
  id: string;
  artist: string | null;
  title: string | null;
  album: string | null;
  status: WantStatus | null;
  notes: string | null;
}

/** Recent searches, newest first, de-duplicated and capped. */
export interface HistoryState {
  items: string[];
}

/**
 * A query plus the filter set it was run with, as opaque JSON the frontend
 * owns. The sidecar stores it and never interprets it — filters are a
 * TypeScript concept (AGENTS.md, the seam).
 */
export interface SavedSearch {
  query: string;

  /** Serialised filters. Opaque to the sidecar. */
  filtersJson: string;
}

export interface SavedParams {
  query: string;

  /** Serialised filters. */
  filtersJson: string;
}

export interface SavedState {
  items: SavedSearch[];
}

export interface BuddyState {
  /** Buddy usernames, as upstream holds them. */
  items: string[];
}

/** The wishlist, and how often the server permits it to run. */
export interface WishlistState {
  /** Queries, newest first. */
  items: string[];

  /**
   * Server-dictated seconds between automatic runs. 0 before the server has
   * told us, which it does shortly after login.
   */
  intervalSeconds: number;
}

/** Target one or more transfers. Used by pause/resume/cancel/retry/clear. */
export interface TransferIdsParams {
  transferIds: string[];
}

export interface TransferListResult {
  transfers: Transfer[];
}

/**
 * Shallow-merge a patch into sidecar settings. Only the keys present are
 * changed. Unknown keys are rejected rather than silently ignored.
 */
export interface SettingsPatchParams {
  settings: Settings;
}

export interface SettingsResult {
  settings: Settings;
}

/**
 * Everything the frontend is allowed to change. Every field is optional in a
 * patch; a `settings.get` reply has them all populated.
 */
export interface Settings {
  /** Absolute path for completed downloads. */
  downloadFolder: string | null;

  /** Absolute path for in-progress downloads. */
  incompleteFolder: string | null;

  /** Incoming peer connection port. */
  listenPort: number | null;

  /** Bytes/sec, 0 = unlimited. */
  maxDownloadSpeed: number | null;

  /** Bytes/sec, 0 = unlimited. */
  maxUploadSpeed: number | null;

  /** Concurrent upload slots offered to peers. */
  uploadSlots: number | null;

  /** Connect to the Soulseek server on sidecar start. */
  autoConnect: boolean | null;

  /**
   * How long a 'transferring' download may make zero progress before
   * `Transfer.stalled` is set. Seek-specific; upstream has no such concept
   * (RECON.md §5).
   */
  stallSeconds: number | null;
}

/** Current server connection. */
export interface ConnectionState {
  status: ConnectionStatus;

  /** Our logged-in username. Null when not online. */
  username: string | null;

  /** Our public IP as the server sees it. */
  publicAddress: string | null;

  /**
   * Server rejection text on a failed login (e.g. wrong password). Null
   * otherwise.
   */
  error: string | null;
}

/**
 * Emitted about once a second while the network thread runs. Note upstream
 * also emits this event with NO arguments as a reset (RECON.md §3); the
 * sidecar normalises that into explicit zeros.
 */
export interface ConnectionStats {
  /** Open sockets. */
  connections: number;

  /** Bytes/sec across all downloads. */
  downloadBandwidth: number;

  /** Bytes/sec across all uploads. */
  uploadBandwidth: number;
}

/**
 * A batch of files from ONE peer for ONE search. The sidecar coalesces
 * upstream's per-response events into ticks so the frontend is not woken
 * hundreds of times a second; `files` may therefore span several upstream
 * responses from the same peer.
 */
export interface SearchResultEvent {
  searchId: number;
  peer: PeerStats;
  files: FileRef[];

  /** True if these came from the peer's buddy-only share list. */
  private: boolean;

  /** Unix epoch seconds when the sidecar accepted them. */
  receivedAt: number;
}

export interface SearchClosedEvent {
  searchId: number;
  reason: SearchCloseReason;

  /** Total files accepted for this search. */
  resultCount: number;

  /** Distinct peers that responded. */
  peerCount: number;
}

export interface SearchFailedEvent {
  searchId: number;

  /** Currently only ever 'offline' from upstream. */
  reason: string;
}

export interface UserStatusEvent {
  username: string;
  status: UserStatus;

  /** Null when the server did not say. */
  privileged: boolean | null;
}

/** A peer's complete share list. Arrives as one message; can be large. */
export interface UserBrowseResultEvent {
  username: string;
  folders: FolderRef[];
  fileCount: number;

  /** Sum of all file sizes, bytes. */
  totalSize: number;
}

export interface UserBrowseFailedEvent {
  username: string;
  reason: string;
}

/**
 * Reply to `transfer.enqueueFolder`'s underlying folder request. Emitted
 * before the resulting `transfer.added` events.
 */
export interface FolderContentsEvent {
  /** Matches TransferFolderResult.requestId. */
  requestId: string;
  username: string;
  folderPath: string;
  folders: FolderRef[];

  /** How many files were queued as a result. */
  enqueued: number;
}

export interface FolderContentsFailedEvent {
  /** Null if the failure was not tied to a request. */
  requestId: string | null;
  username: string;
  folderPath: string;
  reason: string;
}

/**
 * One transfer, in either direction. `id` is a stable sidecar-minted handle —
 * upstream has no stable transfer id (RECON.md §5).
 *
 * NOT ALL FIELDS MEAN THE SAME THING BOTH WAYS. On an upload,
 * `localFolder` is where YOUR file already lives rather than where a
 * file is being written, and `queuePosition` is a place in someone
 * else's queue rather than in yours. `state` is drawn from the same
 * vocabulary, but uploads never produce `paused`, `filtered` or
 * `download_folder_error` — upstream simply never sets them on that
 * side.
 */
export interface Transfer {
  /** Stable opaque id. Survives retries. */
  id: string;

  /**
   * 'download' is a file coming to you; 'upload' is one going to a peer who
   * asked for it.
   */
  direction: TransferDirection;
  username: string;

  /** Full remote virtual path. */
  path: string;

  /** Absolute local destination folder. */
  localFolder: string | null;

  /** Total bytes, as advertised. */
  size: number;

  /** Bytes written so far. 0 before the transfer starts. */
  bytesDone: number;
  state: TransferState;

  /**
   * Instantaneous rate in bytes/sec, from the network thread. 0 when not
   * transferring. This is a MEASUREMENT, unlike PeerStats.advertisedSpeed.
   */
  speed: number;

  /** Bytes/sec over the life of the transfer. */
  averageSpeed: number;

  /**
   * Place in the peer's queue, from PlaceInQueueResponse. Null when the peer
   * has not told us.
   */
  queuePosition: number | null;

  /** Upstream's own estimate. Null when it cannot be computed (speed 0). */
  secondsLeft: number | null;

  /** Seconds since the transfer started. */
  secondsElapsed: number;

  /**
   * Seek-specific: state is 'transferring' but bytesDone has not moved for
   * `Settings.stallSeconds`. Upstream provides no such signal.
   */
  stalled: boolean;

  /**
   * The originating FileRef when the client supplied one on enqueue, so
   * quality info survives into the transfers view.
   */
  file: FileRef | null;

  /**
   * What went wrong, verbatim from upstream or from the peer. Set for every
   * failure state, and for 'rejected' it is the refusal the peer sent - the
   * ONLY place that text survives, so a client that ignores it is back to
   * showing 'unknown'. Never formatted for display: the wording is the
   * frontend's job.
   */
  error: string | null;
}

export interface TransferRemovedEvent {
  transferIds: string[];
}

export interface FolderFinishedEvent {
  /** Absolute local folder that just completed. */
  localFolder: string;
}

/**
 * Result of decoding a DOWNLOADED file and inspecting its spectrum.
 *
 * This is the POST-DOWNLOAD check and it is a different thing from the
 * search-time metadata heuristic (docs/PRODUCT.md §6). The metadata check
 * is a prediction made before the bytes exist; this is a finding made
 * from the bytes themselves. Keep them distinct in the UI — a file that
 * passed the prediction and fails this is exactly the moment the app
 * earns its keep.
 *
 * It exists because RECON.md §4 established the metadata check cannot
 * run on lossless files at all: the protocol sends no bitrate for
 * FLAC/WAV/AIFF, so there is nothing to contradict. Spectral analysis
 * needs no cooperation from the uploader's metadata.
 *
 * Everything here is raw measurement. No labels, no colours, no
 * percentages formatted for display, no sentence to render.
 */
export interface SpectralAnalysis {
  /** Echoes the analysis.spectral request. */
  requestId: string;

  /** Absolute local path of the analysed file. */
  path: string;

  /** The transfer this file came from, when the request supplied one. */
  transferId: string | null;

  /** Decoded sample rate in Hz. */
  sampleRate: number;

  /** Decoded channel count. */
  channels: number;

  /** Decoded duration. */
  durationSeconds: number;

  /**
   * Which decoder produced the samples ('soundfile' or 'ffmpeg'). Useful when
   * a result looks wrong and you need to know why.
   */
  decodedWith: string;

  /** sampleRate / 2. The ceiling any content can reach. */
  nyquistHz: number;

  /**
   * Highest frequency still carrying meaningful energy, in Hz. Null when no
   * shelf could be located — which is itself informative, not a failure.
   */
  cutoffHz: number | null;

  /**
   * How far energy falls across the shelf, in dB. A sharp cliff is what
   * distinguishes an encoder lowpass from natural HF rolloff; a gentle slope
   * means much less.
   */
  shelfDropDb: number | null;

  /**
   * How wide the transition is. Encoder lowpass filters are abrupt; acoustic
   * rolloff is gradual.
   */
  shelfWidthHz: number | null;

  /**
   * 0..1, how much the shape supports the assessment. Low confidence on a
   * 'possible transcode' must read as a question, not a charge.
   */
  confidence: number;
  assessment: SpectralAssessment;

  /**
   * Whether the container claims to be lossless. A lowpass shelf in a lossy
   * file is expected and uninteresting; the same shelf in a FLAC is the entire
   * point of this check.
   */
  declaredLossless: boolean;

  /**
   * Rough bitrate a lossy source with this cutoff would have had. A hint for
   * the explanation, not a measurement. Null when no cutoff was found.
   */
  impliedSourceKbps: number | null;

  /**
   * Bin centre frequencies for `spectrumDb`, downsampled for transport. Pairs
   * index-for-index.
   */
  spectrumHz: number[];

  /**
   * Time-averaged magnitude in dB, normalised so the peak is 0. The frontend
   * renders this; the sidecar does not.
   */
  spectrumDb: number[];

  /**
   * Coarse time x frequency grid in dB, FLATTENED row-major as freq-major rows
   * of heatmapTimeBins each (index = f * heatmapTimeBins + t), low frequency
   * first, peak-normalised frequency first, peak-normalised to 0. This is the
   * Spek-style picture and answers a DIFFERENT question from spectrumDb: the
   * averaged curve resolves whether a lowpass cliff exists, this shows where
   * in the track energy sits and whether the ceiling holds throughout. Empty
   * if rendering failed — the verdict never depends on it.
   */
  heatmapDb: number[];

  /** Columns in heatmapDb. */
  heatmapTimeBins: number;

  /** Rows in heatmapDb. */
  heatmapFreqBins: number;

  /** FFT window length in samples. */
  fftSize: number;

  /** How many windows were averaged. */
  windowCount: number;

  /**
   * How much audio was actually inspected. The sidecar samples windows across
   * the file rather than reading all of it.
   */
  analysedSeconds: number;
}

/**
 * Analyse a downloaded file. Runs on a worker thread; the reply is immediate
 * and the result arrives later as `analysis.result`.
 */
export interface SpectralRequestParams {
  /** Absolute local path. Null means 'use the file for transferId'. */
  path: string | null;

  /** Analyse the completed file for this transfer. Ignored if `path` is given. */
  transferId: string | null;
}

export interface SpectralRequestResult {
  /** Correlates the later analysis.result event. */
  requestId: string;
}

export interface AnalysisFailedEvent {
  requestId: string;
  path: string | null;

  /** Developer-facing text. Not for display. */
  reason: string;
}

/** One folder offered to the network. */
export interface SharedFolder {
  /**
   * Name peers see. Upstream keys shares on this, and it need not resemble the
   * real path.
   */
  virtualName: string;

  /** Absolute local path. */
  path: string;

  /**
   * Whether the path is currently readable. External volumes go missing;
   * upstream emits shares-unavailable when they do.
   */
  exists: boolean;
}

/**
 * One line of chat. Soulseek carries no message ids for room chat, so the
 * frontend keys on (room|user, timestamp, sender, text).
 */
export interface ChatMessage {
  /** Which conversation this belongs to. */
  scope: ChatScope;

  /**
   * Room name for scope 'room'; the other party's username for scope
   * 'private'.
   */
  target: string;

  /** Who sent it. Our own name for outgoing lines. */
  username: string;

  /** The raw text. Never formatted by the sidecar. */
  message: string;

  /**
   * True when we sent it. Upstream echoes our own messages back through a
   * different event, and the UI must not show them as if a stranger said them.
   */
  outgoing: boolean;

  /**
   * 'action' is the /me form. 'local' is client-generated text that never
   * touched the network.
   */
  kind: ChatMessageKind;

  /** Our username appears in the text. Upstream computes this. */
  mentioned: boolean;

  /**
   * Unix seconds. Private messages carry the server's own timestamp for
   * offline delivery; room messages are stamped on arrival because the
   * protocol sends none.
   */
  timestamp: number;
}

/** A room in the server's list, or one we have joined. */
export interface ChatRoom {
  name: string;

  /** As last reported by the server. */
  userCount: number;

  /** We are in it and receiving messages. */
  joined: boolean;

  /** Owned/members-only room. */
  private: boolean;
}

/** The server's room directory plus whatever we have joined. */
export interface ChatRoomList {
  rooms: ChatRoom[];
}

/** Who is in a room. Emitted on join and as people come and go. */
export interface ChatRoomMembers {
  room: string;

  /** Usernames, unsorted — ordering is the UI's job. */
  users: string[];
}

export interface ChatJoinParams {
  room: string;
}

export interface ChatLeaveParams {
  room: string;
}

export interface ChatSayParams {
  scope: ChatScope;

  /** Room name, or the username for a private message. */
  target: string;
  message: string;
}

/** Open a private conversation without sending anything. */
export interface ChatOpenParams {
  username: string;
}

/**
 * Everything the frontend needs to drive sharing and to render the persistent
 * 'you are not sharing' indicator.
 */
export interface ShareState {
  consent: ShareConsent;
  folders: SharedFolder[];

  /** A rescan is in progress. */
  scanning: boolean;

  /** The share index is built and peers can be served. */
  ready: boolean;

  /** Files indexed. Null before the first scan. */
  fileCount: number | null;

  /** Folders indexed. Null before the first scan. */
  folderCount: number | null;

  /** Bytes indexed. Null before the first scan. */
  totalSize: number | null;

  /** Unix epoch seconds of the last completed scan. */
  lastScanAt: number | null;

  /**
   * Consent was granted after the sidecar started without the shares
   * component. Sharing begins on next launch.
   */
  restartRequired: boolean;
}

/**
 * Set the share configuration. This is the explicit choice — nothing is ever
 * shared without one.
 */
export interface ShareSetParams {
  consent: ShareConsent;

  /**
   * Replaces the current list wholesale. Empty is valid and means 'share
   * nothing'; combined with consent 'granted' it is a contradiction the
   * sidecar rejects.
   */
  folders: SharedFolder[];
}

export interface ShareRescanParams {
  /** Rescan even if upstream believes the index is current. */
  force: boolean | null;
}

export interface PathCheckParams {
  /** A local path, absolute or starting with ~. May not exist. */
  path: string;
}

/**
 * What is actually true of a local path. RAW FACTS ONLY — the sidecar
 * does not decide whether a path is acceptable for a given purpose, and
 * emits no message. Which of these fields matters, and how to word it,
 * is the frontend's call: a download folder must be a writable directory,
 * while a shared folder only has to be readable.
 *
 * Writability is tested by CREATING A FILE and deleting it, not by
 * reading the mode bits. os.access() answers from the permission bits
 * alone and is wrong on exactly the cases that matter here: a read-only
 * mount and a macOS TCC-protected folder both report the user as having
 * write permission, because they do — the refusal comes from the volume
 * and from the sandbox, neither of which is in the mode.
 */
export interface PathCheck {
  /** The path as it was given, unchanged. */
  path: string;

  /**
   * The path after ~ expansion and normalisation. This is what would actually
   * be written to the config.
   */
  resolved: string;

  /** Something is there. */
  exists: boolean;

  /** It exists and is a directory. */
  isDirectory: boolean;

  /**
   * A file could be created inside it. False whenever the path is not an
   * existing directory.
   */
  writable: boolean;

  /** The containing directory exists, so this one could be created. */
  parentExists: boolean;

  /** A directory could be created here. False unless parentExists. */
  parentWritable: boolean;
}

export interface EnsureFolderParams {
  /** The folder to create, including any missing parents. */
  path: string;
}

/**
 * What an existing Nicotine+ installation on this machine offers.
 *
 * This is the PREVIEW half of the import: it reports what WOULD be read
 * so the UI can state it before anything is read for real. It is only
 * ever produced in response to an explicit user action, never on start.
 *
 * Note what is absent: there is no password field, and there never will
 * be. `hasCredentials` says whether one exists; the value itself is
 * copied inside the sidecar and never crosses this socket.
 */
export interface ImportSource {
  /** A readable Nicotine+ config was found. */
  available: boolean;

  /** Where the sidecar looked. */
  configPath: string;

  /** Both a username and a password are present. */
  hasCredentials: boolean;

  /**
   * The Soulseek username, so the UI can name what it is about to import. Null
   * when absent.
   */
  username: string | null;

  /** Shares configured in Nicotine+. */
  folders: SharedFolder[];

  /** Nicotine+'s download folder, if it set one. */
  downloadFolder: string | null;

  /** Why the config could not be read, when it could not be. */
  error: string | null;
}

/**
 * Copy selected settings across. Every field is an explicit opt-in; there is
 * no 'import everything' shorthand on purpose.
 */
export interface ImportApplyParams {
  /** Copy the Soulseek username and password. */
  credentials: boolean;

  /** Copy the shared-folder list. */
  shares: boolean;

  /** Copy the download folder. */
  downloadFolder: boolean;
}

export interface ImportResult {
  importedCredentials: boolean;

  /** How many folders were copied. */
  importedShares: number;
  importedDownloadFolder: boolean;

  /** The username now configured, for confirmation. */
  username: string | null;
}

export interface LogEvent {
  level: LogLevel;
  message: string;

  /** Unix epoch seconds. */
  at: number;
}

/* ------------------------------------------------------------- envelope */

/**
 * A command frame, client -> sidecar. `id` is chosen by the client and echoed
 * back on the reply.
 */
export interface Request<C extends CommandName = CommandName> {
  id: string;
  cmd: C;
  params: CommandParams[C];
}

/** A reply frame, sidecar -> client. Exactly one per Request. */
export type Response<C extends CommandName = CommandName> =
  | { id: string; ok: true; result: CommandResult[C] }
  | { id: string; ok: false; error: ErrorInfo };

/** An unsolicited event frame, sidecar -> client. */
export interface Event<E extends EventName = EventName> {
  ev: E;
  data: EventPayload[E];
}

/** Anything that can arrive from the sidecar. */
export type Frame = Response | Event;

export function isEvent(frame: Frame): frame is Event {
  return (frame as Event).ev !== undefined;
}

/* ------------------------------------------------------- command tables */

export interface CommandParams {
  /** Handshake. Must be the first command. */
  'hello': HelloParams;
  /**
   * Log in to the Soulseek server. Omit the credentials (send null) to use
   * whatever is already stored, which is the path taken after an import.
   */
  'connection.connect': ConnectParams;
  /** Log out. */
  'connection.disconnect': Record<string, never>;
  /** Begin a search. */
  'search.start': SearchStartParams;
  /** Stop accepting results. Emits `search.closed` with reason 'stopped'. */
  'search.stop': SearchStopParams;
  /** Request a peer's full share list. */
  'user.browse': UserBrowseParams;
  /** Request and watch a peer's stats. */
  'user.stats': UserStatsParams;
  /** Queue one file. */
  'transfer.enqueue': TransferEnqueueParams;
  /** Queue a remote folder. */
  'transfer.enqueueFolder': TransferFolderParams;
  /**
   * Pause downloads. DOWNLOADS ONLY — upstream has no paused state for an
   * upload, and a peer waiting on you is not something to quietly park.
   */
  'transfer.pause': TransferIdsParams;
  /** Resume paused downloads. */
  'transfer.resume': TransferIdsParams;
  /**
   * Cancel transfers, either direction. Cancelling an upload tells the peer
   * rather than dropping the connection silently.
   */
  'transfer.cancel': TransferIdsParams;
  /** Retry failed transfers, either direction. */
  'transfer.retry': TransferIdsParams;
  /** Forget downloads entirely (does not delete files). */
  'transfer.clear': TransferIdsParams;
  /** Snapshot of every known transfer, both directions. */
  'transfer.list': Record<string, never>;
  /** Queue a post-download spectral analysis. Returns immediately. */
  'analysis.spectral': SpectralRequestParams;
  /** Ask the server for the room list. Answers on the chat.rooms event. */
  'chat.rooms': Record<string, never>;
  /** Join a room and start receiving its messages. */
  'chat.join': ChatJoinParams;
  /** Leave a room. */
  'chat.leave': ChatLeaveParams;
  /**
   * Send a line to a room or a user. The echo comes back as a chat.message
   * event with outgoing=true, so the UI renders sent and received messages
   * through one path.
   */
  'chat.say': ChatSayParams;
  /** Open a private conversation without sending anything. */
  'chat.open': ChatOpenParams;
  /**
   * Add a query to the wishlist. Upstream re-runs it automatically on the
   * interval the SERVER dictates — we do not poll, and must not.
   */
  'wishlist.add': WishParams;
  /** Drop a query from the wishlist. */
  'wishlist.remove': WishParams;
  /** Current wishlist and interval. */
  'wishlist.list': Record<string, never>;
  /**
   * Ask for a release cover. Replies immediately with a requestId; the image
   * arrives later as `artwork.result` or `artwork.failed`. Never on the
   * critical path — rows render with their placeholder first.
   */
  'artwork.get': ArtworkParams;
  /** Cache size and cap. */
  'artwork.stats': Record<string, never>;
  /** Empty the artwork cache. */
  'artwork.clear': Record<string, never>;
  /**
   * Match a downloaded file against MusicBrainz and report what WOULD change.
   * Reads the file's current tags; writes nothing. Replies with a requestId;
   * the proposal arrives as `metadata.proposal`.
   */
  'metadata.inspect': SpectralRequestParams;
  /** Write tags to a downloaded file. Only the fields supplied are touched. */
  'metadata.apply': MetadataApplyParams;
  /**
   * Move one downloaded file into Artist/Year - Album/ beneath the download
   * folder, using the MusicBrainz match. Never overwrites, never leaves the
   * download folder, and reports where the file went.
   */
  'organise.file': SpectralRequestParams;
  /**
   * Decode a short excerpt of a downloaded file and return it as playable
   * audio. Deliberately an EXCERPT: the brief puts a short preview in scope
   * and a full player out of it, and shipping whole 50 MB FLACs over the
   * socket to play them would be neither.
   */
  'preview.get': PreviewParams;
  /**
   * Seek's own preferences. Distinct from `settings.get`, which is
   * pynicotine's config — these live in Seek's state file because they are not
   * upstream's concern.
   */
  'app.settings.get': Record<string, never>;
  /** Shallow-merge preferences. Only the keys present are changed. */
  'app.settings.patch': AppSettingsPatch;
  /**
   * Per-peer transfer outcomes, accumulated from OUR OWN history. The protocol
   * exposes nothing about how a stranger behaves, so this is the only honest
   * basis for a reliability score.
   */
  'peers.stats': Record<string, never>;
  /** Index size and when it was last built. */
  'library.state': Record<string, never>;
  /**
   * Rebuild the index by walking the download folder and any extra roots. Runs
   * on a worker; progress arrives as `library.state` events.
   */
  'library.scan': LibraryScanParams;
  /** Everything indexed, for the Library screen. */
  'library.releases': Record<string, never>;
  /**
   * Which tracks of an owned release are missing, per MusicBrainz. This is the
   * vision note's 'find albums I do not already have', one release at a time —
   * a whole-collection sweep would be one rate-limited request per release and
   * take hours.
   */
  'library.gaps': ArtworkParams;
  /**
   * Every release and track key you own. Sent once and matched client-side —
   * asking per search result would be thousands of round trips for a
   * set-membership test.
   */
  'library.owned': Record<string, never>;
  /**
   * Ask a provider what a music URL is. Replies immediately with a requestId;
   * the answer arrives as `discover.parsed` or `discover.parseFailed`, because
   * it costs a rate-limited HTTP request and a command handler runs on
   * pynicotine's main thread. Same shape as `artwork.get` for the same reason.
   */
  'discover.parseUrl': DiscoverParseUrlParams;
  /** Every digging session, newest first. */
  'session.list': Record<string, never>;
  /** Start a session explicitly. Entries added while it is active join it. */
  'session.create': SessionCreateParams;
  /** Give a session a name of your own. */
  'session.rename': SessionRenameParams;
  /**
   * Stop a session collecting. Its entries stay in it and stay in the want
   * list; only the grouping of NEW entries is affected.
   */
  'session.close': SessionIdParams;
  /**
   * Forget the session. Its entries are UNLINKED, never deleted — the session
   * is a grouping of things you wanted, not the things themselves.
   */
  'session.delete': SessionIdParams;
  /** Your own Soulseek profile, as peers see it. */
  'profile.get': Record<string, never>;
  /** Change your own profile. */
  'profile.set': ProfileParams;
  /** Who Seek is exchanging data with right now. */
  'connections.get': Record<string, never>;
  /** Transfer counters, session and lifetime. */
  'stats.get': Record<string, never>;
  /** Every watched catalogue, newest first. */
  'labels.list': Record<string, never>;
  /**
   * Watch a label or artist catalogue so it survives the card being dismissed.
   * Idempotent.
   */
  'labels.watch': LabelWatchParams;
  /**
   * Stop watching. Nothing saved FROM the catalogue is touched — the want list
   * and the library are not a function of the watchlist.
   */
  'labels.unwatch': LabelIdParams;
  /** Set the user's own note on a watched catalogue. */
  'labels.note': LabelNoteParams;
  /** Record the counts from a catalogue read, with the time. */
  'labels.seen': LabelSeenParams;
  /** The whole want list. */
  'want.list': Record<string, never>;
  /**
   * Add entries. Every mutation returns the full list, like history and saved
   * searches do — the list is small, and partial patches invite exactly the
   * stale UI this avoids.
   */
  'want.add': WantAddParams;
  /** Drop entries by id. */
  'want.remove': WantRemoveParams;
  /** Change one entry. Returns the full list for the same reason as add. */
  'want.update': WantUpdateParams;
  /**
   * Try to read a tracklist out of a YouTube video's description. Low
   * confidence by design — a DJ set's tracklist is typed by a human into a
   * free-text box, and half of them are not there at all.
   */
  'discover.parseTracklist': DiscoverParseUrlParams;
  /**
   * Identify a local audio file. Replies immediately; the answer arrives as
   * `discover.identified`. Needs the `fpcalc` binary from chromaprint and an
   * AcoustID application key — without either it fails saying which.
   */
  'discover.fingerprint': FingerprintParams;
  /**
   * Read a public YouTube playlist. Replies immediately with a requestId; the
   * contents arrive as discover.playlistItems, because a long playlist costs
   * several rate-limited HTTP requests. Needs a YouTube Data API key in
   * Settings - without one it fails saying so.
   */
  'discover.playlist': PlaylistParams;
  /**
   * Read the signed-in user's Discogs wantlist. Replies immediately with a
   * requestId; the contents arrive as `discover.wantlistItems`, because a long
   * wantlist costs several rate-limited HTTP requests and a command handler
   * runs on pynicotine's main thread. Needs a Discogs token in Settings — the
   * username is resolved from it.
   */
  'discover.wantlist': Record<string, never>;
  /**
   * Find music adjacent to a release. Replies immediately; results arrive as
   * `discover.relatedResults`.
   */
  'discover.related': RelatedParams;
  /**
   * Fetch a whole discography. Replies immediately with a requestId; the
   * catalogue arrives as `discover.catalog`, because it costs several
   * rate-limited requests and a command handler runs on pynicotine's main
   * thread.
   */
  'discover.browse': DiscoverBrowseParams;
  /** Recent searches, newest first. */
  'history.list': Record<string, never>;
  /** Note that a search was run. */
  'history.record': WishParams;
  /** Forget the search history. */
  'history.clear': Record<string, never>;
  /** Saved searches. */
  'saved.list': Record<string, never>;
  /** Save a search, with its filters. */
  'saved.add': SavedParams;
  /** Drop a saved search. */
  'saved.remove': WishParams;
  /** The buddy list. */
  'buddies.list': Record<string, never>;
  /** Add a buddy. */
  'buddies.add': UserBrowseParams;
  /** Remove a buddy. */
  'buddies.remove': UserBrowseParams;
  /** Read the current share configuration. */
  'shares.get': Record<string, never>;
  /** Record the user's sharing choice and folder list. */
  'shares.set': ShareSetParams;
  /** Rebuild the share index. */
  'shares.rescan': ShareRescanParams;
  /**
   * Report what an existing Nicotine+ install offers, WITHOUT importing
   * anything. User-triggered only.
   */
  'import.inspect': Record<string, never>;
  /** Copy selected settings from Nicotine+ into Seek. */
  'import.apply': ImportApplyParams;
  /** Read all settings. */
  'settings.get': Record<string, never>;
  /** Shallow-merge a settings patch. */
  'settings.patch': SettingsPatchParams;
  /**
   * Report what is true of a local path, so the UI can say what is wrong with
   * one BEFORE it is saved. Reads nothing but the path itself.
   */
  'fs.check': PathCheckParams;
  /**
   * Create a folder and any missing parents, then report the result. Succeeds
   * silently if it already exists. Never deletes or overwrites.
   */
  'fs.ensureFolder': EnsureFolderParams;
}

export interface CommandResult {
  'hello': HelloResult;
  'connection.connect': Record<string, never>;
  'connection.disconnect': Record<string, never>;
  'search.start': SearchStartResult;
  'search.stop': Record<string, never>;
  'user.browse': Record<string, never>;
  'user.stats': Record<string, never>;
  'transfer.enqueue': TransferEnqueueResult;
  'transfer.enqueueFolder': TransferFolderResult;
  'transfer.pause': Record<string, never>;
  'transfer.resume': Record<string, never>;
  'transfer.cancel': Record<string, never>;
  'transfer.retry': Record<string, never>;
  'transfer.clear': Record<string, never>;
  'transfer.list': TransferListResult;
  'analysis.spectral': SpectralRequestResult;
  'chat.rooms': Record<string, never>;
  'chat.join': Record<string, never>;
  'chat.leave': Record<string, never>;
  'chat.say': Record<string, never>;
  'chat.open': Record<string, never>;
  'wishlist.add': WishlistState;
  'wishlist.remove': WishlistState;
  'wishlist.list': WishlistState;
  'artwork.get': RequestAccepted;
  'artwork.stats': ArtworkCacheStats;
  'artwork.clear': ArtworkCacheStats;
  'metadata.inspect': RequestAccepted;
  'metadata.apply': MetadataApplyResult;
  'organise.file': OrganiseResult;
  'preview.get': RequestAccepted;
  'app.settings.get': AppSettings;
  'app.settings.patch': AppSettings;
  'peers.stats': PeerHistory;
  'library.state': LibraryState;
  'library.scan': LibraryState;
  'library.releases': LibraryReleases;
  'library.gaps': RequestAccepted;
  'library.owned': LibraryOwned;
  'discover.parseUrl': RequestAccepted;
  'session.list': DigSessionList;
  'session.create': DigSessionList;
  'session.rename': DigSessionList;
  'session.close': DigSessionList;
  'session.delete': DigSessionList;
  'profile.get': Profile;
  'profile.set': Profile;
  'connections.get': ConnectionSnapshot;
  'stats.get': TransferStats;
  'labels.list': WatchedLabelList;
  'labels.watch': WatchedLabelList;
  'labels.unwatch': WatchedLabelList;
  'labels.note': WatchedLabelList;
  'labels.seen': WatchedLabelList;
  'want.list': WantList;
  'want.add': WantList;
  'want.remove': WantList;
  'want.update': WantList;
  'discover.parseTracklist': RequestAccepted;
  'discover.fingerprint': RequestAccepted;
  'discover.playlist': RequestAccepted;
  'discover.wantlist': RequestAccepted;
  'discover.related': RequestAccepted;
  'discover.browse': RequestAccepted;
  'history.list': HistoryState;
  'history.record': HistoryState;
  'history.clear': HistoryState;
  'saved.list': SavedState;
  'saved.add': SavedState;
  'saved.remove': SavedState;
  'buddies.list': BuddyState;
  'buddies.add': BuddyState;
  'buddies.remove': BuddyState;
  'shares.get': ShareState;
  'shares.set': ShareState;
  'shares.rescan': Record<string, never>;
  'import.inspect': ImportSource;
  'import.apply': ImportResult;
  'settings.get': SettingsResult;
  'settings.patch': SettingsResult;
  'fs.check': PathCheck;
  'fs.ensureFolder': PathCheck;
}

export type CommandName = keyof CommandParams;

export const COMMAND_NAMES = [
  'hello',
  'connection.connect',
  'connection.disconnect',
  'search.start',
  'search.stop',
  'user.browse',
  'user.stats',
  'transfer.enqueue',
  'transfer.enqueueFolder',
  'transfer.pause',
  'transfer.resume',
  'transfer.cancel',
  'transfer.retry',
  'transfer.clear',
  'transfer.list',
  'analysis.spectral',
  'chat.rooms',
  'chat.join',
  'chat.leave',
  'chat.say',
  'chat.open',
  'wishlist.add',
  'wishlist.remove',
  'wishlist.list',
  'artwork.get',
  'artwork.stats',
  'artwork.clear',
  'metadata.inspect',
  'metadata.apply',
  'organise.file',
  'preview.get',
  'app.settings.get',
  'app.settings.patch',
  'peers.stats',
  'library.state',
  'library.scan',
  'library.releases',
  'library.gaps',
  'library.owned',
  'discover.parseUrl',
  'session.list',
  'session.create',
  'session.rename',
  'session.close',
  'session.delete',
  'profile.get',
  'profile.set',
  'connections.get',
  'stats.get',
  'labels.list',
  'labels.watch',
  'labels.unwatch',
  'labels.note',
  'labels.seen',
  'want.list',
  'want.add',
  'want.remove',
  'want.update',
  'discover.parseTracklist',
  'discover.fingerprint',
  'discover.playlist',
  'discover.wantlist',
  'discover.related',
  'discover.browse',
  'history.list',
  'history.record',
  'history.clear',
  'saved.list',
  'saved.add',
  'saved.remove',
  'buddies.list',
  'buddies.add',
  'buddies.remove',
  'shares.get',
  'shares.set',
  'shares.rescan',
  'import.inspect',
  'import.apply',
  'settings.get',
  'settings.patch',
  'fs.check',
  'fs.ensureFolder',
] as const satisfies readonly CommandName[];

/* --------------------------------------------------------- event tables */

export interface EventPayload {
  /** Server connection changed. */
  'connection.state': ConnectionState;
  /** Per-second network counters. */
  'connection.stats': ConnectionStats;
  /** A search was accepted and broadcast. */
  'search.started': SearchInfo;
  /** A batch of results from one peer. */
  'search.result': SearchResultEvent;
  /** The sidecar stopped accepting results. */
  'search.closed': SearchClosedEvent;
  /** The search could not be sent. */
  'search.failed': SearchFailedEvent;
  /** A peer's server-side stats changed. */
  'user.stats': PeerStats;
  /** A peer's presence changed. */
  'user.status': UserStatusEvent;
  /** A peer's share list arrived. */
  'user.browse.result': UserBrowseResultEvent;
  /** A share list request failed. */
  'user.browse.failed': UserBrowseFailedEvent;
  /** Remote folder contents arrived. */
  'folder.contents': FolderContentsEvent;
  /** A folder request failed. */
  'folder.contents.failed': FolderContentsFailedEvent;
  /** A transfer entered the list, either direction. */
  'transfer.added': Transfer;
  /**
   * A download changed — progress tick OR state change. Upstream emits one
   * event for both (RECON.md §3); the sidecar throttles progress-only updates
   * but never throttles a state change.
   */
  'transfer.updated': Transfer;
  /** Transfers left the list, either direction. */
  'transfer.removed': TransferRemovedEvent;
  /** Every file in a local folder finished. */
  'folder.finished': FolderFinishedEvent;
  /** A spectral analysis finished. Post-download only. */
  'analysis.result': SpectralAnalysis;
  /** A spectral analysis could not run. */
  'analysis.failed': AnalysisFailedEvent;
  /** A chat line, incoming or echoed. */
  'chat.message': ChatMessage;
  /** The room list changed. */
  'chat.rooms': ChatRoomList;
  /** A room's membership changed. */
  'chat.members': ChatRoomMembers;
  /** Share configuration or scan state changed. */
  'shares.state': ShareState;
  /** The wishlist or its interval changed. */
  'wishlist.state': WishlistState;
  /** The buddy list changed. */
  'buddies.state': BuddyState;
  /** Index changed, or a scan progressed. */
  'library.state': LibraryState;
  /** Preferences changed. */
  'app.settings': AppSettings;
  /** A transfer outcome updated a peer's record. */
  'peers.stats': PeerHistory;
  /** Which tracks of a release are missing. */
  'library.gaps': LibraryGaps;
  /** A decoded excerpt is ready to play. */
  'preview.result': PreviewResult;
  /** The excerpt could not be decoded. */
  'preview.failed': PreviewFailed;
  /** A cover image arrived. */
  'artwork.result': ArtworkResult;
  /** No cover could be found. */
  'artwork.failed': ArtworkFailed;
  /** A MusicBrainz match for a downloaded file. */
  'metadata.proposal': MetadataProposal;
  /** The want list was added to, edited or pruned. */
  'want.changed': WantList;
  /**
   * The set of peers with a transfer active or queued changed. Emitted on
   * CHANGE rather than on the once-a-second tick that detects it — the list is
   * usually identical from one second to the next, and a snapshot nobody asked
   * for is not worth a frame.
   */
  'connections.changed': ConnectionSnapshot;
  /**
   * Transfer counters moved. RATE LIMITED by the sidecar: upstream emits its
   * own `update-stat` once per fragment per transfer, which is several a
   * second with a few downloads running, and a statistics screen has no use
   * for that resolution.
   */
  'stats.changed': TransferStats;
  /** The watched catalogue list changed. */
  'labels.changed': WatchedLabelList;
  /** A digging session was created, renamed, closed or deleted. */
  'session.changed': DigSessionList;
  /** A provider answered about a URL. */
  'discover.parsed': DiscoverParsed;
  /** No provider recognised the URL, or the lookup failed. */
  'discover.parseFailed': DiscoverFailed;
  /** A label's or artist's discography arrived. */
  'discover.catalog': DiscoverCatalog;
  /** A YouTube playlist's contents arrived. */
  'discover.playlistItems': DiscoverPlaylist;
  /** A Discogs wantlist arrived. */
  'discover.wantlistItems': DiscoverWantlist;
  /** An AcoustID match, or the absence of one. */
  'discover.identified': DiscoverIdentified;
  /** Music adjacent to a release. */
  'discover.relatedResults': DiscoverRelated;
  /** Timestamped lines from a video description. */
  'discover.tracklistParsed': DiscoverTracklist;
  /** The discography could not be fetched. */
  'discover.browseFailed': DiscoverFailed;
  /** A forwarded log line. */
  'log': LogEvent;
}

export type EventName = keyof EventPayload;

export const EVENT_NAMES = [
  'connection.state',
  'connection.stats',
  'search.started',
  'search.result',
  'search.closed',
  'search.failed',
  'user.stats',
  'user.status',
  'user.browse.result',
  'user.browse.failed',
  'folder.contents',
  'folder.contents.failed',
  'transfer.added',
  'transfer.updated',
  'transfer.removed',
  'folder.finished',
  'analysis.result',
  'analysis.failed',
  'chat.message',
  'chat.rooms',
  'chat.members',
  'shares.state',
  'wishlist.state',
  'buddies.state',
  'library.state',
  'app.settings',
  'peers.stats',
  'library.gaps',
  'preview.result',
  'preview.failed',
  'artwork.result',
  'artwork.failed',
  'metadata.proposal',
  'want.changed',
  'connections.changed',
  'stats.changed',
  'labels.changed',
  'session.changed',
  'discover.parsed',
  'discover.parseFailed',
  'discover.catalog',
  'discover.playlistItems',
  'discover.wantlistItems',
  'discover.identified',
  'discover.relatedResults',
  'discover.tracklistParsed',
  'discover.browseFailed',
  'log',
] as const satisfies readonly EventName[];

