// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The saved views beside Collector's results: one click applies a whole view,
 * the selected one follows the search, and yours are named, kept and removed.
 */

import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SavedViews } from './SavedViews.tsx';
import type { SavedView } from '../domain/savedViews.ts';
import { EMPTY_FILTERS } from '../domain/types.ts';
import type { Filters, GroupBy } from '../domain/types.ts';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const KEY = 'seek.searchViews';

/** Owns the search's filters and grouping the way SearchView's session does. */
function Search({ start, groupBy: g = 'release', spy }: { start?: Partial<Filters>; groupBy?: GroupBy; spy?(v: SavedView): void }) {
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, formats: new Set(), ...start });
  const [groupBy, setGroupBy] = useState<GroupBy>(g);
  return (
    <SavedViews
      filters={filters}
      groupBy={groupBy}
      onApply={(v) => { spy?.(v); setFilters(v.filters); setGroupBy(v.groupBy); }}
    />
  );
}

const show = (props: Parameters<typeof Search>[0] = {}) => render(<StrictMode><Search {...props} /></StrictMode>);
const selected = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);

describe('the views', () => {
  it('select the one the search is on, and apply another in one click', () => {
    const spy = vi.fn();
    show({ spy });
    expect(selected()).toEqual(['All results']);
    expect((screen.getByRole('button', { name: '+ Save view' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Lossless, slot free' }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lossless, slot free', groupBy: 'release' }));
    expect(selected()).toEqual(['Lossless, slot free']);
  });

  it('select none once the search is something of your own, and keep it under the name you give', () => {
    show({ start: { formats: new Set(['FLAC']) }, groupBy: 'track' });
    expect(selected()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '+ Save view' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name this view' }), { target: { value: '  FLAC tracks ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(selected()).toEqual(['FLAC tracks']);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([
      expect.objectContaining({ name: 'FLAC tracks', groupBy: 'track' }),
    ]);
  });

  it('bring yours back on the next launch, and remove one when asked', () => {
    show({ start: { formats: new Set(['FLAC']) }, groupBy: 'track' });
    fireEvent.click(screen.getByRole('button', { name: '+ Save view' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name this view' }), { target: { value: 'FLAC tracks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    cleanup();

    show();
    fireEvent.click(screen.getByRole('tab', { name: 'FLAC tracks' }));
    expect(selected()).toEqual(['FLAC tracks']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the view FLAC tracks' }));
    expect(screen.queryByRole('tab', { name: 'FLAC tracks' })).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('[]');
  });

  it('let Escape put the name away unsaved', () => {
    show({ groupBy: 'file' });
    fireEvent.click(screen.getByRole('button', { name: '+ Save view' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name this view' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
