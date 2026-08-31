/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The one property this whole feature rests on: an `.ffp` mismatch and an
 * `.md5` mismatch must never look the same.
 *
 * An .ffp hashes the decoded audio, so a mismatch means the music is different.
 * An .md5 hashes the whole file, so a mismatch happens when somebody fixes a
 * misspelt track title. Painting both red would call a retagged file a fake —
 * the same conflation PRODUCT §6 forbids between the search-time prediction and
 * the post-download finding, in a new place.
 */

import { describe, expect, it } from 'vitest';
import type { ChecksumEntry, ChecksumReport } from '../../../shared/protocol.ts';
import {
  explainEntry, labelOfEntry, orderedEntries, summarise, toneOfEntry, verdictOf,
} from './checksums.ts';

const A = 'ab'.repeat(16);
const B = 'cd'.repeat(16);

function entry(over: Partial<ChecksumEntry> = {}): ChecksumEntry {
  return {
    name: '01 Track.flac',
    kind: 'ffp',
    expected: A,
    localPath: '/dl/release/01 Track.flac',
    actual: A,
    issue: null,
    ...over,
  };
}

function report(over: Partial<ChecksumReport> = {}): ChecksumReport {
  return {
    requestId: 'r',
    folderPath: '/dl/release',
    transferId: 't',
    sidecars: [{
      path: '/dl/release/album.ffp', kind: 'ffp',
      entryCount: 1, unparsedLines: 0, error: '',
    }],
    entries: [entry()],
    ...over,
  };
}

describe('verdictOf', () => {
  it('agrees when the digests agree', () => {
    expect(verdictOf(entry())).toBe('match');
  });

  it('disagrees when they differ', () => {
    expect(verdictOf(entry({ actual: B }))).toBe('mismatch');
  });

  it('ignores hex case', () => {
    // md5sum writes lowercase; several Windows tools write uppercase. Treating
    // those as different is a false mismatch, which is the worst thing here.
    expect(verdictOf(entry({ expected: A.toUpperCase() }))).toBe('match');
    expect(verdictOf(entry({ actual: A.toUpperCase() }))).toBe('match');
  });

  it('is unchecked when the sidecar reported an issue', () => {
    expect(verdictOf(entry({ actual: null, issue: 'missing' }))).toBe('unchecked');
  });

  it('is unchecked when there is no actual, whatever the issue says', () => {
    // Belt and braces: `actual: null` with `issue: null` should be impossible,
    // and must not compare null against a real digest and call it a mismatch.
    expect(verdictOf(entry({ actual: null }))).toBe('unchecked');
  });
});

describe('the two kinds of mismatch are not the same kind of news', () => {
  it('an audio-fingerprint mismatch is the strong result', () => {
    expect(toneOfEntry(entry({ kind: 'ffp', actual: B }))).toBe('bad');
  });

  it('a whole-file mismatch is a question, not a charge', () => {
    expect(toneOfEntry(entry({ kind: 'md5', actual: B }))).toBe('warn');
  });

  it('either kind matching is good news', () => {
    expect(toneOfEntry(entry({ kind: 'ffp' }))).toBe('good');
    expect(toneOfEntry(entry({ kind: 'md5' }))).toBe('good');
  });

  it('an unchecked entry claims nothing', () => {
    expect(toneOfEntry(entry({ actual: null, issue: 'no_signature' }))).toBe('unknown');
  });

  it('the two mismatches do not read the same', () => {
    // Otherwise the entire distinction is carried by colour alone, and anyone
    // who cannot separate red from amber sees two identical accusations.
    const audio = labelOfEntry(entry({ kind: 'ffp', actual: B }));
    const bytes = labelOfEntry(entry({ kind: 'md5', actual: B }));
    expect(audio).not.toBe(bytes);
    expect(audio).toMatch(/audio/i);
    expect(bytes).toMatch(/bytes/i);
  });

  it('but both kinds passing read the same, because they mean the same', () => {
    expect(labelOfEntry(entry({ kind: 'ffp' })))
      .toBe(labelOfEntry(entry({ kind: 'md5' })));
  });

  it('says out loud that a tag edit explains a whole-file mismatch', () => {
    // The hedge IS the feature. Without it this reads as an accusation.
    expect(explainEntry(entry({ kind: 'md5', actual: B }))).toMatch(/tag/i);
  });

  it('does not hedge an audio mismatch the same way', () => {
    const text = explainEntry(entry({ kind: 'ffp', actual: B }));
    expect(text).not.toMatch(/tag/i);
    expect(text).toMatch(/re-encode|different master/i);
  });

  it('an unset encoder signature is not described as a fault', () => {
    const text = explainEntry(entry({ actual: null, issue: 'no_signature' }));
    expect(text).toMatch(/not a fault/i);
  });
});

describe('summarise', () => {
  it('a folder with no sidecar is an answer, not a failure', () => {
    const s = summarise(report({ sidecars: [], entries: [] }));
    expect(s.none).toBe(true);
    expect(s.tone).toBe('unknown');
    // Never the language of a failed check.
    expect(s.headline).not.toMatch(/fail|error|problem/i);
  });

  it('counts the good news', () => {
    const s = summarise(report({ entries: [entry(), entry({ name: 'b.flac' })] }));
    expect(s.matched).toBe(2);
    expect(s.mismatched).toBe(0);
    expect(s.tone).toBe('good');
    expect(s.headline).toContain('2 of 2 files');
  });

  it('one audio mismatch takes the whole report to bad', () => {
    const s = summarise(report({
      entries: [entry(), entry({ name: 'b.flac', actual: B })],
    }));
    expect(s.audioMismatched).toBe(1);
    expect(s.tone).toBe('bad');
  });

  it('whole-file mismatches alone stop at warn', () => {
    const s = summarise(report({
      entries: [entry({ kind: 'md5', actual: B })],
    }));
    expect(s.mismatched).toBe(1);
    expect(s.audioMismatched).toBe(0);
    expect(s.tone).toBe('warn');
    expect(s.headline).toMatch(/tag/i);
  });

  it('separates a file that is absent from one that cannot be checked', () => {
    const s = summarise(report({
      entries: [
        entry({ name: 'gone.flac', actual: null, issue: 'missing' }),
        entry({ name: 'nosig.flac', actual: null, issue: 'no_signature' }),
      ],
    }));
    expect(s.missing).toBe(1);
    expect(s.unverifiable).toBe(1);
    // Neither is a mismatch, so neither may darken the tone.
    expect(s.mismatched).toBe(0);
    expect(s.tone).toBe('unknown');
  });

  it('says how many files the sidecar named but the folder lacks', () => {
    // How you learn a release is incomplete. "1 of 1 verified" with three
    // files missing would be true and misleading.
    const s = summarise(report({
      entries: [
        entry(),
        entry({ name: 'b.flac', actual: null, issue: 'missing' }),
        entry({ name: 'c.flac', actual: null, issue: 'missing' }),
      ],
    }));
    expect(s.headline).toContain('1 of 1 file');
    expect(s.headline).toContain('2 more files');
  });

  it('carries the count of lines it could not read', () => {
    const s = summarise(report({
      sidecars: [{
        path: '/dl/release/album.ffp', kind: 'ffp',
        entryCount: 1, unparsedLines: 4, error: '',
      }],
    }));
    expect(s.unparsedLines).toBe(4);
  });

  it('a sidecar that could not be opened says so rather than claiming nothing found', () => {
    const s = summarise(report({
      sidecars: [{
        path: '/dl/release/album.md5', kind: 'md5',
        entryCount: 0, unparsedLines: 0, error: 'too large',
      }],
      entries: [],
    }));
    expect(s.none).toBe(false);
    expect(s.unreadableSidecars).toBe(1);
    expect(s.headline).toMatch(/could not be read/i);
  });
});

describe('orderedEntries', () => {
  it('puts problems first, then the unchecked, then the good news', () => {
    const ordered = orderedEntries(report({
      entries: [
        entry({ name: 'ok.flac' }),
        entry({ name: 'gone.flac', actual: null, issue: 'missing' }),
        entry({ name: 'bad.flac', actual: B }),
      ],
    }));
    expect(ordered.map((e) => e.name)).toEqual(['bad.flac', 'gone.flac', 'ok.flac']);
  });

  it('keeps the folder order within a band', () => {
    const ordered = orderedEntries(report({
      entries: [
        entry({ name: '03.flac', actual: B }),
        entry({ name: '01.flac', actual: B }),
        entry({ name: '02.flac', actual: B }),
      ],
    }));
    expect(ordered.map((e) => e.name)).toEqual(['03.flac', '01.flac', '02.flac']);
  });

  it('does not lose or duplicate entries', () => {
    const r = report({
      entries: [
        entry({ name: 'a' }), entry({ name: 'b', actual: B }),
        entry({ name: 'c', actual: null, issue: 'not_flac' }),
      ],
    });
    expect(orderedEntries(r)).toHaveLength(3);
    expect(new Set(orderedEntries(r).map((e) => e.name)).size).toBe(3);
  });
});
