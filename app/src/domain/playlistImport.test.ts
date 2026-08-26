/*
 * Seek — turning a real YouTube playlist into want list rows.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The titles below are VERBATIM from a live playlistItems response for
 * Burial's Untrue, not invented. That matters: a hand-written fixture would
 * have used tidy `Artist - Title` strings and missed every case here.
 */

import { describe, expect, it } from 'vitest';
import { playlistEntries, stripPositionalTrackNumber, weakCount } from './playlistImport.ts';
import type { DiscoverPlaylistItem } from '../../../shared/protocol.ts';

function item(over: Partial<DiscoverPlaylistItem> & { title: string; position: number }): DiscoverPlaylistItem {
  return {
    videoId: `v${over.position}`, channel: 'Hyperdub', available: true, ...over,
  } as DiscoverPlaylistItem;
}

/** Straight off the wire, in playlist order. */
const REAL: DiscoverPlaylistItem[] = [
  item({ title: 'Burial 01, Untitled', position: 0 }),
  item({ title: 'Burial, Archangel', position: 1 }),
  item({ title: 'Burial: Near Dark', position: 2 }),
  item({ title: 'Burial,  Ghost Hardware', position: 3 }),
  item({ title: 'Burial: Endorphin (Hyperdub 2007)', position: 4 }),
];

describe('stripPositionalTrackNumber', () => {
  it('removes a number the playlist itself corroborates', () => {
    // "Burial 01" at position 0 is track 1, so the 01 is an index.
    expect(stripPositionalTrackNumber('Burial 01', 0)).toBe('Burial');
  });

  it('keeps a number that is part of the artist name', () => {
    /* The reason the naive fix is not allowed. These are real acts, and
     * stripping their digits would quietly rename them. */
    expect(stripPositionalTrackNumber('Front 242', 5)).toBe('Front 242');
    expect(stripPositionalTrackNumber('Model 500', 3)).toBe('Model 500');
    expect(stripPositionalTrackNumber('Unit 4', 9)).toBe('Unit 4');
  });

  it('keeps a number that does not match this position', () => {
    expect(stripPositionalTrackNumber('Burial 07', 0)).toBe('Burial 07');
  });

  it('never strips the whole name away', () => {
    expect(stripPositionalTrackNumber('01', 0)).toBe('01');
  });
});

describe('playlistEntries', () => {
  const entries = playlistEntries(REAL);

  it('recovers the artist from every real title shape', () => {
    expect(entries.map((e) => e.artist)).toEqual(
      ['Burial', 'Burial', 'Burial', 'Burial', 'Burial'],
    );
  });

  it('fixes the track number the raw parse absorbed into the artist', () => {
    // Without the positional correction this reads "Burial 01".
    expect(entries[0].artist).toBe('Burial');
    expect(entries[0].title).toBe('Untitled');
  });

  it('handles comma, double-space and colon separators alike', () => {
    expect(entries[1].title).toBe('Archangel');
    expect(entries[2].title).toBe('Near Dark');
    expect(entries[3].title).toBe('Ghost Hardware');
  });

  it('keeps the untouched original for every row', () => {
    expect(entries[0].raw).toBe('Burial 01, Untitled');
  });

  it('builds a query a Soulseek search can actually use', () => {
    expect(entries[1].query).toBe('Burial Archangel');
  });

  it('drops entries YouTube will not serve', () => {
    const withDead = [...REAL, item({ title: 'Deleted video', position: 5, available: false })];
    expect(playlistEntries(withDead)).toHaveLength(REAL.length);
  });

  it('does not put the same track on the list twice', () => {
    const twice = [
      item({ title: 'Burial, Archangel', position: 0 }),
      item({ title: 'Burial, Archangel', position: 1 }),
    ];
    expect(playlistEntries(twice)).toHaveLength(1);
  });

  it('drops an entry with nothing to search for', () => {
    expect(playlistEntries([item({ title: '', position: 0 })])).toHaveLength(0);
  });
});

describe('weakCount', () => {
  it('counts the rows a human should glance at', () => {
    // Every real Untrue title parses above the floor, so none need review.
    expect(weakCount(playlistEntries(REAL))).toBe(0);
  });
});
