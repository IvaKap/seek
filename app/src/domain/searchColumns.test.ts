/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The reason columns became data rather than CSS: the rules they replace hid
 * columns by POSITION (`nth-child(9)` meaning "user"), which is only true while
 * the set never changes. These tests pin that dropping now follows the column,
 * not its index — and that the order of sacrifice the CSS encoded survived.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMNS, normaliseColumns, reorderColumns, templateFor, toggleColumn,
  visibleColumns,
} from './searchColumns.ts';
import type { ColumnId } from './searchColumns.ts';

describe('visibleColumns', () => {
  it('keeps every default column when there is room', () => {
    expect(visibleColumns(DEFAULT_COLUMNS, 100)).toEqual(DEFAULT_COLUMNS);
  });

  it('drops user, then queue, then spec — the order the CSS encoded', () => {
    /* The old rules dropped nth-child(9) at 58em, (7) at 46em and (3) at 38em,
     * which were user, queue and spec. Same sequence, now by priority. */
    const dropped: ColumnId[][] = [90, 52, 46, 40].map(
      (rem) => visibleColumns(DEFAULT_COLUMNS, rem),
    );
    expect(dropped[0]).toContain('user');
    expect(dropped[1]).not.toContain('user');
    expect(dropped[1]).toContain('queue');
    expect(dropped[2]).not.toContain('queue');
    expect(dropped[2]).toContain('spec');
    expect(dropped[3]).not.toContain('spec');
  });

  it('drops the right column AFTER a reorder', () => {
    /* The whole point. Move user to the front of the value columns and it must
     * still be the first thing sacrificed — under the old nth-child rules the
     * table would instead have hidden whatever had landed in ninth place. */
    const moved = reorderColumns(DEFAULT_COLUMNS, 'user', 1);
    expect(moved[1]).toBe('user');
    const tight = visibleColumns(moved, 52);
    expect(tight).not.toContain('user');
    expect(tight).toContain('size');
  });

  it('never drops name, format or the quality check', () => {
    /* The row must stay identifiable, the badge is the only colour in the line,
     * and the check is the verdict the screen exists to deliver. */
    const squeezed = visibleColumns(DEFAULT_COLUMNS, 1);
    expect(squeezed).toContain('name');
    expect(squeezed).toContain('format');
    expect(squeezed).toContain('check');
  });

  it('sacrifices an added column before one that was already there', () => {
    /* Switching on Bitrate is not a request to lose Size. */
    const withExtra = toggleColumn(DEFAULT_COLUMNS, 'bitrate');
    const tight = visibleColumns(withExtra, 52);
    expect(tight).not.toContain('bitrate');
    expect(tight).toContain('size');
  });
});

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
    /* Every other column is right-aligned against the name, so a table that
     * put it third would be unreadable rather than merely unusual. */
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
  it('gives the name all the slack and everything else a fixed track', () => {
    expect(templateFor(['name', 'format', 'check']))
      .toBe('minmax(6rem, 1fr) 4.5rem 1.75rem');
  });
});
