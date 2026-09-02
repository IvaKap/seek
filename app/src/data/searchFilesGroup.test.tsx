// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The "Files" grouping — the classic Nicotine+ flat list.
 *
 * The other groupings COLLAPSE: three peers offering the same track become one
 * row with three sources. "Files" must not — its whole purpose is to show every
 * individual file, one row each, so a collector can pick the exact copy. This
 * pins that difference (one row per file, kind 'file', ids preserved) against
 * the same batch that track-grouping folds into a single row.
 *
 * Driven through the real store like searchInTab.test.tsx, so it exercises the
 * derive branch, rowValue and the fileValue comparator together rather than a
 * private function in isolation.
 */

import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TICK_MS, useSearchSession } from './searchStore.ts';
import type { SidecarConnection } from './connectionStore.ts';
import type { WireSearchResultData } from './adapt.ts';
import type { Sidecar, SidecarHandlers } from './mockSidecar.ts';

afterEach(cleanup);

/* The SAME track (one path), offered by three peers at three DISTINCT sizes, so
 * track-grouping still collapses to one row (identity is the path, not the size)
 * while the sizes give the fileValue comparator something to order. */
const PEERS: Array<{ name: string; size: number }> = [
  { name: 'alpha', size: 30_000_000 },
  { name: 'bravo', size: 50_000_000 },
  { name: 'charlie', size: 40_000_000 },
];

function batchFrom(peer: string, size: number, query: string): WireSearchResultData {
  return {
    searchId: 1,
    peer: {
      username: peer, freeSlots: true, advertisedSpeed: 800_000, queueLength: 0,
    },
    files: [{
      path: `music\\${query}\\01 ${query} track.flac`,
      size, bitrate: null, duration: 240,
      sampleRate: 44_100, bitDepth: 16, isVbr: null,
    }],
  };
}

function fakeSidecar(): Sidecar {
  let live = false;
  return {
    start(query: string, h: SidecarHandlers) {
      live = true;
      // Three peers, same file — a track-group of three sources, or three files.
      for (const p of PEERS) {
        setTimeout(() => { if (live) h.onResult(batchFrom(p.name, p.size, query)); }, 10);
      }
    },
    stop() { live = false; },
    setRate() {},
  } as unknown as Sidecar;
}

function connection(): SidecarConnection {
  return {
    phase: 'open', isMock: true, serverState: 'online',
    client: null, sidecar: fakeSidecar(), startupError: null,
  } as unknown as SidecarConnection;
}

function Harness() {
  const [conn] = useState(connection);
  const session = useSearchSession(conn);
  return (
    <div>
      <p data-testid="rows">{session.rows.length}</p>
      <p data-testid="kinds">{session.rows.map((r) => r.kind).join(',')}</p>
      <p data-testid="ids">{session.rows.map((r) => r.id).join(',')}</p>
      <p data-testid="sizes">
        {session.rows.map((r) => (r.kind === 'file' ? r.source.size : 0)).join(',')}
      </p>
      <p data-testid="matched">{session.matchedFiles}</p>
      <button type="button" onClick={() => session.run('shackleton')}>run</button>
      <button type="button" onClick={() => session.setGroupBy('track')}>track</button>
      <button type="button" onClick={() => session.setGroupBy('file')}>file</button>
      <button type="button" onClick={() => session.setSort('size')}>by-size</button>
    </div>
  );
}

const read = (id: string) => screen.getByTestId(id).textContent ?? '';
const num = (id: string) => Number(read(id));
const press = (label: string) => act(() => { fireEvent.click(screen.getByText(label)); });
const tick = () => act(() => { vi.advanceTimersByTime(TICK_MS * 2); });

function withFakeTimers(body: () => void) {
  vi.useFakeTimers();
  try { body(); } finally { vi.useRealTimers(); }
}

describe('the Files grouping', () => {
  it('shows one row per file where Track folds the copies into one', () => withFakeTimers(() => {
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();

    // Three peers offered the one track: track-grouping collapses to a single row.
    press('track');
    expect(num('matched')).toBe(3);
    expect(num('rows')).toBe(1);
    expect(read('kinds')).toBe('track');

    // Files does not collapse: one row per file, each a 'file' row.
    press('file');
    expect(num('rows')).toBe(3);
    expect(read('kinds')).toBe('file,file,file');
  }));

  it('gives every file row a distinct id, so the virtualiser never reuses a node', () => withFakeTimers(() => {
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();
    press('file');

    const ids = read('ids').split(',');
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  }));

  it('orders file rows by the fileValue comparator — largest first when sorted by size', () => withFakeTimers(() => {
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();
    press('file');
    press('by-size');

    // fileValue('size') returns -size, compared ascending → sizes descending.
    expect(read('sizes')).toBe('50000000,40000000,30000000');
  }));
});
