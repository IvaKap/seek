import { describe, expect, it } from 'vitest';
import { judge, pickSource } from './preferences.ts';
import type { SourceFile } from './types.ts';

/** Only the fields the preference layer reads. */
function file(over: Partial<SourceFile> & { name?: string }): SourceFile {
  return {
    quality: { lossless: false, tier: 'lossy-high', score: 80, label: '320', description: '' },
    transcode: { suspect: false, checked: true, verdict: 'ok', impliedKbps: null, referenceKbps: null },
    bitrate: 320,
    score: 0.5,
    parsed: { displayTitle: over.name ?? 'Track' },
    ...over,
  } as unknown as SourceFile;
}

const OFF = { preferLossless: false, minBitrate: 0, rejectTranscodes: false };

describe('download preferences', () => {
  it('never applies a bitrate floor to lossless', () => {
    // A FLAC advertises no bitrate at all (RECON.md §4). Treating that as
    // "below the minimum" would reject every lossless file on the network.
    const flac = file({ quality: { lossless: true, tier: 'lossless', score: 100, label: 'FLAC', description: '' }, bitrate: null });
    expect(judge(flac, { ...OFF, minBitrate: 320 }).allowed).toBe(true);
  });

  it('refuses lossy files under the floor, with a reason', () => {
    const v = judge(file({ bitrate: 192 }), { ...OFF, minBitrate: 256 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('192');
  });

  it('refuses suspected transcodes only when asked', () => {
    const bad = file({ transcode: { suspect: true, checked: true, verdict: 'contradicted', impliedKbps: 190, referenceKbps: 320 } as SourceFile['transcode'] });
    expect(judge(bad, OFF).allowed).toBe(true);
    expect(judge(bad, { ...OFF, rejectTranscodes: true }).allowed).toBe(false);
  });

  it('prefers lossless over a better-scoring lossy source', () => {
    const fastMp3 = file({ name: 'mp3', score: 0.9 });
    const slowFlac = file({
      name: 'flac', score: 0.4,
      quality: { lossless: true, tier: 'lossless', score: 100, label: 'FLAC', description: '' },
      bitrate: null,
    });
    expect(pickSource([fastMp3, slowFlac], OFF).parsed.displayTitle).toBe('mp3');
    expect(pickSource([fastMp3, slowFlac], { ...OFF, preferLossless: true }).parsed.displayTitle)
      .toBe('flac');
  });

  it('falls back rather than queueing nothing when every source is refused', () => {
    const only = file({ bitrate: 128 });
    expect(pickSource([only], { ...OFF, minBitrate: 320 })).toBe(only);
  });
});
