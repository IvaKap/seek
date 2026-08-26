/*
 * Seek — how much of a peer's collection you already own.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * "This user shares 47 releases you already have" is the strongest signal
 * Soulseek can give you about a stranger. It says their taste overlaps yours
 * where it has been tested, which is a far better reason to browse someone
 * than a fast connection.
 *
 * A COUNT, NOT A PERCENTAGE, and that is deliberate. "12% overlap" needs you to
 * know the denominator to mean anything, and you do not: a 300 GB sharer with
 * 40 records in common is a better lead than a 2 GB sharer with the same 40 out
 * of 45. `DISCOVERY.md` makes the same call and it is right.
 *
 * PERFORMANCE. Naively this is O(library × shares) — a 5,000-release library
 * against a 10,000-file share is 50 million comparisons per peer. The library
 * keys go in a Set, so it is one hash lookup per shared file: O(shares), and
 * measured in single-digit milliseconds for any share a person actually has.
 */

import { releaseKey } from '../data/libraryStore.ts';
import { parsePath } from './parsePath.ts';

export interface Overlap {
  /** Distinct releases the peer shares that are already on your disk. */
  count: number;
  /** A few of them, for saying WHICH — a number alone invites disbelief. */
  examples: string[];
}

const EXAMPLES = 3;

/**
 * Count the releases a peer shares that you already own.
 *
 * `owned` is the library's release keys. Paths are parsed with the same parser
 * the search list uses, so "already own" means the same thing on both screens —
 * a second notion of sameness here would let the two disagree in front of the
 * user.
 */
export function overlapWith(paths: string[], owned: Set<string>): Overlap {
  if (owned.size === 0 || paths.length === 0) return { count: 0, examples: [] };

  const seen = new Set<string>();
  const examples: string[] = [];

  for (const path of paths) {
    const parsed = parsePath(path);
    const artist = parsed.artist?.value ?? null;
    const release = parsed.release?.value ?? '';
    if (!release) continue;

    const key = releaseKey(artist, release);
    // Distinct RELEASES, not files: a 12-track album you own is one thing in
    // common, not twelve.
    if (seen.has(key) || !owned.has(key)) continue;
    seen.add(key);
    if (examples.length < EXAMPLES) {
      examples.push(artist ? `${artist} — ${release}` : release);
    }
  }

  return { count: seen.size, examples };
}

/**
 * Worth interrupting the user about?
 *
 * A callout for two records in common is noise — most peers on Soulseek share
 * something you have. The threshold is high enough that seeing it means
 * something, which is what keeps it worth reading the tenth time.
 */
export const NOTABLE_OVERLAP = 8;
