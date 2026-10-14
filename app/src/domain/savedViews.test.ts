/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Saved views: which one the search is on is worked out from its filters and
 * grouping, never stored, and yours survive storage or are dropped whole.
 */

import { describe, expect, it } from 'vitest';
import { BUILT_IN_VIEWS, currentView, parseViews, sameFilters, storeViews, withView } from './savedViews.ts';
import type { SavedView } from './savedViews.ts';
import { EMPTY_FILTERS } from './types.ts';
import type { Filters } from './types.ts';

const filters = (over: Partial<Filters> = {}): Filters => ({ ...EMPTY_FILTERS, formats: new Set(), ...over });
const names = (views: SavedView[]) => views.map((v) => v.name);

describe('which view the search is on', () => {
  it('is the one its filters and grouping equal, whatever order the formats were picked in', () => {
    expect(currentView(BUILT_IN_VIEWS, filters(), 'release')?.name).toBe('All results');
    expect(currentView(BUILT_IN_VIEWS, filters({ losslessOnly: true, freeSlotsOnly: true }), 'release')?.name)
      .toBe('Lossless, slot free');
    expect(sameFilters(filters({ formats: new Set(['FLAC', 'WAV']) }), filters({ formats: new Set(['WAV', 'FLAC']) })))
      .toBe(true);
  });

  it('is none once a pill or the grouping moves away from every view', () => {
    expect(currentView(BUILT_IN_VIEWS, filters({ excludeTranscodes: true }), 'release')).toBeUndefined();
    expect(currentView(BUILT_IN_VIEWS, filters(), 'track')).toBeUndefined();
    expect(sameFilters(filters({ formats: new Set(['FLAC']) }), filters({ formats: new Set(['FLAC', 'WAV']) })))
      .toBe(false);
  });
});

describe('your views', () => {
  const flac: SavedView = { name: 'FLAC tracks', groupBy: 'track', filters: filters({ formats: new Set(['FLAC']), minSpeed: 500 }) };

  it('replace one of the same name, so saving again is how a view is updated', () => {
    const updated = { ...flac, name: 'flac TRACKS', groupBy: 'file' as const };
    expect(names(withView([flac], updated))).toEqual(['flac TRACKS']);
    expect(names(withView([flac], { ...flac, name: 'Fast' }))).toEqual(['FLAC tracks', 'Fast']);
  });

  it('come back from storage as they went in', () => {
    const [back] = parseViews(storeViews([flac]));
    expect(back.name).toBe('FLAC tracks');
    expect(back.groupBy).toBe('track');
    expect(sameFilters(back.filters, flac.filters)).toBe(true);
  });

  it('are dropped whole when storage holds something unreadable', () => {
    for (const junk of [null, '', 'not json', '{"a":1}', '[null, 3, {"name": 1}]']) expect(parseViews(junk)).toEqual([]);
    const stored = JSON.parse(storeViews([flac])) as Array<Record<string, unknown>>;
    // A grouping the control no longer offers, and a nameless view.
    const bad = [{ ...stored[0], groupBy: 'user' }, { ...stored[0], name: '  ' }, stored[0]];
    expect(names(parseViews(JSON.stringify(bad)))).toEqual(['FLAC tracks']);
  });
});
