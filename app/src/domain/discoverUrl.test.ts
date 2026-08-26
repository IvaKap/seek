/*
 * Seek — URL detection tests.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The load-bearing case is the NEGATIVE one: a user who types an ordinary query
 * must never see a preview card. Everything else here is a convenience.
 */

import { describe, expect, it } from 'vitest';
import { guessUrl, looksLikeUrl } from './discoverUrl.ts';

describe('looksLikeUrl', () => {
  it('accepts http and https', () => {
    expect(looksLikeUrl('https://youtu.be/abc')).toBe(true);
    expect(looksLikeUrl('http://example.bandcamp.com/album/x')).toBe(true);
  });

  it('tolerates surrounding whitespace, as a paste does', () => {
    expect(looksLikeUrl('  https://youtu.be/abc \n')).toBe(true);
  });

  it('rejects ordinary search queries, including ones with dots', () => {
    for (const query of [
      'Burial Untrue',
      'Aphex Twin - Windowlicker.flac',
      'RA.823',
      'discogs.com/release/123',        // no scheme: a query that mentions a site
      'www.youtube.com/watch?v=x',
      'ftp://example.com/x',
      '',
      'https://',
      'https:// two words',
    ]) {
      expect(looksLikeUrl(query), query).toBe(false);
    }
  });
});

describe('guessUrl — providers', () => {
  it('recognises the YouTube hosts', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=Nc4L9tOFvxA',
      'https://youtube.com/watch?v=Nc4L9tOFvxA',
      'https://m.youtube.com/watch?v=Nc4L9tOFvxA',
      'https://youtu.be/Nc4L9tOFvxA',
      'https://music.youtube.com/watch?v=Nc4L9tOFvxA',
    ]) {
      expect(guessUrl(url)?.provider, url).toBe('youtube');
    }
  });

  it('flags a YouTube playlist', () => {
    expect(guessUrl('https://www.youtube.com/playlist?list=PLabc')?.playlist).toBe(true);
    expect(guessUrl('https://www.youtube.com/watch?v=x&list=PLabc')?.playlist).toBe(true);
    expect(guessUrl('https://youtu.be/x')?.playlist).toBe(false);
  });

  it('recognises Bandcamp subdomains and marks albums', () => {
    const album = guessUrl('https://hyperdub.bandcamp.com/album/untrue');
    expect(album?.provider).toBe('bandcamp');
    expect(album?.album).toBe(true);

    const track = guessUrl('https://hyperdub.bandcamp.com/track/archangel');
    expect(track?.provider).toBe('bandcamp');
    expect(track?.album).toBe(false);
  });

  it('does not mistake a lookalike host for Bandcamp', () => {
    // The trap: `endsWith('bandcamp.com')` would match `notbandcamp.com`.
    expect(guessUrl('https://notbandcamp.com/album/x')?.provider).toBeNull();
    expect(guessUrl('https://bandcamp.com.evil.example/album/x')?.provider).toBeNull();
  });

  it('recognises Discogs entities', () => {
    expect(guessUrl('https://www.discogs.com/release/1082826')?.album).toBe(true);
    expect(guessUrl('https://www.discogs.com/master/12345')?.album).toBe(true);
    expect(guessUrl('https://www.discogs.com/label/23604-Hyperdub')?.album).toBe(false);
    expect(guessUrl('https://www.discogs.com/artist/12345')?.provider).toBe('discogs');
  });

  it('an unfamiliar host is still worth asking about — Bandcamp custom domains', () => {
    const guess = guessUrl('https://music.mysterylabel.co.uk/album/whatever');
    expect(guess).not.toBeNull();
    expect(guess?.provider).toBeNull();
  });

  it('a non-URL is not a guess', () => {
    expect(guessUrl('Burial Untrue')).toBeNull();
  });

  it('returns the URL trimmed, ready for the wire', () => {
    expect(guessUrl('  https://youtu.be/abc  ')?.url).toBe('https://youtu.be/abc');
  });
});
