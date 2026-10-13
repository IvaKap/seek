// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A post-download check that fails at once (an undecodable file, a folder that
 * is gone) can be announced before the request's own reply arrives. The
 * failure used to be matched to its row only through the requestId in that
 * reply, so it was dropped and the row stayed on "running" for the session.
 * The failure event now names its transfer; these pin that it lands.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useAnalysis } from './analysisStore.ts';
import type { AnalysisSession } from './analysisStore.ts';
import { useChecksums } from './checksumStore.ts';
import type { ChecksumSession } from './checksumStore.ts';
import type { SidecarClient } from './sidecarClient.ts';

afterEach(cleanup);

/** A client whose replies the test releases by hand, after its events. */
function slowClient() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const held: (() => void)[] = [];
  const client = {
    on(event: string, fn: (d: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => { set.delete(fn); };
    },
    request() {
      return new Promise((resolve) => { held.push(() => resolve({ requestId: 'req-1' })); });
    },
  } as unknown as SidecarClient;
  const emit = (event: string, data: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn(data);
  };
  const reply = () => act(async () => { for (const r of held.splice(0)) r(); });
  return { client, emit, reply };
}

describe('a failure that beats its reply still lands on its row', () => {
  it('spectral analysis', async () => {
    const { client, emit, reply } = slowClient();
    const box: { s?: AnalysisSession } = {};
    function Probe() { box.s = useAnalysis(client); return null; }
    render(<StrictMode><Probe /></StrictMode>);

    act(() => box.s!.analyseTransfer('tr-9'));
    expect(box.s!.byTransfer.get('tr-9')?.state).toBe('running');

    act(() => emit('analysis.failed', {
      requestId: 'req-1', path: '/music/01.flac', transferId: 'tr-9', reason: 'decode failed',
    }));
    await reply();
    expect(box.s!.byTransfer.get('tr-9')).toEqual({ state: 'failed', reason: 'decode failed' });
  });

  it('checksums', async () => {
    const { client, emit, reply } = slowClient();
    const box: { s?: ChecksumSession } = {};
    function Probe() { box.s = useChecksums(client); return null; }
    render(<StrictMode><Probe /></StrictMode>);

    act(() => box.s!.check('tr-9'));
    expect(box.s!.byTransfer.get('tr-9')?.state).toBe('running');

    act(() => emit('checksums.failed', {
      requestId: 'req-1', path: '/music/01.flac', transferId: 'tr-9', reason: 'no such folder',
    }));
    await reply();
    expect(box.s!.byTransfer.get('tr-9')).toEqual({ state: 'failed', reason: 'no such folder' });
  });
});
