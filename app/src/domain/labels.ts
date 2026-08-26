/*
 * Seek — how a watched catalogue reads.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One job, and it is the honesty rule for this whole feature: the counts on a
 * watched label are a SNAPSHOT of a reading, not a live figure. A catalogue is
 * persisted nowhere, so recounting one costs several rate-limited requests —
 * which is why they are stored at all (`data/labelStore.ts` has the contrast
 * with dig sessions, which correctly derive theirs instead).
 *
 * So nothing here ever says "47 of 312 in your library". It says "47 of 312
 * when you last looked, 3 days ago", and where it has no reading it says so
 * rather than showing zeros. This is the same rule as `PeerHistory`, which
 * renders nothing where no history exists and withholds a verdict below three
 * transfers: a number with no reading behind it is decoration.
 */

import { since } from './format.ts';

export interface LabelProgress {
  /** Has this catalogue ever been read? */
  read: boolean;
  /** The headline, always past-tense where it quotes a count. */
  summary: string;
  /** When the reading was taken, e.g. "3 days ago". Empty when never read. */
  when: string;
  /** 0..1 of the catalogue accounted for — owned or wanted. Null when unread. */
  fraction: number | null;
  /** Releases neither owned nor on the want list, at the last reading. */
  remaining: number | null;
}

export interface LabelCounts {
  lastSeenAt: number | null;
  releaseCount: number | null;
  ownedCount: number | null;
  wantedCount: number | null;
}

export function describeProgress(label: LabelCounts): LabelProgress {
  const total = label.releaseCount;

  // Never read is NOT the same as read and empty, and the sidecar keeps them
  // apart with null against 0 precisely so this branch can exist.
  if (label.lastSeenAt === null || total === null) {
    return {
      read: false,
      summary: 'Not opened yet',
      when: '',
      fraction: null,
      remaining: null,
    };
  }

  const when = since(label.lastSeenAt);

  if (total === 0) {
    return {
      read: true,
      summary: 'No releases found',
      when,
      fraction: null,
      remaining: 0,
    };
  }

  const owned = label.ownedCount ?? 0;
  const wanted = label.wantedCount ?? 0;
  /* Clamped because owned and wanted are counted separately and a release can
   * be both — already in the library AND still on the want list from before it
   * arrived. Adding them can therefore exceed the catalogue, and "313 of 312"
   * would read as a bug in a screen whose whole job is to be trusted. */
  const accounted = Math.min(total, owned + wanted);
  const remaining = total - accounted;

  return {
    read: true,
    summary: owned > 0
      ? `${owned} of ${total} in your library`
      : `${total} ${total === 1 ? 'release' : 'releases'}`,
    when,
    fraction: accounted / total,
    remaining,
  };
}

/**
 * The line under the summary. Empty when there is nothing worth saying.
 *
 * Deliberately quiet where a catalogue is untouched: "0 on your want list" is
 * a fact nobody needs, and a row of zeros trains you to stop reading the row.
 */
export function describeRemaining(label: LabelCounts): string {
  const progress = describeProgress(label);
  if (!progress.read || progress.remaining === null) return '';
  const wanted = label.wantedCount ?? 0;
  const parts: string[] = [];
  if (wanted > 0) parts.push(`${wanted} on your want list`);
  if (progress.remaining > 0) parts.push(`${progress.remaining} neither`);
  return parts.join(' · ');
}

/**
 * How stale a reading is allowed to get before the UI suggests a refresh.
 *
 * Deliberately generous. A back catalogue barely moves — that is the entire
 * argument for this being a watchlist rather than a release feed — so the
 * thing that actually goes stale is YOUR library, and that only matters when
 * you have been downloading. A week is long enough not to nag.
 */
const STALE_SECONDS = 7 * 24 * 60 * 60;

export function isStale(label: LabelCounts, now = Date.now() / 1000): boolean {
  if (label.lastSeenAt === null) return false;
  return now - label.lastSeenAt > STALE_SECONDS;
}

/** What to call a watched catalogue's kind, for a row that mixes both. */
export function kindLabel(kind: 'label' | 'artist'): string {
  return kind === 'label' ? 'Label' : 'Artist';
}
