// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Search · Simple's list: one row per version, in plain words, Get on the copy
 * the row shows, the copies beneath it. And the store underneath: Simple
 * groups by version without touching the tab's own grouping.
 */

import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Answered, CopiesHeading, SimpleReleaseRow, SimpleTrackRow } from './AllCopies.tsx';
import { adaptSearchResult } from '../data/adapt.ts';
import type { WireFileRef, WireSearchResultData } from '../data/adapt.ts';
import { TICK_MS, useSearchSession } from '../data/searchStore.ts';
import type { Row } from '../data/searchStore.ts';
import type { SidecarConnection } from '../data/connectionStore.ts';
import type { Sidecar, SidecarHandlers } from '../data/mockSidecar.ts';
import { WISHLIST_REASON } from '../data/searchTabs.ts';
import type { Release } from '../domain/types.ts';
import { createGrouper } from '../domain/group.ts';
import { releaseVersions } from '../domain/bestSources.ts';
import { fileSize } from '../domain/format.ts';

afterEach(cleanup);

const UNTRUE = 'Music\\Burial - Untrue (2007)';
const flac = (path: string, size = 28_400_000): WireFileRef => ({
  path, size, bitrate: null, duration: 238, sampleRate: 44_100, bitDepth: 16, isVbr: null,
});

function answer(username: string, files: WireFileRef[], queueLength = 0): WireSearchResultData {
  return {
    searchId: 1,
    peer: { username, freeSlots: queueLength === 0, advertisedSpeed: 1_000_000, queueLength, files: 10, folders: 1, country: null },
    files,
  };
}

const dave = answer('dave', [flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`)]);
const nightbus = answer('nightbus', [flac(`${UNTRUE}\\02 Archangel.flac`, 28_500_000)], 2);

function versions(...answers: WireSearchResultData[]) {
  const g = createGrouper();
  answers.forEach((a, i) => adaptSearchResult(a, i + 1, () => 0.5).forEach((s) => g.add(s)));
  return { tracks: g.versions(g.all), records: releaseVersions(g.releases(g.all)) };
}

describe('a version of a track', () => {
  const archangel = versions(dave, nightbus).tracks.find((t) => t.displayTitle === 'Archangel')!;

  it('says what it is in plain words, and how many people have it', () => {
    render(<StrictMode><SimpleTrackRow track={archangel} expanded={false} onToggle={vi.fn()} onQueue={vi.fn()} /></StrictMode>);
    const row = screen.getByRole('button', { name: /^Burial, Archangel/ });
    for (const words of ['Burial — Archangel', 'FLAC', '3:58', fileSize(archangel.best.size), 'slot free', 'Likely lossless', '2 copies']) {
      expect(row.textContent).toContain(words);
    }
  });

  it('opens its copies, and Get takes the copy it shows', () => {
    const onToggle = vi.fn();
    const onQueue = vi.fn();
    render(<StrictMode><SimpleTrackRow track={archangel} expanded={false} onToggle={onToggle} onQueue={onQueue} /></StrictMode>);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Burial, Archangel/ }), { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /^Queue Archangel from dave/ }));
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({ user: 'dave', path: `${UNTRUE}\\02 Archangel.flac` }));
  });

  it('holds its copy under the pointer while a better one arrives, and moves on once you leave', () => {
    const fast = answer('fast', [flac(`${UNTRUE}\\02 Archangel.flac`, 28_450_000)]);
    fast.peer.advertisedSpeed = 9_000_000;
    const better = versions(dave, nightbus, fast).tracks.find((t) => t.displayTitle === 'Archangel')!;
    expect(better.best.user).toBe('fast');

    const ui = (track: typeof archangel) => (
      <StrictMode><SimpleTrackRow track={track} expanded={false} onToggle={vi.fn()} onQueue={vi.fn()} /></StrictMode>
    );
    const { container, rerender } = render(ui(archangel));
    const row = container.querySelector('.row') as HTMLElement;
    fireEvent.pointerEnter(row);
    rerender(ui(better));
    expect(screen.getByRole('button', { name: /^Queue Archangel from dave/ })).toBeTruthy();
    fireEvent.pointerLeave(row);
    expect(screen.getByRole('button', { name: /^Queue Archangel from fast/ })).toBeTruthy();
  });

  it('says when a name could not be read, and when a length is unknown', () => {
    const odd = answer('radiorips', [{ path: 'Shared\\misc\\01.mp3', size: 8_900_000, bitrate: null, duration: null, sampleRate: null, bitDepth: null, isVbr: null }]);
    const [track] = versions(odd).tracks;
    render(<StrictMode><SimpleTrackRow track={track} expanded={false} onToggle={vi.fn()} onQueue={vi.fn()} /></StrictMode>);
    const row = screen.getByRole('button', { name: /^01/ });
    expect(row.textContent).toContain('name not recognised');
    expect(row.textContent).toContain('length unknown');
    expect(row.textContent).toContain('1 copy');
  });
});

describe('a version of a record', () => {
  const cold = answer('cold', [flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`)], 5);
  const [untrue] = versions(dave, cold).records;

  it('opens its tracks, and its copies as the comparison', () => {
    const onToggle = vi.fn();
    const onCompare = vi.fn();
    const ui = (copies: Release[]) => (
      <StrictMode>
        <SimpleReleaseRow copies={copies} expanded={false}
          onToggle={onToggle} onQueue={vi.fn()} badge="idle" onCompare={onCompare} />
      </StrictMode>
    );
    const { container, rerender } = render(ui(untrue.copies));
    const row = screen.getByRole('button', { name: /^Burial, Untrue/ });
    expect(row.textContent).toContain('release');
    expect(row.textContent).toContain('2 tracks');

    // Held under the pointer while the ranking changes: the comparison marks the copy shown.
    fireEvent.pointerEnter(container.querySelector('.row') as HTMLElement);
    rerender(ui([...untrue.copies].reverse()));
    fireEvent.click(screen.getByRole('button', { name: '2 copies' }));
    expect(onCompare).toHaveBeenCalledOnce();
    expect(onCompare).toHaveBeenCalledWith(untrue.copies[0]);
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('button', { name: /^Burial, Untrue/ }), { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('the heading', () => {
  it('counts versions and copies, and sorts', () => {
    const { tracks, records } = versions(dave, nightbus);
    const rows: Row[] = [
      ...tracks.map((t): Row => ({ kind: 'track', id: t.id, track: t, tick: t.tick })),
      ...records.map((v): Row => ({ kind: 'release', id: v.id, release: v.copies[0], copies: v.copies, tick: 1 })),
    ];
    const onSort = vi.fn();
    render(<StrictMode><CopiesHeading rows={rows} sort="best" onSort={onSort} /></StrictMode>);
    // Archangel ×2, Near Dark ×1, and dave's Untrue folder.
    expect(screen.getByRole('heading').textContent).toBe('All copies3 versions · 4 copies');
    fireEvent.change(screen.getByLabelText('Sort copies'), { target: { value: 'speed' } });
    expect(onSort).toHaveBeenCalledWith('speed');
  });
});

describe('the status line', () => {
  const line = (running: boolean, people: number, closedReason: string | null) => {
    const { container } = render(<Answered running={running} people={people} closedReason={closedReason} />);
    const text = container.textContent ?? '';
    cleanup();
    return text;
  };

  it('counts who has answered while Seek listens, and says when it stopped', () => {
    expect(line(true, 0, null)).toBe('Asking the network…');
    expect(line(true, 1, null)).toBe('1 person has answered so far. Seek keeps listening for more.');
    expect(line(true, 17, null)).toBe('17 people have answered so far. Seek keeps listening for more.');
    expect(line(false, 17, 'timeout')).toBe('17 people answered. Seek stopped listening.');
    expect(line(false, 17, WISHLIST_REASON)).toMatch(/^What your wishlist found/);
    expect(line(false, 0, null)).toBe('');
  });
});

/* ------------------------------------------------------------- the store */

function connection(): SidecarConnection {
  let live = false;
  const sidecar = {
    start(_query: string, h: SidecarHandlers) {
      live = true;
      for (const a of [dave, nightbus]) setTimeout(() => { if (live) h.onResult(a); }, 10);
    },
    stop() { live = false; },
  } as unknown as Sidecar;
  return {
    phase: 'open', isMock: true, serverState: 'online', serverError: null, client: null, sidecar, startupError: null,
  } as unknown as SidecarConnection;
}

function Harness() {
  const [conn] = useState(connection);
  const [simple, setSimple] = useState(true);
  const session = useSearchSession(conn, { versions: simple });
  return (
    <div>
      <p data-testid="rows">{session.rows.map((r) => `${r.kind}:${r.id}`).sort().join(' ')}</p>
      <p data-testid="group">{session.groupBy}</p>
      <p data-testid="people">{session.peerCount}</p>
      <button type="button" onClick={() => session.run('burial')}>run</button>
      <button type="button" onClick={() => setSimple((v) => !v)}>switch</button>
    </div>
  );
}

describe('Simple in the store', () => {
  it('groups by version, and gives Collector its own grouping back', () => {
    vi.useFakeTimers();
    try {
      render(<StrictMode><Harness /></StrictMode>);
      act(() => { fireEvent.click(screen.getByText('run')); });
      act(() => { vi.advanceTimersByTime(TICK_MS * 2); });
      const read = (id: string) => screen.getByTestId(id).textContent ?? '';

      // Archangel (dave and nightbus), Near Dark, and dave's two-track Untrue.
      expect(read('rows')).toMatch(/^release:rv:\S+ track:v\d+ track:v\d+$/);
      expect(read('group')).toBe('release');
      expect(read('people')).toBe('2');

      act(() => { fireEvent.click(screen.getByText('switch')); });
      expect(read('rows')).toMatch(/^release:r\d+ release:r\d+$/);
    } finally {
      vi.useRealTimers();
    }
  });
});
