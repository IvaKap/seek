/*
 * Seek — best picks: two or three copies worth taking, above the results.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Search · Simple leads with a few picks instead of one big top result, each
 * saying what it is best at:
 *
 *   Best overall   the best-scoring copy of the track the results are about
 *   Fastest        the copy of that same track likely to arrive soonest
 *   Whole release  the best copy of the record the most people have
 *
 * NOTHING HERE CHOOSES FOR THE USER (bestSources.ts has that story). A pick is
 * one peer's one file or folder, named on its card, and its Get downloads that
 * copy and no other.
 *
 * "The track the results are about" is the one the most PEOPLE have. Soulseek
 * returns every path that matched the words, so a track whose folder happened
 * to match turns up once or twice, and the track that was searched for turns
 * up from everyone.
 *
 * Every pick would pass the user's own download rules, so pressing Get on one
 * is never refused, and "Prefer lossless" narrows Best overall and Whole
 * release the way it narrows a track's Get. None is a suspected transcode or a
 * buddy-only file either: a best pick that says the numbers don't add up is
 * not one.
 */

import type { Release, SourceFile, TrackCluster } from './types.ts';
import type { DownloadPrefs } from './preferences.ts';
import { judge, judgeRelease, pickSource } from './preferences.ts';
import { groupCopies } from './bestSources.ts';

export type PickKind = 'overall' | 'fastest' | 'release';

export type BestPick =
  /** `folder` is the release the file sits in, for its cover. */
  | { kind: 'overall' | 'fastest'; source: SourceFile; folder: Release | null }
  | { kind: 'release'; release: Release };

/** The filtered results, grouped both ways. */
export interface PickPool {
  tracks: TrackCluster[];
  releases: Release[];
}

/**
 * Slot → the id of the file (or release) it must keep showing, while that is
 * still a valid pick. How the UI stops a card changing under the cursor.
 */
export type PickPins = Partial<Record<PickKind, string>>;

export function pickId(p: BestPick): string {
  return p.kind === 'release' ? p.release.id : p.source.id;
}

/**
 * "Fastest" never trades below 320 or V0. A quicker 128 kbps copy is not a
 * shortcut for someone who has to play it on a club system.
 */
const FAST_ENOUGH = new Set(['lossless', 'high']);

function eligible(s: SourceFile, rules: DownloadPrefs): boolean {
  return !s.private && !s.transcode.suspect && judge(s, rules).allowed;
}

/** A free slot first, then a shorter queue, then fewer seconds at the advertised rate. */
function sooner(a: SourceFile, b: SourceFile): number {
  if (a.peer.freeSlots !== b.peer.freeSlots) return a.peer.freeSlots ? -1 : 1;
  if (a.peer.queueLength !== b.peer.queueLength) return a.peer.queueLength - b.peer.queueLength;
  return a.size / Math.max(1, a.peer.advertisedSpeed) - b.size / Math.max(1, b.peer.advertisedSpeed);
}

const first = <T>(items: T[], order: (a: T, b: T) => number): T | undefined =>
  items.reduce<T | undefined>((top, x) => (top === undefined || order(x, top) < 0 ? x : top), undefined);

const lossless = (r: Release) => r.files.every((f) => f.quality.lossless);

/** A record's copy to show: its best, or under "Prefer lossless" its best lossless one. */
const bestCopy = (copies: Release[], rules: DownloadPrefs) =>
  (rules.preferLossless ? copies.find(lossless) : undefined) ?? copies[0];

/**
 * Whole release holds what it showed while answers arrive. Copy counts and
 * scores move with every answer, and a card that followed them changed ten
 * times in twelve seconds. It moves to a record with twice the copies of its
 * own, and within its own record to a fuller copy, or to a lossless one under
 * "Prefer lossless". A lead of two flipped it seven times as copies arrived in
 * bursts; double settled in three, on the record the search was for.
 */
function steady(
  before: Release | undefined, records: Release[][], lead: Release[] | undefined, rules: DownloadPrefs,
): Release | undefined {
  const own = before && records.find((copies) => copies.includes(before));
  if (!before || !own || (lead && lead.length >= Math.max(own.length * 2, own.length + 2))) return lead && bestCopy(lead, rules);
  const rival = bestCopy(own, rules);
  return rival.trackCount > before.trackCount || (rules.preferLossless && lossless(rival) && !lossless(before))
    ? rival : before;
}

/** `shown` is what was on screen last time: held more loosely than a pin (see `steady`). */
export function bestPicks(pool: PickPool, rules: DownloadPrefs, pins: PickPins = {}, shown: PickPins = {}): BestPick[] {
  const picks: BestPick[] = [];
  const folderOf = (s: SourceFile) => pool.releases.find((r) => r.files[0]?.releaseKey === s.releaseKey) ?? null;

  /* The track. Its copies stay in score order (the grouper sorts them), so
   * `ok[0]` is the best-scoring one. A track Seek could not parse a title from
   * loses to any it could. */
  const tracks = pool.tracks
    .map((t) => ({ t, ok: t.sources.filter((s) => eligible(s, rules)) }))
    .filter((c) => c.ok.length > 0);
  const holding = (id?: string) => (id ? tracks.find((c) => c.ok.some((s) => s.id === id)) : undefined);
  const peers = (ok: SourceFile[]) => new Set(ok.map((s) => s.user)).size;
  const target = holding(pins.overall) ?? holding(pins.fastest) ?? first(tracks, (a, b) =>
    Number(a.t.fallback) - Number(b.t.fallback)
    || peers(b.ok) - peers(a.ok)
    || b.ok[0].score - a.ok[0].score);

  if (target) {
    const pinned = (id?: string) => target.ok.find((s) => s.id === id);
    const overall = pinned(pins.overall) ?? pickSource(target.ok, rules);
    picks.push({ kind: 'overall', source: overall, folder: folderOf(overall) });
    const held = pinned(pins.fastest);
    const fastest = (held !== overall ? held : undefined)
      ?? first(target.ok.filter((s) => s !== overall && FAST_ENOUGH.has(s.quality.tier)), sooner);
    if (fastest) picks.push({ kind: 'fastest', source: fastest, folder: folderOf(fastest) });
  }

  /* The release: a folder of two or more tracks with nothing in it the rules
   * or the size check object to. The record with the most copies wins, and
   * its copies are already ranked best first (completeness, then score). */
  const folders = pool.releases.filter((r) => r.trackCount >= 2 && r.suspectCount === 0
    && r.files.every((f) => !f.private) && judgeRelease(r.files, rules).allowed);
  const records = [...new Set(groupCopies(folders).values())];
  const record = first(records, (a, b) => b.length - a.length || b[0].score - a[0].score);
  const release = folders.find((r) => r.id === pins.release)
    ?? steady(folders.find((r) => r.id === shown.release), records, record, rules);
  if (release) picks.push({ kind: 'release', release });

  return picks;
}
