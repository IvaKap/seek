/*
 * Seek — domain types.
 * Copyright (C) 2026 Seek contributors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is the VIEW MODEL layer (see AGENTS.md §"The seam"). It is derived
 * entirely in TypeScript. `shared/protocol.ts` (owned by the core agent) is the
 * WIRE schema; `data/adapt.ts` is the only thing allowed to know both.
 *
 * The wire surface is deliberately reflected here because it is small and real:
 * Soulseek gives you username, path, size, and — for audio — bitrate, duration,
 * sample rate, bit depth and a VBR flag. Nothing else. Verified against
 * upstream/pynicotine/slskmessages.py: `FileAttribute` (BITRATE=0, LENGTH=1,
 * VBR=2, ENCODER=3, SAMPLE_RATE=4, BIT_DEPTH=5) and `FileSearchResponse`
 * (search_username, token, list, freeulslots, ulspeed, inqueue).
 */

/** A single field recovered from a path, with how much we trust it. */
export interface Field<T> {
  value: T;
  /** 0..1. Below `CONFIDENCE_FLOOR` the UI must show raw text instead. */
  confidence: number;
  /** Which part of the path this came from — shown in the parse tooltip. */
  from: 'file' | 'folder' | 'parent' | 'tag';
}

/** Everything `parsePath` can recover. Every field is independently optional. */
export interface ParsedPath {
  /** The path exactly as the peer sent it. Never modified. */
  raw: string;
  /** Last segment, with extension. */
  filename: string;
  /** Last segment, without extension. */
  stem: string;
  /** Lowercased, no dot. `null` when the filename has no extension. */
  extension: string | null;
  /** Parent folder segment (the release folder candidate). */
  folder: string;
  /** Everything up to and including the parent folder — the release group key. */
  folderPath: string;

  artist: Field<string> | null;
  title: Field<string> | null;
  release: Field<string> | null;
  year: Field<number> | null;
  trackNumber: Field<number> | null;
  discNumber: Field<number> | null;
  catalogue: Field<string> | null;
  /** Vinyl side/position, e.g. "A1", "B2". Very common on electronic releases. */
  vinylPosition: Field<string> | null;
  /** Format claimed by a folder tag like `[FLAC]` / `[V0]`. A claim, not a fact. */
  formatHint: Field<string> | null;
  /** Remix / edit / version qualifier lifted out of the title, kept verbatim. */
  version: string | null;
  /** True when the folder looks like a compilation (VA / Various Artists). */
  compilation: boolean;

  /** Weighted overall trust, 0..1. */
  confidence: number;
  /**
   * True when we could not recover a title we trust. The UI MUST then render
   * `displayTitle` (the raw filename) and mark it as unparsed. Never invent.
   */
  fallback: boolean;
  /** What to render on the primary line. Either the parsed title or the raw filename. */
  displayTitle: string;
  /** What to render before it, if anything. */
  displayArtist: string | null;
}

/** Broad format bucket. Drives the badge, and the badge is the only colour in a row. */
export type FormatTier = 'lossless' | 'high' | 'medium' | 'low' | 'unknown';

export interface Quality {
  tier: FormatTier;
  /** 0..100. Ranking is FLAC/WAV/AIFF > 320 CBR > V0 VBR > 256 > 192 > below. */
  score: number;
  /** Short badge text: "FLAC", "320", "V0", "192"… */
  label: string;
  /** Long form for screen readers and tooltips. */
  description: string;
  lossless: boolean;
}

/**
 * Four states, not two. Per RECON.md §4, Soulseek sends two DISJOINT attribute
 * sets — lossless files carry duration/sampleRate/bitDepth and NO bitrate;
 * lossy files carry bitrate/duration/vbr and NO sampleRate/bitDepth — and any
 * of them may be absent entirely. So:
 *
 *  - `contradicted`      lossy file whose bytes are materially below its own
 *                        advertised bitrate. The claim is refuted. High confidence.
 *  - `inferred-transcode` lossless file whose bytes imply an impossible
 *                        compression ratio. Nothing was claimed to contradict,
 *                        so this is inference. Lower confidence, flagged quieter.
 *  - `unchecked`         no duration (or no attributes at all) — verification is
 *                        impossible. MUST NOT be rendered as if it were clean.
 *  - `ok`                the check ran and the file passed.
 */
export type TranscodeVerdict = 'ok' | 'unchecked' | 'inferred-transcode' | 'contradicted';

export interface TranscodeCheck {
  verdict: TranscodeVerdict;
  /** Convenience: `contradicted` or `inferred-transcode`. */
  suspect: boolean;
  /** False only for `unchecked`. Drives the fourth badge state. */
  checked: boolean;
  /** Bitrate the file size actually implies, kbps. `null` when unknowable. */
  impliedKbps: number | null;
  /** What it was measured against: advertised kbps (lossy) or uncompressed PCM (lossless). */
  referenceKbps: number | null;
  ratio: number | null;
  confidence: 'high' | 'moderate' | 'none';
  /** One line, used as the accessible label. */
  headline: string;
  /** The full arithmetic, for the tooltip. Never a bare "suspicious". */
  explanation: string;
}

/** Per-peer facts that arrive with every search response. */
export interface PeerStats {
  username: string;
  /** `freeulslots` — peer has an upload slot free right now. */
  freeSlots: boolean;
  /** `ulspeed` — the peer's *advertised* average upload speed, bytes/sec. A promise. */
  advertisedSpeed: number;
  /** `inqueue` — how many files are queued ahead of you. */
  queueLength: number;
  /**
   * Our own historical success rate with this peer, 0..1, Laplace-smoothed.
   * Persisted (SQLite, Tauri side) in a later phase; mocked here.
   */
  reliability: number;
  /** Number of (successful, failed) transfers behind `reliability`. */
  history?: { ok: number; failed: number };
  /**
   * Two-letter country code, resolved by the sidecar from the address the
   * search response arrived on. NULL FOR A GREAT MANY PEERS and that is
   * ordinary, not an error — anyone on a private address has none. A flag must
   * never be guessed from anything else.
   */
  country: string | null;
}

/** One file from one peer — the atom of everything else. */
export interface SourceFile {
  /** Content-derived stable key: `${user}\0${path}`. Never an array index. */
  id: string;
  user: string;
  path: string;
  size: number;
  /* Every attribute below is genuinely nullable. Lossless files carry no
   * bitrate and no vbr flag; lossy files carry no sampleRate and no bitDepth;
   * older clients send none of it. See RECON.md §4. */
  bitrate: number | null;
  /** Seconds. */
  duration: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  vbr: boolean | null;

  /**
   * True when the peer returned this in their BUDDY-ONLY share list rather
   * than their public one.
   *
   * It is not a label on the file, it is a prediction about the download:
   * their client checks `buddy_files` only if you are in their buddy list
   * (upstream shares.py `file_is_shared`), so if you are not, every request
   * for this file is refused with "File not shared." — which Seek renders as
   * "They are no longer sharing this file", the least informative thing it
   * could possibly say about a file they never offered you.
   */
  private: boolean;

  parsed: ParsedPath;
  quality: Quality;
  /** Never null — `unchecked` is a real verdict, not an absence. */
  transcode: TranscodeCheck;
  peer: PeerStats;
  /** Combined source score, 0..1. Default sort is this, descending. */
  score: number;
  /** Which ingest tick this arrived in. Drives group-level enter animation. */
  tick: number;

  /* ---- pre-indexed filter fields, computed once on ingest ---- */
  /** Lowercased filename, for the include/exclude text filter. */
  needle: string;
  releaseKey: string;
  clusterKey: string;
}

/** A unique track, with every peer that has it, ranked. */
export interface TrackCluster {
  id: string;
  displayArtist: string | null;
  displayTitle: string;
  fallback: boolean;
  /** Median duration across sources, seconds. */
  duration: number | null;
  sources: SourceFile[];
  /** The best source by `score`. Drives the collapsed row. */
  best: SourceFile;
  /** Best quality present anywhere in the cluster (may not be `best`). */
  topTier: FormatTier;
  tick: number;
}

/** One peer's one folder — the unit a DJ actually downloads. */
export interface Release {
  id: string;
  user: string;
  folder: string;
  folderPath: string;
  artist: string | null;
  title: string;
  year: number | null;
  catalogue: string | null;
  files: SourceFile[];
  totalSize: number;
  trackCount: number;
  dominantTier: FormatTier;
  dominantLabel: string;
  /** Any file in the folder failing the physics check. */
  suspectCount: number;
  peer: PeerStats;
  score: number;
  tick: number;
}

/** Everything one peer returned, for the "this person has great taste" mode. */
export interface UserGroup {
  id: string;
  user: string;
  peer: PeerStats;
  files: SourceFile[];
  releases: Release[];
  totalSize: number;
  bestTier: FormatTier;
  score: number;
  tick: number;
}

/**
 * `'file'` is the classic Nicotine+ flat list — one row per file, no grouping.
 * `'version'` is one row per version of a track (same format, same size, from
 * however many people) and per record in one format: Simple's only list.
 * `'user'` is retired from the picker (see GROUPS in SearchView) but kept in the
 * type: a saved tab may still carry it, and the store's derive/rowValue keep the
 * branch so restoring such a tab does not crash.
 */
export type GroupBy = 'track' | 'release' | 'version' | 'file' | 'user';
export type SortKey = 'best' | 'quality' | 'speed' | 'queue' | 'size' | 'name';

export interface Filters {
  /** Empty set = no format constraint. */
  formats: Set<string>;
  losslessOnly: boolean;
  minBitrate: number | null;
  durationMin: number | null;
  durationMax: number | null;
  sizeMin: number | null;
  sizeMax: number | null;
  excludeTranscodes: boolean;
  freeSlotsOnly: boolean;
  minSpeed: number | null;
  maxQueue: number | null;
  include: string;
  exclude: string;
  /**
   * ON by default, unlike every other filter here.
   *
   * A buddy-only result you are not a buddy for cannot be downloaded — it is
   * not a long shot, it is a guaranteed refusal — so showing it unmarked is
   * offering something that does not exist. Nicotine+ reached the same
   * conclusion and hides them by default as of 3.3.5.
   *
   * It stays a toggle rather than a hard rule because the results are real for
   * anyone who IS on that peer's buddy list.
   */
  hidePrivate: boolean;
}

export const EMPTY_FILTERS: Filters = {
  formats: new Set(),
  losslessOnly: false,
  minBitrate: null,
  durationMin: null,
  durationMax: null,
  sizeMin: null,
  sizeMax: null,
  excludeTranscodes: false,
  freeSlotsOnly: false,
  minSpeed: null,
  maxQueue: null,
  include: '',
  exclude: '',
  hidePrivate: true,
};

/* Filters contain a Set, which JSON cannot carry. These two are the only places
 * that know that, so the shape stays in one file. */
export function serialiseFilters(f: Filters): string {
  return JSON.stringify({ ...f, formats: [...f.formats] });
}

export function deserialiseFilters(json: string): Filters {
  if (!json) return EMPTY_FILTERS;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      ...EMPTY_FILTERS,
      ...raw,
      formats: new Set(Array.isArray(raw.formats) ? (raw.formats as string[]) : []),
    };
  } catch {
    // A corrupt saved filter should not take the screen down with it.
    return EMPTY_FILTERS;
  }
}

/**
 * A wish's stored filters. Identical to `Filters` field for field, EXCEPT
 * `formats` is an array rather than a Set — this is the shape that travels on
 * the wire (`WishFilters` in shared/schema.py) and sits in seek-state.json,
 * where a Set does not serialise. `autoWishlist.toFilters` converts it to the
 * runtime `Filters` when a wish is actually judged.
 */
export interface WishFilters {
  formats: string[];
  losslessOnly: boolean;
  minBitrate: number | null;
  durationMin: number | null;
  durationMax: number | null;
  sizeMin: number | null;
  sizeMax: number | null;
  excludeTranscodes: boolean;
  freeSlotsOnly: boolean;
  minSpeed: number | null;
  maxQueue: number | null;
  include: string;
  exclude: string;
  hidePrivate: boolean;
}

export function filtersActive(f: Filters): boolean {
  return (
    f.formats.size > 0 ||
    f.losslessOnly ||
    f.minBitrate !== null ||
    f.durationMin !== null ||
    f.durationMax !== null ||
    f.sizeMin !== null ||
    f.sizeMax !== null ||
    f.excludeTranscodes ||
    f.freeSlotsOnly ||
    f.minSpeed !== null ||
    f.maxQueue !== null ||
    f.include.trim() !== '' ||
    f.exclude.trim() !== '' ||
    // Inverted, because this one defaults to ON: it is SHOWING private results
    // that is the departure from the default, and Clear should put them back.
    !f.hidePrivate
  );
}

/* ---------------------------------------------------------------- wire-ish */

/**
 * Shape the mock sidecar emits. Deliberately raw and unformatted, and shaped to
 * RECON.md §4 rather than to the brief — the brief was wrong about attributes.
 *
 * Notes that cost real money to get wrong:
 *  - There is no `ext` on the wire. Upstream parses the extension field and
 *    throws it away, so it is ALWAYS null. Derive the format from the filename.
 *  - Every attribute is `| null`. The sidecar computes nothing.
 *  - `ulspeed` is the peer's own claim about itself, not a measurement.
 */
export interface WireFile {
  /** Full virtual path, backslash-separated. */
  path: string;
  size: number;
  bitrate: number | null;
  /** Seconds. */
  duration: number | null;
  isVbr: boolean | null;
  sampleRate: number | null;
  bitDepth: number | null;
}

export interface WireSearchResult {
  type: 'search.result';
  searchId: string;
  /** The connection-authenticated peer name, never the self-reported one. */
  user: string;
  files: WireFile[];
  userStats: {
    freeSlots: boolean;
    /** Bytes/sec, advertised by the peer. A claim. */
    advertisedSpeed: number;
    queueLength: number;
  };
}
