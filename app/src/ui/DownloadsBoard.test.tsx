// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Downloads · Board: every release in the column of what is happening to it.
 * Pinned: the columns agree with Simple's list (a refusal waits in Queued, a
 * stall with bytes stays in Downloading), Checking and Sent are facts (a check
 * running, the hand-off's record), review waits in Ready whatever its age, and
 * nothing moves without the person.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DownloadsBoard, boardColumns, say } from './DownloadsBoard.tsx';
import { homeShort } from './DownloadsSimple.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer, TransferGroup, TransferSession } from '../data/transferStore.ts';
import type { HandoffSession } from '../data/handoffStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { AutoClaim, HandoffSent } from '../../../shared/protocol.ts';

afterEach(cleanup);

const NOW = Date.now() / 1000;
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
const done = (folder: string, agoS = 60, over: Partial<Transfer> = {}) =>
  file(folder, { state: 'finished', bytesDone: 1_000_000, finishedAt: NOW - agoS, ...over });

const sentRow = (t: Transfer, sentAt = NOW - 7200): HandoffSent => (
  { transferId: t.id, user: t.username, path: t.path, dest: `/Users/iva/RB/Release/${t.id}.flac`, sentAt }
);
function handoffOf(sent: HandoffSent[] = [], folder: string | null = '/Users/iva/RB'): HandoffSession {
  return {
    folder, sent: new Map(sent.map((r) => [r.transferId, r])), sending: new Set(), failed: new Map(),
    send: vi.fn(async () => {}), reveal: vi.fn(async () => {}),
  };
}
const titles = (gs: TransferGroup[]) => gs.map((g) => g.title);

describe('the columns', () => {
  const queued = file('Actress - Hazyville', { queuePosition: 4 });
  const refused = file('Drexciya - Neptune', { state: 'rejected', error: 'File not shared.' });
  const moving = file('Burial - Untrue', { state: 'transferring', speed: 2_000_000, bytesDone: 500_000 });
  const stalled = file('Shed - The Traveller', { state: 'transferring', bytesDone: 300_000, secondsSinceProgress: 600 });
  const paused = file('Objekt - Flatland', { state: 'paused', bytesDone: 100_000 });
  const checking = done('Lena - Phantom');
  const ready = done('Actress - RIP');
  const old = done('Old - Record', 7200);
  const review = done('Call Super - Suzi Ecto', 7200);
  const gone = done('Objekt - Cocoon Crush', 7200);
  const groups = group([queued, refused, moving, stalled, paused, checking, ready, old, review, gone], 300, Date.now());
  const checks = new Map([[checking.id, { state: 'running' as const }]]);
  const cols = boardColumns(groups, NOW, checks, handoffOf([sentRow(gone)]), new Set([review.id]));

  /* A refusal filed under "Queued by peer — waiting for a slot" said it was
     waiting when it never would be; List and Collector call it trouble. */
  it('puts a refusal and a stall in Needs attention, apart from what is only waiting', () => {
    expect(titles(cols.trouble).sort()).toEqual(['Drexciya - Neptune', 'Shed - The Traveller']);
    expect(titles(cols.queued)).toEqual(['Actress - Hazyville']);
    expect(titles(cols.downloading).sort()).toEqual(['Burial - Untrue', 'Objekt - Flatland']);
  });

  it('checks while a check runs, holds review whatever its age, and leaves older finishes to Completed', () => {
    expect(titles(cols.checking)).toEqual(['Lena - Phantom']);
    expect(titles(cols.ready)).toEqual(['Actress - RIP', 'Call Super - Suzi Ecto']);
    expect(titles([...cols.queued, ...cols.downloading, ...cols.checking, ...cols.ready, ...cols.sent]))
      .not.toContain('Old - Record');
  });

  it('is Sent from the record, however long ago it finished', () => {
    expect(titles(cols.sent)).toEqual(['Objekt - Cocoon Crush']);
  });

  it('holds a file waiting for review in Ready, even when the rest of its folder went', () => {
    const [kept, wish] = [done('Burial - Untrue'), done('Burial - Untrue')];
    const both = boardColumns(group([kept, wish], 300, Date.now()), NOW, new Map(), handoffOf([sentRow(kept)]), new Set([wish.id]));
    expect(titles(both.ready)).toEqual(['Burial - Untrue']);
    expect(both.sent).toEqual([]);
  });

  it('says both checksum files when a release ships both', () => {
    const [a, ffp, md5] = [done('Lena - Phantom'), done('Lena - Phantom', 60, { path: 'Music\\Lena - Phantom\\x.ffp' }),
      done('Lena - Phantom', 60, { path: 'Music\\Lena - Phantom\\x.md5' })];
    const g = group([a, ffp, md5], 300, Date.now());
    const running = new Map([[a.id, { state: 'running' as const }]]);
    const c = boardColumns(g, NOW, running, handoffOf(), new Set());
    expect(say(c.checking[0], 'checking', { now: NOW, checks: running, handoff: handoffOf(), review: new Map() }).line)
      .toBe('Checking each track against the .ffp and .md5');
  });
});

describe('the board', () => {
  function show(transfers: Transfer[], more: { claims?: AutoClaim[]; sent?: HandoffSent[]; folder?: string | null } = {}) {
    const handoff = handoffOf(more.sent, more.folder === undefined ? '/Users/iva/RB' : more.folder);
    const props = {
      session: { groups: group(transfers, 999_999, Date.now()), retry: vi.fn() } as unknown as TransferSession,
      checksums: { byTransfer: new Map(), check: vi.fn() } as unknown as ChecksumSession,
      handoff: { session: handoff, held: new Set((more.claims ?? []).map((c) => c.transferId)), onSetFolder: vi.fn() },
      review: new Map((more.claims ?? []).map((c) => [c.transferId, c])), now: NOW, tools: null, notices: null,
      onFindAnother: vi.fn(), onApproveAuto: vi.fn(), onRejectAuto: vi.fn(),
    };
    render(<StrictMode><DownloadsBoard {...props} /></StrictMode>);
    return { ...props, hs: handoff };
  }
  const column = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name}`) });

  it('keeps or rejects a wishlist download, and sends only when asked', () => {
    const wish = done('Call Super - Suzi Ecto');
    const mine = done('Actress - RIP');
    const claim: AutoClaim = { query: 'call super suzi ecto', user: 'nightbus', transferId: wish.id, path: wish.path, status: 'awaiting-review' };
    const p = show([wish, mine], { claims: [claim] });
    const ready = within(column('Ready'));

    fireEvent.click(ready.getByRole('button', { name: 'Keep' }));
    expect(p.onApproveAuto).toHaveBeenCalledWith('call super suzi ecto');
    expect(ready.getAllByRole('button', { name: 'Send to Rekordbox' })).toHaveLength(1);
    expect(p.hs.send).not.toHaveBeenCalled();
    fireEvent.click(ready.getByRole('button', { name: 'Send to Rekordbox' }));
    expect(p.hs.send).toHaveBeenCalledWith([mine.id]);
  });

  it('retries what a retry can fix, and offers another copy otherwise', () => {
    const timeout = file('Objekt - Flatland', { state: 'connection_timeout' });
    const p = show([timeout, file('Drexciya - Neptune', { state: 'rejected', error: 'File not shared.' })]);
    const queued = within(column('Queued by peer'));
    expect(column('Queued by peer').querySelector('.board__laneh')!.textContent).toBe('Needs attention 2');
    expect(column('Queued by peer').querySelector('h2')!.textContent).toBe('Queued by peer 0');
    fireEvent.click(queued.getByRole('button', { name: 'Retry' }));
    expect(p.session.retry).toHaveBeenCalledWith([timeout.id]);
    fireEvent.click(queued.getByRole('button', { name: 'Find another copy' }));
    expect(p.onFindAnother).toHaveBeenCalledWith('Drexciya Neptune');
  });

  it('counts every release sent, though it shows only the latest', () => {
    const sent = Array.from({ length: 10 }, (_, i) => done(`Artist ${i} - Record`));
    show(sent, { sent: sent.map((t) => sentRow(t)) });
    const col = column('Sent to Rekordbox');
    expect(col.querySelector('h2')!.textContent).toBe('Sent to Rekordbox 10');
    expect(col.querySelectorAll('.board__card')).toHaveLength(8);
    expect(col.textContent).toContain('and 2 more, in Completed');
  });

  it('says where Sent went, and asks for a folder when there is none', () => {
    const gone = done('Objekt - Cocoon Crush');
    show([gone], { sent: [sentRow(gone)] });
    expect(column('Sent to Rekordbox').textContent).toContain('In the Rekordbox folder · sent 2 hours ago');
    expect(screen.getByText('Rekordbox folder: ~/RB')).toBeTruthy();
    cleanup();

    const p = show([done('Actress - RIP')], { folder: null });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a Rekordbox folder' }));
    expect(p.handoff.onSetFolder).toHaveBeenCalled();
    expect(p.hs.send).not.toHaveBeenCalled();
  });
});

describe('homeShort', () => {
  it('says ~ for the home folder and nothing else', () => {
    expect(homeShort('/Users/iva/Music/RB')).toBe('~/Music/RB');
    expect(homeShort('/Volumes/USB/RB')).toBe('/Volumes/USB/RB');
    expect(homeShort('/Users/ivan')).toBe('~');
  });
});
