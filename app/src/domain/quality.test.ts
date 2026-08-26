/*
 * Seek — quality ranking, the three-path transcode check, and dedupe.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The attribute sets here are DISJOINT on purpose (RECON.md §4): lossless files
 * get duration/sampleRate/bitDepth and no bitrate; lossy files get
 * bitrate/duration/vbr and no sampleRate/bitDepth. Any fixture that populates
 * all of them at once is testing a shape the network never produces.
 */

import { describe, expect, it } from 'vitest';
import { checkTranscode, classify } from './quality.ts';
import type { AudioFacts } from './quality.ts';
import { createGrouper } from './group.ts';
import { toSourceFile } from './ingest.ts';
import type { PeerStats } from './types.ts';

const MB = 1024 * 1024;

/** A lossless file as the wire actually presents one. */
function lossless(over: Partial<AudioFacts> = {}): AudioFacts {
  return {
    extension: 'flac', size: 38 * MB, duration: 372,
    sampleRate: 44100, bitDepth: 16,
    bitrate: null, vbr: null,
    ...over,
  };
}

/** A lossy file as the wire actually presents one. */
function lossy(over: Partial<AudioFacts> = {}): AudioFacts {
  return {
    extension: 'mp3', size: 14 * MB, duration: 372,
    bitrate: 320, vbr: false,
    sampleRate: null, bitDepth: null,
    ...over,
  };
}

describe('classify — ranking', () => {
  it('ranks FLAC/WAV/AIFF above 320 above V0 above 256 above 192', () => {
    const flac = classify(lossless()).score;
    const wav = classify(lossless({ extension: 'wav' })).score;
    const cbr320 = classify(lossy({ bitrate: 320, vbr: false })).score;
    const v0 = classify(lossy({ bitrate: 245, vbr: true })).score;
    const cbr256 = classify(lossy({ bitrate: 256, vbr: false })).score;
    const cbr192 = classify(lossy({ bitrate: 192, vbr: false })).score;
    const cbr128 = classify(lossy({ bitrate: 128, vbr: false })).score;

    expect(flac).toBe(wav);
    expect(flac).toBeGreaterThan(cbr320);
    expect(cbr320).toBeGreaterThan(v0);
    expect(v0).toBeGreaterThan(cbr256);
    expect(cbr256).toBeGreaterThan(cbr192);
    expect(cbr192).toBeGreaterThan(cbr128);
  });

  it('labels VBR MP3 by its LAME preset', () => {
    expect(classify(lossy({ bitrate: 245, vbr: true })).label).toBe('V0');
    expect(classify(lossy({ bitrate: 190, vbr: true })).label).toBe('V2');
    expect(classify(lossy({ bitrate: 320, vbr: false })).label).toBe('320');
  });

  it('classifies lossless from the extension, without any bitrate', () => {
    const q = classify(lossless());
    expect(q.lossless).toBe(true);
    expect(q.tier).toBe('lossless');
    expect(q.label).toBe('FLAC');
  });

  it('does not invent a bitrate when the peer reported none', () => {
    const q = classify({
      extension: 'mp3', size: 9 * MB, duration: 372,
      bitrate: null, vbr: null, sampleRate: null, bitDepth: null,
    });
    expect(q.tier).toBe('unknown');
    expect(q.description).toMatch(/no bitrate reported/i);
  });

  it('rates hi-res lossless above CD-quality lossless', () => {
    const hi = classify(lossless({ sampleRate: 96000, bitDepth: 24 })).score;
    expect(hi).toBeGreaterThan(classify(lossless()).score);
  });
});

describe('checkTranscode — lossy: a contradicted claim', () => {
  it('flags a 320 whose bytes imply ~192', () => {
    // 372s at a true 192 kbps ≈ 8.9 MB, shared as 320.
    const c = checkTranscode(lossy({ bitrate: 320, size: 8.9 * MB }));
    expect(c.verdict).toBe('contradicted');
    expect(c.suspect).toBe(true);
    expect(c.confidence).toBe('high');
    expect(Math.round(c.impliedKbps!)).toBeGreaterThan(185);
    expect(Math.round(c.impliedKbps!)).toBeLessThan(215);
    // The tooltip must show the arithmetic, not a verdict.
    expect(c.explanation).toMatch(/320 kbps/);
    expect(c.explanation).toMatch(/6:12/);
  });

  it('passes an honest 320', () => {
    const c = checkTranscode(lossy({ bitrate: 320, size: 14.9 * MB }));
    expect(c.verdict).toBe('ok');
    expect(c.suspect).toBe(false);
    expect(c.checked).toBe(true);
  });

  it('gives VBR more headroom than CBR', () => {
    // 11.6 MB over 372s implies ~262 kbps; against a 320 claim that is a ratio
    // of 0.82 — under the 0.85 CBR floor, over the 0.78 VBR floor. A variable
    // stream is legitimately allowed to average below its nominal rate.
    const size = 11.6 * MB;
    expect(checkTranscode(lossy({ bitrate: 320, vbr: false, size })).verdict).toBe('contradicted');
    expect(checkTranscode(lossy({ bitrate: 320, vbr: true, size })).verdict).toBe('ok');
  });
});

describe('checkTranscode — lossless: an inference, not a contradiction', () => {
  it('flags an MP3 renamed to .flac', () => {
    // 372s of 320 kbps is ~14 MB. No real FLAC of that length is that small.
    const c = checkTranscode(lossless({ size: 14 * MB }));
    expect(c.verdict).toBe('inferred-transcode');
    expect(c.suspect).toBe(true);
    // Lower confidence than the lossy case — nothing was claimed to contradict.
    expect(c.confidence).toBe('moderate');
    expect(c.explanation).toMatch(/no advertised\s+bitrate|nothing here to contradict|no claim here to contradict/i);
  });

  it('passes a genuine FLAC', () => {
    const c = checkTranscode(lossless({ size: 38 * MB }));
    expect(c.verdict).toBe('ok');
    expect(c.ratio).toBeGreaterThan(0.3);
  });

  it('says so when it had to assume CD quality', () => {
    const c = checkTranscode(lossless({ sampleRate: null, bitDepth: null, size: 10 * MB }));
    expect(c.verdict).toBe('inferred-transcode');
    expect(c.explanation).toMatch(/did not report sample rate/i);
  });
});

describe('checkTranscode — unchecked is a real state, never silent success', () => {
  it('cannot check without a duration', () => {
    const c = checkTranscode(lossy({ duration: null }));
    expect(c.verdict).toBe('unchecked');
    expect(c.checked).toBe(false);
    expect(c.suspect).toBe(false);
    expect(c.explanation).toMatch(/no duration/i);
  });

  it('cannot check a file with no attributes at all', () => {
    const c = checkTranscode({
      extension: 'mp3', size: 7 * MB,
      bitrate: null, duration: null, sampleRate: null, bitDepth: null, vbr: null,
    });
    expect(c.verdict).toBe('unchecked');
  });

  it('cannot check a lossy file with a duration but no bitrate', () => {
    const c = checkTranscode(lossy({ bitrate: null }));
    expect(c.verdict).toBe('unchecked');
    expect(c.explanation).toMatch(/no bitrate/i);
  });

  it('refuses to judge very short files', () => {
    expect(checkTranscode(lossy({ duration: 12, size: 200_000 })).verdict).toBe('unchecked');
  });

  it('unchecked is distinguishable from ok without reading a colour', () => {
    const un = checkTranscode(lossy({ duration: null }));
    const ok = checkTranscode(lossy({ size: 14.9 * MB }));
    expect(un.checked).not.toBe(ok.checked);
    expect(un.headline).not.toBe(ok.headline);
  });
});

/* ------------------------------------------------------------------ dedupe */

const peer = (username: string, over: Partial<PeerStats> = {}): PeerStats => ({
  username, freeSlots: true, advertisedSpeed: 500_000, queueLength: 0,
  reliability: 0.5, country: null, ...over,
});

function src(user: string, path: string, over: Partial<Parameters<typeof toSourceFile>[0]> = {}) {
  return toSourceFile(
    {
      user, path, size: 38 * MB, bitrate: null, duration: 372,
      sampleRate: 44100, bitDepth: 16, vbr: null, ...over,
    },
    peer(user),
    0,
  );
}

describe('grouper — dedupe across users', () => {
  it('collapses the same track from many peers into one row', () => {
    const g = createGrouper();
    for (const u of ['alice', 'bob', 'carol']) {
      g.add(src(u, `@@${u}\\Music\\Burial - Untrue\\03 - Archangel.flac`));
    }
    const tracks = g.tracks(g.all);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].sources).toHaveLength(3);
    expect(tracks[0].displayTitle).toBe('Archangel');
  });

  it('tolerates a ±2s difference in duration but not more', () => {
    const g = createGrouper();
    g.add(src('a', '@@a\\M\\Burial - Untrue\\03 - Archangel.flac', { duration: 372 }));
    g.add(src('b', '@@b\\M\\Burial - Untrue\\03 - Archangel.flac', { duration: 374 }));
    g.add(src('c', '@@c\\M\\Burial - Untrue\\03 - Archangel.flac', { duration: 400 }));
    const tracks = g.tracks(g.all);
    expect(tracks).toHaveLength(2);
    expect(tracks.find((t) => t.sources.length === 2)).toBeTruthy();
  });

  it('never merges different remixes of the same title', () => {
    const g = createGrouper();
    g.add(src('a', '@@a\\M\\X - Y\\01 - Floating Points - Silhouettes.flac'));
    g.add(src('b', '@@b\\M\\X - Y\\01 - Floating Points - Silhouettes (Four Tet Remix).flac'));
    expect(g.tracks(g.all)).toHaveLength(2);
  });

  it('ranks sources within a cluster by score, best first', () => {
    const g = createGrouper();
    g.add(toSourceFile(
      { user: 'slow', path: '@@s\\M\\A - B\\01 - T.flac', size: 38 * MB, bitrate: null,
        duration: 372, sampleRate: 44100, bitDepth: 16, vbr: null },
      peer('slow', { freeSlots: false, queueLength: 40, advertisedSpeed: 12_000 }), 0,
    ));
    g.add(toSourceFile(
      { user: 'fast', path: '@@f\\M\\A - B\\01 - T.flac', size: 38 * MB, bitrate: null,
        duration: 372, sampleRate: 44100, bitDepth: 16, vbr: null },
      peer('fast', { freeSlots: true, queueLength: 0, advertisedSpeed: 3_000_000 }), 0,
    ));
    const [t] = g.tracks(g.all);
    expect(t.sources).toHaveLength(2);
    expect(t.best.user).toBe('fast');
  });

  it('groups a folder into a release keyed by (user, parent folder)', () => {
    const g = createGrouper();
    g.add(src('alice', '@@a\\Music\\Burial - Untrue (2007)\\01 - Untitled.flac'));
    g.add(src('alice', '@@a\\Music\\Burial - Untrue (2007)\\02 - Archangel.flac'));
    g.add(src('bob', '@@b\\Music\\Burial - Untrue (2007)\\01 - Untitled.flac'));

    const releases = g.releases(g.all);
    expect(releases).toHaveLength(2);
    const alice = releases.find((r) => r.user === 'alice')!;
    expect(alice.trackCount).toBe(2);
    expect(alice.title).toBe('Untrue');
    expect(alice.year).toBe(2007);
    expect(alice.dominantLabel).toBe('FLAC');
  });

  it('keeps cluster identity stable when a later source joins', () => {
    const g = createGrouper();
    g.add(src('a', '@@a\\M\\Burial - Untrue\\03 - Archangel.flac'));
    const first = g.tracks(g.all)[0].id;
    g.add(src('b', '@@b\\M\\Burial - Untrue\\03 - Archangel.flac'));
    const second = g.tracks(g.all).find((t) => t.sources.length === 2)!.id;
    // If this ever fails, React remounts a row the user is reading. That is the
    // whole reason identity is assigned once instead of derived per tick.
    expect(second).toBe(first);
  });

  it('files that could not be parsed still dedupe on their raw filename', () => {
    const g = createGrouper();
    g.add(src('a', '@@a\\incoming\\01.mp3'));
    g.add(src('b', '@@b\\incoming\\01.mp3'));
    const tracks = g.tracks(g.all);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].fallback).toBe(true);
    expect(tracks[0].displayTitle).toBe('01.mp3');
  });
});
