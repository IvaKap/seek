// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A folder Get from search. A search shows some of a folder's files, so the
 * "this is a lot of files" question used to be asked about the wrong number
 * and a 3,000-file folder could be queued without it. Only the sidecar sees
 * the real count, so it holds a big folder back; these pin that the app asks
 * about the REAL count and, once you agree, takes the folder where you first
 * chose.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTransfers } from './transferStore.ts';
import type { SidecarClient } from './sidecarClient.ts';

afterEach(cleanup);

const FOLDER = 'Music\\Burial - Untrue';

function fakeClient() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const sent: { cmd: string; params: Record<string, unknown> }[] = [];
  const client = {
    on(event: string, fn: (d: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => { set.delete(fn); };
    },
    request(cmd: string, params?: Record<string, unknown>) {
      sent.push({ cmd, params: params ?? {} });
      if (cmd === 'transfer.list') return Promise.resolve({ transfers: [] });
      if (cmd === 'transfer.enqueueFolder') return Promise.resolve({ requestId: 'f1' });
      return Promise.resolve({});
    },
  } as unknown as SidecarClient;
  const emit = (event: string, data: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn(data);
  };
  const folderRequests = () => sent.filter((s) => s.cmd === 'transfer.enqueueFolder').map((s) => s.params);
  return { client, emit, folderRequests };
}

describe('a folder Get asks about the real count', () => {
  it('lets the sidecar hold back a folder bigger than the search showed', async () => {
    const { client, emit, folderRequests } = fakeClient();
    const hook = renderHook(() => useTransfers(client), { wrapper: StrictMode });

    await act(() => hook.result.current.enqueueFolder(
      'nightbus', FOLDER, false, { destination: '/Volumes/USB', count: 12 },
    ));
    expect(folderRequests()).toEqual([{
      username: 'nightbus', folderPath: FOLDER, recurse: false,
      destination: '/Volumes/USB', confirmAbove: 1000,
    }]);

    act(() => emit('folder.contents', {
      requestId: 'f1', username: 'nightbus', folderPath: FOLDER, folders: [], enqueued: 0,
      held: { count: 1200, recurse: false, destination: '/Volumes/USB' },
    }));
    expect(hook.result.current.pendingFolder).toEqual({
      username: 'nightbus', folderPath: FOLDER, recurse: false,
      destination: '/Volumes/USB', count: 1200,
    });

    await act(async () => { hook.result.current.confirmFolder(); });
    expect(folderRequests()[1]).toEqual({
      username: 'nightbus', folderPath: FOLDER, recurse: false,
      destination: '/Volumes/USB', confirmAbove: null,
    });
    expect(hook.result.current.pendingFolder).toBeNull();
  });

  it('asks about two held folders in turn, not just the last', async () => {
    const { client, emit } = fakeClient();
    const hook = renderHook(() => useTransfers(client), { wrapper: StrictMode });
    const held = (folderPath: string) => ({
      requestId: 'f', username: 'nightbus', folderPath, folders: [], enqueued: 0,
      held: { count: 1200, recurse: false, destination: null },
    });

    act(() => emit('folder.contents', held('Music\\A')));
    act(() => emit('folder.contents', held('Music\\B')));
    expect(hook.result.current.pendingFolder?.folderPath).toBe('Music\\A');

    act(() => hook.result.current.dismissFolder());
    expect(hook.result.current.pendingFolder?.folderPath).toBe('Music\\B');
  });

  it('asks at once when what is already known is past the limit', async () => {
    const { client, folderRequests } = fakeClient();
    const hook = renderHook(() => useTransfers(client), { wrapper: StrictMode });

    await act(() => hook.result.current.enqueueFolder('nightbus', FOLDER, true, { count: 1500 }));
    expect(folderRequests()).toEqual([]);
    expect(hook.result.current.pendingFolder?.count).toBe(1500);

    await act(async () => { hook.result.current.confirmFolder(); });
    expect(folderRequests()).toEqual([{
      username: 'nightbus', folderPath: FOLDER, recurse: true,
      destination: null, confirmAbove: null,
    }]);
  });
});
