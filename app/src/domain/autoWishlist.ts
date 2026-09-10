/*
 * Seek — choosing what an auto-download wish should grab.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * PURE, and deliberately so. The controller (data/autoDownloads.ts) decides
 * WHEN to run this and what to do with the answer; this file only answers one
 * question with no side effects: given everything a wish has found and the
 * filters it is judged by, which single file — if any — should be downloaded?
 *
 * It reuses `group.matches`, the exact predicate the manual search and the
 * wishlist view already filter with, rather than a second copy of the quality
 * rules. That matters most for the trap the request walks straight into: a
 * "minimum bitrate" gate must not reject FLAC, which advertises no bitrate.
 * `matches` already gets that right (RECON.md §4), so borrowing it means the
 * automatic path and the manual path can never disagree about what qualifies.
 *
 * The gate runs on SELF-REPORTED attributes — all that exists before the file
 * is on disk. That is exactly why the pipeline then decodes and analyses the
 * file and hands it to a person: the spectrogram is the check the peer cannot
 * fake, and it is the human's to read, never an automatic accept.
 */

import { matches, terms } from './group.ts';
import { EMPTY_FILTERS } from './types.ts';
import type { Filters, SourceFile, WishFilters } from './types.ts';

/**
 * Turn a wish's stored filters (arrays and strings, as they travel on the wire)
 * into the runtime `Filters` `matches` expects (a format Set). A wish with no
 * filters of its own is judged by the defaults — which accept anything except
 * buddy-only results, the one thing that cannot be downloaded at all.
 */
export function toFilters(w: WishFilters | null): Filters {
  if (!w) return EMPTY_FILTERS;
  return {
    formats: new Set(w.formats),
    losslessOnly: w.losslessOnly,
    minBitrate: w.minBitrate,
    durationMin: w.durationMin,
    durationMax: w.durationMax,
    sizeMin: w.sizeMin,
    sizeMax: w.sizeMax,
    excludeTranscodes: w.excludeTranscodes,
    freeSlotsOnly: w.freeSlotsOnly,
    minSpeed: w.minSpeed,
    maxQueue: w.maxQueue,
    include: w.include,
    exclude: w.exclude,
    hidePrivate: w.hidePrivate,
  };
}

/**
 * The best qualifying file for a wish, or null if nothing it found passes.
 * "Best" is `SourceFile.score` — the same combined ranking the search sorts by,
 * so the automatic pick is the one a person scanning the list would reach for.
 */
export function pickAutoCandidate(
  sources: SourceFile[],
  filters: WishFilters | null,
): SourceFile | null {
  const f = toFilters(filters);
  const include = terms(f.include);
  const exclude = terms(f.exclude);
  let best: SourceFile | null = null;
  for (const s of sources) {
    if (!matches(s, f, include, exclude)) continue;
    if (!best || s.score > best.score) best = s;
  }
  return best;
}
