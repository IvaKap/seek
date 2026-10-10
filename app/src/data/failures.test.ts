// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Failures used to be swallowed — the click did nothing and said nothing. A
 * user action now leaves a short notice; a first read retries instead.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { dismissFailure, readUntilAnswered, reportFailure, useFailures } from './failures.ts';
import type { SidecarClient } from './sidecarClient.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('reportFailure', () => {
  it('says what was tried and why, in words', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFailures());
    act(() => reportFailure('Join #techno', new Error('not_connected: not connected to the Soulseek server')));
    expect(result.current.at(-1)?.text)
      .toBe("Join #techno didn't work — not connected to the Soulseek server");
    act(() => { vi.advanceTimersByTime(7_001); });
    expect(result.current).toEqual([]);
  });

  it('shows the same failure once, and at most three', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFailures());
    act(() => {
      reportFailure('Follow bob', new Error('x'));
      reportFailure('Follow bob', new Error('x'));
    });
    expect(result.current).toHaveLength(1);
    act(() => {
      for (const who of ['a', 'b', 'c', 'd']) reportFailure(`Follow ${who}`, new Error('x'));
    });
    expect(result.current).toHaveLength(3);
    act(() => { for (const f of result.current) dismissFailure(f.id); });
    expect(result.current).toEqual([]);
  });
});

describe('readUntilAnswered', () => {
  it('asks again until the engine answers, then stops', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = {
      request: () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('busy')) : Promise.resolve({ ok: 1 });
      },
    } as unknown as SidecarClient;
    const got: unknown[] = [];
    readUntilAnswered(client, 'settings.get', undefined, (v) => got.push(v), 1000);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(got).toEqual([{ ok: 1 }]);
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
    expect(calls).toBe(3);
  });
});
