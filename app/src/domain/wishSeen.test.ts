/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A wish runs forever on the server's interval, and most of what a run returns
 * is what the last run returned. These pin the two things that makes tolerable:
 * an id stable enough to recognise the same file from the same peer across
 * weeks, and a split that reports only what is genuinely new.
 */

import { describe, expect, it } from 'vitest';
import { idsOf, seenId, splitSeen } from './wishSeen.ts';
import type { SourceFile } from './types.ts';

const src = (id: string) => ({ id } as SourceFile);

describe('seenId', () => {
  it('is stable for the same source', () => {
    // The whole feature rests on this: a hash that moved would report every
    // repeat as new, which is the bug it exists to fix.
    expect(seenId(src('someone music\\a.flac')))
      .toBe(seenId(src('someone music\\a.flac')));
  });

  it('separates two files from one peer', () => {
    expect(seenId(src('someone music\\a.flac')))
      .not.toBe(seenId(src('someone music\\b.flac')));
  });

  it('separates one file held by two peers', () => {
    // A different peer IS different news — they may be online when the other
    // is not, which is the entire reason a wishlist exists.
    expect(seenId(src('someone music\\a.flac')))
      .not.toBe(seenId(src('anyone music\\a.flac')));
  });

  it('notices a one-character difference', () => {
    expect(seenId(src('someone music\\a.flac')))
      .not.toBe(seenId(src('someone music\\A.flac')));
  });

  it('is 12 hex characters', () => {
    expect(seenId(src('someone music\\a.flac'))).toMatch(/^[0-9a-f]{12}$/);
  });

  it('pads rather than truncating a short half', () => {
    // A hash whose halves are not padded would sometimes be 11 characters and
    // sometimes collide with a different source's 12.
    for (const text of ['', 'a', 'ab', ' ', '\u0000', 'x'.repeat(400)]) {
      expect(seenId(src(text))).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('is a FORMAT, and these values are the format', () => {
    /* These hashes are written to seek-state.json and read back weeks later.
       Changing how they are computed does not "improve" anything — it silently
       invalidates every seen-set on disk, and every wish starts announcing
       results it has already shown you. If this test fails, the change is a
       migration, not a refactor.

       Two of these begin with a zero, which is not decoration: they are what
       fails if a half of the hash stops being zero-padded. */
    expect(seenId(src(''))).toBe('811c9dc50000');
    expect(seenId(src('a'))).toBe('e40c292c0002');
    expect(seenId(src('someone music\\a.flac'))).toBe('037796b96959');
    expect(seenId(src('peer-b music\\Drexciya\\01.flac'))).toBe('05b7ce4be9a1');
    expect(seenId(src('x'.repeat(64)))).toBe('d19b1ac56e83');
  });

  it('does not collide across a realistic wish', () => {
    // 500 results — twice the sidecar's cap — from 25 peers.
    const ids = new Set<string>();
    for (let p = 0; p < 25; p++) {
      for (let f = 0; f < 20; f++) {
        ids.add(seenId(src(`peer${p} music\\Artist - Release\\${f} Track.flac`)));
      }
    }
    expect(ids.size).toBe(500);
  });

  it('survives non-ASCII, which remote paths are full of', () => {
    const a = seenId(src('пётр music\\Ütopía\\01 — Träume.flac'));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(seenId(src('пётр music\\Ütopía\\01 — Träume.flac')));
    expect(a).not.toBe(seenId(src('пётр music\\Ütopía\\02 — Träume.flac')));
  });
});

describe('splitSeen', () => {
  const a = src('u1 a.flac');
  const b = src('u1 b.flac');
  const c = src('u2 c.flac');

  it('calls everything new when nothing has been seen', () => {
    const { fresh, seenCount } = splitSeen([a, b], new Set());
    expect(fresh).toEqual([a, b]);
    expect(seenCount).toBe(0);
  });

  it('holds back what has been seen', () => {
    const { fresh, seenCount } = splitSeen([a, b, c], new Set([seenId(a), seenId(c)]));
    expect(fresh).toEqual([b]);
    expect(seenCount).toBe(2);
  });

  it('reports nothing new when the run is an exact repeat', () => {
    // The ordinary case, every twelve minutes, forever.
    const seen = new Set([seenId(a), seenId(b)]);
    const { fresh, seenCount } = splitSeen([a, b], seen);
    expect(fresh).toEqual([]);
    expect(seenCount).toBe(2);
  });

  it('keeps the order it was given', () => {
    // The grouper already ranked these; the split must not re-order them.
    const { fresh } = splitSeen([c, b, a], new Set());
    expect(fresh.map((s) => s.id)).toEqual(['u2 c.flac', 'u1 b.flac', 'u1 a.flac']);
  });

  it('an unrelated id in the set holds nothing back', () => {
    const { fresh, seenCount } = splitSeen([a], new Set(['deadbeefcafe']));
    expect(fresh).toEqual([a]);
    expect(seenCount).toBe(0);
  });

  it('handles an empty run', () => {
    expect(splitSeen([], new Set([seenId(a)]))).toEqual({ fresh: [], seenCount: 0 });
  });
});

describe('idsOf', () => {
  it('is what gets sent to the sidecar', () => {
    const a = src('u1 a.flac');
    const b = src('u1 b.flac');
    expect(idsOf([a, b])).toEqual([seenId(a), seenId(b)]);
  });

  it('covers the repeats too, not only what was new', () => {
    // Re-marking a still-offered file is what keeps it inside the sidecar's
    // window; sending only the new ones would let live results age out.
    const all = [src('u1 a.flac'), src('u1 b.flac'), src('u2 c.flac')];
    expect(idsOf(all)).toHaveLength(3);
  });
});
