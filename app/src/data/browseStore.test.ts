/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it } from 'vitest';
import { enrichFile, filterShelves, toShelves } from './browseStore.ts';
import type { WireFileRef } from './adapt.ts';

function flac(overrides: Partial<WireFileRef> = {}): WireFileRef {
  return {
    path: 'Artist\\Album\\track.flac', size: 30_000_000, bitrate: null,
    duration: 240, sampleRate: 44100, bitDepth: 16, isVbr: null,
    ...overrides,
  };
}

describe('enrichFile', () => {
  it('carries every wire field through, unlike the old {path, size} shape', () => {
    const f = enrichFile(flac());
    expect(f.bitrate).toBeNull();
    expect(f.duration).toBe(240);
    expect(f.sampleRate).toBe(44100);
    expect(f.bitDepth).toBe(16);
  });

  it('computes a real quality assessment, the same way search results do', () => {
    const f = enrichFile(flac());
    expect(f.quality.lossless).toBe(true);
    expect(f.transcode.verdict).toBe('ok');
  });

  it('flags a suspiciously small file claiming to be lossless', () => {
    const f = enrichFile(flac({ size: 500_000 }));
    expect(f.transcode.verdict).toBe('inferred-transcode');
  });

  it('classifies a lossy file from its bitrate, not its extension', () => {
    const f = enrichFile(flac({
      path: 'Artist\\Album\\track.mp3', size: 9_600_000, bitrate: 320, bitDepth: null, sampleRate: null,
    }));
    expect(f.quality.lossless).toBe(false);
    expect(f.quality.tier).toBe('high');
  });

  it('parses a display title, the same way search results do', () => {
    const f = enrichFile(flac({ path: 'Burial\\Untrue (2007)\\01 - Burial - Archangel.flac' }));
    expect(f.parsed.displayTitle).toBe('Archangel');
    expect(f.parsed.displayArtist).toBe('Burial');
  });
});

describe('toShelves with enriched files', () => {
  it('still groups by folder, now carrying quality on each file', () => {
    const shelves = toShelves([
      { path: 'Artist\\Album', private: false, files: [enrichFile(flac())] },
    ]);
    expect(shelves).toHaveLength(1);
    expect(shelves[0].files[0].quality.lossless).toBe(true);
  });
});

describe('filterShelves', () => {
  it('matches a filename inside a shelf whose own name/path says nothing about it', () => {
    // A compilation named for itself, not for the artists on it — the bug a
    // real 76k-file share surfaced: nothing about "Compilations\Big Room
    // Anthems (2019)" mentions the one track someone is actually looking for.
    const shelves = toShelves([{
      path: 'Compilations\\Big Room Anthems (2019)', private: false,
      files: [enrichFile(flac({ path: 'Compilations\\Big Room Anthems (2019)\\03 Hamatsuki - Uncertain Loops.flac' }))],
    }]);
    expect(filterShelves(shelves, 'hamatsuki')).toHaveLength(1);
  });

  it('still matches on the shelf name, artist and path as before', () => {
    const shelves = toShelves([
      { path: 'Burial\\Untrue (2007)', private: false, files: [enrichFile(flac({ path: 'Burial\\Untrue (2007)\\01 Archangel.flac' }))] },
    ]);
    expect(filterShelves(shelves, 'untrue')).toHaveLength(1);
    expect(filterShelves(shelves, 'burial')).toHaveLength(1);
  });

  it('excludes a shelf that matches nowhere', () => {
    const shelves = toShelves([
      { path: 'Burial\\Untrue (2007)', private: false, files: [enrichFile(flac({ path: 'Burial\\Untrue (2007)\\01 Archangel.flac' }))] },
    ]);
    expect(filterShelves(shelves, 'nonexistent')).toHaveLength(0);
  });

  it('is a no-op for an empty query', () => {
    const shelves = toShelves([
      { path: 'A', private: false, files: [enrichFile(flac({ path: 'A\\x.flac' }))] },
    ]);
    expect(filterShelves(shelves, '  ')).toBe(shelves);
  });
});
