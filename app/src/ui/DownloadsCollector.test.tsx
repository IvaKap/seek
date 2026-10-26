// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Downloads · Collector: everything still in hand on one screen, sorted by the
 * corner panel's answer into chips, with bulk actions that touch only what is
 * shown and a Retry that leaves alone what a retry cannot fix. At table
 * density a chosen release opens in the details pane, not in place.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DownloadsView } from './DownloadsView.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer, TransferSession } from '../data/transferStore.ts';
import type { AnalysisSession } from '../data/analysisStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { PreviewSession } from './Preview.tsx';
import type { Density } from './ViewMenu.tsx';

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

const now = () => Date.now() / 1000;

/** One release in each state, plus a cancel that Downloads leaves out. */
function everything() {
  return [
    file('Burial - Untrue', { state: 'transferring', speed: 2_000_000, bytesDone: 500_000 }),
    file('Actress - Hazyville', { queuePosition: 3 }),
    file('Shed - The Traveller', { state: 'paused', bytesDone: 300_000 }),
    file('Drexciya - Neptune', { state: 'rejected', error: 'File not shared.' }),
    file('Objekt - Flatland', { state: 'connection_timeout' }),
    file('Lena - Phantom', { state: 'finished', bytesDone: 1_000_000, finishedAt: now() - 120 }),
    file('Old - Record', { state: 'finished', bytesDone: 1_000_000, finishedAt: now() - 7200 }),
    file('Gone - Cancelled', { state: 'cancelled' }),
  ];
}

function show(transfers: Transfer[], density: Density = 'comfortable', more: Partial<Parameters<typeof DownloadsView>[0]> = {}) {
  const session = {
    groups: group(transfers, 999_999, Date.now()), note: null, error: null, cancelled: null,
    undoCancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), cancel: vi.fn(), clear: vi.fn(), reveal: vi.fn(),
  };
  render(
    <StrictMode>
      <DownloadsView
        session={session as unknown as TransferSession}
        signedIn
        filter="active"
        analysis={{ byTransfer: new Map() } as unknown as AnalysisSession}
        checksums={{ byTransfer: new Map() } as unknown as ChecksumSession}
        client={null}
        preview={{} as unknown as PreviewSession}
        density={density}
        onDensity={() => {}}
        {...more}
      />
    </StrictMode>,
  );
  return session;
}

const chip = (name: RegExp) => screen.getByRole('tab', { name });
const titles = () => [...document.querySelectorAll('.dl__title, .dl__rowname')].map((e) => e.textContent);

describe('the chips', () => {
  it('count everything still in hand, and leave out a cancel and an old finish', () => {
    show(everything());
    expect(screen.getAllByRole('tab').map((t) => t.textContent))
      .toEqual(['All6', 'Moving1', 'Queued2', 'Problems2', 'Finished1']);
    expect(titles()).not.toContain('Gone - Cancelled');
    expect(titles()).not.toContain('Old - Record');
  });

  it('show only what the chosen one counts, and say so when it counts nothing', () => {
    show(everything());
    fireEvent.click(chip(/^Problems/));
    expect(chip(/^Problems/).getAttribute('aria-selected')).toBe('true');
    expect(titles().sort()).toEqual(['Drexciya - Neptune', 'Objekt - Flatland']);
    cleanup();

    show([file('Burial - Untrue', { state: 'transferring', speed: 1 })]);
    fireEvent.click(chip(/^Finished/));
    expect(screen.getByText(/1 release is here, but none finished in the last hour\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filter' }));
    expect(chip(/^All/).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the bulk actions', () => {
  const idOf = (all: Transfer[], folder: string) => all.find((t) => t.path.includes(folder))!.id;

  it('pause what is coming down or queued, and resume once everything is paused', () => {
    const all = everything();
    const session = show(all);
    expect(screen.getByText(/· ↓ 1\.9 MB\/s/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause all' }));
    expect([...session.pause.mock.calls[0][0]].sort())
      .toEqual([idOf(all, 'Burial'), idOf(all, 'Actress')].sort());
    cleanup();

    const shed = file('Shed - The Traveller', { state: 'paused' });
    const paused = show([shed]);
    fireEvent.click(screen.getByRole('button', { name: 'Resume all' }));
    expect(paused.resume).toHaveBeenCalledWith([shed.id]);
  });

  it('retry only the failures a retry could fix', () => {
    const all = everything();
    const session = show(all);
    // The timeout, not the file they no longer share.
    fireEvent.click(screen.getByRole('button', { name: 'Retry 1 failed' }));
    expect(session.retry).toHaveBeenCalledWith([idOf(all, 'Objekt')]);
  });
});

describe('the table', () => {
  it('says each release’s status in its own column, and its format', () => {
    show(everything(), 'table');
    const status = (title: string) => [...document.querySelectorAll('.dl__row')]
      .find((r) => r.querySelector('.dl__rowname')?.textContent === title)
      ?.querySelector('.dl__cell--status')?.textContent;
    expect(status('Burial - Untrue')).toBe('Downloading');
    expect(status('Actress - Hazyville')).toBe('#3 in queue');
    expect(status('Shed - The Traveller')).toBe('Paused');
    expect(status('Drexciya - Neptune')).toBe('They are no longer sharing this file');
    expect(status('Lena - Phantom')).toBe('Finished');
    expect(document.querySelector('.dl__row .badge')?.textContent).toBe('FLAC');
  });
});

describe('the details pane', () => {
  const pane = () => document.querySelector('.inspector') as HTMLElement | null;
  const row = (title: string) => [...document.querySelectorAll<HTMLButtonElement>('.dl__disclose')]
    .find((b) => b.querySelector('.dl__rowname')?.textContent === title)!;

  it('shows a chosen release beneath the table, its tracks there and not under the row', () => {
    show(everything(), 'table');
    expect(pane()).toBeNull();
    expect(screen.queryByRole('button', { name: /Expand all/ })).toBeNull();

    fireEvent.click(row('Burial - Untrue'));
    expect(pane()?.textContent).toContain('nightbus · Music\\Burial - Untrue');
    expect(pane()?.querySelectorAll('.dl__file')).toHaveLength(1);
    expect(document.querySelectorAll('.dls .dl__file')).toHaveLength(0);
    expect(row('Burial - Untrue').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(row('Burial - Untrue'));
    expect(pane()).toBeNull();
    fireEvent.click(row('Actress - Hazyville'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(pane()).toBeNull();
  });

  it('says what the peer is doing for you, with a way to browse them or find another copy', () => {
    const onBrowse = vi.fn();
    const onFindAnother = vi.fn();
    show(everything(), 'table', { onBrowse, onFindAnother });
    fireEvent.click(row('Drexciya - Neptune'));
    fireEvent.click(screen.getByRole('tab', { name: 'Peer' }));
    const text = pane()!.textContent;
    expect(text).toContain('They are no longer sharing this file');
    expect(text).toContain('6 releases from them');
    fireEvent.click(screen.getByRole('button', { name: 'Browse their files' }));
    expect(onBrowse).toHaveBeenCalledWith('nightbus');
    fireEvent.click(screen.getByRole('button', { name: 'Find another copy' }));
    expect(onFindAnother).toHaveBeenCalledWith('Drexciya Neptune');
  });

  it('says where the folder is coming from and going, and shows a finished one in Finder', () => {
    const all = everything();
    const session = show(all, 'table');
    fireEvent.click(row('Lena - Phantom'));
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }));
    const text = pane()!.textContent;
    expect(text).toContain('Their folderMusic\\Lena - Phantom');
    expect(text).toContain('Saved inYour download folder');
    expect(text).toContain('1 track · 977 KB');
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(session.reveal).toHaveBeenCalledWith(all.find((t) => t.path.includes('Lena'))!.id);
  });
});
