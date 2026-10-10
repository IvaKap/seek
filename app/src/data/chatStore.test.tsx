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

  it('keeps the room list current from comings, goings and status changes', () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const { result } = renderHook(() => useChatSession(client, true));
    act(() => {
      emit('chat.members', { room: 'techno', members: [
        { username: 'ana', status: 'online', files: 10 },
        { username: 'bo', status: 'online', files: null },
      ] });
      emit('chat.member', { room: 'techno', present: true, member: { username: 'cy', status: 'away', files: 3 } });
      emit('chat.member', { room: 'techno', present: false, member: { username: 'ana', status: 'online', files: 10 } });
      emit('user.status', { username: 'bo', status: 'away' });
    });
    act(() => { vi.advanceTimersByTime(200); });
    const members = result.current.conversations[0].members;
    expect(members.map((m) => `${m.username}:${m.status}`)).toEqual(['bo:away', 'cy:away']);
  });

  it('counts mentions apart from the rest', () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const { result } = renderHook(() => useChatSession(client, true));
    act(() => {
      emit('chat.message', line({ message: 'hey me', mentioned: true }));
      emit('chat.message', line({ message: 'small talk' }));
    });
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current.conversations[0].unread).toBe(2);
    expect(result.current.conversations[0].mentions).toBe(1);
  });

  it('a refused join says so and leaves no empty room behind', () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const { result } = renderHook(() => useChatSession(client, true));
    act(() => { result.current.join('closed-room'); });
    expect(result.current.conversations[0].joining).toBe(true);
    act(() => {
      emit('chat.message', line({ target: 'closed-room', username: 'server', message: 'The room is private' }));
    });
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current.conversations).toHaveLength(0);
  });
});
