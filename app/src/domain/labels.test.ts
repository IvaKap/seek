/*
 * Seek — watched catalogue progress.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { describeProgress, describeRemaining, isStale } from './labels.ts';
import type { LabelCounts } from './labels.ts';
import { sameCatalogue } from '../data/labelStore.ts';
import type { WatchedLabel } from '../data/labelStore.ts';

const NOW = Date.now() / 1000;

function counts(over: Partial<LabelCounts> = {}): LabelCounts {
  return {
    lastSeenAt: NOW - 3600,
    releaseCount: 312,
    ownedCount: 47,
    wantedCount: 9,
    ...over,
  };
}

describe('describeProgress', () => {
  it('reports a reading with the count it found', () => {
    const p = describeProgress(counts());
    expect(p.read).toBe(true);
    expect(p.summary).toBe('47 of 312 in your library');
    expect(p.when).toMatch(/hour/);
  });

  /* The whole honesty rule: never a live figure, always "when you last
   * looked". The caller renders `when` beside `summary`. */
  it('always carries when the reading was taken', () => {
    expect(describeProgress(counts()).when).not.toBe('');
  });

  it('distinguishes never-opened from opened-and-empty', () => {
    const never = describeProgress(counts({ lastSeenAt: null, releaseCount: null }));
    expect(never.read).toBe(false);
    expect(never.summary).toBe('Not opened yet');
    expect(never.when).toBe('');
    expect(never.fraction).toBeNull();

    const empty = describeProgress(counts({ releaseCount: 0, ownedCount: 0, wantedCount: 0 }));
    expect(empty.read).toBe(true);
    expect(empty.summary).toBe('No releases found');
    expect(empty.remaining).toBe(0);
  });

  it('treats a missing release count as never read even with a timestamp', () => {
    expect(describeProgress(counts({ releaseCount: null })).read).toBe(false);
  });

  it('drops the ownership clause when nothing is owned', () => {
    const p = describeProgress(counts({ ownedCount: 0 }));
    expect(p.summary).toBe('312 releases');
  });

  it('says release, singular, for one', () => {
    expect(describeProgress(counts({ releaseCount: 1, ownedCount: 0, wantedCount: 0 })).summary)
      .toBe('1 release');
  });

  it('computes what is left after owned and wanted', () => {
    const p = describeProgress(counts());
    expect(p.remaining).toBe(312 - 47 - 9);
    expect(p.fraction).toBeCloseTo(56 / 312);
  });

  /* Owned and wanted are counted separately and a release can be BOTH —
   * already in the library and still on the want list from before it arrived.
   * "313 of 312" would read as a bug on a screen whose job is to be trusted. */
  it('never accounts for more than the catalogue holds', () => {
    const p = describeProgress(counts({ releaseCount: 10, ownedCount: 8, wantedCount: 7 }));
    expect(p.remaining).toBe(0);
    expect(p.fraction).toBe(1);
  });

  it('copes with null owned and wanted alongside a real total', () => {
    const p = describeProgress(counts({ ownedCount: null, wantedCount: null }));
    expect(p.summary).toBe('312 releases');
    expect(p.remaining).toBe(312);
  });
});

describe('describeRemaining', () => {
  it('names the want list and what is untouched', () => {
    expect(describeRemaining(counts())).toBe('9 on your want list · 256 neither');
  });

  /* A row of zeros trains you to stop reading the row. */
  it('says nothing about an untouched catalogue beyond the headline', () => {
    expect(describeRemaining(counts({ ownedCount: 0, wantedCount: 0, releaseCount: 0 })))
      .toBe('');
  });

  it('omits the want list clause when nothing is wanted', () => {
    expect(describeRemaining(counts({ wantedCount: 0 }))).toBe('265 neither');
  });

  it('says nothing at all for a catalogue never opened', () => {
    expect(describeRemaining(counts({ lastSeenAt: null, releaseCount: null }))).toBe('');
  });

  it('says nothing when everything is accounted for', () => {
    expect(describeRemaining(counts({ releaseCount: 10, ownedCount: 10, wantedCount: 0 })))
      .toBe('');
  });
});

describe('isStale', () => {
  it('is false for a fresh reading', () => {
    expect(isStale(counts({ lastSeenAt: NOW - 60 }), NOW)).toBe(false);
  });

  it('is true past a week', () => {
    expect(isStale(counts({ lastSeenAt: NOW - 8 * 86_400 }), NOW)).toBe(true);
  });

  /* Never opened is not stale — there is nothing to refresh, and nagging
   * about it would fire on every row the moment it is added. */
  it('is false for something never opened', () => {
    expect(isStale(counts({ lastSeenAt: null }), NOW)).toBe(false);
  });
});

/* `sameCatalogue` mirrors `_label_identity` in the sidecar. If the two
 * disagree, pressing Watch on something already watched silently does nothing
 * and the button never changes — so the cases here match test_labels.py's. */
describe('sameCatalogue', () => {
  function watched(over: Partial<WatchedLabel> = {}): WatchedLabel {
    return {
      id: 'l1', sourceKind: 'discogs', kind: 'label', name: 'Hyperdub',
      url: 'https://www.discogs.com/label/1119', entityId: 1119,
      addedAt: NOW, lastSeenAt: null, releaseCount: null,
      ownedCount: null, wantedCount: null, note: '', ...over,
    };
  }

  it('matches on the numeric id across a rename and a URL rewrite', () => {
    expect(sameCatalogue(
      { sourceKind: 'discogs', kind: 'label', name: 'Hyperdub Records', entityId: 1119,
        url: 'https://discogs.com/label/1119/' },
      watched(),
    )).toBe(true);
  });

  it('falls back to the URL, ignoring case and a trailing slash', () => {
    expect(sameCatalogue(
      { sourceKind: 'bandcamp', kind: 'label', name: 'x',
        url: 'https://HyperDub.bandcamp.com/music/' },
      watched({ sourceKind: 'bandcamp', entityId: null,
        url: 'https://hyperdub.bandcamp.com/music' }),
    )).toBe(true);
  });

  it('falls back to the name when neither has an id or a URL', () => {
    expect(sameCatalogue(
      { sourceKind: 'discogs', kind: 'label', name: '  hyperdub  ' },
      watched({ entityId: null, url: '' }),
    )).toBe(true);
  });

  it('separates a label from an artist of the same name', () => {
    expect(sameCatalogue(
      { sourceKind: 'discogs', kind: 'artist', name: 'Aphex Twin' },
      watched({ kind: 'label', name: 'Aphex Twin', entityId: null, url: '' }),
    )).toBe(false);
  });

  it('separates the same name on two providers', () => {
    expect(sameCatalogue(
      { sourceKind: 'bandcamp', kind: 'label', name: 'Hyperdub', url: 'https://h.bandcamp.com/music' },
      watched({ entityId: null, url: '' }),
    )).toBe(false);
  });

  /* One side having an id and the other not means we cannot tell, and
   * guessing yes would silently merge two catalogues. */
  it('refuses to match when only one side carries an id', () => {
    expect(sameCatalogue(
      { sourceKind: 'discogs', kind: 'label', name: 'Hyperdub', entityId: 1119 },
      watched({ entityId: null, url: '' }),
    )).toBe(false);
  });

  it('separates two genuinely different labels', () => {
    expect(sameCatalogue(
      { sourceKind: 'discogs', kind: 'label', name: 'Livity Sound', entityId: 52340 },
      watched(),
    )).toBe(false);
  });
});
