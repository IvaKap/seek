/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The query a YouTube row is searched by. This is the seam: the sidecar never
 * derives it, so if this is wrong the whole feature searches Discogs for the
 * wrong thing. The cases are the noise real music uploads carry.
 */

import { describe, expect, it } from 'vitest';
import { cleanForDiscogs, discogsQuery } from './youtubeMatch.ts';

describe('cleanForDiscogs', () => {
  it('strips bracketed and parenthesised asides', () => {
    expect(cleanForDiscogs('Windowlicker [Official Video]')).toBe('Windowlicker');
    expect(cleanForDiscogs('Rez (Remastered 2013)')).toBe('Rez');
    expect(cleanForDiscogs('Track [FREE DL]')).toBe('Track');
  });

  it('strips upload furniture', () => {
    expect(cleanForDiscogs('Archangel (Official Music Video)')).toBe('Archangel');
    expect(cleanForDiscogs('Some Track HD')).toBe('Some Track');
    expect(cleanForDiscogs('Whole Thing Full Album')).toBe('Whole Thing');
  });

  it('strips version qualifiers a Discogs release will not carry', () => {
    expect(cleanForDiscogs('Untrue (Extended Mix)')).toBe('Untrue');
    expect(cleanForDiscogs('Untrue - Radio Edit')).toBe('Untrue');
    expect(cleanForDiscogs('Untrue (Someone Remix)')).toBe('Untrue');
  });

  it('collapses whitespace and trims stray separators', () => {
    expect(cleanForDiscogs('  Burial   -  ')).toBe('Burial');
    expect(cleanForDiscogs('A   B')).toBe('A B');
  });

  it('leaves a clean title alone', () => {
    expect(cleanForDiscogs('Aural Imbalance')).toBe('Aural Imbalance');
  });

  it('is empty for empty-ish input', () => {
    expect(cleanForDiscogs('')).toBe('');
    expect(cleanForDiscogs('   ')).toBe('');
  });
});

describe('discogsQuery', () => {
  it('splits artist and title from a dash title', () => {
    const q = discogsQuery('Aural Imbalance - Thought Patterns');
    expect(q.artist).toBe('Aural Imbalance');
    expect(q.title).toBe('Thought Patterns');
  });

  it('cleans noise out of both halves', () => {
    const q = discogsQuery('Burial - Archangel (Official Video) [HD]');
    expect(q.artist).toBe('Burial');
    expect(q.title).toBe('Archangel');
  });

  it('falls back to the cleaned whole title when there is no artist', () => {
    // A bare, single-part title: no artist to find, but the search must not be
    // empty — the whole thing carries it, as the old script always did.
    const q = discogsQuery('Windowlicker [Official Video]');
    expect(q.artist).toBe('');
    expect(q.title).toBe('Windowlicker');
  });

  it('never yields an empty title for input that has real content', () => {
    for (const t of ['Rez', 'A - B', 'Boiler Room - Someone - Live']) {
      expect(discogsQuery(t).title.length).toBeGreaterThan(0);
    }
  });

  it('yields an empty query for a title that is all noise', () => {
    // Nothing to search; the sidecar will mark it "none" rather than mis-match
    // against a search for the word "video".
    const q = discogsQuery('(Official Video)');
    expect(q.artist).toBe('');
    expect(q.title).toBe('');
  });

  it('uses the channel to resolve uploader branding', () => {
    // On the label's own channel, the first dash-part is the label, not the
    // artist — parseTitle uses the channel to tell, and the query should too.
    const q = discogsQuery('Hyperdub - Burial - Archangel', 'Hyperdub');
    expect(q.artist.toLowerCase()).not.toContain('hyperdub');
  });
});
