/*
 * Seek — chat.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Rooms on the left, transcript on the right, composer pinned to the bottom.
 * Deliberately plain: this is a utility panel inside a music tool, not a
 * messaging app, and giving it bubbles and avatars would make it shout louder
 * than the search results it sits beside.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatScope, ChatSession } from '../data/chatStore.ts';
import { IconUsers } from '../icons/index.tsx';

function clock(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
}

export function ChatView({
  chat, signedIn, scope,
}: {
  chat: ChatSession;
  signedIn: boolean;
  /** Rooms and private messages are different places, not one list with a
   *  prefix character. A room is ambient; a DM is addressed to you. */
  scope: ChatScope;
}) {
  const [newTarget, setNewTarget] = useState('');
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const scoped = chat.conversations.filter((c) => c.scope === scope);
  const conv = chat.conversations.find(
    (c) => c.scope === scope && `${c.scope}:${c.target}` === chat.active,
  ) ?? null;

  /* Only autoscroll when already at the bottom. Yanking someone back down
   * while they are reading scrollback is the classic chat annoyance. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [conv?.target]);

  useEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [conv?.messages.length]);

  const visibleRooms = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? chat.rooms.filter((r) => r.name.toLowerCase().includes(q)) : chat.rooms;
    // Joined first, then by population — an empty room is rarely what you want.
    return [...list].sort((a, b) =>
      Number(b.joined) - Number(a.joined) || b.userCount - a.userCount,
    ).slice(0, 200);
  }, [chat.rooms, filter]);

  if (!signedIn) {
    return (
      <div className="chat chat--empty">
        <IconUsers size={28} painted={1.3} className="empty__icon" />
        <p className="empty__title">Chat needs a Soulseek connection</p>
        <p className="empty__body">
          Sign in from Settings, then rooms and messages appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="chat">
      <aside className="chat__rail">
        <input
          className="chat__filter"
          value={filter}
          placeholder="Find a room"
          aria-label="Filter rooms"
          onChange={(e) => setFilter(e.target.value)}
        />

        {scoped.length > 0 && (
          <>
            <h3 className="chat__heading">Open</h3>
            <ul className="chat__list">
              {scoped.map((c) => {
                const k = `${c.scope}:${c.target}`;
                return (
                  <li key={k}>
                    <button
                      type="button"
                      className="chat__item pressable"
                      data-active={chat.active === k ? 'true' : undefined}
                      onPointerDown={() => chat.setActive(k)}
                    >
                      <span className="chat__name">
                        {c.scope === 'private' ? '@' : '#'}{c.target}
                      </span>
                      {c.unread > 0 && (
                        <span className="chat__unread tnum">{c.unread}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <h3 className="chat__heading">Rooms</h3>
        <ul className="chat__list">
          {scope === 'private' && (
            <form
              className="chat__new"
              onSubmit={(e) => {
                e.preventDefault();
                const who = newTarget.trim();
                if (!who) return;
                chat.openPrivate(who);
                setNewTarget('');
              }}
            >
              <input
                className="settings__input"
                value={newTarget}
                placeholder="Message a user…"
                aria-label="Username to message"
                spellCheck={false}
                autoCapitalize="none"
                onChange={(e) => setNewTarget(e.target.value)}
              />
            </form>
          )}
          {scope === 'room' && visibleRooms.map((r) => (
            <li key={r.name}>
              <button
                type="button"
                className="chat__item pressable"
                data-joined={r.joined ? 'true' : undefined}
                onPointerDown={() => (r.joined
                  ? chat.setActive(`room:${r.name}`)
                  : chat.join(r.name))}
              >
                <span className="chat__name">#{r.name}</span>
                <span className="chat__count tnum">{r.userCount}</span>
              </button>
            </li>
          ))}
          {scope === 'room' && visibleRooms.length === 0 && (
            <li className="chat__none">
              {chat.rooms.length === 0 ? 'Loading rooms…' : 'No room matches.'}
            </li>
          )}
        </ul>
      </aside>

      <section className="chat__main">
        {!conv ? (
          <div className="chat--empty">
            <p className="empty__title">No conversation open</p>
            <p className="empty__body">Pick a room on the left to join it.</p>
          </div>
        ) : (
          <>
            <header className="chat__head">
              <h2 className="chat__title">
                {conv.scope === 'private' ? '@' : '#'}{conv.target}
              </h2>
              {conv.scope === 'room' && (
                <>
                  <span className="chat__members tnum">
                    {conv.members.length} here
                  </span>
                  <button
                    type="button"
                    className="btn pressable"
                    onPointerDown={() => chat.leave(conv.target)}
                  >
                    Leave
                  </button>
                </>
              )}
            </header>

            <div className="chat__scroll" ref={scrollRef}>
              {conv.messages.length === 0 && (
                <p className="chat__none">Nothing said yet.</p>
              )}
              {conv.messages.map((m, i) => (
                <div
                  key={`${m.timestamp}-${m.username}-${i}`}
                  className="chat__line"
                  data-outgoing={m.outgoing ? 'true' : undefined}
                  data-mentioned={m.mentioned ? 'true' : undefined}
                  data-kind={m.kind}
                >
                  <span className="chat__time tnum">{clock(m.timestamp)}</span>
                  <span className="chat__who">{m.username}</span>
                  <span className="chat__text">{m.message}</span>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <form
              className="chat__composer"
              onSubmit={(e) => {
                e.preventDefault();
                chat.send(draft);
                setDraft('');
              }}
            >
              <input
                className="chat__input"
                value={draft}
                placeholder={`Message ${conv.scope === 'private' ? '' : '#'}${conv.target}`}
                aria-label={`Message ${conv.target}`}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="btn btn--primary pressable" disabled={!draft.trim()}>
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
