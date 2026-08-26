/*
 * Seek — the copies of an album, gathered and ranked so the USER can choose.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * THIS FILE USED TO DECIDE. Clicking Get on a release card ranked every other
 * copy in the results, silently downloaded whichever it rated best, and put up
 * a banner afterwards saying what it had done. It was measured doing exactly
 * that: a 9-track copy was clicked and a 13-track copy from a stranger arrived.
 *
 * Iva's instruction ends it — the app must not choose. Get now downloads the
 * copy that was clicked, and nothing else. The ranking below survives, demoted
 * from a decision to an ORDERING: it decides what sits at the top of a
 * comparison the user reads, and every download still comes from a row they
 * clicked themselves.
 *
 * WHY THIS IS ALBUM-LEVEL AND NOT PER-TRACK, which is what the roadmap asked
 * for. Per-track selection needs to recognise the same track across different
 * people's rips, and that was tried and measured against real data three ways:
 *
 *   - keyed on number AND title: 46 picks for a 13-track record, because rips
 *     disagree about numbering and some carry no titles at all;
 *   - keyed on title alone: 146 live, because one real copy names its files
 *     `01.mp3`, `02.mp3`;
 *   - keyed on number with a title veto: 13 against the recorded fixture, but
 *     186 live, because some peers' files parse with the number left inside
 *     the title ("02 Archangel") so nothing matched across peers.
 *
 * Each fix revealed a new filename convention. That measurement still binds the
 * comparison UI: it may show what each peer HAS, file by file and verbatim,
 * because that is a fact off the wire — and it must not claim that one peer's
 * file is the same track as another's, because that is the thing which was
 * wrong three times. The folder is the unit Soulseek gives reliably, so whole
 * copies are what get compared.
 */

import type { Release } from './types.ts';
import { fuzzyKey } from './text.ts';

export interface Choice {
  /** The best-ranked copy. Shown at the top of a comparison, never queued. */
  release: Release;
  /** Every copy considered, best first. */
  candidates: Release[];
}

/**
 * Two folders are the same album when artist and title agree once normalised.
 *
 * Deliberately NOT comparing folder names: `Burial - Untrue (2007) [FLAC]` and
 * `Untrue` are the same record, and the parser has already pulled the artist
 * and title out of both.
 */
export function releaseMatches(a: Release, b: Release): boolean {
  const title = fuzzyKey(a.title);
  if (!title || title !== fuzzyKey(b.title)) return false;
  const left = fuzzyKey(a.artist ?? '');
  const right = fuzzyKey(b.artist ?? '');
  // One side missing an artist is common on Soulseek and is not a mismatch.
  return !left || !right || left === right;
}

/**
 * Rank one copy of a release.
 *
 * COMPLETENESS DOMINATES. A flawless source missing four tracks is not a
 * better copy of the album than a decent one with all thirteen — the folder is
 * the thing being downloaded, and a short folder is the single most common
 * disappointment in a Soulseek download. Below that it defers to the score the
 * app already computes, which folds in quality, free slots, queue length,
 * advertised speed and our own history with the peer.
 *
 * `typicalFiles` is the MEDIAN across copies, never the maximum. Measured
 * live: one "copy" of Untrue carried 26 files — a double-CD folder, or the album
 * plus extras — and against a maximum every genuine 13-track copy scored 50%
 * complete and lost. The median is what a copy of this record normally looks
 * like, and anything at or above it is simply complete.
 */
export function copyScore(release: Release, typicalFiles: number): number {
  const completeness = typicalFiles > 0
    ? Math.min(1, release.trackCount / typicalFiles)
    : 1;
  /* Weighted so that a MISSING THIRD of the record can never be outweighed by
   * being fast, while a single missing track still can — the app score runs
   * 0..1, so four points of completeness puts one absent track (0.31 here)
   * within reach of a much better source and puts four absent tracks well
   * beyond it. */
  return completeness * 4 + release.score;
}

/** What a copy of this record normally looks like. Robust to one odd folder. */
export function medianTrackCount(copies: Release[]): number {
  const counts = copies.map((r) => r.trackCount).sort((a, b) => a - b);
  if (counts.length === 0) return 0;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : Math.round((counts[mid - 1] + counts[mid]) / 2);
}

/** Order copies of one album, most promising first. Never mutates its input. */
export function rankCopies(copies: Release[]): Release[] {
  const typical = medianTrackCount(copies);
  return [...copies].sort((a, b) => copyScore(b, typical) - copyScore(a, typical));
}

/**
 * Bucket every release in the result set into groups of "the same record".
 *
 * Computed ONCE per result set and shared by everything that needs it, so the
 * count on a card ("27 copies") and the list inside the comparison can never
 * disagree in front of the user — `overlap.ts` makes the same call for the same
 * reason. Returns a map from release id to that release's group, best first;
 * every group contains the release itself, so a lone copy maps to `[itself]`.
 *
 * O(n) buckets by title, then resolves artists inside each bucket, where the
 * numbers are tiny. A pairwise `releaseMatches` sweep would be O(n²) per render
 * over a live result list that grows all through a search.
 */
export function groupCopies(releases: Release[]): Map<string, Release[]> {
  const byTitle = new Map<string, Release[]>();
  const seen = new Set<string>();
  for (const r of releases) {
    // Same peer, same folder, twice: one copy, however it reached us.
    const identity = `${r.user} ${r.folderPath}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    /* No usable title means no grouping. An unnamed folder cannot be compared
     * against anything, and guessing which record it is would be the confident
     * wrongness this whole change exists to remove. */
    const key = fuzzyKey(r.title);
    if (!key) continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(r);
    else byTitle.set(key, [r]);
  }

  const out = new Map<string, Release[]>();
  for (const bucket of byTitle.values()) {
    const named = new Map<string, Release[]>();
    const anonymous: Release[] = [];
    for (const r of bucket) {
      const artist = fuzzyKey(r.artist ?? '');
      if (!artist) { anonymous.push(r); continue; }
      const group = named.get(artist);
      if (group) group.push(r);
      else named.set(artist, [r]);
    }

    /* A copy with no artist matches ANY artist pairwise, which is not a
     * transitive relation and so cannot define groups by itself: two different
     * artists sharing a title would be welded into one record by a single
     * artist-less folder sitting between them. Resolved the only honest way —
     * where the bucket names exactly one artist the anonymous copies are that
     * artist's, and where it names several they stand alone, because nothing
     * here says which of them they belong to. */
    if (named.size === 1 && anonymous.length > 0) {
      const only = named.values().next().value as Release[];
      only.push(...anonymous);
      anonymous.length = 0;
    }

    const groups = [...named.values()];
    if (anonymous.length > 0) groups.push(anonymous);
    for (const group of groups) {
      const ranked = rankCopies(group);
      for (const r of ranked) out.set(r.id, ranked);
    }
  }
  return out;
}

/** The copies of this release, best first. Always contains the release itself. */
export function copiesOf(release: Release, groups: Map<string, Release[]>): Release[] {
  return groups.get(release.id) ?? [release];
}

/**
 * How complete the copies on offer are, and — the part that matters — how much
 * of that we actually know.
 *
 * `catalogueTracks` is a real track count from MusicBrainz, via the artwork
 * lookup, and is present only when that lookup matched. It is the ONLY thing
 * here that can prove a copy is short, so `short` is false without it: a spread
 * of track counts across copies says the peers disagree, not that the record is
 * longer than the longest of them. Calling the fullest copy incomplete on the
 * strength of the other copies would be inventing a fact.
 */
export interface Completeness {
  /** Fewest tracks in any copy here. */
  low: number;
  /** Most tracks in any copy here — `fullest`'s count. */
  high: number;
  /** The copy holding `high`. */
  fullest: Release;
  /** MusicBrainz's count for this record, when the lookup matched. */
  catalogue: number | null;
  /** True only when the catalogue count PROVES no copy here is whole. */
  short: boolean;
  /** True when the copies disagree about how long the record is. */
  disagree: boolean;
}

export function completeness(
  copies: Release[],
  catalogueTracks?: number | null,
): Completeness | null {
  if (copies.length === 0) return null;
  let fullest = copies[0];
  let low = copies[0].trackCount;
  for (const r of copies) {
    if (r.trackCount > fullest.trackCount) fullest = r;
    if (r.trackCount < low) low = r.trackCount;
  }
  const catalogue = catalogueTracks && catalogueTracks > 0 ? catalogueTracks : null;
  return {
    low,
    high: fullest.trackCount,
    fullest,
    catalogue,
    short: catalogue !== null && fullest.trackCount < catalogue,
    disagree: low !== fullest.trackCount,
  };
}

/**
 * The best-ranked copy of a release.
 *
 * NOT wired to any download path — see the header. It ranks; the caller shows
 * the ranking; the user picks. Kept because the ordering it defines is the one
 * the comparison presents, and because it is pinned against a real recorded
 * search in `bestSourcesReal.test.ts`.
 */
export function chooseCopy(target: Release, candidates: Release[]): Choice {
  const seen = new Set<string>();
  const copies = candidates
    .filter((r) => r === target || releaseMatches(target, r))
    .filter((r) => {
      const key = `${r.user} ${r.folderPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const ranked = rankCopies(copies);
  return { release: ranked[0] ?? target, candidates: ranked };
}
