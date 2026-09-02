/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The YouTube sheet's columns. The engine itself is covered by
 * searchColumns.test.ts; what is new here is TWO pinned columns (search has
 * one), so these pin the behaviour the sheet depends on: neither pinned column
 * can be turned off or dragged out of the front, and a stored order is repaired
 * with both of them ahead of everything else.
 */

import { describe, expect, it } from 'vitest';
import {
  YT_COLUMNS, YT_DEFAULT_COLUMNS, ytNormaliseColumns, ytTemplateFor, ytVisibleColumns,
} from './youtubeColumns.ts';

describe('youtube columns', () => {
  it('defaults to the spreadsheet order', () => {
    expect(YT_DEFAULT_COLUMNS[0]).toBe('title');
    expect(YT_DEFAULT_COLUMNS).toContain('artist');
    expect(YT_DEFAULT_COLUMNS).toContain('downloaded');
    // The two opt-in columns are not shown by default.
    expect(YT_DEFAULT_COLUMNS).not.toContain('description');
    expect(YT_DEFAULT_COLUMNS).not.toContain('published');
  });

  it('keeps both pinned columns at the front when normalising', () => {
    const repaired = ytNormaliseColumns(['album', 'search', 'title', 'style']);
    expect(repaired.slice(0, 2)).toEqual(['title', 'search']);
  });

  it('refuses to toggle a pinned column off', () => {
    expect(YT_COLUMNS.toggle(YT_DEFAULT_COLUMNS, 'title')).toEqual(YT_DEFAULT_COLUMNS);
    expect(YT_COLUMNS.toggle(YT_DEFAULT_COLUMNS, 'search')).toEqual(YT_DEFAULT_COLUMNS);
  });

  it('toggles a normal column on and off', () => {
    const on = YT_COLUMNS.toggle(YT_DEFAULT_COLUMNS, 'description');
    expect(on).toContain('description');
    expect(YT_COLUMNS.toggle(on, 'description')).not.toContain('description');
  });

  it('does not let a reorder push a column ahead of the pinned pair', () => {
    const moved = YT_COLUMNS.reorder(YT_DEFAULT_COLUMNS, 'album', 0);
    expect(moved.slice(0, 2)).toEqual(['title', 'search']);
    expect(moved.indexOf('album')).toBeGreaterThanOrEqual(2);
  });

  it('drops the lowest-priority column first when space is tight', () => {
    // url has the lowest priority of the defaults, so it goes before style.
    const fits = ytVisibleColumns(YT_DEFAULT_COLUMNS, 20);
    expect(fits).toContain('title');
    expect(fits).toContain('search');
    expect(fits).not.toContain('url');
  });

  it('never drops a pinned column, however narrow', () => {
    const fits = ytVisibleColumns(YT_DEFAULT_COLUMNS, 1);
    expect(fits).toContain('title');
    expect(fits).toContain('search');
  });

  it('builds a grid template of the right length', () => {
    expect(ytTemplateFor(['title', 'search', 'duration']).split(' ').length)
      .toBeGreaterThanOrEqual(3);
  });

  it('repairs an unknown stored column away', () => {
    expect(ytNormaliseColumns(['title', 'search', 'nonsense'])).not.toContain('nonsense');
  });

  it('falls back to the defaults for an empty stored value', () => {
    expect(ytNormaliseColumns(null)).toEqual(YT_DEFAULT_COLUMNS);
  });
});
