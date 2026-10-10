// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Notifications beyond downloads: a private message, your name in a room, a
 * wish with something new. Only for what arrives after launch, and only once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const sent: { title: string; body: string }[] = [];
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: { title: string; body: string }) => { sent.push(n); },
}));

const { useChatNotifications, useWishNotifications } = await import('./notify.ts');
import type { ChatMessage, Conversation } from './chatStore.ts';
import type { WishHit } from './wishHits.ts';

afterEach(() => { cleanup(); sent.length = 0; });

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  scope: 'private', target: 'bob', username: 'bob', message: 'hi', outgoing: false,
  kind: 'message', mentioned: false, timestamp: 1, ...over,
});
const conv = (scope: 'private' | 'room', target: string, messages: ChatMessage[]): Conversation => ({
  scope, target, messages, members: [], unread: 0, mentions: 0,
});

describe('useChatNotifications', () => {
  it('announces a new private message, not the ones already there', async () => {
    const old = msg({ message: 'from before launch' });
    const { rerender } = renderHook(
      ({ convs }) => useChatNotifications(convs, null),
      { initialProps: { convs: [conv('private', 'bob', [old])] } },
    );
    rerender({ convs: [conv('private', 'bob', [old, msg({ message: 'still got the test press?' })])] });
    await waitFor(() => expect(sent).toEqual([{ title: 'bob', body: 'still got the test press?' }]));
  });

  it('announces a room line only when it names you', async () => {
    const { rerender } = renderHook(
      ({ convs }) => useChatNotifications(convs, null),
      { initialProps: { convs: [conv('room', 'techno', [])] } },
    );
    rerender({ convs: [conv('room', 'techno', [msg({ scope: 'room', target: 'techno', message: 'small talk' })])] });
    rerender({
      convs: [conv('room', 'techno', [
        msg({ scope: 'room', target: 'techno', message: 'small talk' }),
        msg({ scope: 'room', target: 'techno', username: 'alice', message: 'iva, got it?', mentioned: true }),
      ])],
    });
    await waitFor(() => expect(sent).toEqual([{ title: '#techno — alice', body: 'iva, got it?' }]));
  });

  it('never announces your own lines', async () => {
    const { rerender } = renderHook(
      ({ convs }) => useChatNotifications(convs, null),
      { initialProps: { convs: [conv('private', 'bob', [])] } },
    );
    rerender({ convs: [conv('private', 'bob', [msg({ outgoing: true, username: 'me' })])] });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
  });
});

describe('useWishNotifications', () => {
  const hit = (unseen: boolean, fresh = 3): WishHit => ({
    query: 'drexciya', sources: [], fresh: Array(fresh).fill({}), releases: [],
    peerCount: 2, seenCount: 0, foundAt: 1, unseen,
  } as unknown as WishHit);

  it('announces a wish once when it finds something new, until you look', async () => {
    const { rerender } = renderHook(
      ({ byQuery }) => useWishNotifications(byQuery),
      { initialProps: { byQuery: { drexciya: hit(false) } as Record<string, WishHit> } },
    );
    rerender({ byQuery: { drexciya: hit(true) } });
    rerender({ byQuery: { drexciya: hit(true, 5) } });   // more in the same run
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toBe('drexciya — 3 new files from 2 people');
  });
});
