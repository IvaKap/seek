/*
 * Seek — Discogs wantlist import.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The inputs here are shaped from measured live responses, same as
 * test_wantlist.py on the other side of the seam.
 */

import { describe, expect, it } from 'vitest';
import { wantlistEntries, wantQuery } from './wantlistImport.ts';
import type { DiscogsWant } from './wantlistImport.ts';

function want(over: Partial<DiscogsWant> = {}): DiscogsWant {
  return {
    discogsId: 9226618,
    masterId: null,
    title: 'Aline Brooklyn 001',
    artist: 'Aline Brooklyn',
    year: 2016,
    label: 'Aline Brooklyn',
    catno: 'ALN 001',
    format: 'Vinyl',
    url: 'https://www.discogs.com/release/9226618',
    addedAt: '2025-06-12T16:17:31-07:00',
    notes: '',
    ...over,
  };
}

describe('wantlistEntries', () => {
  it('carries every stated field across', () => {
    const [e] = wantlistEntries([want()]);
    expect(e.artist).toBe('Aline Brooklyn');
    expect(e.title).toBe('Aline Brooklyn 001');
    expect(e.year).toBe(2016);
    expect(e.label).toBe('Aline Brooklyn');
    expect(e.catalogNumber).toBe('ALN 001');
    expect(e.sourceKind).toBe('discogs');
    expect(e.sourceUrl).toBe('https://www.discogs.com/release/9226618');
  });

  /* A Discogs want is always a release, so the title is an album title. It has
   * to be in `title` to render and in `album` for `resultsMatch` to recognise
   * a folder. */
  it('puts the release title in both title and album', () => {
    const [e] = wantlistEntries([want({ title: 'Untrue' })]);
    expect(e.title).toBe('Untrue');
    expect(e.album).toBe('Untrue');
  });

  it('names the catalogue number as the source where there is one', () => {
    expect(wantlistEntries([want({ catno: 'HDB 20' })])[0].sourceTitle)
      .toBe('Discogs · HDB 20');
  });

  it('falls back to a plain source label with no catalogue number', () => {
    expect(wantlistEntries([want({ catno: '' })])[0].sourceTitle)
      .toBe('Discogs wantlist');
  });

  it('turns empty strings into nulls rather than blank fields', () => {
    const [e] = wantlistEntries([want({ label: '', catno: '', notes: '' })]);
    expect(e.label).toBeNull();
    expect(e.catalogNumber).toBeNull();
    expect(e.notes).toBeNull();
  });

  it('keeps a null year null', () => {
    expect(wantlistEntries([want({ year: null })])[0].year).toBeNull();
  });

  it("carries the collector's own note", () => {
    expect(wantlistEntries([want({ notes: 'repress only' })])[0].notes)
      .toBe('repress only');
  });

  /* Two pressings of one record is an ordinary thing to have wanted. */
  it('collapses the same record listed twice', () => {
    const entries = wantlistEntries([
      want({ discogsId: 1, catno: 'ALN 001' }),
      want({ discogsId: 2, catno: 'ALN 001 RP' }),
    ]);
    expect(entries).toHaveLength(1);
  });

  it('treats artist and title case-insensitively when deduping', () => {
    const entries = wantlistEntries([
      want({ discogsId: 1, artist: 'Burial', title: 'Untrue' }),
      want({ discogsId: 2, artist: 'BURIAL', title: 'untrue' }),
    ]);
    expect(entries).toHaveLength(1);
  });

  it('keeps two genuinely different records', () => {
    const entries = wantlistEntries([
      want({ discogsId: 1, artist: 'Burial', title: 'Untrue' }),
      want({ discogsId: 2, artist: 'Burial', title: 'Burial' }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it('drops a row with neither an artist nor a title', () => {
    expect(wantlistEntries([want({ artist: '  ', title: '   ' })])).toHaveLength(0);
  });

  /* A compilation has no artist worth searching for but a very real title. */
  it('keeps a release that has a title but no artist', () => {
    const entries = wantlistEntries([want({ artist: '', title: 'Bison Bop Volume 1' })]);
    expect(entries).toHaveLength(1);
    expect(entries[0].artist).toBe('');
  });

  it('handles an empty list', () => {
    expect(wantlistEntries([])).toEqual([]);
  });

  /* Nothing here is inferred, so nothing claims a confidence — unlike the
   * YouTube path, where the artist/title split is a parse. */
  it('claims no confidence, because nothing was parsed', () => {
    const [e] = wantlistEntries([want()]);
    expect('confidence' in e).toBe(false);
  });
});

describe('wantQuery', () => {
  it('joins artist and title', () => {
    expect(wantQuery(want({ artist: 'Burial', title: 'Untrue' }))).toBe('Burial Untrue');
  });

  it('drops the empty half rather than leaving a stray space', () => {
    expect(wantQuery(want({ artist: '', title: 'Untrue' }))).toBe('Untrue');
    expect(wantQuery(want({ artist: 'Burial', title: '' }))).toBe('Burial');
  });
});
