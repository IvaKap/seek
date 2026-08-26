/*
 * Seek — gathering and ranking the copies of an album.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The behaviour that matters is that COMPLETENESS WINS. A flawless source
 * missing four tracks is not a better copy of the record than a decent one
 * with all of them, and a scoring function that lets speed outrank a missing
 * third of the album is how you end up with a folder you have to re-download.
 *
 * The ranking no longer picks anything to download — it orders a comparison the
 * user reads. What that ordering must never do is invent a relationship it
 * cannot back up, which is what `groupCopies` is pinned on below.
 */

import { describe, expect, it } from 'vitest';
import {
  chooseCopy, completeness, copiesOf, copyScore, groupCopies, medianTrackCount, rankCopies,
  releaseMatches,
} from './bestSources.ts';
import type { Release } from './types.ts';

function release(over: Partial<Release> & { user: string }): Release {
  return {
    id: `${over.user}/x`, folder: 'Untrue', folderPath: `@@x\\Music\\Untrue`,
    artist: 'Burial', title: 'Untrue', trackCount: 13, score: 0.5,
    files: [],
    ...over,
  } as unknown as Release;
}

describe('releaseMatches', () => {
  it('sees through folder decoration', () => {
    expect(releaseMatches(
      release({ user: 'a', title: 'Untrue' }),
      release({ user: 'b', title: 'UNTRUE' }),
    )).toBe(true);
  });

  it('tolerates one side having no artist, which is common', () => {
    expect(releaseMatches(
      release({ user: 'a' }), release({ user: 'b', artist: null }),
    )).toBe(true);
  });

  it('does not merge different records or different artists', () => {
    const a = release({ user: 'a' });
    expect(releaseMatches(a, release({ user: 'b', title: 'Kindred' }))).toBe(false);
    expect(releaseMatches(a, release({ user: 'b', artist: 'Someone Else' }))).toBe(false);
  });
});

describe('copyScore', () => {
  it('ranks a complete album above a much faster incomplete one', () => {
    const full = release({ user: 'slow', trackCount: 13, score: 0.1 });
    const part = release({ user: 'fast', trackCount: 9, score: 0.9 });
    expect(copyScore(full, 13)).toBeGreaterThan(copyScore(part, 13));
  });

  it('lets a far better source win by ONE missing track, but not by four', () => {
    // The line is deliberate: one absent track is worth trading for a much
    // better source, a third of the record is not.
    const best = release({ user: 'best', trackCount: 13, score: 0.0 });
    const oneShort = release({ user: 'one', trackCount: 12, score: 1.0 });
    const fourShort = release({ user: 'four', trackCount: 9, score: 1.0 });
    expect(copyScore(oneShort, 13)).toBeGreaterThan(copyScore(best, 13));
    expect(copyScore(fourShort, 13)).toBeLessThan(copyScore(best, 13));
  });

  it('falls back to the app score when both are complete', () => {
    const a = release({ user: 'a', trackCount: 13, score: 0.9 });
    const b = release({ user: 'b', trackCount: 13, score: 0.2 });
    expect(copyScore(a, 13)).toBeGreaterThan(copyScore(b, 13));
  });
});

describe('medianTrackCount', () => {
  it('is not dragged upwards by one bloated folder', () => {
    // Measured live: one "copy" of Untrue carried 26 files. Against a maximum
    // every genuine 13-track copy scored 50% complete and lost.
    const copies = [13, 13, 13, 13, 26].map(
      (n, i) => release({ user: `p${i}`, trackCount: n }),
    );
    expect(medianTrackCount(copies)).toBe(13);
  });

  it('is zero for nothing at all', () => {
    expect(medianTrackCount([])).toBe(0);
  });
});

describe('chooseCopy', () => {
  it('does not prefer a bloated folder over a normal complete one', () => {
    const normal = release({ user: 'normal', trackCount: 13, score: 0.6 });
    const others = [13, 13, 13].map((n, i) => release({ user: `o${i}`, trackCount: n, score: 0.1 }));
    const bloated = release({ user: 'bloated', trackCount: 26, score: 0.2 });
    const choice = chooseCopy(normal, [normal, ...others, bloated]);
    expect(choice.release.user).toBe('normal');
  });

  it('ranks a better peer above the clicked copy without taking it', () => {
    // Ranking only. The clicked copy is still in `candidates`, and what gets
    // downloaded is decided by the user clicking a row, not by this order.
    const clicked = release({ user: 'deadpeer', score: 0.05 });
    const better = release({ user: 'goodpeer', score: 0.95 });
    const choice = chooseCopy(clicked, [clicked, better]);
    expect(choice.release.user).toBe('goodpeer');
    expect(choice.candidates.map((r) => r.user)).toEqual(['goodpeer', 'deadpeer']);
  });

  it('leaves the clicked copy on top when it is already the best', () => {
    const clicked = release({ user: 'good', score: 0.9 });
    const worse = release({ user: 'bad', score: 0.1 });
    const choice = chooseCopy(clicked, [clicked, worse]);
    expect(choice.release.user).toBe('good');
  });

  it('puts a fuller copy above a shorter, faster one', () => {
    const clicked = release({ user: 'short', trackCount: 9, score: 0.9 });
    const full = release({ user: 'full', trackCount: 13, score: 0.5 });
    const choice = chooseCopy(clicked, [clicked, full]);
    expect(choice.candidates.map((r) => r.user)).toEqual(['full', 'short']);
  });

  it('ignores releases that are not the same record', () => {
    const clicked = release({ user: 'a', score: 0.1 });
    const other = release({ user: 'b', title: 'Kindred', score: 0.99 });
    expect(chooseCopy(clicked, [clicked, other]).release.user).toBe('a');
  });

  it('never returns nothing, even with an empty candidate list', () => {
    const clicked = release({ user: 'a' });
    expect(chooseCopy(clicked, []).release).toBe(clicked);
  });

  it('does not count the same peer folder twice', () => {
    const clicked = release({ user: 'a' });
    expect(chooseCopy(clicked, [clicked, clicked, clicked]).candidates).toHaveLength(1);
  });
});

describe('groupCopies', () => {
  it('gathers every peer holding the same record into one group', () => {
    const copies = ['a', 'b', 'c'].map((u) => release({ user: u }));
    const groups = groupCopies(copies);
    expect(copiesOf(copies[0], groups)).toHaveLength(3);
    // Every member sees the SAME group, so a count on a card and the list
    // inside the comparison cannot disagree in front of the user.
    expect(copiesOf(copies[2], groups)).toBe(copiesOf(copies[0], groups));
  });

  it('orders each group the way the ranking does', () => {
    const copies = [
      release({ user: 'short', trackCount: 9, score: 0.9 }),
      release({ user: 'full', trackCount: 13, score: 0.5 }),
    ];
    expect(copiesOf(copies[0], groupCopies(copies)).map((r) => r.user))
      .toEqual(rankCopies(copies).map((r) => r.user));
  });

  it('keeps different records apart', () => {
    const untrue = release({ user: 'a' });
    const kindred = release({ user: 'b', title: 'Kindred' });
    const groups = groupCopies([untrue, kindred]);
    expect(copiesOf(untrue, groups)).toHaveLength(1);
    expect(copiesOf(kindred, groups)).toHaveLength(1);
  });

  it('gives an artist-less copy to the one artist its bucket names', () => {
    const named = release({ user: 'a' });
    const bare = release({ user: 'b', artist: null });
    expect(copiesOf(bare, groupCopies([named, bare]))).toHaveLength(2);
  });

  it('never welds two artists together through an artist-less copy', () => {
    /* The trap. `releaseMatches` says a missing artist matches ANY artist,
     * which is not transitive: taken as a grouping rule, one bare folder would
     * make Burial's record and someone else's same-titled record into a single
     * thing, and the comparison would offer the wrong album as a copy. */
    const burial = release({ user: 'a', artist: 'Burial' });
    const other = release({ user: 'b', artist: 'Someone Else' });
    const bare = release({ user: 'c', artist: null });
    const groups = groupCopies([burial, other, bare]);
    expect(copiesOf(burial, groups).map((r) => r.user)).toEqual(['a']);
    expect(copiesOf(other, groups).map((r) => r.user)).toEqual(['b']);
    // It stands alone rather than being assigned to a guess.
    expect(copiesOf(bare, groups).map((r) => r.user)).toEqual(['c']);
  });

  it('does not group a folder it cannot name', () => {
    const unnamed = release({ user: 'a', title: '' });
    const named = release({ user: 'b' });
    expect(copiesOf(unnamed, groupCopies([unnamed, named]))).toEqual([unnamed]);
  });

  it('counts one peer folder once, however many times it arrives', () => {
    const copy = release({ user: 'a' });
    expect(copiesOf(copy, groupCopies([copy, copy, copy]))).toHaveLength(1);
  });

  it('always offers the copy the user clicked', () => {
    /* The comparison is the only place a download now starts from, so a copy
     * missing from its own comparison would be a copy the user cannot choose —
     * the failure this whole change exists to prevent, in a new place. Holds
     * even for a record nothing else matches, and for one with no title. */
    const lonely = release({ user: 'a', title: 'Nothing Else Like It' });
    const unnamed = release({ user: 'b', title: '' });
    const groups = groupCopies([lonely, unnamed]);
    expect(copiesOf(lonely, groups)).toContain(lonely);
    expect(copiesOf(unnamed, groups)).toContain(unnamed);
  });
});

describe('completeness', () => {
  it('reports the range the copies actually span', () => {
    const copies = [6, 13, 10].map((n, i) => release({ user: `p${i}`, trackCount: n }));
    const c = completeness(copies);
    expect(c?.low).toBe(6);
    expect(c?.high).toBe(13);
    expect(c?.fullest.user).toBe('p1');
    expect(c?.disagree).toBe(true);
  });

  it('will not call a copy short without a catalogue count to prove it', () => {
    /* THE HONESTY TEST. Nine copies at six tracks and one at ten tell you the
     * peers disagree. They do not tell you the record has more than ten tracks,
     * so nothing here may claim the fullest copy is incomplete. */
    const copies = [6, 6, 6, 10].map((n, i) => release({ user: `p${i}`, trackCount: n }));
    const c = completeness(copies);
    expect(c?.disagree).toBe(true);
    expect(c?.short).toBe(false);
    expect(c?.catalogue).toBe(null);
  });

  it('calls a copy short when MusicBrainz proves it', () => {
    const copies = [9, 11].map((n, i) => release({ user: `p${i}`, trackCount: n }));
    const c = completeness(copies, 13);
    expect(c?.short).toBe(true);
    expect(c?.catalogue).toBe(13);
    expect(c?.fullest.trackCount).toBe(11);
  });

  it('is content when a copy meets the catalogue count', () => {
    const copies = [9, 13].map((n, i) => release({ user: `p${i}`, trackCount: n }));
    expect(completeness(copies, 13)?.short).toBe(false);
  });

  it('has nothing to say about no copies at all', () => {
    expect(completeness([])).toBe(null);
  });
});
