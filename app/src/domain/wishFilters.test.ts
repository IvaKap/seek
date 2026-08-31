/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A wish runs unattended, so the list has to answer "what will this accept?"
 * without being opened. These pin the wording, and in particular the two
 * silences: an unset filter says nothing, and the buddy-only default says
 * nothing — it is only worth a word when it has been turned OFF.
 */

import { describe, expect, it } from 'vitest';
import { describeFilters } from './wishFilters.ts';
import type { WishFilters } from '../ui/WishlistView.tsx';

const NONE: WishFilters = {
  formats: [], losslessOnly: false, minBitrate: null,
  durationMin: null, durationMax: null, sizeMin: null, sizeMax: null,
  excludeTranscodes: false, freeSlotsOnly: false, minSpeed: null,
  maxQueue: null, include: '', exclude: '', hidePrivate: true,
};
const f = (over: Partial<WishFilters> = {}) => describeFilters({ ...NONE, ...over });

describe('describeFilters', () => {
  it('says nothing when nothing is set', () => {
    // Callers test the string directly, so "no filters" must be falsy rather
    // than a placeholder they would have to keep in step.
    expect(f()).toBe('');
  });

  it('names the formats', () => {
    expect(f({ formats: ['FLAC', 'WAV'] })).toBe('FLAC/WAV');
  });

  it('does not say "lossless" as well as a format list', () => {
    // Both together read as two conditions where there is one.
    expect(f({ formats: ['FLAC'], losslessOnly: true })).toBe('FLAC');
  });

  it('says lossless when no format list narrows it', () => {
    expect(f({ losslessOnly: true })).toBe('lossless');
  });

  it('reads a bounded range as a range, and a single bound as a direction', () => {
    expect(f({ durationMin: 60, durationMax: 600 })).toContain('1m–10m');
    expect(f({ durationMin: 60 })).toContain('over 1m');
    expect(f({ durationMax: 600 })).toContain('under 10m');
  });

  it('sizes read in human units', () => {
    expect(f({ sizeMin: 50_000_000 })).toContain('over 50 MB');
  });

  it('joins several conditions', () => {
    expect(f({ formats: ['FLAC'], excludeTranscodes: true, freeSlotsOnly: true }))
      .toBe('FLAC · no transcodes · free slots');
  });

  it('quotes the word filters', () => {
    expect(f({ include: 'vinyl rip' })).toContain('with “vinyl rip”');
    expect(f({ exclude: 'live' })).toContain('without “live”');
  });

  it('ignores whitespace-only word filters', () => {
    expect(f({ include: '   ', exclude: '  ' })).toBe('');
  });

  it('SAYS NOTHING about hiding buddy-only results, because that is the default', () => {
    expect(f({ hidePrivate: true })).toBe('');
  });

  it('but says so when they have been let back in', () => {
    // The absence of the default is the news, not its presence.
    expect(f({ hidePrivate: false })).toBe('buddy-only included');
  });
});
