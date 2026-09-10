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
import { pickAutoCandidate } from './autoWishlist.ts';
import type { WishFilters } from './types.ts';

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
