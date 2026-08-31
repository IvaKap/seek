/*
 * Seek — grouping, dedupe and the stable identities the list animation depends on.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is an INCREMENTAL index, not a pure function, and that is deliberate.
 * The brief requires stable, content-derived keys and forbids index keys,
 * because results stream in for thirty seconds while the user scrolls. If
 * cluster identity were recomputed from scratch each tick, a row's key could
 * change when a new source joined it — React would unmount and remount, and the
 * user would see a flash in the middle of a list they were reading.
 *
 * So identity is ASSIGNED ONCE, on first sight, and never revised:
 *   - a release is `(user, parent folder)` — inherently stable
 *   - a user group is the username — inherently stable
 *   - a track cluster is `(fuzzy artist, fuzzy title)` plus the duration of the
 *     FIRST source that created it. Later sources within ±2s join it; the
 *     anchor never moves.
 */

import type {
  Filters, FormatTier, Release, SourceFile, TrackCluster, UserGroup,
} from './types.ts';
import { TIER_RANK, bestTier } from './quality.ts';

/** The brief's tolerance for "the same track from a different rip". */
const DURATION_TOLERANCE = 2;

/*
 * One collator, reused. `String.prototype.localeCompare(a, undefined, opts)`
 * constructs a fresh Intl.Collator on every single call, which dominated the
 * cost of building releases: 17.4ms for 5,000 files, over the 16ms budget for
 * one derivation. Hoisting it takes the same work to ~4ms.
 */
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

interface ClusterState {
  id: string;
  key: string;
  /** Duration of the source that created this cluster. Never revised. */
  anchor: number | null;
  sources: SourceFile[];
  tick: number;
}

interface ReleaseState {
  id: string;
  user: string;
  folder: string;
  folderPath: string;
  sources: SourceFile[];
  tick: number;
}

export interface Grouper {
  add(source: SourceFile): void;
  readonly all: SourceFile[];
  size(): number;
  tracks(sources: SourceFile[]): TrackCluster[];
  releases(sources: SourceFile[]): Release[];
  users(sources: SourceFile[]): UserGroup[];
  reset(): void;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function createGrouper(): Grouper {
  let all: SourceFile[] = [];
  /** fuzzy key → the clusters that exist under it. */
  const buckets = new Map<string, ClusterState[]>();
  /** source id → cluster id. The assignment, made once. */
  const clusterOf = new Map<string, string>();
  const releaseOf = new Map<string, ReleaseState>();
  let seq = 0;

  function assignCluster(s: SourceFile): string {
    const existing = clusterOf.get(s.id);
    if (existing) return existing;

    let bucket = buckets.get(s.clusterKey);
    if (!bucket) {
      bucket = [];
      buckets.set(s.clusterKey, bucket);
    }

    let target = bucket.find((c) => {
      if (s.duration === null || c.anchor === null) return true;
      return Math.abs(s.duration - c.anchor) <= DURATION_TOLERANCE;
    });

    if (!target) {
      target = {
        id: `c${seq++}`,
        key: s.clusterKey,
        anchor: s.duration,
        sources: [],
        tick: s.tick,
      };
      bucket.push(target);
    }
    target.sources.push(s);
    clusterOf.set(s.id, target.id);
    return target.id;
  }

  function add(s: SourceFile): void {
    all.push(s);
    assignCluster(s);
    let rel = releaseOf.get(s.releaseKey);
    if (!rel) {
      rel = {
        id: `r${seq++}`,
        user: s.user,
        folder: s.parsed.folder,
        folderPath: s.parsed.folderPath,
        sources: [],
        tick: s.tick,
      };
      releaseOf.set(s.releaseKey, rel);
    }
    rel.sources.push(s);
  }

  /* --------------------------------------------------------------- views */

  function tracks(sources: SourceFile[]): TrackCluster[] {
    const byCluster = new Map<string, SourceFile[]>();
    for (const s of sources) {
      const id = clusterOf.get(s.id);
      if (!id) continue;
      const arr = byCluster.get(id);
      if (arr) arr.push(s);
      else byCluster.set(id, [s]);
    }

    const out: TrackCluster[] = [];
    for (const [id, srcs] of byCluster) {
      // Sources are ranked by score; the collapsed row shows the best one.
      srcs.sort((a, b) => b.score - a.score);
      const best = srcs[0];
      let top: FormatTier = 'unknown';
      let tick = Infinity;
      for (const s of srcs) {
        top = bestTier(top, s.quality.tier);
        if (s.tick < tick) tick = s.tick;
      }
      const durations = srcs.map((s) => s.duration).filter((d): d is number => d !== null);
      out.push({
        id,
        displayArtist: best.parsed.displayArtist,
        displayTitle: best.parsed.displayTitle,
        fallback: best.parsed.fallback,
        duration: median(durations),
        sources: srcs,
        best,
        topTier: top,
        tick: tick === Infinity ? best.tick : tick,
      });
    }
    return out;
  }

  function releases(sources: SourceFile[]): Release[] {
    const byRelease = new Map<string, SourceFile[]>();
    for (const s of sources) {
      const arr = byRelease.get(s.releaseKey);
      if (arr) arr.push(s);
      else byRelease.set(s.releaseKey, [s]);
    }

    const out: Release[] = [];
    for (const [key, srcs] of byRelease) {
      const state = releaseOf.get(key);
      if (!state) continue;

      // Track order inside a folder is the folder's own order, not a ranking.
      srcs.sort((a, b) => {
        const at = a.parsed.trackNumber?.value ?? Number.MAX_SAFE_INTEGER;
        const bt = b.parsed.trackNumber?.value ?? Number.MAX_SAFE_INTEGER;
        if (at !== bt) return at - bt;
        return NATURAL.compare(a.parsed.filename, b.parsed.filename);
      });

      const counts = new Map<string, number>();
      let totalSize = 0;
      let dominantTier: FormatTier = 'unknown';
      let suspectCount = 0;
      let scoreSum = 0;
      for (const s of srcs) {
        totalSize += s.size;
        counts.set(s.quality.label, (counts.get(s.quality.label) ?? 0) + 1);
        dominantTier = bestTier(dominantTier, s.quality.tier);
        if (s.transcode.suspect) suspectCount++;
        scoreSum += s.score;
      }
      let dominantLabel = '—';
      let bestCount = -1;
      for (const [label, n] of counts) {
        if (n > bestCount) {
          bestCount = n;
          dominantLabel = label;
        }
      }

      const head = srcs[0];
      out.push({
        id: state.id,
        user: state.user,
        folder: state.folder,
        folderPath: state.folderPath,
        artist: head.parsed.release ? (head.parsed.artist?.value ?? null) : head.parsed.artist?.value ?? null,
        title: head.parsed.release?.value ?? state.folder ?? head.parsed.folder,
        year: head.parsed.year?.value ?? null,
        catalogue: head.parsed.catalogue?.value ?? null,
        files: srcs,
        totalSize,
        trackCount: srcs.length,
        dominantTier,
        dominantLabel,
        suspectCount,
        peer: head.peer,
        score: scoreSum / srcs.length,
        tick: state.tick,
      });
    }
    return out;
  }

  function users(sources: SourceFile[]): UserGroup[] {
    const byUser = new Map<string, SourceFile[]>();
    for (const s of sources) {
      const arr = byUser.get(s.user);
      if (arr) arr.push(s);
      else byUser.set(s.user, [s]);
    }

    const out: UserGroup[] = [];
    for (const [user, srcs] of byUser) {
      const rels = releases(srcs);
      rels.sort((a, b) => b.score - a.score);
      let totalSize = 0;
      let top: FormatTier = 'unknown';
      let scoreSum = 0;
      let tick = Infinity;
      for (const s of srcs) {
        totalSize += s.size;
        top = bestTier(top, s.quality.tier);
        scoreSum += s.score;
        if (s.tick < tick) tick = s.tick;
      }
      out.push({
        id: `u:${user}`,
        user,
        peer: srcs[0].peer,
        files: srcs,
        releases: rels,
        totalSize,
        bestTier: top,
        score: scoreSum / srcs.length,
        tick: tick === Infinity ? 0 : tick,
      });
    }
    return out;
  }

  function reset(): void {
    all = [];
    buckets.clear();
    clusterOf.clear();
    releaseOf.clear();
    seq = 0;
  }

  return {
    add,
    get all() {
      return all;
    },
    size: () => all.length,
    tracks,
    releases,
    users,
    reset,
  };
}

/* ------------------------------------------------------------------ filter */

/**
 * Runs over pre-indexed fields only — no parsing, no string building, no
 * allocation. This is the function that has to stay under 16ms for 5,000 rows.
 */
export function matches(s: SourceFile, f: Filters, include: string[], exclude: string[]): boolean {
  // First because it is the cheapest test and the most decisive: a buddy-only
  // result is not a worse result, it is one that cannot be downloaded at all.
  if (f.hidePrivate && s.private) return false;
  if (f.losslessOnly && !s.quality.lossless) return false;
  if (f.formats.size > 0 && !f.formats.has(s.quality.label)) return false;
  if (f.excludeTranscodes && s.transcode.suspect) return false;
  if (f.freeSlotsOnly && !s.peer.freeSlots) return false;

  if (f.minBitrate !== null) {
    // Lossless files advertise no bitrate; they satisfy any bitrate floor by
    // definition rather than being excluded for a field they cannot have.
    if (!s.quality.lossless && (s.bitrate ?? 0) < f.minBitrate) return false;
  }
  if (f.durationMin !== null && (s.duration ?? 0) < f.durationMin) return false;
  if (f.durationMax !== null && (s.duration ?? Number.MAX_SAFE_INTEGER) > f.durationMax) return false;
  if (f.sizeMin !== null && s.size < f.sizeMin) return false;
  if (f.sizeMax !== null && s.size > f.sizeMax) return false;
  if (f.minSpeed !== null && s.peer.advertisedSpeed < f.minSpeed) return false;
  if (f.maxQueue !== null && s.peer.queueLength > f.maxQueue) return false;

  for (let i = 0; i < include.length; i++) if (!s.needle.includes(include[i])) return false;
  for (let i = 0; i < exclude.length; i++) if (s.needle.includes(exclude[i])) return false;

  return true;
}

/** Split the text filters once per filter change, not once per row. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export { TIER_RANK };
