/*
 * Seek — saying what a wish is looking for, in a phrase.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A wish runs while nobody is watching, so the one thing the list has to answer
 * at a glance is "what will this accept?". A row of chips would say it more
 * precisely and read more slowly; this is the sentence you would say out loud.
 *
 * Only what is SET appears. An all-defaults filter set is indistinguishable
 * from no filters at all, which is exactly why clearing them removes the record
 * rather than storing an empty one — see `_cmd_wishlist_filters`.
 */

import type { WishFilters } from '../ui/WishlistView.tsx';

function seconds(n: number): string {
  if (n < 60) return `${n}s`;
  const m = Math.round(n / 60);
  return `${m}m`;
}

function bytes(n: number): string {
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

/**
 * Returns an empty string when nothing is set, so callers can test it directly
 * rather than comparing against a placeholder they have to keep in step.
 */
export function describeFilters(f: WishFilters): string {
  const parts: string[] = [];

  if (f.formats.length > 0) parts.push(f.formats.join('/'));
  // Redundant beside an explicit format list, and saying both reads as two
  // conditions where there is one.
  else if (f.losslessOnly) parts.push('lossless');

  if (f.minBitrate !== null) parts.push(`${f.minBitrate}+ kbps`);

  if (f.durationMin !== null && f.durationMax !== null) {
    parts.push(`${seconds(f.durationMin)}–${seconds(f.durationMax)}`);
  } else if (f.durationMin !== null) parts.push(`over ${seconds(f.durationMin)}`);
  else if (f.durationMax !== null) parts.push(`under ${seconds(f.durationMax)}`);

  if (f.sizeMin !== null && f.sizeMax !== null) {
    parts.push(`${bytes(f.sizeMin)}–${bytes(f.sizeMax)}`);
  } else if (f.sizeMin !== null) parts.push(`over ${bytes(f.sizeMin)}`);
  else if (f.sizeMax !== null) parts.push(`under ${bytes(f.sizeMax)}`);

  if (f.excludeTranscodes) parts.push('no transcodes');
  if (f.freeSlotsOnly) parts.push('free slots');
  if (f.minSpeed !== null) parts.push(`${bytes(f.minSpeed)}/s+`);
  if (f.maxQueue !== null) parts.push(`queue under ${f.maxQueue}`);
  if (f.include.trim()) parts.push(`with “${f.include.trim()}”`);
  if (f.exclude.trim()) parts.push(`without “${f.exclude.trim()}”`);

  /* NOT MENTIONED WHEN TRUE. Hiding buddy-only results is the default
     everywhere in Seek, and listing a default alongside choices the user
     actually made would bury them. Its absence is the news. */
  if (!f.hidePrivate) parts.push('buddy-only included');

  return parts.join(' · ');
}
