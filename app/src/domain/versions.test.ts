/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Versions: Simple's one list. A track's copies in one format and one size,
 * from however many people, are one row; a record's folders in one format are
 * another. Sources go through the real adapter, so formats, sizes and the size
 * check are the genuine ones.
 */

import { describe, expect, it } from 'vitest';
import { adaptSearchResult } from '../data/adapt.ts';
import type { WireFileRef, WireSearchResultData } from '../data/adapt.ts';
import { createGrouper } from './group.ts';
import { releaseVersions } from './bestSources.ts';

const UNTRUE = 'Music\\Burial - Untrue (2007)';
const flac = (path: string, size = 28_400_000): WireFileRef => ({
  path, size, bitrate: null, duration: 238, sampleRate: 44_100, bitDepth: 16, isVbr: null,
});
const mp3 = (path: string, kbps: number): WireFileRef => ({
  path, size: (kbps * 1000 * 238) / 8, bitrate: kbps, duration: 238, sampleRate: null, bitDepth: null, isVbr: false,
});

function answer(username: string, files: WireFileRef[]): WireSearchResultData {
  return {
    searchId: 1,
    peer: { username, freeSlots: true, advertisedSpeed: 1_000_000, queueLength: 0, files: 100, folders: 10, country: null },
    files,
  };
}

function grouped(...answers: WireSearchResultData[]) {
  const g = createGrouper();
  answers.forEach((a, i) => adaptSearchResult(a, i + 1, () => 0.5).forEach((s) => g.add(s)));
  return g;
}

const say = (t: { best: { quality: { label: string }; size: number }; sources: { user: string }[] }) =>
  `${t.best.quality.label} ${(t.best.size / 1e6).toFixed(1)} MB: ${t.sources.map((s) => s.user).sort().join(', ')}`;

describe('versions of a track', () => {
  const dave = answer('dave', [flac(`${UNTRUE}\\02 Archangel.flac`)]);
  // Re-tagged: a few hundred kilobytes more, the same file.
  const nightbus = answer('nightbus', [flac(`${UNTRUE}\\02 Archangel.flac`, 28_520_000)]);
  // A third of the size: the size check doubts it, and it is no copy of dave's.
  const hoarder = answer('flac_hoarder', [flac('Music\\Burial - Untrue\\02 Archangel.flac', 9_800_000)]);
  const hessle = answer('hessle_head', [mp3('Music\\Burial - Archangel (2007)\\01 Archangel.mp3', 320)]);

  it('one file shared by several people is one version; another format or size is another', () => {
    const g = grouped(dave, nightbus, hoarder, hessle);
    expect(g.versions(g.all).map(say).sort()).toEqual([
      '320 9.5 MB: hessle_head',
      'FLAC 28.4 MB: dave, nightbus',
      'FLAC 9.8 MB: flac_hoarder',
    ]);
    // Still one track, with every copy.
    expect(g.tracks(g.all)).toHaveLength(1);
  });

  it('keeps its id while copies stream in, and leaves track ids as they were', () => {
    const g = grouped(dave);
    const [first] = g.versions(g.all);
    const trackId = g.tracks(g.all)[0].id;
    adaptSearchResult(nightbus, 2, () => 0.5).forEach((s) => g.add(s));
    adaptSearchResult(hessle, 3, () => 0.5).forEach((s) => g.add(s));
    expect(g.versions(g.all).find((v) => v.best.quality.label === 'FLAC')?.id).toBe(first.id);
    expect(g.tracks(g.all)[0].id).toBe(trackId);
  });

  it('counts only the copies the filters kept', () => {
    const g = grouped(dave, nightbus);
    const kept = g.all.filter((s) => s.user === 'dave');
    expect(g.versions(kept).map(say)).toEqual(['FLAC 28.4 MB: dave']);
  });
});

describe('versions of a record', () => {
  const dave = answer('dave', [flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`)]);
  const nightbus = answer('nightbus', [
    flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`), flac(`${UNTRUE}\\04 Ghost Hardware.flac`)]);
  const quick = answer('quick', [mp3(`${UNTRUE}\\02 Archangel.mp3`, 320), mp3(`${UNTRUE}\\03 Near Dark.mp3`, 320)]);
  const single = answer('single', [flac('Music\\Burial - Kindred (2012)\\01 Kindred.flac')]);

  const versionsOf = (...answers: WireSearchResultData[]) => {
    const g = grouped(...answers);
    return releaseVersions(g.releases(g.all));
  };

  it('every folder of one record in one format is one version, the fullest first', () => {
    const versions = versionsOf(dave, nightbus, quick, single);
    expect(versions.map((v) => `${v.copies[0].dominantLabel}: ${v.copies.map((r) => r.user).join(', ')}`).sort())
      .toEqual(['320: quick', 'FLAC: nightbus, dave']);
  });

  it('a folder with one matching track is not a release', () => {
    expect(versionsOf(single)).toEqual([]);
  });

  it('keeps its id when another copy arrives', () => {
    const [before] = versionsOf(dave);
    const after = versionsOf(dave, nightbus);
    expect(after.map((v) => v.id)).toEqual([before.id]);
  });
});
