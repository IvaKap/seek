/*
 * Seek — saved views, the "presets in one click" of docs/PRODUCT.md §3.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A view is a whole way of looking at a search: its filters AND its grouping.
 * Choosing one replaces both, the way choosing a tab does. Which view is
 * selected is never stored. It is whichever one the current filters and
 * grouping equal, so touching a pill leaves every view unselected rather than
 * quietly editing the one you started from.
 */

import type { Filters, GroupBy } from './types.ts';
import { EMPTY_FILTERS, deserialiseFilters, serialiseFilters } from './types.ts';

export interface SavedView {
  name: string;
  filters: Filters;
  groupBy: GroupBy;
}

const view = (name: string, groupBy: GroupBy, over: Partial<Filters> = {}): SavedView =>
  ({ name, groupBy, filters: { ...EMPTY_FILTERS, ...over } });

/* Folders are how a search opens (docs/PRODUCT.md §4), so "All results" is
 * that, and the other list a search offers is the one per version. */
export const BUILT_IN_VIEWS: readonly SavedView[] = [
  view('All results', 'release'),
  view('Lossless, slot free', 'release', { losslessOnly: true, freeSlotsOnly: true }),
  view('By version', 'version'),
  // At most two people ahead of you.
  view('Under 3 waiting', 'release', { maxQueue: 2 }),
];

/** The groupings a view may hold: the ones the grouping control offers. */
const GROUPINGS: readonly GroupBy[] = ['track', 'release', 'version', 'file'];

export function sameFilters(a: Filters, b: Filters): boolean {
  return (Object.keys(EMPTY_FILTERS) as Array<keyof Filters>).every((k) => (k === 'formats'
    ? a.formats.size === b.formats.size && [...a.formats].every((f) => b.formats.has(f))
    : a[k] === b[k]));
}

/** The first view the search currently equals, if any. */
export function currentView(views: readonly SavedView[], filters: Filters, groupBy: GroupBy): SavedView | undefined {
  return views.find((v) => v.groupBy === groupBy && sameFilters(v.filters, filters));
}

/** Add a view, replacing one of yours with the same name: that is how a view is updated. */
export function withView(mine: SavedView[], next: SavedView): SavedView[] {
  const same = (v: SavedView) => v.name.toLocaleLowerCase() === next.name.toLocaleLowerCase();
  return mine.some(same) ? mine.map((v) => (same(v) ? next : v)) : [...mine, next];
}

export function storeViews(views: SavedView[]): string {
  return JSON.stringify(views.map((v) => ({ name: v.name, groupBy: v.groupBy, filtersJson: serialiseFilters(v.filters) })));
}

/** Your views from storage. Anything unreadable is dropped, never shown half-built. */
export function parseViews(json: string | null): SavedView[] {
  try {
    const raw: unknown = JSON.parse(json ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((v: { name?: unknown; groupBy?: unknown; filtersJson?: unknown } | null) => (
      typeof v?.name === 'string' && v.name.trim() !== '' && typeof v.filtersJson === 'string'
        && GROUPINGS.includes(v.groupBy as GroupBy)
        ? [{ name: v.name, groupBy: v.groupBy as GroupBy, filters: deserialiseFilters(v.filtersJson) }]
        : []));
  } catch {
    return [];
  }
}
