// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A search must produce ROWS, not just a count.
 *
 * Found by driving the app: open a tab, search in it, and the counter climbs
 * to sixty-odd results while the list sits on "No results yet" — the screen
 * reporting results it never shows.
 *
 * Deliberately NOT the fixture replay. That streams over about thirty seconds
 * of real time and the bug is in the store rather than the transport, so the
 * sidecar here is a fake that answers on a timer. Results arrive on their own
 * turn of the event loop, as they do against a real transport; handing them
 * over synchronously inside `start()` would land them while `run()` is still
 * assigning state, which is a moment that never actually happens.
 */

import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TICK_MS, useSearchSession } from './searchStore.ts';
import { useSearchTabs } from './searchTabs.ts';
import type { SidecarConnection } from './connectionStore.ts';
import type { WireSearchResultData } from './adapt.ts';
import type { Sidecar, SidecarHandlers } from './mockSidecar.ts';

afterEach(cleanup);

/** Three FLAC files from one peer — enough to group into a release. */
function batch(query: string): WireSearchResultData {
  return {
    searchId: 1,
    peer: {
      username: 'a-peer', freeSlots: true, advertisedSpeed: 800_000, queueLength: 0,
    },
    files: [1, 2, 3].map((n) => ({
      path: `music\\${query}\\0${n} ${query} track ${n}.flac`,
      size: 40_000_000, bitrate: null, duration: 240,
      sampleRate: 44_100, bitDepth: 16, isVbr: null,
    })),
  };
}

function fakeSidecar(): Sidecar {
  let live = false;
  return {
    start(query: string, h: SidecarHandlers) {
      live = true;
      setTimeout(() => { if (live) h.onResult(batch(query)); }, 10);
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
  const tabs = useSearchTabs(session);

  return (
    <div>
      <p data-testid="rows">{session.rows.length}</p>
      <p data-testid="matched">{session.matchedFiles}</p>
      <p data-testid="total">{session.totalFiles}</p>
      <p data-testid="tabs">{tabs.tabs.length}</p>
      <button type="button" onClick={() => session.run('shackleton')}>run</button>
      <button type="button" onClick={() => tabs.open()}>open</button>
      {/* What the virtualised list does on scroll. Nothing else in the suite
          reports a viewport, which is exactly why this went unnoticed. */}
      <button type="button" onClick={() => session.reportViewport(5, false)}>scroll</button>
    </div>
  );
}

const read = (id: string) => Number(screen.getByTestId(id).textContent);
const press = (label: string) => act(() => { fireEvent.click(screen.getByText(label)); });

/** Let the ~250ms ingest tick fire. */
const tick = () => act(() => { vi.advanceTimersByTime(TICK_MS * 2); });

/** Fake timers, always restored — a leaked fake clock breaks every later file. */
function withFakeTimers(body: () => void) {
  vi.useFakeTimers();
  try { body(); } finally { vi.useRealTimers(); }
}

describe('a search produces rows', () => {
  it('in the first tab', () => withFakeTimers(() => {
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();

    expect(read('total')).toBeGreaterThan(0);
    expect(read('rows')).toBeGreaterThan(0);
  }));

  it('in a second tab, not just a count', () => withFakeTimers(() => {
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();
    expect(read('rows')).toBeGreaterThan(0);

    // The trip through restore() that only tabs perform.
    press('open');
    expect(read('tabs')).toBe(2);
    expect(read('rows')).toBe(0);       // a new tab is empty, correctly

    press('run');
    tick();

    /* Asserting all three keeps a failure legible: it says WHICH half of the
       pipeline stopped, rather than only that the list looked empty. */
    expect(read('total')).toBeGreaterThan(0);
    expect(read('matched')).toBeGreaterThan(0);
    expect(read('rows')).toBeGreaterThan(0);
  }));

  it('when the previous search was left scrolled', () => withFakeTimers(() => {
    /* The store freezes rows above the reader's position so nothing shifts
       under their eye. That is right while results stream into a list you are
       inside, and wrong the moment the list is REPLACED: a new search leaves
       the old position pointing at results that no longer exist, and every
       arriving row is judged against it. */
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();
    expect(read('rows')).toBeGreaterThan(0);

    press('scroll');
    press('run');
    tick();

    expect(read('total')).toBeGreaterThan(0);
    expect(read('rows')).toBeGreaterThan(0);
  }));

  it('in a second tab opened while the first was scrolled', () => withFakeTimers(() => {
    render(<StrictMode><Harness /></StrictMode>);
    press('run');
    tick();
    press('scroll');

    press('open');
    press('run');
    tick();

    expect(read('total')).toBeGreaterThan(0);
    expect(read('rows')).toBeGreaterThan(0);
  }));
});
