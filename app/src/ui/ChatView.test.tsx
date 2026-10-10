// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The chat composer. One ChatView serves rooms AND private chats and is never
 * remounted between them, so a single draft used to follow you from a room into
 * a private conversation and go to the wrong person; and the box was cleared
 * before the send result came back, so a failed send lost the text.
 */

import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ChatView } from './ChatView.tsx';
import type { ChatScope, ChatSession, Conversation } from '../data/chatStore.ts';

afterEach(cleanup);
// jsdom has no layout, so no scrollIntoView; the view calls it to follow new lines.
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

const conv = (scope: ChatScope, target: string): Conversation => ({
  scope, target, messages: [], members: [], unread: 0,
});

function session(active: string, send: ChatSession['send'] = () => Promise.resolve()) {
  return {
    rooms: [],
    conversations: [conv('room', 'techno'), conv('private', 'bob')],
    active,
    setActive: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    openPrivate: vi.fn(),
    send: vi.fn(send),
    refreshRooms: vi.fn(),
    available: true,
  } satisfies ChatSession;
}

function view(chat: ChatSession, scope: ChatScope) {
  return (
    <StrictMode>
      <ChatView chat={chat} signedIn scope={scope} />
    </StrictMode>
  );
}

const box = (c: HTMLElement) => c.querySelector<HTMLInputElement>('.chat__input')!;

describe('the composer', () => {
  it('keeps one draft per conversation', () => {
    const room = session('room:techno');
    const { container, rerender } = render(view(room, 'room'));
    fireEvent.change(box(container), { target: { value: 'half a thought about' } });

    // Right-click → Message bob: same component, different conversation.
    rerender(view(session('private:bob'), 'private'));
    expect(box(container).value).toBe('');

    rerender(view(room, 'room'));
    expect(box(container).value).toBe('half a thought about');
  });

  it('clears the box only once the line was taken', async () => {
    const chat = session('private:bob');
    const { container } = render(view(chat, 'private'));
    fireEvent.change(box(container), { target: { value: 'see you there' } });
    await act(async () => { fireEvent.submit(box(container).form!); });
    expect(chat.send).toHaveBeenCalledWith('see you there');
    expect(box(container).value).toBe('');
  });

  it('keeps the text and says why when sending fails', async () => {
    const chat = session('private:bob', () => Promise.reject(new Error('not_connected: not connected to the Soulseek server')));
    const { container, getByRole } = render(view(chat, 'private'));
    fireEvent.change(box(container), { target: { value: 'a long message worth keeping' } });
    await act(async () => { fireEvent.submit(box(container).form!); });

    expect(box(container).value).toBe('a long message worth keeping');
    expect(getByRole('alert').textContent).toMatch(/not connected to the Soulseek server/);
  });
});

describe('Leave', () => {
  it('acts on click, never on a press or right-click', () => {
    const chat = session('room:techno');
    const { getByRole } = render(view(chat, 'room'));
    const leave = getByRole('button', { name: 'Leave' });
    fireEvent.pointerDown(leave, { button: 2 });
    fireEvent.pointerDown(leave);
    expect(chat.leave).not.toHaveBeenCalled();
    fireEvent.click(leave);
    expect(chat.leave).toHaveBeenCalledWith('techno');
  });
});

describe('history', () => {
  it('shows earlier lines from the log, marked off from this session', () => {
    const chat = session('private:bob');
    chat.conversations[1] = {
      ...chat.conversations[1],
      history: [{ stamp: '09/21/26 17:10', username: 'bob', message: 'still got the test press?' }],
    };
    const { getByText, queryByText } = render(view(chat, 'private'));
    expect(getByText('still got the test press?')).toBeTruthy();
    expect(getByText('Earlier messages above')).toBeTruthy();
    expect(queryByText('Nothing said yet.')).toBeNull();
  });
});
