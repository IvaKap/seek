/*
 * Seek — folder verdicts.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  folderLeaf, judgeFolder, readableError, tildeAbbreviate,
} from './folders.ts';
import type { PathFacts } from './folders.ts';

function facts(over: Partial<PathFacts> = {}): PathFacts {
  return {
    path: '/Users/x/Music',
    resolved: '/Users/x/Music',
    exists: true,
    isDirectory: true,
    writable: true,
    parentExists: true,
    parentWritable: true,
    ...over,
  };
}

describe('judgeFolder', () => {
  it('says nothing at all about a folder that is simply fine', () => {
    const v = judgeFolder(facts(), 'download');
    expect(v.usable).toBe(true);
    expect(v.tone).toBe('ok');
    expect(v.message).toBe('');
  });

  it('stays quiet before anything has been checked', () => {
    expect(judgeFolder(null, 'download')).toEqual({
      usable: false, tone: 'empty', message: '', offerCreate: false,
    });
  });

  it('treats a missing folder with a writable parent as an offer, not a failure', () => {
    const v = judgeFolder(facts({ exists: false, isDirectory: false, writable: false }), 'download');
    expect(v.tone).toBe('warn');
    expect(v.offerCreate).toBe(true);
    expect(v.usable).toBe(false);
  });

  it('does not offer to create what it cannot create', () => {
    const v = judgeFolder(
      facts({ exists: false, isDirectory: false, writable: false, parentWritable: false }),
      'download',
    );
    expect(v.tone).toBe('error');
    expect(v.offerCreate).toBe(false);
  });

  it('distinguishes a missing leaf from a missing path', () => {
    const leaf = judgeFolder(
      facts({ exists: false, writable: false, parentExists: true, parentWritable: false }),
      'download',
    );
    const deep = judgeFolder(
      facts({ exists: false, writable: false, parentExists: false, parentWritable: false }),
      'download',
    );
    expect(leaf.message).not.toBe(deep.message);
    expect(deep.message).toMatch(/Nothing along this path/);
  });

  it('names a file as a file rather than complaining it is unwritable', () => {
    const v = judgeFolder(facts({ isDirectory: false, writable: false }), 'download');
    expect(v.message).toMatch(/file, not a folder/);
  });

  /* The whole reason the sidecar reports facts instead of a verdict. */
  it('accepts a read-only folder for sharing and refuses it for downloads', () => {
    const readOnly = facts({ writable: false });
    expect(judgeFolder(readOnly, 'share').usable).toBe(true);
    expect(judgeFolder(readOnly, 'download').usable).toBe(false);
    expect(judgeFolder(readOnly, 'incomplete').usable).toBe(false);
  });

  it('blames the volume and the sandbox, because those are the real causes on a Mac', () => {
    const v = judgeFolder(facts({ writable: false }), 'download');
    expect(v.message).toMatch(/read-only volume/);
    expect(v.message).toMatch(/macOS/);
  });

  it('reports an empty path as empty rather than as a missing folder', () => {
    const v = judgeFolder(facts({ resolved: '', path: '', exists: false, isDirectory: false, writable: false, parentExists: false, parentWritable: false }), 'download');
    expect(v.tone).toBe('empty');
    expect(v.offerCreate).toBe(false);
  });
});

describe('tildeAbbreviate', () => {
  it('shortens a path inside the home folder', () => {
    expect(tildeAbbreviate('/Users/dana/Music/Seek', '/Users/dana')).toBe('~/Music/Seek');
  });

  it('shortens the home folder itself', () => {
    expect(tildeAbbreviate('/Users/dana', '/Users/dana')).toBe('~');
  });

  it('leaves a path outside home alone', () => {
    expect(tildeAbbreviate('/Volumes/Archive', '/Users/dana')).toBe('/Volumes/Archive');
  });

  /* `/Users/danah` is not inside `/Users/dana`, and a prefix test without the
   * separator would abbreviate it to `~n`. */
  it('does not match a partial folder name', () => {
    expect(tildeAbbreviate('/Users/danah/Music', '/Users/dana')).toBe('/Users/danah/Music');
  });

  it('tolerates a trailing slash on home', () => {
    expect(tildeAbbreviate('/Users/dana/Music', '/Users/dana/')).toBe('~/Music');
  });

  it('does nothing without a home to compare against', () => {
    expect(tildeAbbreviate('/Users/dana/Music', '')).toBe('/Users/dana/Music');
  });
});

describe('folderLeaf', () => {
  it('takes the last segment', () => {
    expect(folderLeaf('/Users/dana/Music/Seek')).toBe('Seek');
  });

  it('ignores a trailing slash', () => {
    expect(folderLeaf('/Users/dana/Music/')).toBe('Music');
  });

  it('falls back to the whole path rather than to nothing', () => {
    expect(folderLeaf('/')).toBe('/');
  });
});

describe('readableError', () => {
  it('drops the machine-readable code', () => {
    expect(readableError(new Error('bad_request: the download folder does not exist: /x')))
      .toBe('the download folder does not exist: /x');
  });

  it('leaves a message with no code alone', () => {
    expect(readableError(new Error('sidecar connection closed')))
      .toBe('sidecar connection closed');
  });

  /* A path can contain a colon. Only the leading code is stripped. */
  it('keeps colons inside the message', () => {
    expect(readableError(new Error('bad_request: could not create /a:b: denied')))
      .toBe('could not create /a:b: denied');
  });

  it('copes with something that is not an Error', () => {
    expect(readableError('plain string')).toBe('plain string');
  });
});
