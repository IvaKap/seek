// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Chat lines are applied in batches. The store lives at the top of the app,
 * and applying each line as it arrived redrew every screen per line in a busy
 * room. Nothing may be lost or miscounted by the batching.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChatSession } from './chatStore.ts';
import type { ChatMessage } from './chatStore.ts';
import type { SidecarClient } from './sidecarClient.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function fakeClient() {
  const handlers = new Map<string, (d: unknown) => void>();
  const client = {
    on(name: string, fn: (d: unknown) => void) { handlers.set(name, fn); return () => handlers.delete(name); },
    request: () => Promise.resolve({ lines: [] }),
  } as unknown as SidecarClient;
  return { client, emit: (name: string, d: unknown) => handlers.get(name)?.(d) };
}

const line = (over: Partial<ChatMessage>): ChatMessage => ({
  scope: 'room', target: 'techno', username: 'alice', message: 'x', outgoing: false,
  kind: 'message', mentioned: false, timestamp: 1, ...over,
});

describe('useChatSession', () => {
  it('applies a burst of lines together, losing none and counting right', () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const { result } = renderHook(() => useChatSession(client, true));

    act(() => {
      for (let i = 0; i < 5; i += 1) emit('chat.message', line({ message: `line ${i}` }));
      emit('chat.message', line({ username: 'me', message: 'mine', outgoing: true }));
    });
    expect(result.current.conversations).toHaveLength(0);   // not yet applied

    act(() => { vi.advanceTimersByTime(200); });
    const conv = result.current.conversations[0];
    expect(conv.messages.map((m) => m.message)).toEqual([
      'line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'mine',
    ]);
    expect(conv.unread).toBe(5);                                // your own line is not unread
  });
});
