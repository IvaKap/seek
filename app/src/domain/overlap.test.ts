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

describe('the list behind the count', () => {
  /* The count used to be all there was, with three examples in a `title`
   * attribute. WHICH records overlap is the actual information. */

  it('returns every shared release, not just the examples', () => {
    const owned = new Set([
      releaseKey('Aphex Twin', 'Syro'),
      releaseKey('Burial', 'Untrue'),
      releaseKey('Boards of Canada', 'Geogaddi'),
      releaseKey('Autechre', 'Amber'),
    ]);
    const paths = [
      'Music\\Aphex Twin - Syro\\01 minipops.flac',
      'Music\\Burial - Untrue\\01 Archangel.flac',
      'Music\\Boards of Canada - Geogaddi\\01 Ready Lets Go.flac',
      'Music\\Autechre - Amber\\01 Foil.flac',
    ];
    const o = overlapWith(paths, owned);
    expect(o.count).toBe(4);
    expect(o.examples).toHaveLength(3);
    expect(o.releases).toHaveLength(4);
  });

  it('counts files per release, because one track is not the album', () => {
    const owned = new Set([releaseKey('Aphex Twin', 'Syro')]);
    const o = overlapWith([
      'Music\\Aphex Twin - Syro\\01 minipops.flac',
      'Music\\Aphex Twin - Syro\\02 XMAS_EVET10.flac',
      'Music\\Aphex Twin - Syro\\03 produk 29.flac',
    ], owned);
    // Still ONE thing in common...
    expect(o.count).toBe(1);
    // ...but knowing they have three of its tracks is the difference between
    // "they have the album" and "they have a single off it".
    expect(o.releases[0].files).toBe(3);
  });

  it('carries the peer folder, so the list can jump to it', () => {
    const owned = new Set([releaseKey('Burial', 'Untrue')]);
    const o = overlapWith(['Music\\Burial - Untrue\\01 Archangel.flac'], owned);
    expect(o.releases[0].folder).toContain('Untrue');
  });

  it('is empty rather than undefined when nothing overlaps', () => {
    /* The sheet maps over this unconditionally. */
    expect(overlapWith([], new Set(['x'])).releases).toEqual([]);
    expect(overlapWith(['a\\b.flac'], new Set()).releases).toEqual([]);
  });
});
