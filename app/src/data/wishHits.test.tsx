// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `useWishHits` under a real React render, because the interesting behaviour
 * here only exists while it is rendering.
 *
 * The bug this harness is for: the split between new and already-seen results
 * is FROZEN when a run's results arrive, and opening a wish is what marks them
 * seen. Judged against the live set instead, a wish would report its own
 * results as old the moment you looked at them — and no pure-logic test can
 * see that, because there is no function to call that has it. `splitSeen` is
 * correct in isolation either way.
 *
 * Rendered in <StrictMode> like the rest of the component tests here: it is
 * the only configuration that surfaces an impure render, and this hook keeps
 * three refs across two event handlers.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useWishHits } from './wishHits.ts';
import type { WishHits } from './wishHits.ts';
import type { SidecarClient } from './sidecarClient.ts';
import { adaptSearchResult } from './adapt.ts';
import { seenId } from '../domain/wishSeen.ts';

afterEach(cleanup);

/** A client that lets the test push events and watch the commands sent back. */
function fakeClient(seenList: { query: string; ids: string[] }[] = []) {
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
      if (cmd === 'wishlist.seenList') return Promise.resolve({ items: seenList });
      return Promise.resolve({});
    },
  } as unknown as SidecarClient;

  const emit = (event: string, data: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn(data);
  };
  return { client, emit, sent };
}

/** One wire result: `n` files from `user`, for the given search. */
function results(searchId: number, user: string, names: string[]) {
  return {
    searchId,
    peer: {
      username: user, freeSlots: true, advertisedSpeed: 900_000,
      queueLength: 0, files: 500, folders: 40, country: 'NL',
    },
    files: names.map((name) => ({
      path: `music\\Drexciya\\${name}`,
      size: 40_000_000,
      bitrate: null, duration: 300, sampleRate: 44_100, bitDepth: 16, isVbr: null,
    })),
  };
}

function mount(client: SidecarClient) {
  const box: { hits?: WishHits } = {};
  function Probe() {
    box.hits = useWishHits(client);
    return null;
  }
  render(<StrictMode><Probe /></StrictMode>);
  return box as { hits: WishHits };
}

/**
 * The id the hook will compute for one of `results()`'s files.
 *
 * Derived by running the REAL adapter, not by rebuilding the string. The first
 * version of this file did rebuild it and was wrong: `SourceFile.id` joins user
 * and path with a NUL, not a space — which is invisible in the source and
 * invisible to grep, since a literal NUL makes the whole file read as binary.
 * A helper that reconstructs an id is a second implementation of it, and this
 * one silently disagreed with the first.
 */
const idFor = (user: string, name: string) =>
  seenId(adaptSearchResult(results(1, user, [name]) as never, 0, () => 0.5)[0]);

const started = (query = 'drexciya', searchId = 7) =>
  ({ searchId, query, mode: 'wishlist' });

describe('a wish only announces what is new', () => {
  it('a first run is all new', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac', '02.flac']));
    });

    const hit = box.hits.byQuery.drexciya;
    expect(hit.sources).toHaveLength(2);
    expect(hit.fresh).toHaveLength(2);
    expect(hit.seenCount).toBe(0);
    expect(box.hits.unseenCount).toBe(1);
  });

  it('an exact repeat announces nothing', async () => {
    // THE POINT OF THE WHOLE FEATURE. Upstream re-runs this query forever and
    // the same peer keeps offering the same files.
    const { client, emit } = fakeClient([{
      query: 'drexciya',
      ids: [idFor('peer-a', '01.flac'), idFor('peer-a', '02.flac')],
    }]);
    const box = mount(client);
    await act(async () => {});   // let seenList resolve

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac', '02.flac']));
    });

    const hit = box.hits.byQuery.drexciya;
    expect(hit.sources).toHaveLength(2);
    expect(hit.fresh).toEqual([]);
    expect(hit.seenCount).toBe(2);
    expect(hit.unseen).toBe(false);
    expect(box.hits.unseenCount).toBe(0);
  });

  it('one genuinely new file among the repeats is the news', async () => {
    const { client, emit } = fakeClient([{
      query: 'drexciya', ids: [idFor('peer-a', '01.flac')],
    }]);
    const box = mount(client);
    await act(async () => {});

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac', '02.flac']));
    });

    const hit = box.hits.byQuery.drexciya;
    expect(hit.fresh.map((s) => s.path)).toEqual(['music\\Drexciya\\02.flac']);
    expect(hit.seenCount).toBe(1);
    expect(box.hits.unseenCount).toBe(1);
  });

  it('a new peer holding a file you have seen elsewhere IS news', async () => {
    // They may be online when the other is not, which is why a wishlist exists.
    const { client, emit } = fakeClient([{
      query: 'drexciya', ids: [idFor('peer-a', '01.flac')],
    }]);
    const box = mount(client);
    await act(async () => {});

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-b', ['01.flac']));
    });

    expect(box.hits.byQuery.drexciya.fresh).toHaveLength(1);
  });
});

describe('opening a wish', () => {
  it('does not empty the results you are looking at', async () => {
    // The freeze. Recomputed against the live set, marking seen would strip
    // the very rows that were just announced.
    const { client, emit } = fakeClient();
    const box = mount(client);

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac', '02.flac']));
    });
    await act(async () => { box.hits.markSeen('drexciya'); });

    expect(box.hits.byQuery.drexciya.sources).toHaveLength(2);
  });

  it('mid-run, does not turn the rest of that run into old news', () => {
    // THE FREEZE, at the one moment it is visible. Results stream in over
    // seconds; open the wish while they are still arriving and the run's
    // baseline must not move under it. Judged against the live set, the batch
    // you just marked would be subtracted from the batch that follows.
    const { client, emit } = fakeClient();
    const box = mount(client);

    act(() => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    act(() => { box.hits.markSeen('drexciya'); });
    act(() => { emit('search.result', results(7, 'peer-b', ['02.flac'])); });

    // One run, one baseline: both are new relative to where it started.
    expect(box.hits.byQuery.drexciya.sources).toHaveLength(2);
    expect(box.hits.byQuery.drexciya.fresh).toHaveLength(2);
    expect(box.hits.byQuery.drexciya.seenCount).toBe(0);
  });

  it('stops it counting as news', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    expect(box.hits.unseenCount).toBe(1);

    await act(async () => { box.hits.markSeen('drexciya'); });
    expect(box.hits.unseenCount).toBe(0);
    expect(box.hits.byQuery.drexciya.fresh).toEqual([]);
    expect(box.hits.byQuery.drexciya.seenCount).toBe(1);
  });

  it('tells the sidecar, with every result and not only the new ones', async () => {
    // Re-marking a still-offered file keeps it inside the sidecar's window;
    // sending only what was new would let live results age out and reappear.
    const { client, emit, sent } = fakeClient([{
      query: 'drexciya', ids: [idFor('peer-a', '01.flac')],
    }]);
    const box = mount(client);
    await act(async () => {});

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac', '02.flac']));
    });
    await act(async () => { box.hits.markSeen('drexciya'); });

    const mark = sent.filter((c) => c.cmd === 'wishlist.seen').pop();
    expect(mark).toBeTruthy();
    expect(mark!.params.query).toBe('drexciya');
    expect(mark!.params.ids).toEqual([
      idFor('peer-a', '01.flac'), idFor('peer-a', '02.flac'),
    ]);
  });

  it('is silent when there is nothing to mark', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { box.hits.markSeen('never ran'); });
    expect(sent.filter((c) => c.cmd === 'wishlist.seen')).toEqual([]);
  });

  it('is silent for a run that found nothing at all', async () => {
    // A wish DOES have an entry once its run starts — it is just empty. An
    // empty mark is a pointless write to the state file on every glance.
    const { client, emit, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { emit('search.started', started()); });
    expect(box.hits.byQuery.drexciya).toBeTruthy();

    await act(async () => { box.hits.markSeen('drexciya'); });
    expect(sent.filter((c) => c.cmd === 'wishlist.seen')).toEqual([]);
  });

  it('means the NEXT run holds those results back', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    await act(async () => { box.hits.markSeen('drexciya'); });

    // The timer fires again on the same token, and the peer still has it.
    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });

    expect(box.hits.byQuery.drexciya.sources).toHaveLength(1);
    expect(box.hits.byQuery.drexciya.fresh).toEqual([]);
    expect(box.hits.unseenCount).toBe(0);
  });
});

describe('the seen-set from the sidecar', () => {
  it('does not overwrite what this session already marked', async () => {
    // The reply can land after a run has already come and gone. Replacing
    // rather than merging would resurrect results already marked seen.
    let resolveList: (v: unknown) => void = () => {};
    const handlers = new Map<string, Set<(d: unknown) => void>>();
    const client = {
      on(event: string, fn: (d: unknown) => void) {
        const set = handlers.get(event) ?? new Set();
        set.add(fn); handlers.set(event, set);
        return () => { set.delete(fn); };
      },
      request(cmd: string) {
        if (cmd === 'wishlist.seenList') {
          return new Promise((res) => { resolveList = res; });
        }
        return Promise.resolve({});
      },
    } as unknown as SidecarClient;
    const emit = (e: string, d: unknown) => {
      for (const fn of handlers.get(e) ?? []) fn(d);
    };

    const box = mount(client);
    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    await act(async () => { box.hits.markSeen('drexciya'); });

    /* Only now does the sidecar answer — with a real entry for this wish from
       an earlier session, and knowing nothing about the mark just made.
       Replacing rather than merging would drop that mark on the floor. */
    await act(async () => {
      resolveList({ items: [{ query: 'drexciya', ids: ['0123456789ab'] }] });
    });

    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    expect(box.hits.byQuery.drexciya.fresh).toEqual([]);
  });

  it('a failure to read it degrades to "everything is new"', async () => {
    const handlers = new Map<string, Set<(d: unknown) => void>>();
    const client = {
      on(event: string, fn: (d: unknown) => void) {
        const set = handlers.get(event) ?? new Set();
        set.add(fn); handlers.set(event, set);
        return () => { set.delete(fn); };
      },
      request: vi.fn().mockRejectedValue(new Error('nope')),
    } as unknown as SidecarClient;
    const emit = (e: string, d: unknown) => {
      for (const fn of handlers.get(e) ?? []) fn(d);
    };

    const box = mount(client);
    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    // Noisier than it should be, never emptier. A screen full of repeats beats
    // a wish that silently stops announcing anything.
    expect(box.hits.byQuery.drexciya.fresh).toHaveLength(1);
  });
});

describe('what the wishlist ignores', () => {
  it('a search the user typed is not a wish', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);
    await act(async () => {
      emit('search.started', { searchId: 3, query: 'burial', mode: 'global' });
      emit('search.result', results(3, 'peer-a', ['01.flac']));
    });
    expect(box.hits.byQuery).toEqual({});
  });

  it('forgetting a wish drops what it knew', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);
    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    // Marked first, or there is nothing for `forget` to fail to drop.
    await act(async () => { box.hits.markSeen('drexciya'); });
    await act(async () => { box.hits.forget('drexciya'); });
    expect(box.hits.byQuery.drexciya).toBeUndefined();

    // And the seen-set with it: re-adding the same text must not begin life
    // believing it has already shown you things you have never seen.
    await act(async () => {
      emit('search.started', started());
      emit('search.result', results(7, 'peer-a', ['01.flac']));
    });
    expect(box.hits.byQuery.drexciya.fresh).toHaveLength(1);
  });
});
