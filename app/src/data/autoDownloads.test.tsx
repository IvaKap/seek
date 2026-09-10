// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The auto-download controller under a real render. The DECISION is tested pure
 * in domain/autoWishlist.test.ts; this pins the wiring that only exists while
 * the hook renders: it waits for the ledger before acting, enqueues the planned
 * file, records a claim, and never acts twice on a wish it has already claimed.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAutoDownloads } from './autoDownloads.ts';
import type { SidecarClient } from './sidecarClient.ts';
import type { WishHits, WishHit } from './wishHits.ts';
import type { Transfer } from './transferStore.ts';
import { adaptSearchResult } from './adapt.ts';

afterEach(cleanup);

const analysisStub = () => ({ analyseTransfer: vi.fn() });
const transfersOf = (all: Transfer[] = []) =>
  ({ enqueue: vi.fn(() => Promise.resolve()), all, clear: vi.fn() });

/** A finished download row for a claimed candidate. */
function finishedTransfer(user: string, path: string): Transfer {
  return {
    id: `${user}:${path}`, direction: 'download', username: user, path,
    localFolder: null, size: 40_000_000, bytesDone: 40_000_000, state: 'finished',
    speed: 0, averageSpeed: 0, queuePosition: null, secondsLeft: null,
    secondsElapsed: 10, stalled: false, secondsSinceProgress: 0,
    finishedAt: Date.now() / 1000, error: null,
  };
}

function fakeClient(over: {
  wishes?: { query: string; filters: null; auto: boolean }[];
  claims?: unknown[];
} = {}) {
  const sent: { cmd: string; params: Record<string, unknown> }[] = [];
  const client = {
    on() { return () => {}; },
    request(cmd: string, params?: Record<string, unknown>) {
      sent.push({ cmd, params: params ?? {} });
      if (cmd === 'wishlist.list') {
        return Promise.resolve({ items: over.wishes ?? [], intervalSeconds: 720 });
      }
      if (cmd === 'wishlist.claimsList') return Promise.resolve({ items: over.claims ?? [] });
      return Promise.resolve({});
    },
  } as unknown as SidecarClient;
  return { client, sent };
}

/** A wish's results, as real SourceFiles from the adapter. */
function hit(query: string, name: string): WishHit {
  const sources = adaptSearchResult({
    searchId: 1,
    peer: {
      username: 'a-peer', freeSlots: true, advertisedSpeed: 900_000,
      queueLength: 0, files: 500, folders: 40, country: 'NL',
    },
    files: [{
      path: `music\\Drexciya\\${name}`, size: 40_000_000,
      bitrate: null, duration: 300, sampleRate: 44_100, bitDepth: 16, isVbr: null,
    }],
  }, 0, () => 0.5);
  return {
    query, sources, fresh: sources, releases: [], peerCount: 1,
    seenCount: 0, foundAt: Date.now(), unseen: true,
  };
}

const wishHitsOf = (h: Record<string, WishHit>): WishHits => ({
  byQuery: h, unseenCount: 0, markSeen: vi.fn(), forget: vi.fn(),
});

describe('useAutoDownloads', () => {
  it('enqueues the candidate and records a claim for an auto wish', async () => {
    const { client, sent } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
    });
    const transfers = transfersOf();
    renderHook(() => useAutoDownloads(client, wishHitsOf({ drexciya: hit('drexciya', '01.flac') }), transfers, analysisStub()),
      { wrapper: StrictMode });

    await waitFor(() => expect(transfers.enqueue).toHaveBeenCalledTimes(1));
    expect(transfers.enqueue).toHaveBeenCalledWith('a-peer', 'music\\Drexciya\\01.flac', 40_000_000);

    const claimWrite = sent.find((s) => s.cmd === 'wishlist.claims');
    expect(claimWrite).toBeTruthy();
    const items = (claimWrite!.params as { items: { query: string; status: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ query: 'drexciya', status: 'downloading' });
  });

  it('does nothing for a wish with auto off', async () => {
    const { client } = fakeClient({ wishes: [{ query: 'drexciya', filters: null, auto: false }] });
    const transfers = transfersOf();
    renderHook(() => useAutoDownloads(client, wishHitsOf({ drexciya: hit('drexciya', '01.flac') }), transfers, analysisStub()),
      { wrapper: StrictMode });

    // Give the effects a chance to run, then assert nothing happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(transfers.enqueue).not.toHaveBeenCalled();
  });

  it('does not re-download a wish that already has a claim', async () => {
    const { client } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{ query: 'drexciya', user: 'a-peer', transferId: '', path: 'x', status: 'downloading' }],
    });
    const transfers = transfersOf();
    renderHook(() => useAutoDownloads(client, wishHitsOf({ drexciya: hit('drexciya', '01.flac') }), transfers, analysisStub()),
      { wrapper: StrictMode });

    await new Promise((r) => setTimeout(r, 20));
    expect(transfers.enqueue).not.toHaveBeenCalled();
  });

  it('analyses a finished claim and moves it to awaiting-review', async () => {
    const path = 'music\\Drexciya\\01.flac';
    const { client, sent } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{ query: 'drexciya', user: 'a-peer', transferId: '', path, status: 'downloading' }],
    });
    const transfers = transfersOf([finishedTransfer('a-peer', path)]);
    const analysis = analysisStub();
    renderHook(() => useAutoDownloads(client, wishHitsOf({}), transfers, analysis),
      { wrapper: StrictMode });

    await waitFor(() => expect(analysis.analyseTransfer).toHaveBeenCalledWith('a-peer:' + path));
    // The claim it persists last is the awaiting-review one, carrying the id.
    const writes = sent.filter((s) => s.cmd === 'wishlist.claims');
    const last = writes[writes.length - 1].params as { items: { status: string; transferId: string }[] };
    expect(last.items[0]).toMatchObject({ status: 'awaiting-review', transferId: 'a-peer:' + path });
  });

  it('approve ends the wish and drops the claim, keeping the file', async () => {
    const { client, sent } = fakeClient({
      wishes: [{ query: 'q', filters: null, auto: true }],
      claims: [{ query: 'q', user: 'u', transferId: 't1', path: 'p', status: 'awaiting-review' }],
    });
    const transfers = transfersOf();
    const { result } = renderHook(() => useAutoDownloads(client, wishHitsOf({}), transfers, analysisStub()),
      { wrapper: StrictMode });

    await waitFor(() => expect(result.current.claims).toHaveLength(1));
    act(() => result.current.approve('q'));

    expect(sent.some((s) => s.cmd === 'wishlist.remove'
      && (s.params as { query: string }).query === 'q')).toBe(true);
    expect(transfers.clear).not.toHaveBeenCalled();           // the file is kept
    await waitFor(() => expect(result.current.claims).toHaveLength(0));
  });

  it('reject discards the copy (clears the transfer) and resumes', async () => {
    const { client, sent } = fakeClient({
      wishes: [{ query: 'q', filters: null, auto: true }],
      claims: [{ query: 'q', user: 'u', transferId: 't1', path: 'p', status: 'awaiting-review' }],
    });
    const transfers = transfersOf();
    const { result } = renderHook(() => useAutoDownloads(client, wishHitsOf({}), transfers, analysisStub()),
      { wrapper: StrictMode });

    await waitFor(() => expect(result.current.claims).toHaveLength(1));
    act(() => result.current.reject('q'));

    expect(transfers.clear).toHaveBeenCalledWith(['t1']);
    // The wish is NOT removed — it stays to find another copy.
    expect(sent.some((s) => s.cmd === 'wishlist.remove')).toBe(false);
    await waitFor(() => expect(result.current.claims).toHaveLength(0));
  });
});
