/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it } from 'vitest';
import { matchesQuery, sortGroups } from './transferOrder.ts';
import type { TransferGroup } from '../data/transferStore.ts';

function g(over: Partial<TransferGroup> = {}): TransferGroup {
  return {
    key: over.title ?? 'k',
    username: 'peer',
    folder: 'f',
    title: 'Untrue',
    transfers: [],
    size: 100,
    bytesDone: 0,
    speed: 0,
    active: 0,
    finished: 0,
    failed: 0,
    stalled: false,
    quietFor: 0,
    state: 'active',
    ...over,
  };
}

const titles = (list: TransferGroup[]) => list.map((x) => x.title);

describe('sortGroups', () => {
  it('does not mutate the array the store owns', () => {
    /* The store hands the SAME array to every reader; sorting it in place would
     * reorder the other lenses as a side effect of looking at this one. */
    const input = [g({ title: 'B' }), g({ title: 'A' })];
    const before = [...input];
    sortGroups(input, 'name', false);
    expect(input).toEqual(before);
  });

  it('puts what needs attention first by default', () => {
    const out = sortGroups([
      g({ title: 'done', state: 'finished' }),
      g({ title: 'going', state: 'active' }),
      g({ title: 'quiet', state: 'stalled' }),
    ], 'default', false);
    expect(titles(out)).toEqual(['going', 'quiet', 'done']);
  });

  it('applies an explicit order verbatim, ignoring state', () => {
    /* Choosing "Release name" and still getting active-first would read as the
     * sort being broken. An explicit choice overrides the default entirely. */
    const out = sortGroups([
      g({ title: 'Zeta', state: 'active' }),
      g({ title: 'Alpha', state: 'finished' }),
    ], 'name', false);
    expect(titles(out)).toEqual(['Alpha', 'Zeta']);
  });

  it('sorts by how far along, not by bytes', () => {
    /* A 90%-done 10 MB release is further along than a 10%-done 1 GB one, and
     * "how far along" has to mean the fraction or the column is just size. */
    const out = sortGroups([
      g({ title: 'big-early', size: 1000, bytesDone: 100 }),
      g({ title: 'small-late', size: 10, bytesDone: 9 }),
    ], 'progress', true);
    expect(titles(out)).toEqual(['small-late', 'big-early']);
  });

  it('breaks ties on title so the list does not reshuffle', () => {
    /* Two releases of equal size would otherwise swap on every progress tick,
     * and a list that moves while being read is worse than one sorted badly. */
    const input = [g({ title: 'B', size: 5 }), g({ title: 'A', size: 5 })];
    expect(titles(sortGroups(input, 'size', false))).toEqual(['A', 'B']);
    expect(titles(sortGroups([...input].reverse(), 'size', false))).toEqual(['A', 'B']);
  });

  it('sorts by the most recent completion in the group', () => {
    const out = sortGroups([
      g({ title: 'older', transfers: [{ finishedAt: 100 }, { finishedAt: 50 }] as never }),
      g({ title: 'newer', transfers: [{ finishedAt: 900 }] as never }),
    ], 'recent', true);
    expect(titles(out)).toEqual(['newer', 'older']);
  });

  it('reverses when asked', () => {
    const out = sortGroups([g({ title: 'A' }), g({ title: 'B' })], 'name', true);
    expect(titles(out)).toEqual(['B', 'A']);
  });
});

describe('matchesQuery', () => {
  it('matches the peer as well as the release', () => {
    /* A failed batch is very often one peer who went offline, so "everything
     * from this person" is the other question this box gets asked. */
    expect(matchesQuery(g({ username: 'sublow' }), 'sublow')).toBe(true);
  });

  it('requires every term, so two words narrow rather than widen', () => {
    const row = g({ title: 'Untrue', username: 'sublow' });
    expect(matchesQuery(row, 'untrue sublow')).toBe(true);
    expect(matchesQuery(row, 'untrue goldie')).toBe(false);
  });

  it('is case-insensitive and ignores stray whitespace', () => {
    expect(matchesQuery(g({ title: 'Untrue' }), '  UNTRUE ')).toBe(true);
  });

  it('matches everything when nothing was typed', () => {
    expect(matchesQuery(g(), '')).toBe(true);
    expect(matchesQuery(g(), '   ')).toBe(true);
  });
});
