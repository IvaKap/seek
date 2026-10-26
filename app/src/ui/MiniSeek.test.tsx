// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Mini Seek: what is coming down, waiting and in trouble, in Simple's words;
 * a Retry only where a retry can change something; and a search that goes to
 * the full window, because there is no room for results in this one.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MiniSeek } from './MiniSeek.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer, TransferSession } from '../data/transferStore.ts';
import type { AutoClaim } from '../../../shared/protocol.ts';

afterEach(cleanup);

let n = 0;
function file(folder: string, over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `t${n}`, direction: 'download', username: 'nightbus', path: `Music\\${folder}\\${n} Track.flac`,
    localFolder: null, size: 1_000_000, bytesDone: 0, state: 'queued', speed: 0, averageSpeed: 0,
    queuePosition: null, secondsLeft: null, secondsElapsed: 0, stalled: false, secondsSinceProgress: 0,
    finishedAt: null, error: null, ...over,
  };
}

/** `quiet` is the stall threshold in seconds, as the transfer store is given it. */
function show(transfers: Transfer[], more: Partial<Parameters<typeof MiniSeek>[0]> = {}, quiet = 999_999) {
  const props = {
    session: { groups: group(transfers, quiet, Date.now()), retry: vi.fn() } as unknown as TransferSession,
    awaiting: [] as AutoClaim[],
    onTop: true,
    onKeepOnTop: vi.fn(), onSearch: vi.fn(), onFindAnother: vi.fn(), onReview: vi.fn(), onOpen: vi.fn(), onBack: vi.fn(),
    ...more,
  };
  render(<StrictMode><MiniSeek {...props} /></StrictMode>);
  return props;
}

const section = (name: string) => screen.getByRole('region', { name });
const text = (name: string) => section(name).textContent;

describe('the list', () => {
  it('sorts what is in hand into Downloading, Waiting and Needs attention, and leaves a finish out', () => {
    show([
      file('Burial - Untrue', { state: 'transferring', speed: 2_000_000, bytesDone: 500_000, secondsLeft: 300 }),
      file('Actress - Hazyville', { queuePosition: 4 }),
      file('Shed - The Traveller', { state: 'paused', bytesDone: 300_000 }),
      file('Objekt - Flatland', { state: 'connection_timeout' }),
      file('Lena - Phantom', { state: 'finished', bytesDone: 1_000_000, finishedAt: Date.now() / 1000 - 60 }),
    ]);
    expect(text('Downloading')).toContain('1.9 MB/s · about 5 minutes left');
    expect(text('Waiting')).toContain("4th in nightbus's queue");
    expect(text('Waiting')).toContain('Paused · 293 KB of 977 KB');
    expect(text('Needs attention')).toContain('Objekt — Flatland');
    expect(screen.getByRole('region', { name: 'Mini Seek' }).textContent).not.toContain('Lena');
  });

  it('offers Retry only where a retry can change something, and another copy otherwise', () => {
    const timeout = file('Objekt - Flatland', { state: 'connection_timeout' });
    const props = show([
      timeout,
      file('Drexciya - Neptune', { state: 'rejected', error: 'File not shared.' }),
      // Quiet for ten minutes against a five-minute threshold: still "transferring" upstream.
      file('Shed - The Traveller', { state: 'transferring', bytesDone: 300_000, secondsSinceProgress: 600 }),
    ], {}, 300);
    const row = (artist: string) => [...section('Needs attention').querySelectorAll('li')]
      .find((li) => li.querySelector('.mini__name')?.textContent?.startsWith(artist)) as HTMLElement;

    fireEvent.click(within(row('Objekt')).getByRole('button', { name: 'Retry' }));
    expect(props.session.retry).toHaveBeenCalledWith([timeout.id]);

    fireEvent.click(within(row('Drexciya')).getByRole('button', { name: 'Find another copy' }));
    expect(props.onFindAnother).toHaveBeenCalledWith('Drexciya Neptune');

    expect(row('Shed').textContent).toContain('Stalled');
    expect(within(row('Shed')).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says so when nothing is downloading', () => {
    show([]);
    expect(screen.getByText('Nothing downloading')).toBeTruthy();
  });
});

describe('the search', () => {
  it('sends what you type to the full window, on ↵ or ⌘↵, and nothing when it is blank', () => {
    const props = show([]);
    const field = screen.getByRole('searchbox', { name: 'Search the Soulseek network' });

    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form')!);
    expect(props.onSearch).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: ' objekt ' } });
    fireEvent.submit(field.closest('form')!);
    expect(props.onSearch).toHaveBeenLastCalledWith('objekt');

    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(props.onSearch).toHaveBeenCalledTimes(2);
  });
});

describe('the rest of the window', () => {
  it('holds the review strip, keeps on top when asked, and goes back to the full window', () => {
    const claim = (query: string): AutoClaim => ({ query, user: 'nightbus', transferId: '', path: '', status: 'awaiting-review' });
    const props = show([], { awaiting: [claim('burial untrue'), claim('shed traveller')] });

    expect(text('2 waiting for your review')).toContain('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(props.onReview).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep on top' }));
    expect(props.onKeepOnTop).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open Seek' }));
    expect(props.onOpen).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the full window' }));
    expect(props.onBack).toHaveBeenCalled();
  });
});
