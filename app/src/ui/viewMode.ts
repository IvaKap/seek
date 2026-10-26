/*
 * Seek — Simple and Collector: one app, two presets of what is in front.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A preset, not a fork (docs/PRODUCT.md §9): every feature is reachable in
 * both modes, and nobody has to choose before they know what they want. What
 * the mode sets is each screen's density and how much of the sidebar is in
 * front. Each screen remembers its density PER MODE, so flipping back gives
 * you the view you left there, not the preset again.
 *
 * Collector keeps the storage keys the app used before the switch existed:
 * Collector IS that view, so an upgrade changes nothing.
 */

import type { Density } from './ViewMenu.tsx';

export type Mode = 'simple' | 'collector';
export type DensityScreen = 'search' | 'downloads' | 'library';
export type Views = Record<DensityScreen, Density>;

export const MODE_KEY = 'seek.mode';

const KEYS: Record<DensityScreen, string> = {
  search: 'seek.density',
  /* Downloads keeps its OWN density. The two lists answer different questions
   * — search results are things you are still judging, transfers are things
   * you have already decided on — and a collector who wants roomy release
   * cards while choosing usually wants a dense table while watching them
   * arrive. */
  downloads: 'seek.density.downloads',
  /* And the collection keeps its own, for the same reason again: picking
   * through records wants covers, auditing what you own wants a table, and
   * neither answer should be imposed by what you last chose elsewhere. */
  library: 'seek.density.library',
};

/** Where each screen starts in each mode, until you pick another there. */
const PRESETS: Record<Mode, Views> = {
  // Release cards: judging a few results at a time, unhurried.
  simple: { search: 'comfortable', downloads: 'comfortable', library: 'grid' },
  // What the app always was: tables you read down, covers for the collection.
  collector: { search: 'table', downloads: 'table', library: 'grid' },
};

const DENSITIES: readonly string[] = ['comfortable', 'compact', 'table', 'grid'];

/** Downloads · Simple's three layouts, after its canvas boards. Collector keeps
 * its densities instead, so this is Simple's alone and has one key. Kept out
 * of KEYS: it is no evidence of an install from before the mode switch. */
export type DownloadsLayout = 'list' | 'board' | 'folders';
export const LAYOUT_KEY = 'seek.downloads.layout.simple';
const LAYOUTS: readonly string[] = ['list', 'board', 'folders'];

export function loadLayout(read: Read): DownloadsLayout {
  const raw = read(LAYOUT_KEY);
  return raw !== null && LAYOUTS.includes(raw) ? raw as DownloadsLayout : 'list';
}

type Read = (key: string) => string | null;

/** The storage key for one screen's density in one mode. */
export function densityKey(screen: DensityScreen, mode: Mode): string {
  return mode === 'collector' ? KEYS[screen] : `${KEYS[screen]}.simple`;
}

/** Every screen's density in `mode`: what you chose there last, else the preset. */
export function loadViews(mode: Mode, read: Read): Views {
  const one = (screen: DensityScreen): Density => {
    const raw = read(densityKey(screen, mode));
    return raw !== null && DENSITIES.includes(raw) ? raw as Density : PRESETS[mode][screen];
  };
  return { search: one('search'), downloads: one('downloads'), library: one('library') };
}

/**
 * The mode to open in. A first launch gets Simple. An install from before the
 * switch keeps the Collector view it already had: `earlierRun` names keys any
 * earlier launch wrote, because a person who never touched density stored no
 * density key, and would otherwise be moved to Simple by an update.
 */
export function initialMode(read: Read, earlierRun: readonly string[]): Mode {
  const raw = read(MODE_KEY);
  if (raw === 'simple' || raw === 'collector') return raw;
  return [...Object.values(KEYS), ...earlierRun].some((k) => read(k) !== null) ? 'collector' : 'simple';
}

/** What a Simple sidebar keeps in front, in the sidebar's usual order. */
const FRONT: ReadonlySet<string> = new Set([
  'search', 'downloads', 'completed', 'wishlist', 'collections', 'chat',
]);

/**
 * Simple's sidebar: what stays in front and what waits behind More. News (a
 * badge) and the screen you are on never wait behind it — a private message
 * you cannot see is worse than a longer list.
 */
export function splitSimple<T extends { id: string; badge?: number }>(
  items: T[], active: string,
): { front: T[]; more: T[] } {
  const front: T[] = [];
  const more: T[] = [];
  for (const item of items) {
    (FRONT.has(item.id) || item.badge !== undefined || item.id === active ? front : more).push(item);
  }
  return { front, more };
}
