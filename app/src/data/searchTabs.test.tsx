// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The first React tests in this app, and they exist for a specific reason.
 *
 * `useSearchTabs.close()` originally restored the neighbour's snapshot INSIDE
 * the `setIds` updater. React invokes updaters twice in development to surface
 * impure ones, and this one was: the first pass consumed the snapshot from a
 * ref, so the second found nothing and restored an empty search. Closing the
 * active tab emptied the screen instead of showing the tab beside it.
 *
 * That bug is invisible to a pure-logic test — there is no function to call
 * that has it. It only appears when React actually renders the hook, and only
 * under StrictMode, which is why every test here renders in <StrictMode>. That
 * is the whole point of the harness: without it, the only way to catch this
 * class of defect was to drive the app by hand and notice.
 */

import { StrictMode, useCallback, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EMPTY_FILTERS } from '../domain/types.ts';
import type { Filters, GroupBy, SortKey, SourceFile } from '../domain/types.ts';
import { useSearchTabs } from './searchTabs.ts';
import type { SearchSession, SearchSnapshot } from './searchStore.ts';

/* RTL's automatic cleanup only registers when Vitest runs with `globals: true`,
   and this project deliberately does not. Explicit is fine and one line. */
afterEach(cleanup);

const file = (id: string): SourceFile => ({ id } as unknown as SourceFile);

/**
 * The smallest thing `useSearchTabs` will accept.
 *
 * Real state, not stubs: the hook's whole job is moving state between
 * snapshot() and restore(), so a fake that recorded calls without changing
 * anything would pass every test here while the feature stayed broken.
 */
function useFakeSession(): SearchSession {
  const [query, setQuery] = useState('burial');
  const [files, setFiles] = useState<SourceFile[]>([file('a'), file('b'), file('c')]);
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, losslessOnly: true });
  const [groupBy, setGroupBy] = useState<GroupBy>('release');
  const [sort, setSort] = useState<SortKey>('best');

  const snapshot = useCallback((): SearchSnapshot => ({
    query, files, peers: [], filters, groupBy, sort,
    expanded: new Set(), closedReason: null, tick: 0,
  }), [query, files, filters, groupBy, sort]);

  const restore = useCallback((snap: SearchSnapshot) => {
    setQuery(snap.query);
    setFiles(snap.files);
    setFilters(snap.filters);
    setGroupBy(snap.groupBy);
    setSort(snap.sort);
  }, []);

  /* Stands in for running a search in whatever tab is active. Without it every
     tab holds the same blank search, and "restored the heir" and "restored an
     empty search" produce identical screens — which is how the first version
     of these tests passed against the bug they were written for. */
  const runSearch = useCallback((q: string, n: number) => {
    setQuery(q);
    setFiles(Array.from({ length: n }, (_, i) => file(`${q}${i}`)));
  }, []);

  /* `openWith` calls this, so it has to actually search — a no-op `run` would
     let every tab rule pass while the search never happened. */
  const run = useCallback((q?: string) => {
    if (q) runSearch(q, 3);
  }, [runSearch]);

  return {
    query, files, filters, groupBy, sort, running: false,
    totalFiles: files.length,
    snapshot, restore, runSearch, run,
  } as unknown as SearchSession & { files: SourceFile[]; runSearch(q: string, n: number): void };
}

/** Drives the hook the way SearchView does: buttons, and text to read back. */
function Harness() {
  const session = useFakeSession() as SearchSession & {
    files: SourceFile[]; runSearch(q: string, n: number): void;
  };
  const tabs = useSearchTabs(session);

  return (
    <div>
      <p data-testid="labels">{tabs.tabs.map((t) => t.label).join(' | ')}</p>
      <p data-testid="active">{tabs.activeId}</p>
      <p data-testid="query">{session.query || '(none)'}</p>
      <p data-testid="files">{session.files.length}</p>
      <p data-testid="lossless">{String(session.filters.losslessOnly)}</p>
      <button type="button" onClick={() => tabs.open()}>open</button>
      <button type="button" onClick={() => session.runSearch('shackleton', 5)}>search</button>
      <button type="button" onClick={() => tabs.openWith('one')}>find:one</button>
      <button type="button" onClick={() => tabs.openWith('two')}>find:two</button>
      <button type="button" onClick={() => tabs.markUsed()}>used</button>
      <p data-testid="count">{tabs.tabs.length}</p>
      {tabs.tabs.map((t) => (
        <span key={t.id}>
          <button type="button" onClick={() => tabs.select(t.id)}>{`select:${t.id}`}</button>
          <button type="button" onClick={() => tabs.close(t.id)}>{`close:${t.id}`}</button>
        </span>
      ))}
    </div>
  );
}

const mount = () => render(<StrictMode><Harness /></StrictMode>);
const read = (id: string) => screen.getByTestId(id).textContent;
const click = (label: string) => fireEvent.click(screen.getByText(label));

describe('useSearchTabs', () => {
  it('opens a tab that is empty, but keeps how you were reading', () => {
    mount();
    expect(read('files')).toBe('3');

    click('open');
    /* The query and its results belong to the search. The filters and grouping
       are how you like to READ results, so they follow you across. */
    expect(read('query')).toBe('(none)');
    expect(read('files')).toBe('0');
    expect(read('lossless')).toBe('true');
  });

  it('restores a tab exactly when you come back to it', () => {
    mount();
    const first = read('active')!;
    click('open');
    expect(read('files')).toBe('0');

    click(`select:${first}`);
    expect(read('query')).toBe('burial');
    expect(read('files')).toBe('3');
  });

  it('shows the neighbour when the ACTIVE tab is closed', () => {
    /* The regression. Under StrictMode the close updater runs twice, and the
       first version of this hook consumed the neighbour's snapshot on the
       first pass — so the second pass restored an empty search and closing a
       tab blanked the screen. */
    mount();
    const first = read('active')!;
    click('open');
    const second = read('active')!;
    expect(second).not.toBe(first);

    /* The heir must hold something DISTINCT, or "restored the heir" and
       "restored an empty search" look the same and the test proves nothing.
       Verified by reintroducing the bug: without this search the mutant
       survives. */
    click('search');
    expect(read('query')).toBe('shackleton');

    // Go back to the first tab so the one being closed is the ACTIVE one.
    click(`select:${first}`);
    expect(read('query')).toBe('burial');
    expect(read('files')).toBe('3');

    click(`close:${first}`);
    expect(read('labels')).toBe('shackleton');
    expect(read('active')).toBe(second);
    // The heir is shown as ITSELF, with its own results — not as nothing.
    expect(read('query')).toBe('shackleton');
    expect(read('files')).toBe('5');
  });

  it('keeps the closed tab out of the strip', () => {
    mount();
    const first = read('active')!;
    click('open');
    click(`close:${first}`);
    expect(read('labels')).toBe('New search');
  });

  it('refuses to close the last tab, because an empty window is not a state', () => {
    mount();
    const only = read('active')!;
    click(`close:${only}`);
    expect(read('active')).toBe(only);
    expect(read('query')).toBe('burial');
    expect(read('files')).toBe('3');
  });
});

describe('a search opens its own tab', () => {
  it('runs in place the first time, because a fresh tab IS the new one', () => {
    mount();
    expect(read('count')).toBe('1');
    click('find:one');
    /* Opening a tab here would leave a blank one beside the results on the
       very first search anyone ever makes. */
    expect(read('count')).toBe('1');
    expect(read('query')).toBe('one');
  });

  it('opens a tab for a DIFFERENT search', () => {
    mount();
    click('find:one');
    click('find:two');
    expect(read('count')).toBe('2');
    expect(read('query')).toBe('two');
    expect(read('labels')).toBe('one | two');
  });

  it('re-runs in place when the search is the same', () => {
    /* Pressing Return twice is a re-run, not a second search. Without this an
       identical tab appears beside the one you are already reading. */
    mount();
    click('find:one');
    click('find:one');
    expect(read('count')).toBe('1');
  });
});

describe('a spent tab expires', () => {
  it('closes 45 minutes after something was queued from it', () => {
    vi.useFakeTimers();
    try {
      mount();
      click('find:one');
      click('used');                    // queued something from tab one
      click('find:two');                // and moved on to another search
      expect(read('count')).toBe('2');

      act(() => { vi.advanceTimersByTime(46 * 60 * 1000); });
      expect(read('count')).toBe('1');
      expect(read('labels')).toBe('two');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never closes the tab being read, however old', () => {
    /* A tab vanishing while you are looking at it is worse than any number of
       stale ones.
       
       There must be a SECOND tab for this to prove anything. With only one, the
       "never empty the strip" guard saves it whatever the active check does —
       verified by removing that check and watching this test still pass. */
    vi.useFakeTimers();
    try {
      mount();
      click('find:one');
      click('used');                    // tab one is spent
      click('find:two');                // open a second so the strip is not at its floor
      const spent = screen.getAllByText(/^select:/)[0].textContent!.replace('select:', '');
      click(`select:${spent}`);         // and go back to the spent one
      expect(read('query')).toBe('one');

      act(() => { vi.advanceTimersByTime(46 * 60 * 1000); });
      expect(read('count')).toBe('2');
      expect(read('query')).toBe('one');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an unused tab alone forever', () => {
    vi.useFakeTimers();
    try {
      mount();
      click('find:one');
      click('find:two');               // tab one was never queued from
      act(() => { vi.advanceTimersByTime(3 * 60 * 60 * 1000); });
      expect(read('count')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });
});
