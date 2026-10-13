/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Best picks: which copies earn a card above Simple's results. Sources go
 * through the real adapter, so quality, score and the transcode check are the
 * genuine ones; the last block runs the recorded search.
 */

import { describe, expect, it } from 'vitest';
import { adaptSearchResult, isAudioPath } from '../data/adapt.ts';
import type { WireFileRef, WireSearchResultData } from '../data/adapt.ts';
import { createGrouper } from './group.ts';
import { bestPicks } from './bestPicks.ts';
import type { BestPick, PickPool } from './bestPicks.ts';
import type { DownloadPrefs } from './preferences.ts';
import type { WireFile } from './types.ts';
import raw from '../../../fixtures/search-burial.ndjson?raw';

const RULES: DownloadPrefs = { preferLossless: false, minBitrate: 0, rejectTranscodes: false };
const UNTRUE = 'Music\\Burial - Untrue (2007)';

const flac = (path: string): WireFileRef => ({
  path, size: 28_400_000, bitrate: null, duration: 238, sampleRate: 44_100, bitDepth: 16, isVbr: null,
});
/** Sized to match its bitrate unless `size` says otherwise. */
const mp3 = (path: string, kbps: number, size = (kbps * 1000 * 238) / 8): WireFileRef => ({
  path, size, bitrate: kbps, duration: 238, sampleRate: null, bitDepth: null, isVbr: false,
});

type Peer = Partial<WireSearchResultData['peer']> & { username: string };

function answer(peer: Peer, files: WireFileRef[], extra: Partial<WireSearchResultData> = {}): WireSearchResultData {
  return {
    searchId: 1,
    peer: { freeSlots: true, advertisedSpeed: 1_000_000, queueLength: 0, files: 100, folders: 10, country: null, ...peer },
    files,
    ...extra,
  };
}

function pool(...answers: WireSearchResultData[]): PickPool {
  const g = createGrouper();
  answers.forEach((a, i) => adaptSearchResult(a, i + 1, () => 0.5).forEach((s) => g.add(s)));
  return { tracks: g.tracks(g.all), releases: g.releases(g.all) };
}

const say = (p: BestPick) => (p.kind === 'release'
  ? `${p.kind}: ${p.release.user}, ${p.release.title}`
  : `${p.kind}: ${p.source.user}, ${p.source.parsed.displayTitle}`);

/* dave and nightbus have Untrue; hessle_head has a 320 of Archangel alone. */
const dave = answer({ username: 'dave', advertisedSpeed: 2_400_000 },
  [flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`)]);
const hessle = answer({ username: 'hessle_head', advertisedSpeed: 6_100_000 },
  [mp3('Music\\Burial - Archangel (2007)\\01 Archangel.mp3', 320)]);
const nightbus = answer({ username: 'nightbus', freeSlots: false, queueLength: 2, advertisedSpeed: 1_800_000 },
  [flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`), flac(`${UNTRUE}\\04 Ghost Hardware.flac`)]);

describe('what earns a card', () => {
  it('the track most people have, its best copy, its soonest copy, and the most-copied release', () => {
    expect(bestPicks(pool(dave, hessle, nightbus), RULES).map(say)).toEqual([
      'overall: dave, Archangel',
      'fastest: hessle_head, Archangel',
      // The fuller of the two Untrue copies: completeness comes first.
      'release: nightbus, Untrue',
    ]);
  });

  it('Fastest never trades below 320 or V0', () => {
    const slow = answer({ username: 'slowpoke', advertisedSpeed: 9_000_000 },
      [mp3('Music\\Burial - Archangel (2007)\\01 Archangel.mp3', 192)]);
    expect(bestPicks(pool(dave, slow), RULES).map((p) => p.kind)).toEqual(['overall', 'release']);
  });

  it('a lone folder track is no release; one copy offers no Fastest', () => {
    expect(bestPicks(pool(hessle), RULES).map(say)).toEqual(['overall: hessle_head, Archangel']);
  });

  it('"Prefer lossless" narrows Best overall and Whole release, never Fastest', () => {
    // A complete, quick 320 copy of Untrue outranks nightbus's queued FLAC on score.
    const quick = answer({ username: 'quick', advertisedSpeed: 6_000_000 }, [
      mp3(`${UNTRUE}\\02 Archangel.mp3`, 320), mp3(`${UNTRUE}\\03 Near Dark.mp3`, 320),
      mp3(`${UNTRUE}\\04 Ghost Hardware.mp3`, 320)]);
    const all = pool(hessle, nightbus, quick);
    expect(bestPicks(all, RULES).map(say)).toEqual([
      'overall: hessle_head, Archangel', 'fastest: quick, Archangel', 'release: quick, Untrue',
    ]);
    expect(bestPicks(all, { ...RULES, preferLossless: true }).map(say)).toEqual([
      'overall: nightbus, Archangel', 'fastest: hessle_head, Archangel', 'release: nightbus, Untrue',
    ]);
  });

  it('nothing at all from nothing at all', () => {
    expect(bestPicks(pool(), RULES)).toEqual([]);
  });
});

describe('what never earns one', () => {
  it('a suspected transcode, however fast', () => {
    const fake = answer({ username: 'fake', advertisedSpeed: 9_000_000 },
      [mp3('Music\\Burial - Archangel (2007)\\01 Archangel.mp3', 320, 3_800_000)]);
    const picks = bestPicks(pool(dave, fake), RULES);
    expect(picks.some((p) => p.kind !== 'release' && p.source.user === 'fake')).toBe(false);
  });

  it('a buddy-only file', () => {
    const buddies = answer({ username: 'buddies', advertisedSpeed: 9_000_000 },
      [flac('Music\\Burial - Archangel (2007)\\01 Archangel.flac')], { private: true });
    expect(bestPicks(pool(buddies), RULES)).toEqual([]);
  });

  it('a copy your own download rules would refuse', () => {
    const picks = bestPicks(pool(hessle), { ...RULES, minBitrate: 321 });
    expect(picks).toEqual([]);
  });
});

describe('a card that must hold still', () => {
  const all = pool(dave, hessle, nightbus);
  const night = all.tracks.flatMap((t) => t.sources).find((s) => s.user === 'nightbus' && /Archangel/.test(s.path))!;

  it('keeps its copy while that copy is still a pick', () => {
    const picks = bestPicks(all, RULES, { overall: night.id });
    expect(picks.map(say).slice(0, 2)).toEqual(['overall: nightbus, Archangel', 'fastest: hessle_head, Archangel']);
  });

  it('lets go once the copy has left the results', () => {
    expect(bestPicks(pool(dave, hessle), RULES, { overall: night.id }).map(say)[0]).toBe('overall: dave, Archangel');
  });
});

describe('against the recorded search', () => {
  const g = createGrouper();
  let tick = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const { frame } = JSON.parse(line);
    if (frame.ev !== 'search.result') continue;
    tick += 1;
    const audio = { ...frame.data, files: frame.data.files.filter((f: WireFile) => isAudioPath(f.path)) };
    if (audio.files.length > 0) adaptSearchResult(audio, tick, () => 0.5).forEach((s) => g.add(s));
  }
  const picks = bestPicks({ tracks: g.tracks(g.all), releases: g.releases(g.all) }, RULES);

  it('offers all three, Best overall and Fastest being copies of one track', () => {
    expect(picks.map((p) => p.kind)).toEqual(['overall', 'fastest', 'release']);
    const [overall, fastest] = picks as Array<Extract<BestPick, { kind: 'overall' | 'fastest' }>>;
    expect(fastest.source.clusterKey).toBe(overall.source.clusterKey);
    expect(fastest.source.user).not.toBe(overall.source.user);
  });

  it('the release is a clean, whole copy of Untrue, the record everyone has', () => {
    const release = picks.find((p) => p.kind === 'release');
    expect(release?.kind === 'release' && release.release.title).toMatch(/untrue/i);
    if (release?.kind !== 'release') return;
    expect(release.release.suspectCount).toBe(0);
    expect(release.release.trackCount).toBeGreaterThanOrEqual(10);
  });
});
