/*
 * Seek — the columns of the search results table.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Only the TABLE density has columns. Comfortable and Compact render a designed
 * metadata line whose order is part of the reading — badge first because it is
 * the one piece of colour, quality last because it is the verdict — and turning
 * that into a user-ordered list would be offering to break a layout rather than
 * to configure one.
 *
 * Every column can be added or removed (the View menu's + and −), moved (drag
 * its header) and resized (drag its header's edge). The widths below are the
 * defaults, in rem; `columns.ts` explains how a hand-set width overrides them.
 * Name is the one `fill` column: it takes every spare pixel, because a filename
 * cropped to "Burial — Arch…" while a column of queue counts sits half empty
 * is the complaint this layout exists to answer.
 */

import { makeColumns } from './columns.ts';
import type { ColumnSpec as GenericColumnSpec } from './columns.ts';

export type ColumnId =
  | 'name' | 'format' | 'spec' | 'time' | 'size' | 'speed' | 'queue' | 'check'
  | 'user' | 'bitrate' | 'year' | 'files' | 'country' | 'folder';

export type ColumnSpec = GenericColumnSpec<ColumnId>;

const SPECS: ColumnSpec[] = [
  { id: 'name', label: 'Name', width: 15, fill: true, pinned: true },
  { id: 'format', label: 'Format', width: 4.25 },
  { id: 'spec', label: 'Spec', width: 4.5 },
  { id: 'time', label: 'Time', width: 3.5 },
  { id: 'size', label: 'Size', width: 4.5 },
  { id: 'speed', label: 'Speed', width: 5.75 },
  { id: 'queue', label: 'Queue', width: 5 },
  { id: 'check', label: 'Check', width: 3.5 },
  { id: 'user', label: 'User', width: 8 },
  // Off by default; one click away in the View menu.
  { id: 'bitrate', label: 'Bitrate', width: 5 },
  { id: 'year', label: 'Year', width: 3.5 },
  { id: 'files', label: 'Files', width: 4.5 },
  { id: 'country', label: 'From', width: 3.5 },
  // The remote folder. Wide, because a Soulseek folder path carries the
  // catalogue number and the year.
  { id: 'folder', label: 'Folder', width: 12 },
];

export const COLUMNS: Record<ColumnId, ColumnSpec> = Object.fromEntries(
  SPECS.map((c) => [c.id, c]),
) as Record<ColumnId, ColumnSpec>;

/** Every column, in the order the picker offers them. */
export const ALL_COLUMNS: ColumnId[] = SPECS.map((c) => c.id);

/** What a fresh install shows. */
export const DEFAULT_COLUMNS: ColumnId[] = [
  'name', 'format', 'spec', 'time', 'size', 'speed', 'queue', 'check', 'user',
];

const ENGINE = makeColumns<ColumnId>(SPECS, DEFAULT_COLUMNS);

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

/** The whole engine, for the View menu and the header row. */
export const SEARCH_COLUMN_SET = ENGINE;
