/*
 * Seek — the columns of the search results table, and which of them fit.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Only the TABLE density has columns. Comfortable and Compact render a designed
 * metadata line whose order is part of the reading — badge first because it is
 * the one piece of colour, quality last because it is the verdict — and turning
 * that into a user-ordered list would be offering to break a layout rather than
 * to configure one.
 *
 * WHAT THIS REPLACES. The template was nine hard-coded track widths in CSS,
 * with three container queries that redefined it and hid columns by
 * `nth-child`. That worked exactly as long as the set never changed: an
 * `nth-child(9)` rule means "the user column" only while user IS ninth. Reorder
 * anything and the responsive rules start hiding the wrong column — which is
 * not hypothetical, because the non-table `.meta` line has three different cell
 * counts sharing one set of nth-child rules, and its release rows have been
 * dropping their track count where they meant to drop the spec.
 *
 * So the template is computed from the chosen columns, and what drops when
 * space runs short is decided by a PRIORITY on each column rather than by its
 * position. The order of sacrifice the CSS encoded is preserved exactly — user,
 * then queue, then spec — it is simply no longer tied to where a column sits.
 */

import { makeColumns } from './columns.ts';
import type { ColumnSpec as GenericColumnSpec } from './columns.ts';

export type ColumnId =
  | 'name' | 'format' | 'spec' | 'time' | 'size' | 'speed' | 'queue' | 'check'
  | 'user' | 'bitrate' | 'year' | 'files' | 'country' | 'folder';

/* The pure algorithm — fitting, ordering, normalising — now lives in
 * `columns.ts` and is shared with the YouTube sheet. This file is that engine's
 * search instantiation: the specs below, and the historical function names the
 * rest of the search UI already imports, delegating to it. */
export type ColumnSpec = GenericColumnSpec<ColumnId>;

const SPECS: ColumnSpec[] = [
  { id: 'name', label: 'Name', track: 'minmax(6rem, 1fr)', rem: 6, priority: Infinity, pinned: true },
  { id: 'format', label: 'Format', track: '4.5rem', rem: 4.5, priority: Infinity },
  { id: 'spec', label: 'Spec', track: '5.5rem', rem: 5.5, priority: 3 },
  { id: 'time', label: 'Time', track: '3.5rem', rem: 3.5, priority: 5 },
  { id: 'size', label: 'Size', track: '5rem', rem: 5, priority: 6 },
  { id: 'speed', label: 'Speed', track: '6rem', rem: 6, priority: 4 },
  { id: 'queue', label: 'Queue', track: '5.5rem', rem: 5.5, priority: 2 },
  { id: 'check', label: 'Check', track: '1.75rem', rem: 1.75, priority: Infinity },
  { id: 'user', label: 'User', track: '7rem', rem: 7, priority: 1 },
  // Added by this change. All opt-in, and all drop before anything that was
  // already on screen — someone who switches one on has not asked to lose Size.
  { id: 'bitrate', label: 'Bitrate', track: '5rem', rem: 5, priority: 0, extra: true },
  { id: 'year', label: 'Year', track: '3.5rem', rem: 3.5, priority: 0, extra: true },
  { id: 'files', label: 'Files', track: '4rem', rem: 4, priority: 0, extra: true },
  { id: 'country', label: 'From', track: '3rem', rem: 3, priority: 0, extra: true },
  // The remote folder — only the flat "Files" list has a single one to show
  // (a grouped row spans many), so it is an opt-in extra like the others, most
  // at home in that list and one click away in the column picker. Wide, because
  // a Soulseek folder path carries the catalogue number and the year.
  { id: 'folder', label: 'Folder', track: 'minmax(6rem, 12rem)', rem: 6, priority: 0, extra: true },
];

export const COLUMNS: Record<ColumnId, ColumnSpec> = Object.fromEntries(
  SPECS.map((c) => [c.id, c]),
) as Record<ColumnId, ColumnSpec>;

/** Every column, in the order the picker offers them. */
export const ALL_COLUMNS: ColumnId[] = SPECS.map((c) => c.id);

/** Exactly what the table showed before it was configurable. */
export const DEFAULT_COLUMNS: ColumnId[] = [
  'name', 'format', 'spec', 'time', 'size', 'speed', 'queue', 'check', 'user',
];

/*
 * The engine, with the slack the old CSS already had: the nine default columns
 * measure 44.75rem of track plus 6rem of gaps, and the old rules dropped the
 * user column at 58em, so ~7rem of headroom is the design's own.
 */
const ENGINE = makeColumns<ColumnId>(SPECS, DEFAULT_COLUMNS, 7);

/**
 * The columns that fit, dropping the least useful first — measured in rem, not
 * pixels, so it still fires when the OS scales text.
 */
export const visibleColumns = ENGINE.visible;

/** The `grid-template-columns` value for a set of columns. */
export const templateFor = ENGINE.template;

/**
 * Clean a stored choice into something renderable: unknown columns dropped,
 * duplicates collapsed, `name` forced to the front. Stored preferences outlive
 * the code that wrote them, so this never trusts what it reads.
 */
export const normaliseColumns = ENGINE.normalise;

/** Move `id` to `to`, keeping `name` pinned at the front. */
export const reorderColumns = ENGINE.reorder;

/** Turn a column on (appended) or off. `name` cannot be turned off. */
export const toggleColumn = ENGINE.toggle;

/** What the ViewMenu column picker needs to configure this table. */
export const SEARCH_COLUMN_SET = ENGINE;
