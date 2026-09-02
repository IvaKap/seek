/*
 * Seek — the columns of the YouTube sheet.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The user asked for an Excel-like table whose columns can be rearranged, in the
 * default order from their spreadsheet. This is one instantiation of the shared
 * column engine (`columns.ts`), the same one the search table uses, so the sheet
 * gets priority-based responsive dropping, a stored order, and the ↑/↓ picker
 * for free — matching the search table's behaviour exactly.
 *
 * `title` is pinned: a row is unreadable without the video's name, and every
 * other column is read against it. `search` is pinned too — the whole point of
 * the sheet is to act on a row, so its action must never drop out.
 */

import { makeColumns } from './columns.ts';
import type { ColumnSpec } from './columns.ts';

export type YtColumnId =
  | 'title' | 'search' | 'duration' | 'artist' | 'track' | 'album'
  | 'style' | 'downloaded' | 'url' | 'published' | 'description';

const SPECS: ColumnSpec<YtColumnId>[] = [
  { id: 'title', label: 'Video title', track: 'minmax(9rem, 1.4fr)', rem: 9, priority: Infinity, pinned: true },
  { id: 'search', label: 'Search', track: '4rem', rem: 4, priority: Infinity, pinned: true },
  { id: 'duration', label: 'Duration', track: '4.5rem', rem: 4.5, priority: 5 },
  { id: 'artist', label: 'Discogs artist', track: 'minmax(6rem, 1fr)', rem: 7, priority: 8 },
  { id: 'track', label: 'Track name', track: 'minmax(6rem, 1fr)', rem: 7, priority: 6 },
  { id: 'album', label: 'Discogs album', track: 'minmax(6rem, 1fr)', rem: 7, priority: 7 },
  { id: 'style', label: 'Style', track: '7rem', rem: 7, priority: 4 },
  { id: 'downloaded', label: 'Downloaded', track: '5.5rem', rem: 5.5, priority: 9 },
  { id: 'url', label: 'URL', track: '3rem', rem: 3, priority: 2 },
  // Off by default — the spreadsheet had them, but they are the widest and
  // least-scanned, so they earn their place only when switched on.
  { id: 'published', label: 'Published', track: '5.5rem', rem: 5.5, priority: 1, extra: true },
  { id: 'description', label: 'Description', track: 'minmax(8rem, 1.2fr)', rem: 8, priority: 0, extra: true },
];

/** The order Iva's spreadsheet used, minus the two opt-in columns. */
export const YT_DEFAULT_COLUMNS: YtColumnId[] = [
  'title', 'search', 'duration', 'artist', 'track', 'album',
  'style', 'downloaded', 'url',
];

const ENGINE = makeColumns<YtColumnId>(SPECS, YT_DEFAULT_COLUMNS, 6);

export const YT_COLUMNS = ENGINE;
export const ytVisibleColumns = ENGINE.visible;
export const ytTemplateFor = ENGINE.template;
export const ytNormaliseColumns = ENGINE.normalise;
export const YT_COLUMN_SET = ENGINE;
