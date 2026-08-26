/*
 * Seek — peer overlap.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { overlapWith } from './overlap.ts';
import { releaseKey } from '../data/libraryStore.ts';

const own = (...pairs: Array<[string, string]>) =>
  new Set(pairs.map(([a, r]) => releaseKey(a, r)));

describe('overlapWith', () => {
  it('counts a release the peer shares and you own', () => {
    const result = overlapWith(
      ['@@abc\\Music\\Burial - Untrue (2007) [FLAC]\\03 - Archangel.flac'],
      own(['Burial', 'Untrue']),
    );
    expect(result.count).toBe(1);
    expect(result.examples[0]).toContain('Untrue');
  });

  it('counts RELEASES, not files', () => {
    // A twelve-track album you own is one thing in common, not twelve.
    const paths = Array.from({ length: 12 }, (_x, i) => (
      `@@abc\\Burial - Untrue (2007)\\${String(i + 1).padStart(2, '0')} - Track.flac`
    ));
    expect(overlapWith(paths, own(['Burial', 'Untrue'])).count).toBe(1);
  });

  it('ignores what you do not own', () => {
    const result = overlapWith(
      ['@@abc\\Music\\Actress - Splazsh\\01 - Hubble.flac'],
      own(['Burial', 'Untrue']),
    );
    expect(result.count).toBe(0);
    expect(result.examples).toEqual([]);
  });

  it('is zero against an empty library rather than an error', () => {
    expect(overlapWith(['@@a\\B - C\\1.flac'], new Set()).count).toBe(0);
  });

  it('is zero for a peer sharing nothing', () => {
    expect(overlapWith([], own(['Burial', 'Untrue'])).count).toBe(0);
  });

  it('keeps only a few examples, however large the overlap', () => {
    const paths = ['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map((n) => `@@x\\${n} - ${n}\\1.flac`);
    const owned = new Set(['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map((n) => releaseKey(n, n)));
    const result = overlapWith(paths, owned);
    expect(result.count).toBe(5);
    expect(result.examples.length).toBe(3);
  });

  it('matches the way the rest of the app matches', () => {
    // Same normalisation as the library index: the year, the format tag and
    // the case must not stop a release recognising itself.
    const result = overlapWith(
      ['@@abc\\BURIAL - untrue (2007) [FLAC 16-44]\\01 - Untitled.flac'],
      own(['Burial', 'Untrue']),
    );
    expect(result.count).toBe(1);
  });

  it('handles a big share without a big cost', () => {
    // 10,000 files against a 5,000-release library. The Set is what makes this
    // O(shares) rather than O(library × shares).
    const paths = Array.from({ length: 10_000 }, (_x, i) =>
      `@@x\\Artist${i % 500} - Release${i % 500}\\0${i % 9}.flac`);
    const owned = new Set(Array.from({ length: 5_000 }, (_x, i) =>
      releaseKey(`Artist${i}`, `Release${i}`)));

    const started = performance.now();
    const result = overlapWith(paths, owned);
    expect(result.count).toBe(500);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
