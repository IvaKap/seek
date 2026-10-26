// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A row nothing happened to is the SAME object on the next burst.
 *
 * Every burst regrouped from scratch, so every row was new and every memoised
 * row on screen drew again: the Collector table froze on each burst of
 * results. The rows in ResultList skip drawing on identity, so this pins the
 * identity: untouched rows keep it, rows that gained a file lose it.
 */

import { StrictMode, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TICK_MS, useSearchSession } from './searchStore.ts';
import type { Row } from './searchStore.ts';
import type { SidecarConnection } from './connectionStore.ts';
import type { WireSearchResultData } from './adapt.ts';
import type { Sidecar, SidecarHandlers } from './mockSidecar.ts';

afterEach(cleanup);

function batch(peer: string, track: number): WireSearchResultData {
  return {
    searchId: 1,
    peer: { username: peer, freeSlots: true, advertisedSpeed: 800_000, queueLength: 0 },
    files: [{
      path: `music\\${peer} - Record\\0${track} ${peer} tune ${track}.flac`,
      size: 30_000_000 + track, bitrate: null, duration: 240 + track * 30,
      sampleRate: 44_100, bitDepth: 16, isVbr: null,
    }],
  };
}

let push: ((d: WireSearchResultData) => void) | null = null;

function connection(): SidecarConnection {
  const sidecar = {
    start(_q: string, h: SidecarHandlers) { push = h.onResult; },
    stop() { push = null; },
  } as unknown as Sidecar;
  return {
    phase: 'open', isMock: true, serverState: 'online', serverError: null,
    client: null, sidecar, startupError: null,
  } as unknown as SidecarConnection;
}

const seen: Row[][] = [];

function Harness() {
  const [conn] = useState(connection);
  const session = useSearchSession(conn);
  seen.push(session.rows);
  return (
    <div>
      <button type="button" onClick={() => session.run('record')}>run</button>
      <button type="button" onClick={() => session.setGroupBy('release')}>release</button>
    </div>
  );
}

const press = (label: string) => act(() => { fireEvent.click(screen.getByText(label)); });
const burst = (...b: WireSearchResultData[]) => act(() => {
  for (const d of b) push?.(d);
  vi.advanceTimersByTime(TICK_MS * 2);
});
const latest = () => seen[seen.length - 1];
const byUser = (rows: Row[], user: string) => rows.find((r) => r.kind === 'release' && r.release.user === user);

it('keeps an untouched release row and replaces the one that grew', () => {
  vi.useFakeTimers();
  try {
    render(<StrictMode><Harness /></StrictMode>);
    press('release');
    press('run');
    burst(batch('alpha', 1), batch('bravo', 1));
    const before = latest();
    expect(before).toHaveLength(2);

    burst(batch('bravo', 2));
    const after = latest();
    expect(after).not.toBe(before);
    expect(byUser(after, 'alpha')).toBe(byUser(before, 'alpha'));
    expect(byUser(after, 'bravo')).not.toBe(byUser(before, 'bravo'));
  } finally {
    vi.useRealTimers();
  }
});
