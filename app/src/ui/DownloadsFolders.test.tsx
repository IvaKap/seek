// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Downloads · Folders: the releases as folders, beside the Rekordbox folder.
 * Pinned: a release sits under Downloads until it is sent and under the
 * Rekordbox folder after, each line is the Board's, files on their way are
 * dimmed, and Show in Finder only offers what is actually on disk.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DownloadsFolders, folderTree } from './DownloadsFolders.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer, TransferSession } from '../data/transferStore.ts';
import type { HandoffSession } from '../data/handoffStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { HandoffSent } from '../../../shared/protocol.ts';

afterEach(cleanup);

const NOW = Date.now() / 1000;
let n = 0;
function file(folder: string, over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `t${n}`, direction: 'download', username: 'nightbus', path: `Music\\${folder}\\0${n} Track.flac`,
    localFolder: `/Users/iva/Downloads/${folder}`, size: 1_000_000, bytesDone: 0, state: 'queued', speed: 0,
    averageSpeed: 0, queuePosition: null, secondsLeft: null, secondsElapsed: 0, stalled: false,
    secondsSinceProgress: 0, finishedAt: null, error: null, ...over,
  };
}
const done = (folder: string, over: Partial<Transfer> = {}) =>
  file(folder, { state: 'finished', bytesDone: 1_000_000, finishedAt: NOW - 60, ...over });
const sentRow = (t: Transfer): HandoffSent => (
  { transferId: t.id, user: t.username, path: t.path, dest: `/Volumes/USB/RB/Cocoon/${t.id}.flac`, sentAt: NOW - 7200 }
);
function handoffOf(sent: HandoffSent[], folder: string | null = '/Volumes/USB/RB'): HandoffSession {
  return {
    folder, sent: new Map(sent.map((r) => [r.transferId, r])), sending: new Set(), failed: new Map(),
    send: vi.fn(async () => {}), reveal: vi.fn(async () => {}),
  };
}
const bits = (h: HandoffSession) => ({ session: h, held: new Set<string>(), onSetFolder: vi.fn() });

describe('the tree', () => {
  it('puts what is coming under Downloads and what went under the Rekordbox folder', () => {
    const arriving = [done('Burial - Untrue'), file('Burial - Untrue', { state: 'transferring', bytesDone: 500_000, speed: 1_000_000 })];
    const gone = done('Objekt - Cocoon Crush');
    const roots = folderTree({
      groups: group([...arriving, gone], 999_999, Date.now()), now: NOW, checks: new Map(),
      handoff: bits(handoffOf([sentRow(gone)])), review: new Map(), downloadFolder: '/Users/iva/Downloads',
    });
    const [downloads, rekordbox] = roots;
    expect(downloads).toMatchObject({ name: 'Downloads', status: '1 on the way', files: 2 });
    expect(downloads.children!.map((c) => c.name)).toEqual(['Burial - Untrue']);
    expect(downloads.children![0].children!.map((f) => [f.status, f.pending ?? false]))
      .toEqual([['Done', false], ['50% · 977 KB/s', true]]);
    expect(rekordbox).toMatchObject({ name: 'RB', path: '/Volumes/USB/RB' });
    expect(rekordbox.children!.map((c) => [c.name, c.status])).toEqual([['Cocoon', 'Copied 2 hours ago']]);
  });

  it('lists every release that went, even one only partly sent or since cleared', () => {
    const [sentOne, notYet] = [done('Shed - Traveller'), done('Shed - Traveller')];
    const cleared: HandoffSent = { transferId: 'gone', user: 'u', path: 'Music\\Old\\01.flac', dest: '/Volumes/USB/RB/Old/01.flac', sentAt: NOW - 90_000 };
    const [, rekordbox] = folderTree({
      groups: group([sentOne, notYet], 999_999, Date.now()), now: NOW, checks: new Map(),
      handoff: bits(handoffOf([sentRow(sentOne), cleared])), review: new Map(), downloadFolder: null,
    });
    expect(rekordbox.children!.map((c) => [c.name, c.files, c.size])).toEqual([['Cocoon', 1, '977 KB'], ['Old', 1, '']]);
    expect(rekordbox.status).toBe('2 folders · last copy 2 hours ago');
  });

  it('has no Rekordbox root until a folder is set', () => {
    const roots = folderTree({
      groups: [], now: NOW, checks: new Map(), handoff: bits(handoffOf([], null)), review: new Map(), downloadFolder: null,
    });
    expect(roots.map((r) => [r.name, r.status])).toEqual([['Downloads', 'Nothing downloading']]);
  });
});

describe('the view', () => {
  function show(transfers: Transfer[], sent: HandoffSent[] = []) {
    const h = handoffOf(sent);
    const session = { groups: group(transfers, 999_999, Date.now()), reveal: vi.fn() } as unknown as TransferSession;
    render(
      <StrictMode>
        <DownloadsFolders
          session={session} checksums={{ byTransfer: new Map(), check: vi.fn() } as unknown as ChecksumSession}
          handoff={bits(h)} review={new Map()} now={NOW} downloadFolder="/Users/iva/Downloads" tools={null} notices={null}
        />
      </StrictMode>,
    );
    return { session, h };
  }
  const row = (name: string) => screen.getByTitle(name);

  it('opens a release to its files, and follows the selection in the path', () => {
    const [a, b] = [done('Burial - Untrue'), file('Burial - Untrue')];
    show([a, b]);
    expect(screen.queryByTitle('01 Track.flac')).toBeNull();
    fireEvent.click(row('Burial - Untrue'));
    expect(row('Burial - Untrue').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('navigation', { name: 'Selected path' }).textContent).toBe('~›Downloads›Burial - Untrue');
    expect(row(`0${b.id.slice(1)} Track.flac`).closest('li')!.hasAttribute('data-pending')).toBe(true);
  });

  it('shows on disk only what is there: a finished file, not one still on its way', () => {
    const [a, b] = [done('Burial - Untrue'), file('Burial - Untrue')];
    const { session } = show([a, b]);
    fireEvent.click(row('Burial - Untrue'));
    fireEvent.click(row(`0${b.id.slice(1)} Track.flac`));
    expect((screen.getByRole('button', { name: 'Show in Finder' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row(`0${a.id.slice(1)} Track.flac`));
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(session.reveal).toHaveBeenCalledWith(a.id);
  });

  it('reveals a copy in the Rekordbox folder by its path', () => {
    const gone = done('Objekt - Cocoon Crush');
    const { h } = show([gone], [sentRow(gone)]);
    fireEvent.click(row('Cocoon'));
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(h.reveal).toHaveBeenCalledWith('/Volumes/USB/RB/Cocoon');
  });
});
