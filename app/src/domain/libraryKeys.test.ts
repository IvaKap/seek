/*
 * The library normaliser is mirrored in sidecar/library.py. If the two drift,
 * every search result reads as unowned and the feature silently does nothing —
 * which looks like an empty collection rather than a bug. These are the exact
 * strings verified against the Python implementation; treat a failure here as
 * "the two files disagree", not "the expectation is stale".
 */
import { describe, expect, it } from 'vitest';
import { normalise, releaseKey, trackKey } from '../data/libraryStore.ts';

describe('library key normalisation', () => {
  const cases: Array<[string, string]> = [
    ['Burial - Untrue (2007) [FLAC]', 'burial untrue'],
    ['Burial — Untrue [Remastered]', 'burial untrue'],
    ['Aphex Twin', 'aphex twin'],
    ['Various Artists - VA Compilation 2019 WEB', 'various artists compilation 2019'],
    ['Skyra & Hamatsuki', 'skyra hamatsuki'],
    ['IGOR (2019) FLAC WEB', 'igor'],
    ['Boards of Canada - Music Has the Right to Children (24bit)',
      'boards of canada music has the right to children'],
    ['[op.disc 022] Various - Hub Opus', 'various hub opus'],
    ['#Y0', 'y0'],
    ['Tyler, The Creator', 'tyler the creator'],
  ];

  for (const [input, expected] of cases) {
    it(`normalises ${JSON.stringify(input)}`, () => {
      expect(normalise(input)).toBe(expected);
    });
  }

  it('collapses release-folder noise to one key', () => {
    expect(releaseKey('Burial', 'Untrue (2007) [FLAC]'))
      .toBe(releaseKey('burial', 'Untrue [Remastered]'));
  });

  it('drops the empty side rather than leaving a bare separator', () => {
    expect(releaseKey(null, 'Untrue')).toBe('untrue');
    expect(trackKey('', 'Archangel')).toBe('archangel');
  });
});
