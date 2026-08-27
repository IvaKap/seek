/*
 * Seek — turning a provider's answer into a preview card.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * These run against the SAME recorded responses as the sidecar's
 * test_discover.py, one layer further on: that suite proves the sidecar
 * forwards raw facts, this one proves the frontend derives the right things
 * from them. The payloads below are the real shapes, hand-copied from
 * fixtures/discover/ rather than imported, because the wire is the contract
 * and a test that reads the fixture file would drift with it silently.
 */

import { describe, expect, it } from 'vitest';
import { classifyFailure, previewFromWire, previewQuery } from './discoverStore.ts';
import type { WireParsed } from './discoverStore.ts';

function wire(over: Partial<WireParsed> = {}): WireParsed {
  return {
    requestId: 'r1', url: 'https://www.youtube.com/watch?v=8k_f2QK77ew',
    sourceKind: 'youtube', kind: 'track', rawTitle: '', channel: '',
    artist: '', title: '', album: null, year: null, label: null,
    catalogNumber: null, artworkUri: null, duration: null,
    genres: [], tracklist: [], providerUrl: null,
    ...over,
  };
}

describe('previewFromWire — YouTube, where nothing is stated', () => {
  it('parses the raw title the recorded fixture actually carries', () => {
    const p = previewFromWire(wire({
      rawTitle: 'Burial, Archangel', channel: 'Hyperdub',
    }));
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Archangel');
    expect(p.provider).toBe('youtube');
    // Parsed, not stated — so the card must show its working.
    expect(p.parsedFrom).toBe('comma');
    expect(p.confidence).toBeLessThan(1);
  });

  it('keeps the raw title when it cannot be split', () => {
    const p = previewFromWire(wire({ rawTitle: 'TRAUMPRINZ All The Things' }));
    expect(p.artist).toBe('');
    expect(p.title).toBe('TRAUMPRINZ All The Things');
    expect(p.rawTitle).toBe('TRAUMPRINZ All The Things');
    expect(p.confidence).toBeLessThan(0.5);
  });

  it('trusts YouTube Music more, because it enforces the shape', () => {
    const plain = previewFromWire(wire({ rawTitle: 'Burial - Archangel' }));
    const music = previewFromWire(wire({
      rawTitle: 'Burial - Archangel',
      url: 'https://music.youtube.com/watch?v=8k_f2QK77ew',
    }));
    expect(music.confidence).toBeGreaterThan(plain.confidence);
  });
});

describe('previewFromWire — Bandcamp and Discogs, where fields are stated', () => {
  it('takes Bandcamp at its word and claims full confidence', () => {
    const p = previewFromWire(wire({
      sourceKind: 'bandcamp', kind: 'release',
      url: 'https://timreaper.bandcamp.com/album/in-full-effect',
      rawTitle: 'In Full Effect', artist: 'Tim Reaper, Kloke',
      title: 'In Full Effect', album: 'In Full Effect', year: 2024,
      label: 'Tim Reaper',
      tracklist: [
        { position: 1, title: 'Continuities', artist: '', duration: 395 },
        { position: 2, title: 'Blood Pressure', artist: '', duration: 317 },
      ],
    }));
    expect(p.artist).toBe('Tim Reaper, Kloke');
    expect(p.title).toBe('In Full Effect');
    expect(p.trackCount).toBe(2);
    // Stated by the provider: no parse ran, so there is no provenance to show
    // and no doubt to invent.
    expect(p.confidence).toBe(1);
    expect(p.parsedFrom).toBeNull();
  });

  it('does NOT parse a stated artist that happens to contain a comma', () => {
    // The trap: `Tim Reaper, Kloke` is one credit for two people. Running the
    // comma rule over it would turn a duo into an artist and a track title.
    const p = previewFromWire(wire({
      sourceKind: 'bandcamp', artist: 'Tim Reaper, Kloke', title: 'In Full Effect',
    }));
    expect(p.artist).toBe('Tim Reaper, Kloke');
    expect(p.title).toBe('In Full Effect');
  });

  it('carries the Discogs catalogue fields', () => {
    const p = previewFromWire(wire({
      sourceKind: 'discogs', kind: 'release',
      url: 'https://www.discogs.com/release/1125103',
      rawTitle: 'Untrue', artist: 'Burial', title: 'Untrue', album: 'Untrue',
      year: 2007, label: 'Hyperdub', catalogNumber: 'HDBCD002',
      genres: ['Electronic', 'Dubstep'],
      tracklist: new Array(13).fill(null).map((_x, i) => ({
        position: i + 1, title: `t${i}`, artist: '', duration: null,
      })),
    }));
    expect(p.label).toBe('Hyperdub');
    expect(p.catalogNumber).toBe('HDBCD002');
    expect(p.year).toBe(2007);
    expect(p.trackCount).toBe(13);
  });

  it('prefers a stated label over one parsed out of brackets', () => {
    const p = previewFromWire(wire({
      sourceKind: 'discogs', rawTitle: 'Archangel [Some Bracket]',
      artist: 'Burial', title: 'Archangel', label: 'Hyperdub',
    }));
    expect(p.label).toBe('Hyperdub');
  });

  it('falls back to a parsed label when the provider gives none', () => {
    const p = previewFromWire(wire({ rawTitle: 'Burial - Archangel [Hyperdub]' }));
    expect(p.label).toBe('Hyperdub');
  });
});

describe('previewQuery', () => {
  it('a track searches artist and title', () => {
    const p = previewFromWire(wire({ rawTitle: 'Burial - Archangel' }));
    expect(previewQuery(p)).toBe('Burial Archangel');
  });

  it('a release searches the ALBUM, because a DJ downloads folders', () => {
    const p = previewFromWire(wire({
      sourceKind: 'discogs', kind: 'release', artist: 'Burial',
      title: 'Untrue', album: 'Untrue',
    }));
    expect(previewQuery(p)).toBe('Burial Untrue');
  });

  it('a label page searches the label name', () => {
    const p = previewFromWire(wire({
      sourceKind: 'discogs', kind: 'label', rawTitle: 'Hyperdub',
      artist: '', title: 'Hyperdub',
    }));
    expect(previewQuery(p)).toBe('Hyperdub');
  });

  /* Shipped broken to 0.2.4 and found by the first person to paste an artist
   * link for a label they collect. `parse_discogs` reports an artist page's
   * one name in BOTH `artist` and `title`, so joining them searched the name
   * twice. The label case above passed throughout, because a label page leaves
   * `artist` empty — which is exactly why the artist case needed its own. */
  it('an artist page searches the name ONCE, not twice', () => {
    const p = previewFromWire(wire({
      sourceKind: 'discogs', kind: 'artist', rawTitle: 'James',
      artist: 'James', title: 'James',
    }));
    expect(previewQuery(p)).toBe('James');
  });

  it('no preview is an empty query, never a search for nothing', () => {
    expect(previewQuery(null)).toBe('');
  });

  it('an unparseable title still yields something searchable', () => {
    const p = previewFromWire(wire({ rawTitle: 'TRAUMPRINZ All The Things' }));
    expect(previewQuery(p)).toBe('TRAUMPRINZ All The Things');
  });
});

describe('classifyFailure — the message a person actually gets', () => {
  /* 0.2.0 shipped with no CA bundle in the frozen app, so every lookup failed
   * on TLS and every card read "Not a link Seek recognises". These pin the
   * distinction that was missing. */

  it('calls a transport failure unreachable, not unrecognised', () => {
    expect(classifyFailure({ unreachable: true }, 'not-recognised')).toBe('unreachable');
  });

  it('still calls a link nobody recognises unrecognised', () => {
    expect(classifyFailure({ unreachable: false }, 'not-recognised')).toBe('not-recognised');
  });

  it('lets a missing token win over an unreachable provider', () => {
    /* Both can be true at once — an expired token on a flaky connection. The
     * token is the one the user can do something about. */
    expect(classifyFailure({ needs: 'discogsToken', unreachable: true }, 'not-recognised'))
      .toBe('needs-setting');
  });

  it('honours the surface-specific fallback', () => {
    /* A playlist that would not load cannot be "searched as text" the way a
     * URL can, so its fallback says less. */
    expect(classifyFailure({}, 'failed')).toBe('failed');
    expect(classifyFailure({}, 'not-recognised')).toBe('not-recognised');
  });

  it('treats an absent flag as reachable rather than assuming the worst', () => {
    /* An older sidecar sends no `unreachable` at all. Defaulting it to true
     * would report every ordinary 404 as a network problem. */
    expect(classifyFailure({}, 'not-recognised')).toBe('not-recognised');
  });

  it('does not treat an empty needs string as a setting problem', () => {
    expect(classifyFailure({ needs: '', unreachable: true }, 'not-recognised'))
      .toBe('unreachable');
  });
});

describe('a token that exists and was refused', () => {
  /* From a real report: "i pasted and saved the token, now the search says
   * discogs token needed". A 401 carries `needs` too, so without this the
   * card told someone to supply what they had already supplied. */

  it('is not reported as a missing setting', () => {
    const line = classifyFailure(
      { needs: 'discogsToken', unauthorised: true }, 'not-recognised',
    );
    expect(line).toBe('unauthorised');
    expect(line).not.toBe('needs-setting');
  });

  it('still says needs-setting when there genuinely is no token', () => {
    expect(classifyFailure({ needs: 'discogsToken' }, 'not-recognised'))
      .toBe('needs-setting');
  });

  it('outranks unreachable, because the provider clearly answered', () => {
    expect(classifyFailure(
      { needs: 'discogsToken', unauthorised: true, unreachable: false }, 'not-recognised',
    )).toBe('unauthorised');
  });

  it('treats an absent flag as "not refused" rather than assuming the worst', () => {
    /* An older sidecar sends no `unauthorised` at all. */
    expect(classifyFailure({ needs: 'discogsToken' }, 'not-recognised'))
      .toBe('needs-setting');
    expect(classifyFailure({}, 'not-recognised')).toBe('not-recognised');
  });
});
