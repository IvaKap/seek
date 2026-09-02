/*
 * Seek — turning a YouTube video title into a Discogs query.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is a DERIVATION, so it lives on the frontend (AGENTS.md §"The seam"):
 * the sidecar fetches and searches, but the artist/title it searches BY comes
 * from here. Two steps, both from the user's old Apps Script, which reported
 * this working ~95% of the time:
 *
 *   1. parseTitle.ts already splits "Artist - Title" into an artist and a title.
 *   2. cleanForDiscogs strips the noise a Discogs search does not want —
 *      "(Official Video)", "[FREE DL]", "Remaster", and so on.
 *
 * The result is handed to `youtube.enrich`, one query per row. Where parseTitle
 * cannot find an artist (a bare title, a one-word channel upload), artist is
 * empty and the cleaned whole title carries the search on its own — exactly
 * what the script did with its single combined query.
 */

import { parseTitle } from './parseTitle.ts';

/*
 * Noise to strip before searching. Mirrors the script's cleanTitle regex and
 * then some: bracketed asides, the standard upload furniture, and the edit/mix
 * qualifiers that name a version Discogs will not have catalogued under that
 * phrase. Case-insensitive; applied to artist and title alike.
 */
const NOISE = new RegExp(
  [
    '\\[[^\\]]*\\]',              // [FREE DL], [Premiere], …
    '\\([^)]*\\)',               // (Official Video), (2003 Remaster), …
    '\\bofficial\\b.*',          // "official video/audio/…" to end
    '\\b(?:music|lyric[s]?|visualiser|visualizer)\\s+video\\b',
    '\\b(?:audio|hd|hq|4k|full album|full ep)\\b',
    '\\b(?:free\\s*(?:dl|download)|premiere|out now)\\b',
    '\\bremaster(?:ed)?\\b',
    '\\b(?:extended|club|radio|vocal|dub|original)\\s+(?:mix|edit|version)\\b',
    '\\b(?:remix|edit|bootleg|vip|rework|live)\\b',
  ].join('|'),
  'gi',
);

/** Collapse whitespace and trim stray separators a strip can leave behind. */
function tidy(text: string): string {
  return text
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,|/]+|[\s\-–—:;,|/]+$/g, '')
    .trim();
}

export function cleanForDiscogs(text: string): string {
  return tidy(text || '');
}

export interface DiscogsQuery {
  artist: string;
  title: string;
}

/**
 * A row's Discogs query, from its video title and (when known) uploader.
 *
 * The channel is passed to parseTitle for the same reason the Dig Bar does:
 * "Aphex Twin — Windowlicker" on the Warp channel is title-only, and knowing
 * the uploader is Warp is what lets the parser leave the artist to the title.
 */
export function discogsQuery(videoTitle: string, channel = ''): DiscogsQuery {
  const parsed = parseTitle(videoTitle, { channel });
  const artist = cleanForDiscogs(parsed.artist ?? '');
  // Fall back to the cleaned whole title when the parser found no title — a
  // combined query is what the script always sent, so an empty title must not
  // mean an empty search.
  const title = cleanForDiscogs(parsed.title ?? '') || cleanForDiscogs(videoTitle);
  return { artist, title };
}
