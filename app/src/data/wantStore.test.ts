/*
 * Seek — want list matching.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `resultsMatch` is the judgement the sidecar deliberately refuses to make:
 * given what came back from Soulseek, did we actually find the thing?
 *
 * The failure that matters is the GENEROUS one. A matcher that says yes too
 * easily marks every entry 'found' the moment any peer answers a loose query,
 * and a status column that is always the same value is decoration — the same
 * mistake docs/STATUS.md records about peer reliability scores.
 */

import { describe, expect, it } from 'vitest';
import { queryForEntry, resultsMatch } from './wantStore.ts';

const archangel = { artist: 'Burial', title: 'Archangel', album: null };
const untrue = { artist: 'Burial', title: 'Archangel', album: 'Untrue' };

describe('queryForEntry', () => {
  it('searches the track for a track', () => {
    expect(queryForEntry(archangel)).toBe('Burial Archangel');
  });

  it('searches the ALBUM when there is one — a DJ downloads folders', () => {
    expect(queryForEntry(untrue)).toBe('Burial Untrue');
  });

  it('copes with a missing artist without leaving whitespace', () => {
    expect(queryForEntry({ artist: '', title: 'Archangel', album: null }))
      .toBe('Archangel');
  });
});

describe('resultsMatch', () => {
  it('matches a real result for the entry', () => {
    expect(resultsMatch(archangel, ['Burial - Archangel'])).toBe(true);
  });

  it('matches when the result carries extra release furniture', () => {
    expect(resultsMatch(untrue, ['Burial Untrue (2007) [FLAC 16-44]'])).toBe(true);
  });

  it('ignores case, punctuation and diacritics', () => {
    expect(resultsMatch(
      { artist: 'Bjork', title: 'Joga', album: null },
      ['Björk — Jóga'],
    )).toBe(true);
  });

  it('does NOT match a different record by the same artist', () => {
    // The generous-direction failure. "Burial" appears; the track does not.
    expect(resultsMatch(archangel, ['Burial - Ghost Hardware'])).toBe(false);
  });

  it('does NOT match the same title by a different artist', () => {
    expect(resultsMatch(archangel, ['Two Steps From Hell - Archangel'])).toBe(false);
  });

  it('does not match on nothing at all', () => {
    expect(resultsMatch(archangel, [])).toBe(false);
    expect(resultsMatch({ artist: '', title: '', album: null }, ['anything'])).toBe(false);
  });

  it('accepts a result that omits the artist entirely, when the title is right', () => {
    // Plenty of correct results are bare track names inside a release folder,
    // and refusing those would mark real finds as not_found.
    expect(resultsMatch(
      { artist: '', title: 'Archangel', album: null },
      ['03 - Archangel.flac'],
    )).toBe(true);
  });

  it('takes any one of several candidates', () => {
    expect(resultsMatch(archangel, [
      'Some Compilation', 'Burial - Archangel', 'Unrelated',
    ])).toBe(true);
  });
});
