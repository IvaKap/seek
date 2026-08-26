/*
 * Seek — turning a YouTube playlist into things to look for on Soulseek.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar hands over raw facts — title, uploader, position — and every
 * derivation happens here, on the TypeScript side of the seam. `parseTitle`
 * already does the hard part; this adds the one correction that only a
 * PLAYLIST can make safely, and drops the entries that are not music.
 */

import { parseTitle, TITLE_CONFIDENCE_FLOOR } from './parseTitle.ts';
import type { DiscoverPlaylistItem } from '../../../shared/protocol.ts';

export interface PlaylistEntry {
  /** The video id, so an import can be de-duplicated against itself. */
  videoId: string;
  /** The title exactly as YouTube stated it. Never modified. */
  raw: string;
  /** Empty when no artist could be recovered — never a guess. */
  artist: string;
  title: string;
  /** 0..1, from `parseTitle`. Below the floor the UI should show `raw`. */
  confidence: number;
  /** What a want list row would search for. */
  query: string;
}

/**
 * Strip a track number that `parseTitle` mistook for part of the artist.
 *
 * Measured on a real playlist: `Burial 01, Untitled` parses to
 * artist `Burial 01`, and at 0.55 that sits ABOVE the confidence floor, so it
 * would be presented as trustworthy while being wrong.
 *
 * The naive fix — strip trailing digits from any artist — is worse than the
 * bug: `Front 242`, `Model 500` and `Unit 4` are real artists, and this would
 * quietly rename them. So the number is only removed when the playlist itself
 * corroborates it: the trailing digits must match this entry's own position in
 * the playlist. `Burial 01` at position 0 is track 1, so `01` is an index and
 * goes; `Front 242` at position 5 keeps its name, because 242 is not 6.
 */
export function stripPositionalTrackNumber(artist: string, position: number): string {
  const match = /^(.*?)[\s.\-–]+(\d{1,3})$/.exec(artist.trim());
  if (!match) return artist;
  const [, name, digits] = match;
  if (!name.trim()) return artist;
  // position is 0-based; a track number is 1-based.
  return Number(digits) === position + 1 ? name.trim() : artist;
}

/**
 * Every entry worth putting on the want list.
 *
 * Unavailable entries are dropped rather than imported: a deleted video has no
 * title to search for, and a want list row that can never be satisfied is
 * noise the user has to clear by hand.
 */
export function playlistEntries(items: DiscoverPlaylistItem[]): PlaylistEntry[] {
  const out: PlaylistEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.available) continue;
    const parsed = parseTitle(item.title, { channel: item.channel });
    const artist = stripPositionalTrackNumber(parsed.artist, item.position);
    const query = [artist, parsed.title].filter(Boolean).join(' ').trim();
    if (!query) continue;
    // The same track can sit in a playlist twice; the want list should not.
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      videoId: item.videoId,
      raw: item.title,
      artist,
      title: parsed.title,
      confidence: parsed.confidence,
      query,
    });
  }
  return out;
}

/** How many of these the UI should flag as worth a human glance. */
export function weakCount(entries: PlaylistEntry[]): number {
  return entries.filter((e) => e.confidence < TITLE_CONFIDENCE_FLOOR).length;
}
