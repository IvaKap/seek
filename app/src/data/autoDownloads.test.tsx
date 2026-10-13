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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
  /** Fail the first N ledger reads. */
  failClaimsReads?: number;
} = {}) {
  const sent: { cmd: string; params: Record<string, unknown> }[] = [];
  let failures = over.failClaimsReads ?? 0;
  const client = {
    on() { return () => {}; },
    request(cmd: string, params?: Record<string, unknown>) {
      sent.push({ cmd, params: params ?? {} });
      if (cmd === 'wishlist.list') {
        return Promise.resolve({ items: over.wishes ?? [], intervalSeconds: 720 });
      }
      if (cmd === 'wishlist.claimsList') {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('the engine has not answered yet'));
        }
        return Promise.resolve({ items: over.claims ?? [] });
      }
      return Promise.resolve({});
    },
  } as unknown as SidecarClient;
  return { client, sent };
}

/** Two copies of one wish's track, the first scoring higher. */
function twoCopies(query: string): WishHit {
  const a = hit(query, '01.flac');
  const b = hit(query, '01 (other rip).flac');
  const lower = { ...b.sources[0], user: 'b-peer', score: a.sources[0].score - 1 };
  return { ...a, sources: [a.sources[0], lower], fresh: [a.sources[0], lower] };
}

/** Let resolved promises (the ledger read) land inside act. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

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
    query, sources, fresh: sources, peerCount: 1, unseen: true,
  };
}

const wishHitsOf = (h: Record<string, WishHit>): WishHits => ({
  byQuery: h, unseenCount: 0, markSeen: vi.fn(),
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

  it('drops a claim whose download failed, so the wish is free to resume', async () => {
    const path = 'music\\Drexciya\\01.flac';
    const { client } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{ query: 'drexciya', user: 'a-peer', transferId: '', path, status: 'downloading' }],
    });
    const failed: Transfer = {
      ...finishedTransfer('a-peer', path), state: 'local_file_error', bytesDone: 0, finishedAt: null,
    };
    const { result } = renderHook(() => useAutoDownloads(client, wishHitsOf({}), transfersOf([failed]), analysisStub()),
      { wrapper: StrictMode });

    // Kept as SKIPPED — no longer holding the wish, but remembered so the same
    // file is not picked again.
    await waitFor(() => expect(result.current.claims[0]?.status).toBe('skipped'));
  });

  it('after a failure, takes ANOTHER copy rather than the same one again', async () => {
    const path = 'music\\Drexciya\\01.flac';
    const { client } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{ query: 'drexciya', user: 'a-peer', transferId: '', path, status: 'downloading' }],
    });
    const failed: Transfer = {
      ...finishedTransfer('a-peer', path), state: 'rejected', bytesDone: 0, finishedAt: null,
    };
    const transfers = transfersOf([failed]);
    renderHook(() => useAutoDownloads(client, wishHitsOf({ drexciya: twoCopies('drexciya') }), transfers, analysisStub()),
      { wrapper: StrictMode });

    await waitFor(() => expect(transfers.enqueue).toHaveBeenCalled());
    expect(transfers.enqueue).not.toHaveBeenCalledWith('a-peer', path, expect.anything());
    expect(transfers.enqueue).toHaveBeenCalledWith('b-peer', expect.any(String), expect.any(Number));
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
    await waitFor(() => expect(result.current.claims[0]?.status).toBe('skipped'));
  });

  it('never re-picks the file you just rejected', async () => {
    /* The bug: Reject dropped the claim, the planner ran on the same results,
     * and the rejected copy — still the top score — downloaded again. */
    const path = 'music\\Drexciya\\01.flac';
    const { client } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{ query: 'drexciya', user: 'a-peer', transferId: 't1', path, status: 'awaiting-review' }],
    });
    const transfers = transfersOf();
    const { result } = renderHook(
      () => useAutoDownloads(client, wishHitsOf({ drexciya: twoCopies('drexciya') }), transfers, analysisStub()),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.claims).toHaveLength(1));

    act(() => result.current.reject('drexciya'));
    await waitFor(() => expect(transfers.enqueue).toHaveBeenCalled());
    expect(transfers.enqueue).not.toHaveBeenCalledWith('a-peer', path, expect.anything());
    expect(transfers.enqueue).toHaveBeenCalledWith('b-peer', expect.any(String), expect.any(Number));
  });

  it('gives up on a claim whose download never appears, and frees the slot', async () => {
    /* Enqueue fails quietly, or the queued file is cleared by hand: the
     * transfer never shows up, and the claim used to wait for ever. Three of
     * those stopped auto-download entirely, across restarts. */
    vi.useFakeTimers();
    const { client } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{
        query: 'drexciya', user: 'a-peer', transferId: '', path: 'gone.flac', status: 'downloading',
      }],
    });
    const transfers = transfersOf();
    const { result } = renderHook(
      () => useAutoDownloads(client, wishHitsOf({ drexciya: hit('drexciya', '01.flac') }), transfers, analysisStub()),
      { wrapper: StrictMode },
    );
    await settle();
    expect(transfers.enqueue).not.toHaveBeenCalled();         // still waiting

    await act(async () => { vi.advanceTimersByTime(3 * 60_000 + 31_000); });
    // Dropped, not skipped: a transfer that never appeared says nothing
    // against that copy, so the wish may try again — it included.
    expect(result.current.claims.find((c) => c.path === 'gone.flac')).toBeUndefined();
    expect(transfers.enqueue).toHaveBeenCalledWith('a-peer', 'music\\Drexciya\\01.flac', 40_000_000);
  });

  it('waits out a peer who went offline instead of starting a second copy', async () => {
    /* user_logged_off and timeouts recover by themselves; treating them as
       final started another download, and the first then finished past review. */
    vi.useFakeTimers();
    const path = 'music\\Drexciya\\01.flac';
    const { client } = fakeClient({
      wishes: [{ query: 'drexciya', filters: null, auto: true }],
      claims: [{ query: 'drexciya', user: 'a-peer', transferId: '', path, status: 'downloading' }],
    });
    const away: Transfer = {
      ...finishedTransfer('a-peer', path), state: 'user_logged_off', bytesDone: 0, finishedAt: null,
    };
    const transfers = transfersOf([away]);
    const { result } = renderHook(
      () => useAutoDownloads(client, wishHitsOf({ drexciya: twoCopies('drexciya') }), transfers, analysisStub()),
      { wrapper: StrictMode },
    );
    await settle();
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    expect(result.current.claims[0]?.status).toBe('downloading');
    expect(transfers.enqueue).not.toHaveBeenCalled();

    // Long enough gone: given up, and the stale copy cleared so it cannot
    // finish later behind the review's back.
    await act(async () => { vi.advanceTimersByTime(11 * 60_000); });
    expect(result.current.claims[0]?.status).toBe('skipped');
    expect(transfers.clear).toHaveBeenCalled();
  });

  it('starts nothing while signed out', async () => {
    const { client } = fakeClient({ wishes: [{ query: 'drexciya', filters: null, auto: true }] });
    const transfers = transfersOf();
    renderHook(
      () => useAutoDownloads(client, wishHitsOf({ drexciya: hit('drexciya', '01.flac') }), transfers,
        analysisStub(), undefined, false),
      { wrapper: StrictMode },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(transfers.enqueue).not.toHaveBeenCalled();
  });

  it('retries an unreadable ledger instead of overwriting it with nothing', async () => {
    /* The sidecar replaces the whole ledger on every write, so treating a
     * failed read as "empty" and then acting erased everything awaiting review. */
    vi.useFakeTimers();
    const awaiting = { query: 'q', user: 'u', transferId: 't1', path: 'p', status: 'awaiting-review' };
    const { client, sent } = fakeClient({
      // The claim's own wish is on the list too: a claim whose wish was
      // removed is dropped, by design.
      wishes: [{ query: 'drexciya', filters: null, auto: true }, { query: 'q', filters: null, auto: true }],
      claims: [awaiting],
      // Two: StrictMode mounts the effect twice, and each mount reads once.
      failClaimsReads: 2,
    });
    const transfers = transfersOf();
    const { result } = renderHook(
      () => useAutoDownloads(client, wishHitsOf({ drexciya: hit('drexciya', '01.flac') }), transfers, analysisStub()),
      { wrapper: StrictMode },
    );
    await settle();
    // Nothing acted on, nothing written, while the ledger is unknown.
    expect(transfers.enqueue).not.toHaveBeenCalled();
    expect(sent.some((s) => s.cmd === 'wishlist.claims')).toBe(false);

    await act(async () => { vi.advanceTimersByTime(5_000); });
    await settle();
    expect(result.current.claims.some((c) => c.query === 'q')).toBe(true);
    const write = sent.filter((s) => s.cmd === 'wishlist.claims').pop();
    const items = (write?.params as { items: { query: string }[] } | undefined)?.items ?? [];
    expect(items.some((c) => c.query === 'q')).toBe(true);   // review entry kept
  });
});
