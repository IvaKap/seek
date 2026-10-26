// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Downloads · Simple: one release on the card, the rest by what each needs
 * from you, in the corner panel's words. The failed and the just finished
 * are here too, because Simple keeps those lenses behind More.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SimpleDownloads, sections } from './DownloadsSimple.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer, TransferGroup, TransferSession } from '../data/transferStore.ts';
import type { AutoClaim } from '../../../shared/protocol.ts';

afterEach(cleanup);

const UNTRUE = 'Music\\Burial - Untrue (2007)';
let n = 0;

function file(over: Partial<Transfer> = {}, folder = UNTRUE): Transfer {
  n += 1;
  return {
    id: `t${n}`, direction: 'download', username: 'nightbus', path: `${folder}\\${String(n).padStart(2, '0')} Track.flac`,
    localFolder: null, size: 1_000_000, bytesDone: 0, state: 'queued', speed: 0,
    averageSpeed: 0, queuePosition: null, secondsLeft: null, secondsElapsed: 0,
    stalled: false, secondsSinceProgress: 0, finishedAt: null, error: null,
    ...over,
  };
}

const now = () => Date.now() / 1000;
const keys = (gs: TransferGroup[]) => gs.map((g) => g.title);

describe('the sections', () => {
  const moving = (folder: string) => file({ state: 'transferring', speed: 500_000, bytesDone: 300_000 }, folder);

  it('sorts by what each release needs, the paused waiting with the queued', () => {
    const s = sections(group([
      moving('Music\\A'),
      file({ queuePosition: 3 }, 'Music\\B'),
      file({}, 'Music\\C'),
      file({ state: 'paused' }, 'Music\\D'),
      file({ state: 'rejected', error: 'File not shared.' }, 'Music\\E'),
      file({ state: 'finished', finishedAt: now() - 60 }, 'Music\\F'),
      file({ state: 'finished', finishedAt: now() - 7200 }, 'Music\\G'),
      file({ state: 'cancelled' }, 'Music\\H'),
    ]), now(), null);
    expect(s.lead?.title).toBe('A');
    expect(keys(s.waiting).sort()).toEqual(['B', 'C', 'D']);
    expect(keys(s.trouble)).toEqual(['E']);
    // Two hours ago is Completed's; a cancel is yours, not news.
    expect(keys(s.finished)).toEqual(['F']);
  });

  it('keeps the release on the card while it is still coming down', () => {
    const groups = group([moving('Music\\A'), moving('Music\\B')]);
    expect(sections(groups, now(), null).lead?.title).toBe('A');
    const s = sections(groups, now(), groups.find((g) => g.title === 'B')!.key);
    expect(s.lead?.title).toBe('B');
    expect(keys(s.moving)).toEqual(['A']);
  });

  it('counts a stalled release as needing you, and lists the newest finish first', () => {
    const stalled = group([file({ state: 'transferring', secondsSinceProgress: 600 }, 'Music\\S')], 300);
    expect(keys(sections(stalled, now(), null).trouble)).toEqual(['S']);
    const done = group([
      file({ state: 'finished', finishedAt: now() - 600 }, 'Music\\Old'),
      file({ state: 'finished', finishedAt: now() - 60 }, 'Music\\New'),
    ]);
    expect(keys(sections(done, now(), null).finished)).toEqual(['New', 'Old']);
  });
});

function session(groups: TransferGroup[]) {
  return {
    groups, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), reveal: vi.fn(),
  } as unknown as TransferSession & Record<'pause' | 'cancel' | 'reveal', ReturnType<typeof vi.fn>>;
}

function screenOf(groups: TransferGroup[], more: Partial<Parameters<typeof SimpleDownloads>[0]> = {}) {
  const s = session(groups);
  const props = {
    session: s, awaiting: [], signedIn: true, openKeys: new Set<string>(), onOpen: vi.fn(),
    renderOpen: (g: TransferGroup) => <p>files of {g.title}</p>, notices: null,
    onFindAnother: vi.fn(), onShowCompleted: vi.fn(), ...more,
  };
  render(<StrictMode><SimpleDownloads {...props} /></StrictMode>);
  return { ...props, session: s };
}

describe('the screen', () => {
  it('leads with the release coming down: how far, how fast, and its controls', () => {
    const a = file({ state: 'transferring', speed: 2_000_000, bytesDone: 600_000, secondsLeft: 300 });
    const b = file({ state: 'finished', bytesDone: 1_000_000 });
    const ui = screenOf(group([a, b]));
    const card = screen.getByRole('region', { name: 'Now downloading' });
    for (const words of ['Burial — Untrue', 'FLAC · 2 tracks · from nightbus', '80%', '1 of 2 tracks done', 'about 5 minutes left']) {
      expect(card.textContent).toContain(words);
    }
    expect(screen.getByRole('heading', { name: 'Downloads' })).toBeTruthy();
    expect(screen.getByText(/^1 in progress · /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(ui.session.pause).toHaveBeenCalledWith([a.id, b.id]);
    fireEvent.click(screen.getByRole('button', { name: 'Show tracks' }));
    expect(ui.onOpen).toHaveBeenCalledWith(group([a, b])[0].key, true);
  });

  it('says where a release waits, and why one needs you, with a way to find another copy', () => {
    const ui = screenOf(group([
      file({ queuePosition: 3, username: 'werkfan' }, 'Music\\Actress - Hazyville'),
      file({ state: 'rejected', error: 'File not shared.' }),
    ]));
    expect(screen.getByRole('region', { name: 'Waiting' }).textContent)
      .toContain("3rd in werkfan's queue. Starts when the 2 ahead of you finish.");
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(attention.textContent).toContain('They are no longer sharing this file');
    fireEvent.click(screen.getByRole('button', { name: 'Find another copy' }));
    expect(ui.onFindAnother).toHaveBeenCalledWith('Burial Untrue');
  });

  it('shows what just finished, and opens a release to its files', () => {
    const done = group([file({ state: 'finished', bytesDone: 1_000_000, finishedAt: now() - 120 })]);
    const ui = screenOf(done, { openKeys: new Set([done[0].key]) });
    const finished = screen.getByRole('region', { name: 'Just finished' });
    expect(finished.textContent).toContain('Finished 2 minutes ago. Now in Completed.');
    expect(finished.textContent).toContain(`files of ${done[0].title}`);
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(ui.session.reveal).toHaveBeenCalledWith(done[0].transfers[0].id);
  });

  it('asks for a review when the wishlist has held something back', () => {
    const claim = { query: 'call super suzi ecto', status: 'awaiting-review' } as AutoClaim;
    const ui = screenOf([], { awaiting: [claim] });
    expect(screen.getByRole('heading', { name: 'A wishlist download is waiting for your review' })).toBeTruthy();
    expect(screen.getByText(/“call super suzi ecto” arrived/)).toBeTruthy();
    expect(screen.queryByText('Nothing downloading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(ui.onShowCompleted).toHaveBeenCalledOnce();
  });

  it('says so when there is nothing at all', () => {
    screenOf([]);
    expect(screen.getByText('Nothing downloading')).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
  });
});
