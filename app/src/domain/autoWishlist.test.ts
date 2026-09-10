/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The auto-download qualifier: given what a wish found and the filters it is
 * judged by, pick the one file to grab — or nothing. Sources are built through
 * the real adapter (as privateResults.test.ts does) so the quality, score and
 * private flags are the genuine ones, not hand-set numbers a refactor could
 * drift away from.
 *
 * The load-bearing case is the one the feature request would get wrong on its
 * own: a "minimum bitrate" gate must never exclude FLAC, which advertises no
 * bitrate. Because the qualifier borrows `group.matches`, it gets that for free
 * — and this pins it so it stays true.
 */

import { describe, expect, it } from 'vitest';
import { adaptSearchResult } from '../data/adapt.ts';
import type { WireFileRef, WireSearchResultData } from '../data/adapt.ts';
import { pickAutoCandidate, planAutoDownloads } from './autoWishlist.ts';
import type { AutoWish } from './autoWishlist.ts';
import type { SourceFile, WishFilters } from './types.ts';

const NONE: WishFilters = {
  formats: [], losslessOnly: false, minBitrate: null, durationMin: null,
  durationMax: null, sizeMin: null, sizeMax: null, excludeTranscodes: false,
  freeSlotsOnly: false, minSpeed: null, maxQueue: null, include: '', exclude: '',
  hidePrivate: true,
};

const flac = (over: Partial<WireFileRef> = {}): WireFileRef => ({
  path: 'm\\Artist\\Album\\01 Track.flac',
  size: 38_000_000, bitrate: null, duration: 401,
  sampleRate: 44_100, bitDepth: 16, isVbr: null, ...over,
});

/** A lossy file whose size matches its advertised bitrate, so it is not itself
 *  flagged as a transcode — that concern is tested separately. */
const mp3 = (kbps: number, over: Partial<WireFileRef> = {}): WireFileRef => ({
  path: `m\\Artist\\Album\\01 Track ${kbps}.mp3`,
  size: Math.round((kbps * 1000 * 300) / 8),
  bitrate: kbps, duration: 300, sampleRate: null, bitDepth: null, isVbr: false, ...over,
});

function sources(files: WireFileRef[], over: Partial<WireSearchResultData> = {}) {
  const res: WireSearchResultData = {
    searchId: 1,
    peer: {
      username: 'a-peer', freeSlots: true, advertisedSpeed: 1_000_000,
      queueLength: 0, files: 1000, folders: 100, country: 'DE',
    },
    files, ...over,
  };
  return adaptSearchResult(res, 0, () => 0.5);
}

describe('pickAutoCandidate', () => {
  it('finds nothing in nothing', () => {
    expect(pickAutoCandidate([], NONE)).toBeNull();
  });

  it('with no filters, takes the highest-scoring file', () => {
    // FLAC outranks a 320 MP3, so it is the one a person would reach for too.
    const best = pickAutoCandidate(sources([mp3(320), flac()]), NONE);
    expect(best?.path.endsWith('.flac')).toBe(true);
  });

  it('lossless-only keeps only lossless, whatever the scores', () => {
    expect(pickAutoCandidate(sources([mp3(320), flac()]),
      { ...NONE, losslessOnly: true })?.path.endsWith('.flac')).toBe(true);
    expect(pickAutoCandidate(sources([mp3(320)]),
      { ...NONE, losslessOnly: true })).toBeNull();
  });

  it('does NOT exclude FLAC for a minimum-bitrate floor (the request’s trap)', () => {
    // FLAC advertises no bitrate; a naive gate rejects it. matches() — and so
    // the qualifier — treats lossless as satisfying any floor.
    const best = pickAutoCandidate(sources([flac()]), { ...NONE, minBitrate: 320 });
    expect(best).not.toBeNull();
    expect(best?.path.endsWith('.flac')).toBe(true);
  });

  it('applies a minimum-bitrate floor to lossy files', () => {
    expect(pickAutoCandidate(sources([mp3(192)]), { ...NONE, minBitrate: 256 })).toBeNull();
    expect(pickAutoCandidate(sources([mp3(320)]), { ...NONE, minBitrate: 256 })
      ?.path.includes('320')).toBe(true);
  });

  it('never picks a buddy-only result by default, even if it scores highest', () => {
    const srcs = [
      ...sources([flac()], { private: true }),      // higher score, but unreachable
      ...sources([mp3(320)], { private: false }),
    ];
    const best = pickAutoCandidate(srcs, NONE);
    expect(best?.private).toBe(false);
    expect(best?.path.endsWith('.mp3')).toBe(true);
  });

  it('treats a wish with null filters like the defaults (buddy-only hidden)', () => {
    const srcs = [
      ...sources([flac()], { private: true }),
      ...sources([mp3(320)], { private: false }),
    ];
    expect(pickAutoCandidate(srcs, null)?.private).toBe(false);
  });
});

describe('planAutoDownloads', () => {
  const wish = (query: string, auto: boolean): AutoWish => ({ query, auto, filters: null });
  const by = (query: string, files = [flac()]): Record<string, SourceFile[]> =>
    ({ [query]: sources(files) });

  it('plans a download for an auto wish with a qualifying result', () => {
    const plan = planAutoDownloads([wish('a', true)], by('a'), new Set(), 3);
    expect(plan).toHaveLength(1);
    expect(plan[0].query).toBe('a');
    expect(plan[0].source.path.endsWith('.flac')).toBe(true);
  });

  it('ignores wishes with auto off', () => {
    expect(planAutoDownloads([wish('a', false)], by('a'), new Set(), 3)).toEqual([]);
  });

  it('never plans a wish that already has a claim', () => {
    expect(planAutoDownloads([wish('a', true)], by('a'), new Set(['a']), 3)).toEqual([]);
  });

  it('skips a wish that found nothing qualifying', () => {
    expect(planAutoDownloads([wish('a', true)], {}, new Set(), 3)).toEqual([]);
  });

  it('honours the free-slots cap across many eligible wishes', () => {
    const wishes = [wish('a', true), wish('b', true), wish('c', true)];
    const srcs = { ...by('a'), ...by('b'), ...by('c') };
    expect(planAutoDownloads(wishes, srcs, new Set(), 2)).toHaveLength(2);
    expect(planAutoDownloads(wishes, srcs, new Set(), 0)).toEqual([]);
  });
});
