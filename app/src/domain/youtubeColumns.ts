/*
 * Seek — the columns of the YouTube sheet.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The user asked for an Excel-like table whose columns can be rearranged, in the
 * default order from their spreadsheet. This is one instantiation of the shared
 * column engine (`columns.ts`), the same one the search table uses, so the sheet
 * gets the same + / − picker, drag-to-move headers and drag-to-resize edges.
 * No column fills: the sheet is wider than most panes and scrolls sideways.
 *
 * `title` is pinned: a row is unreadable without the video's name, and every
 * other column is read against it. `search` is pinned too — the whole point of
 * the sheet is to act on a row, so its action must never move out of reach.
 */

import { makeColumns } from './columns.ts';
import type { ColumnSpec } from './columns.ts';

export type YtColumnId =
  | 'title' | 'search' | 'duration' | 'artist' | 'track' | 'album'
  | 'style' | 'downloaded' | 'url' | 'published' | 'description';

const SPECS: ColumnSpec<YtColumnId>[] = [
  { id: 'title', label: 'Video title', width: 16.25, pinned: true },
  { id: 'search', label: 'Search', width: 3.25, pinned: true },
  { id: 'duration', label: 'Duration', width: 4.25 },
  { id: 'artist', label: 'Discogs artist', width: 10.5 },
  { id: 'track', label: 'Track name', width: 12.5 },
  { id: 'album', label: 'Discogs album', width: 11.25 },
  { id: 'style', label: 'Style', width: 9.5 },
  { id: 'downloaded', label: 'Downloaded', width: 6 },
  { id: 'url', label: 'URL', width: 3.75 },
  // Off by default — the spreadsheet had them, but they are the widest and
  // least-scanned, so they earn their place only when switched on.
  { id: 'published', label: 'Published', width: 6.25 },
  { id: 'description', label: 'Description', width: 18.75 },
];

/** The order Iva's spreadsheet used, minus the two opt-in columns. */
export const YT_DEFAULT_COLUMNS: YtColumnId[] = [
  'title', 'search', 'duration', 'artist', 'track', 'album',
  'style', 'downloaded', 'url',
];

const ENGINE = makeColumns<YtColumnId>(SPECS, YT_DEFAULT_COLUMNS);

export const YT_COLUMNS = ENGINE;
export const ytTemplateFor = ENGINE.template;
export const ytNormaliseColumns = ENGINE.normalise;
export const YT_COLUMN_SET = ENGINE;
