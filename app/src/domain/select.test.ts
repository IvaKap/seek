/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it } from 'vitest';
import { nextSelection } from './select.ts';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const set = (...ids: string[]) => new Set(ids);
const sorted = (s: Set<string>) => [...s].sort();

describe('nextSelection', () => {
  it('plain click selects only that row and makes it the anchor', () => {
    const r = nextSelection(set('a', 'b'), ORDER, 'd', 'a', {});
    expect(sorted(r.selected)).toEqual(['d']);
    expect(r.anchor).toBe('d');
  });

  it('cmd-click adds a row without dropping the others', () => {
    const r = nextSelection(set('a'), ORDER, 'c', 'a', { meta: true });
    expect(sorted(r.selected)).toEqual(['a', 'c']);
    expect(r.anchor).toBe('c');
  });

  it('cmd-click a selected row toggles it off', () => {
    const r = nextSelection(set('a', 'c'), ORDER, 'c', 'a', { meta: true });
    expect(sorted(r.selected)).toEqual(['a']);
    // Anchor still moves to the clicked row, matching Finder.
    expect(r.anchor).toBe('c');
  });

  it('shift-click selects the contiguous range from the anchor', () => {
    const r = nextSelection(set('b'), ORDER, 'd', 'b', { shift: true });
    expect(sorted(r.selected)).toEqual(['b', 'c', 'd']);
    expect(r.anchor).toBe('b');
  });

  it('shift-click works when the click is ABOVE the anchor', () => {
    const r = nextSelection(set('d'), ORDER, 'b', 'd', { shift: true });
    expect(sorted(r.selected)).toEqual(['b', 'c', 'd']);
    expect(r.anchor).toBe('d');
  });

  it('shift-click REPLACES the prior selection rather than adding to it', () => {
    /* Prior selection of 'a' is dropped: a plain shift-range is a fresh range,
     * not an accumulation (that is what cmd is for). */
    const r = nextSelection(set('a'), ORDER, 'c', 'b', { shift: true });
    expect(sorted(r.selected)).toEqual(['b', 'c']);
  });

  it('shift with no anchor behaves like a plain click', () => {
    const r = nextSelection(set('a'), ORDER, 'c', null, { shift: true });
    expect(sorted(r.selected)).toEqual(['c']);
    expect(r.anchor).toBe('c');
  });

  it('shift with an anchor from another group falls back to a plain click', () => {
    // 'z' is not in this group's order — the range cannot be measured.
    const r = nextSelection(set('a'), ORDER, 'c', 'z', { shift: true });
    expect(sorted(r.selected)).toEqual(['c']);
    expect(r.anchor).toBe('c');
  });

  it('never mutates the set it was handed', () => {
    const current = set('a', 'b');
    nextSelection(current, ORDER, 'c', 'a', { meta: true });
    expect(sorted(current)).toEqual(['a', 'b']);
  });
});
