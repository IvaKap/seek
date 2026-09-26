/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The search table's columns are data, not CSS: a stored choice is repaired
 * rather than trusted, Name can never be removed or moved, and the grid
 * template reads each width from a custom property so a hand-resize is one
 * property write.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMNS, SEARCH_COLUMN_SET, normaliseColumns, reorderColumns, templateFor,
  toggleColumn,
} from './searchColumns.ts';

describe('normaliseColumns', () => {
  it('drops ids it does not recognise', () => {
    /* A stored preference outlives the code that wrote it. */
    expect(normaliseColumns(['name', 'size', 'wat', 42, null]))
      .toEqual(['name', 'size']);
  });

  it('collapses duplicates', () => {
    expect(normaliseColumns(['name', 'size', 'size'])).toEqual(['name', 'size']);
  });

  it('forces name to the front', () => {
    /* Every value is read against the name, so a table that put it third
     * would be unreadable rather than merely unusual. */
    expect(normaliseColumns(['size', 'name', 'user'])[0]).toBe('name');
  });

  it('falls back to the defaults rather than rendering nothing', () => {
    expect(normaliseColumns([])).toEqual(DEFAULT_COLUMNS);
    expect(normaliseColumns('nonsense')).toEqual(DEFAULT_COLUMNS);
    expect(normaliseColumns(undefined)).toEqual(DEFAULT_COLUMNS);
  });
});

describe('toggleColumn and reorderColumns', () => {
  it('refuses to turn off or move the name', () => {
    expect(toggleColumn(DEFAULT_COLUMNS, 'name')).toEqual(DEFAULT_COLUMNS);
    expect(reorderColumns(DEFAULT_COLUMNS, 'name', 5)).toEqual(DEFAULT_COLUMNS);
  });

  it('adds a column at the end and removes it again', () => {
    const on = toggleColumn(DEFAULT_COLUMNS, 'year');
    expect(on[on.length - 1]).toBe('year');
    expect(toggleColumn(on, 'year')).toEqual(DEFAULT_COLUMNS);
  });

  it('clamps a move past either end instead of losing the column', () => {
    const front = reorderColumns(DEFAULT_COLUMNS, 'user', -5);
    expect(front[1]).toBe('user');
    expect(front).toHaveLength(DEFAULT_COLUMNS.length);
    const back = reorderColumns(DEFAULT_COLUMNS, 'format', 99);
    expect(back[back.length - 1]).toBe('format');
    expect(back).toHaveLength(DEFAULT_COLUMNS.length);
  });
});

describe('templateFor', () => {
  it('lets only the name absorb spare width, never going below its own width', () => {
    expect(templateFor(['name', 'format', 'check'])).toBe(
      'minmax(var(--w-name, 15rem), 1fr) var(--w-format, 4.25rem) var(--w-check, 3.5rem)',
    );
  });

  it('follows the chosen order, so a dragged column moves its track too', () => {
    const moved = reorderColumns(['name', 'format', 'check'], 'check', 1);
    expect(templateFor(moved)).toBe(
      'minmax(var(--w-name, 15rem), 1fr) var(--w-check, 3.5rem) var(--w-format, 4.25rem)',
    );
  });

  it('sums the same widths for the table minimum', () => {
    expect(SEARCH_COLUMN_SET.trackSum(['name', 'size']))
      .toBe('(var(--w-name, 15rem) + var(--w-size, 4.5rem))');
  });
});
