// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Undo for Cancel, under a real render. Cancel stops AND forgets a download
 * (the sidecar has to, or folders restart themselves), so one stray press used
 * to throw away a release that had waited hours in a peer's queue. These pin
 * that Undo asks for exactly the cancelled files again, that a second Cancel
 * adds to the batch, that finished files and uploads are never re-requested,
 * and that the offer expires.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useTransfers } from './transferStore.ts';
import type { Transfer } from './transferStore.ts';
import type { SidecarClient } from './sidecarClient.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function row(id: string, over: Partial<Transfer> = {}): Transfer {
  return {
    id, direction: 'download', username: 'peer', path: `@@x\\Release\\${id}.flac`,
    localFolder: null, size: 100, bytesDone: 0, state: 'queued', speed: 0,
    averageSpeed: 0, queuePosition: 1433, secondsLeft: null, secondsElapsed: 0,
    stalled: false, secondsSinceProgress: 0, finishedAt: null, error: null,
    ...over,
  };
}

function fakeClient(transfers: Transfer[]) {
  const sent: { cmd: string; params: Record<string, unknown> }[] = [];
  const client = {
    on() { return () => {}; },
    request(cmd: string, params?: Record<string, unknown>) {
      sent.push({ cmd, params: params ?? {} });
      if (cmd === 'transfer.list') return Promise.resolve({ transfers });
      if (cmd === 'transfer.enqueue') return Promise.resolve({ transferId: 'n', alreadyQueued: false });
      return Promise.resolve({});
    },
  } as unknown as SidecarClient;
  return { client, sent };
}

async function loaded(transfers: Transfer[]) {
  const { client, sent } = fakeClient(transfers);
  const hook = renderHook(() => useTransfers(client), { wrapper: StrictMode });
  await waitFor(() => expect(hook.result.current.all).toHaveLength(
    transfers.filter((t) => t.direction !== 'upload').length,
  ));
  return { hook, sent };
}

describe('Undo for Cancel', () => {
  it('re-requests exactly the cancelled files', async () => {
    const { hook, sent } = await loaded([row('01'), row('02'), row('03')]);

    act(() => hook.result.current.cancel(['01', '02']));
    expect(sent.find((s) => s.cmd === 'transfer.cancel')?.params)
      .toEqual({ transferIds: ['01', '02'] });
    expect(hook.result.current.cancelled).toHaveLength(2);

    act(() => hook.result.current.undoCancel());
    const again = sent.filter((s) => s.cmd === 'transfer.enqueue').map((s) => s.params.path);
    expect(again).toEqual(['@@x\\Release\\01.flac', '@@x\\Release\\02.flac']);
    expect(hook.result.current.cancelled).toBeNull();
  });

  it('adds a second Cancel to the same Undo rather than replacing it', async () => {
    const { hook } = await loaded([row('01'), row('02')]);
    act(() => hook.result.current.cancel(['01']));
    act(() => hook.result.current.cancel(['02']));
    expect(hook.result.current.cancelled?.map((f) => f.path)).toEqual([
      '@@x\\Release\\01.flac', '@@x\\Release\\02.flac',
    ]);
  });

  it('never re-requests a finished file or an upload', async () => {
    const { hook } = await loaded([
      row('01', { state: 'finished' }),
      row('up', { direction: 'upload' }),
    ]);
    act(() => hook.result.current.cancel(['01', 'up']));
    expect(hook.result.current.cancelled).toBeNull();
  });

  it('stops offering Undo after a few seconds', async () => {
    const { hook } = await loaded([row('01')]);
    vi.useFakeTimers();
    act(() => hook.result.current.cancel(['01']));
    expect(hook.result.current.cancelled).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(10_001); });
    expect(hook.result.current.cancelled).toBeNull();
  });
});
