/*
 * Seek — telling a wish's new results from the ones it has shown you before.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * THE PROBLEM THIS SOLVES. Upstream keeps ONE token per wish and re-runs it on
 * the server's interval, forever. The same peers holding the same files come
 * back on every run, so a badge that fires on "this wish found something" fires
 * on identical news every twelve minutes. After a day of that it is furniture,
 * and the one time it means something you will not look.
 *
 * So a wish's results are split: what is NEW since you last looked, and what
 * you have already been shown. The badge counts only the first.
 *
 * WHY THE SPLIT IS FROZEN AT INGEST. It is computed once, when the results
 * arrive, against the seen-set as it stood then — never re-derived at render.
 * Marking results seen is what OPENING a wish does, so a split recomputed on
 * every render would empty itself the instant you looked at it. What you were
 * shown must stay what you were shown until the next run replaces it.
 *
 * The sidecar stores the set and does nothing else with it: deciding what is
 * new is a dedup, and dedup is TypeScript's (AGENTS.md §"The seam").
 */

import type { SourceFile } from './types.ts';

/**
 * A short opaque handle for one result.
 *
 * `SourceFile.id` is `${user} ${path}` — already stable and content-derived,
 * so it is the right thing to identify. It is also a full remote path, and a
 * few hundred of those per wish is a large thing to keep in a state file, to
 * send over the socket, and — since it is a list of who has what — to keep at
 * all. 48 bits is ample: at the sidecar's cap of 250 per wish the chance of a
 * collision hiding one new result is about one in ten billion.
 *
 * Two different mixers rather than one run twice with a different seed, so the
 * halves do not share a weakness.
 */
export function seenId(source: Pick<SourceFile, 'id'>): string {
  const text = source.id;

  // FNV-1a, 32-bit. Math.imul keeps the multiply in 32 bits.
  let a = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
  }

  // djb2 — a different shape entirely: shift-and-add rather than xor-multiply.
  let b = 5381;
  for (let i = 0; i < text.length; i++) {
    b = (Math.imul(b, 33) + text.charCodeAt(i)) | 0;
  }

  return ((a >>> 0).toString(16).padStart(8, '0')
    + (b >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}

export interface WishSplit {
  /** Not shown by any previous run. The only thing worth announcing. */
  fresh: SourceFile[];
  /** How many of this run's results you have already been shown. */
  seenCount: number;
}

/**
 * Split one run's results against what has already been seen.
 *
 * Order is preserved: `fresh` stays in the order the sources arrived, so the
 * ranking the grouper produced survives.
 */
export function splitSeen(sources: SourceFile[], seen: ReadonlySet<string>): WishSplit {
  const fresh: SourceFile[] = [];
  let seenCount = 0;
  for (const s of sources) {
    if (seen.has(seenId(s))) seenCount += 1;
    else fresh.push(s);
  }
  return { fresh, seenCount };
}

/** Every id in a run, for handing to the sidecar when the wish is opened. */
export function idsOf(sources: SourceFile[]): string[] {
  return sources.map(seenId);
}
