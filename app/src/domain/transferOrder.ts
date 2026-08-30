/*
 * Seek — ordering and filtering the transfer lists.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One module for all three lenses, because Downloads, Completed and Failed are
 * one list read three ways (`DownloadsView`'s `filter` prop) and a sort that
 * behaved differently in each would be three things to learn instead of one.
 *
 * The default order is the one that was already there and it is not merely
 * alphabetical-by-accident: active first, because the thing you are waiting on
 * must not sit below the hundred files that already finished. Every other order
 * is something the user asked for explicitly, so it is applied verbatim —
 * choosing "name" and still getting active-first would read as broken.
 */

import { parsePath } from './parsePath.ts';
import type { TransferGroup } from '../data/transferStore.ts';

/**
 * The name the row actually SHOWS.
 *
 * `g.title` is the raw remote folder — `[UR 2000] DJ Rolando a.k.a. The Aztec
 * Mystic - Revenge...` — and the review lenses render the parsed release
 * instead. Sorting or filtering on the raw string means sorting by something
 * the user cannot see: picking "Release name" appeared to do nothing at all,
 * because the two orders happen to be similar and neither matched the labels
 * on screen. Caught by driving it.
 */
export function displayName(g: TransferGroup): string {
  const first = g.transfers[0];
  if (!first) return g.title;
  return parsePath(first.path).release?.value || g.title;
}

export type SortKey = 'default' | 'name' | 'peer' | 'size' | 'progress' | 'recent';

export const SORT_LABELS: Record<SortKey, string> = {
  default: 'What needs attention',
  name: 'Release name',
  peer: 'Who it is from',
  size: 'Size',
  progress: 'How far along',
  recent: 'Most recently finished',
};

/**
 * The same orders, worded for the other direction of traffic.
 *
 * Only `peer` actually differs, and it differs completely: on a download the
 * peer is who it is coming FROM, and on an upload it is who is taking it. One
 * shared string would have been wrong on one of the two screens, and wrong in a
 * way that reads as a bug rather than as a translation slip.
 */
export const UPLOAD_SORT_LABELS: Record<SortKey, string> = {
  ...SORT_LABELS,
  peer: 'Who is taking it',
  recent: 'Most recently sent',
};

/** The order each key reads best in, before the user flips it. */
const NATURAL_DESC: Record<SortKey, boolean> = {
  default: false, name: false, peer: false, size: true, progress: true, recent: true,
};

export function naturallyDescending(key: SortKey): boolean {
  return NATURAL_DESC[key];
}

/* Mirrors the rank in `transferStore.group`. Duplicated deliberately rather
 * than exported from there: this one is a SORT preference and that one is the
 * store's own default, and letting a UI choice reach back into the store is how
 * the two quietly become one thing that neither owns. */
const ATTENTION: Record<TransferGroup['state'], number> = {
  active: 0, queued: 1, paused: 2, stalled: 3, failed: 4, cancelled: 5, finished: 6,
};

function completion(g: TransferGroup): number {
  return g.size > 0 ? g.bytesDone / g.size : 0;
}

/** Most recent completion in the group, 0 when nothing in it has finished. */
function finishedAt(g: TransferGroup): number {
  let latest = 0;
  for (const t of g.transfers) {
    if (t.finishedAt && t.finishedAt > latest) latest = t.finishedAt;
  }
  return latest;
}

function compare(a: TransferGroup, b: TransferGroup, key: SortKey): number {
  switch (key) {
    case 'name': return displayName(a).localeCompare(displayName(b));
    case 'peer': return a.username.localeCompare(b.username)
      || displayName(a).localeCompare(displayName(b));
    case 'size': return a.size - b.size;
    case 'progress': return completion(a) - completion(b);
    case 'recent': return finishedAt(a) - finishedAt(b);
    default: return ATTENTION[a.state] - ATTENTION[b.state]
      || displayName(a).localeCompare(displayName(b));
  }
}

/**
 * Order a lens. Never mutates — the store owns that array and hands the same
 * one to every reader.
 *
 * Ties break on title in every mode, so the list is STABLE: without it, two
 * releases of the same size swap places on every progress tick, and a list that
 * reshuffles while you are reading it is worse than one sorted badly.
 */
export function sortGroups(
  groups: TransferGroup[], key: SortKey, descending: boolean,
): TransferGroup[] {
  const out = [...groups];
  out.sort((a, b) => {
    const n = compare(a, b, key);
    const tied = n === 0 ? displayName(a).localeCompare(displayName(b)) : n;
    return descending ? -tied : tied;
  });
  return out;
}

/**
 * Does this release match what was typed?
 *
 * Matches the release name AND the peer, because "everything from this person"
 * is the other question this box gets asked — a failed batch is very often one
 * peer who went offline, and being able to type their name is the difference
 * between clearing it in one go and hunting.
 *
 * Case-insensitive, and every whitespace-separated term must match somewhere,
 * so `burial 320` finds what a single substring could not.
 */
export function matchesQuery(g: TransferGroup, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  /* Both names: what is on screen, AND the raw folder, because a folder often
   * carries a catalogue number or a year that the parsed name drops and that is
   * exactly the sort of thing someone types to find one record. */
  const hay = `${displayName(g)} ${g.title} ${g.username}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}
