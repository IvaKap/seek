/*
 * Seek — choosing a copy, against a real recorded search.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `bestSources.test.ts` pins the rules with hand-built releases. This pins the
 * OUTCOME against `fixtures/search-burial.ndjson` — a real Soulseek search,
 * with twenty-four copies of Untrue in it and all the filename chaos that
 * implies.
 *
 * It exists because an earlier per-track design looked right against
 * hand-built data and fell apart on this: real rips disagree about numbering,
 * some carry no titles, and some leave the number inside the title.
 *
 * The comparison the user now drives is built on the grouping pinned below, so
 * the same fixture guards it: the copies offered as "the same record" have to
 * be the same record, on data where the folder names are
 * `!!! BURIAL - UNTRUE (2007) WEB FLAC !!!` and `2007 - Untrue`.
 */

import { describe, expect, it } from 'vitest';
import { createGrouper } from './group.ts';
import { adaptSearchResult, isAudioPath } from '../data/adapt.ts';
import type { WireFile } from './types.ts';
import {
  chooseCopy, completeness, copiesOf, groupCopies, releaseMatches,
} from './bestSources.ts';
// `?raw` rather than node:fs: this is a Vite project and the app's tsconfig
// carries no node types.
import raw from '../../../fixtures/search-burial.ndjson?raw';

function realSearch() {
  const grouper = createGrouper();
  let tick = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const { frame } = JSON.parse(line);
    if (frame.ev !== 'search.result') continue;
    tick += 1;
    // Exactly what searchStore does: non-audio files are not results.
    const audio = {
      ...frame.data,
      files: frame.data.files.filter((f: WireFile) => isAudioPath(f.path)),
    };
    if (audio.files.length === 0) continue;
    for (const source of adaptSearchResult(audio, tick, () => 0.5)) grouper.add(source);
  }
  return grouper.releases(grouper.all);
}

describe('choosing a copy from a real search', () => {
  const releases = realSearch();
  const target = releases.filter((r) => /untrue/i.test(r.title))[0];

  it('finds the album spread across many peers', () => {
    const copies = releases.filter((r) => r === target || releaseMatches(target, r));
    expect(copies.length).toBeGreaterThan(10);
  });

  it('chooses exactly one copy — never an assembly of many', () => {
    const choice = chooseCopy(target, releases);
    expect(choice.release).toBeTruthy();
    expect(choice.candidates.length).toBeGreaterThan(10);
    // The whole point of the album-level design: one folder, one peer.
    expect(choice.release.user).toBeTruthy();
  });

  it('never chooses a copy shorter than the one clicked', () => {
    // Completeness dominates the ranking, so switching can only ever hold or
    // improve the track count.
    const choice = chooseCopy(target, releases);
    expect(choice.release.trackCount).toBeGreaterThanOrEqual(target.trackCount);
  });

  it('chooses a copy that really is the same record', () => {
    const choice = chooseCopy(target, releases);
    expect(releaseMatches(target, choice.release)).toBe(true);
  });
});

describe('gathering the copies of a record from a real search', () => {
  const releases = realSearch();
  const target = releases.filter((r) => /untrue/i.test(r.title))[0];
  const groups = groupCopies(releases);
  const copies = copiesOf(target, groups);

  it('finds the copies the pairwise test finds', () => {
    /* Two notions of "the same record" would let the count on the card and the
     * list inside the comparison disagree in front of the user. The bucketing
     * is an optimisation of `releaseMatches`, not a second opinion. */
    const pairwise = releases.filter((r) => r === target || releaseMatches(target, r));
    expect(copies.length).toBe(pairwise.length);
    expect(copies.length).toBeGreaterThan(10);
  });

  it('hands every member of a group the same list', () => {
    for (const copy of copies) expect(copiesOf(copy, groups)).toBe(copies);
  });

  it('never lets a different record into the group', () => {
    for (const copy of copies) expect(releaseMatches(target, copy)).toBe(true);
  });

  it('offers the ranking as the order, and queues nothing', () => {
    expect(copies.map((r) => r.id)).toEqual(chooseCopy(target, releases).candidates.map((r) => r.id));
  });

  it('reports the real spread of track counts across those copies', () => {
    /* Measured on this fixture: the copies run from short folders to full
     * thirteens. The spread is a fact about the peers and is shown as one. */
    const state = completeness(copies);
    expect(state?.disagree).toBe(true);
    expect(state?.low).toBeLessThan(state!.high);
    expect(state?.fullest.trackCount).toBe(state?.high);
  });

  it('will not call these copies short without a catalogue count', () => {
    expect(completeness(copies)?.short).toBe(false);
  });

  it('is content once a copy meets the catalogue count', () => {
    // Untrue is 13 tracks, and this search really does contain whole copies.
    const state = completeness(copies, 13);
    expect(state?.high).toBeGreaterThanOrEqual(13);
    expect(state?.short).toBe(false);
  });
});
