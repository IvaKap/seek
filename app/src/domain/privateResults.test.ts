/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Buddy-only search results, end to end: wire -> ingest -> filter.
 *
 * THE BUG THIS PINS. The sidecar has always marked buddy-only results — it
 * calls `searches.accept(..., private=True)` for `msg.privatelist`, and
 * `SearchResultEvent.private` is documented in the schema — and the app threw
 * the flag away in `adaptSearchResult`. So a peer's buddy-only files sat in the
 * results looking exactly like public ones, and every attempt to download one
 * came back "File not shared." from their client, which Seek renders as "They
 * are no longer sharing this file".
 *
 * That wording is true and useless: they never offered it to you in the first
 * place. Measured on a real download history, 27 of 89 transfers failed that
 * way, and all eleven peers that produced a failure failed EVERY time — the
 * signature of a per-peer permission problem rather than deleted files.
 *
 * Two things have to hold forever: the flag survives the adapter, and the
 * default hides these rows.
 */

import { describe, expect, it } from 'vitest';
import { adaptSearchResult } from '../data/adapt.ts';
import type { WireFileRef, WireSearchResultData } from '../data/adapt.ts';
import { matches } from './group.ts';
import { EMPTY_FILTERS, filtersActive } from './types.ts';
import type { Filters } from './types.ts';

const FILE: WireFileRef = {
  path: 'music\\Basic Channel\\BCD\\01 Phylyps Trak.flac',
  size: 38_000_000,
  bitrate: null,
  duration: 401,
  sampleRate: 44_100,
  bitDepth: 16,
  isVbr: null,
};

function response(over: Partial<WireSearchResultData> = {}): WireSearchResultData {
  return {
    searchId: 1,
    peer: {
      username: 'a-peer',
      freeSlots: true,
      advertisedSpeed: 1_000_000,
      queueLength: 0,
      files: 1000,
      folders: 100,
      country: 'DE',
    },
    files: [FILE],
    ...over,
  };
}

const adapt = (over: Partial<WireSearchResultData> = {}) =>
  adaptSearchResult(response(over), 0, () => 0.5);

/** No text terms — the filter splits those separately. */
const run = (s: ReturnType<typeof adapt>[number], f: Filters) => matches(s, f, [], []);

describe('the private flag survives the wire', () => {
  it('is carried onto every file of a buddy-only response', () => {
    const files = adapt({ private: true });
    expect(files).toHaveLength(1);
    expect(files[0].private).toBe(true);
  });

  it('is false for a public response', () => {
    expect(adapt({ private: false })[0].private).toBe(false);
  });

  it('is false when the field is absent, which is what the fixture replay sends', () => {
    // Absent must not become `undefined` on the domain object: the filter
    // tests truthiness, and a missing flag has to read as public.
    expect(adapt()[0].private).toBe(false);
  });
});

describe('the default hides them', () => {
  it('EMPTY_FILTERS hides private results', () => {
    // The whole fix rests on this being the default rather than an opt-in.
    expect(EMPTY_FILTERS.hidePrivate).toBe(true);
  });

  it('a buddy-only result is filtered out by default', () => {
    expect(run(adapt({ private: true })[0], EMPTY_FILTERS)).toBe(false);
  });

  it('a public result is not', () => {
    expect(run(adapt({ private: false })[0], EMPTY_FILTERS)).toBe(true);
  });

  it('shows them once asked, and still shows public ones', () => {
    const show: Filters = { ...EMPTY_FILTERS, hidePrivate: false };
    expect(run(adapt({ private: true })[0], show)).toBe(true);
    expect(run(adapt({ private: false })[0], show)).toBe(true);
  });

  it('does not let hidePrivate swallow a result for any other reason', () => {
    // Guards against the filter being written as `if (s.private) return false`
    // regardless of the flag — the public row must survive both settings.
    const pub = adapt({ private: false })[0];
    expect(run(pub, EMPTY_FILTERS)).toBe(true);
    expect(run(pub, { ...EMPTY_FILTERS, hidePrivate: false })).toBe(true);
  });
});

describe('showing private results counts as a non-default filter state', () => {
  it('the defaults are not "active"', () => {
    // If this flipped, every fresh search would claim it was filtered.
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
  });

  it('turning them on IS active, so Clear puts them back', () => {
    expect(filtersActive({ ...EMPTY_FILTERS, hidePrivate: false })).toBe(true);
  });
});
