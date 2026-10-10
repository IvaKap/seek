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
import type { ChatMember, ChatScope, ChatSession } from '../data/chatStore.ts';
import { IconUsers } from '../icons/index.tsx';
import { readableError } from '../domain/folders.ts';

function clock(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
}

/** The room list shows this many; the rest are a filter away. */
const ROOM_LIST_CAP = 200;

const STATUS_RANK: Record<ChatMember['status'], number> = { online: 0, away: 1, offline: 2 };

/** A badge that stays a badge: past 99 the number stops informing. */
const badge = (n: number) => (n > 99 ? '99+' : String(n));

export function ChatView({
  chat, signedIn, scope, onUserMenu, self = null, buddies,
}: {
  chat: ChatSession;
  signedIn: boolean;
  /** Rooms and private messages are different places, not one list with a
   *  prefix character. A room is ambient; a DM is addressed to you. */
  scope: ChatScope;
  /** What you can do about the person named on a line or in the member list. */
  onUserMenu?(username: string, x: number, y: number): void;
  /** Our own username, which gets no menu. */
  self?: string | null;
  buddies?: ReadonlySet<string>;
}) {
  const [newTarget, setNewTarget] = useState('');
  const [filter, setFilter] = useState('');
  /* One draft per conversation. This component serves rooms AND private chats
     and is never remounted between them, so a single draft followed you: half
     a line typed in a room, then Message on someone, then Return, sent it to
     them privately. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Conversations with a line on its way, so Return cannot send it twice. */
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<{ key: string; why: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showMembers, setShowMembers] = useState(false);
  /** The conversation whose Leave is waiting for a second click. */
  const [confirmLeave, setConfirmLeave] = useState<string | null>(null);

  const scoped = chat.conversations.filter((c) => c.scope === scope);
  const conv = chat.conversations.find(
    (c) => c.scope === scope && `${c.scope}:${c.target}` === chat.active,
  ) ?? null;
  const convKey = conv ? `${conv.scope}:${conv.target}` : '';
  const draft = drafts[convKey] ?? '';
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [convKey]: text }));

  /* The box is cleared only once the engine has taken the line. It used to be
     cleared first, with the failure swallowed, so a long message typed during
     a hiccup was simply gone. */
  const submit = () => {
    const key = convKey;
    const text = draft;
    if (!key || !text.trim() || sending.has(key)) return;
    setFailed(null);
    setSending((s) => new Set(s).add(key));
    chat.send(text)
      // Only what was sent is removed: anything typed while it was on its way
      // stays, and the sent part cannot go a second time.
      .then(() => setDrafts((d) => {
        const now = d[key] ?? '';
        return { ...d, [key]: now.startsWith(text) ? now.slice(text.length).trimStart() : now };
      }))
      .catch((e) => setFailed({ key, why: readableError(e) }))
      .finally(() => setSending((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      }));
  };

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

  // The array, not its length: past the backlog cap the length stays at 500
  // and new lines stopped being followed.
  useEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [conv?.messages, conv?.history?.length]);

  /* A different conversation opens at its newest line. One scroll box serves
     them all, so the last one's position used to carry over. */
  useEffect(() => {
    pinned.current = true;
    endRef.current?.scrollIntoView({ block: 'end' });
    setConfirmLeave(null);
  }, [convKey]);

  const { visibleRooms, matchingRooms } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? chat.rooms.filter((r) => r.name.toLowerCase().includes(q)) : chat.rooms;
    // Joined first, then by population — an empty room is rarely what you want.
    const sorted = [...list].sort((a, b) =>
      Number(b.joined) - Number(a.joined) || b.userCount - a.userCount,
    );
    // ponytail: capped render, not a virtual list; the full browser is F14.
    return { visibleRooms: sorted.slice(0, ROOM_LIST_CAP), matchingRooms: sorted.length };
  }, [chat.rooms, filter]);

  const members = useMemo(() => (conv?.members ?? []).slice().sort((a, b) => (
    STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || Number(buddies?.has(b.username) ?? false) - Number(buddies?.has(a.username) ?? false)
    || a.username.localeCompare(b.username)
  )), [conv?.members, buddies]);

  /** A name that opens the person's menu, or plain text where there is no one
   *  to act on: our own lines, the server's, and command replies. */
  const who = (name: string, outgoing = false) => {
    if (!onUserMenu || !name || name === 'server' || outgoing || name === self) {
      return <span className="chat__who">{name}</span>;
    }
    return (
      <button
        type="button"
        className="chat__who chat__who--link"
        // Anchored to the name, so a keyboard click (no pointer position)
        // opens the menu beside it rather than at the window's corner.
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onUserMenu(name, r.left, r.bottom); }}
      >
        {name}
      </button>
    );
  };

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
            <h3 className="chat__heading">
              Open
              {scope === 'private' && scoped.length > 1 && (
                <button
                  type="button"
                  className="chat__headbtn"
                  title="Close every private chat. Anyone who writes again opens theirs."
                  onClick={chat.closeAllPrivate}
                >
                  Close all
                </button>
              )}
            </h3>
            <ul className="chat__list">
              {scoped.map((c) => {
                const k = `${c.scope}:${c.target}`;
                return (
                  <li key={k}>
                    <button
                      type="button"
                      className="chat__item pressable"
                      data-active={chat.active === k ? 'true' : undefined}
                      onClick={() => chat.setActive(k)}
                    >
                      <span className="chat__name">
                        {c.scope === 'private' ? '@' : '#'}{c.target}
                      </span>
                      {c.unread > 0 && (
                        <span
                          className="chat__unread tnum"
                          data-mention={c.mentions > 0 ? 'true' : undefined}
                          title={c.mentions > 0 ? `${c.mentions} mention you` : undefined}
                        >
                          {badge(c.mentions > 0 ? c.mentions : c.unread)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <h3 className="chat__heading">{scope === 'private' ? 'New message' : 'Rooms'}</h3>
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
                onClick={() => (r.joined
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
          {scope === 'room' && matchingRooms > visibleRooms.length && (
            <li className="chat__none tnum">
              Showing {visibleRooms.length} of {matchingRooms}. Type to narrow it down.
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
            {/* Chat has no pane header, so this is the top edge you grab. */}
            <header className="chat__head" data-tauri-drag-region="deep">
              <h2 className="chat__title">
                {conv.scope === 'private' ? '@' : '#'}{conv.target}
              </h2>
              {conv.scope === 'room' && conv.joining && (
                <span className="chat__members">Joining…</span>
              )}
              {conv.scope === 'room' && !conv.joining && (
                <>
                  <button
                    type="button"
                    className="chat__members chat__members--btn tnum"
                    aria-expanded={showMembers}
                    onClick={() => setShowMembers((v) => !v)}
                  >
                    {conv.members.length} here
                  </button>
                  <button
                    type="button"
                    className="btn pressable"
                    data-confirm={confirmLeave === convKey ? 'true' : undefined}
                    title="Leaving also stops Seek rejoining this room at launch."
                    // Click, not pointer-down, so a right-click never leaves.
                    // With lines on screen it asks once: leaving drops them.
                    onClick={() => {
                      if (conv.messages.length > 0 && confirmLeave !== convKey) {
                        setConfirmLeave(convKey);
                        return;
                      }
                      setConfirmLeave(null);
                      chat.leave(conv.target);
                    }}
                  >
                    {confirmLeave === convKey ? 'Leave and clear?' : 'Leave'}
                  </button>
                </>
              )}
              {conv.scope === 'private' && (
                <button
                  type="button"
                  className="btn pressable"
                  title="Close this chat. If they write again, it opens again with its history."
                  onClick={() => chat.closePrivate(conv.target)}
                >
                  Close
                </button>
              )}
            </header>

            <div className="chat__body">
            <div className="chat__scroll" ref={scrollRef} key={convKey}>
              {/* What was said before this session, from the engine's log —
                  dimmed, and closed off by a rule, so it never reads as new. */}
              {(conv.history ?? []).map((h, i) => (
                <div key={`h${i}`} className="chat__line chat__line--history">
                  <span className="chat__time tnum">{h.stamp}</span>
                  {h.username && who(h.username)}
                  <span className="chat__text">{h.message}</span>
                </div>
              ))}
              {(conv.history ?? []).length > 0 && (
                <p className="chat__divider">Earlier messages above</p>
              )}
              {conv.messages.length === 0 && (conv.history ?? []).length === 0 && (
                <p className="chat__none">
                  {conv.joining ? `Joining #${conv.target}…` : 'Nothing said yet.'}
                </p>
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
                  {who(m.username, m.outgoing)}
                  <span className="chat__text">{m.message}</span>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            {conv.scope === 'room' && showMembers && !conv.joining && (
              <ul className="chat__people" aria-label={`People in #${conv.target}`}>
                {members.map((p) => (
                  <li key={p.username} className="chat__person" data-status={p.status}>
                    <span className="chat__dot" aria-label={p.status} />
                    {who(p.username)}
                    {buddies?.has(p.username) && <span className="chat__buddy" title="You follow them">★</span>}
                    {p.files !== null && (
                      <span className="chat__files tnum" title={`${p.files} files shared`}>
                        {p.files.toLocaleString()}
                      </span>
                    )}
                  </li>
                ))}
                {members.length === 0 && <li className="chat__none">Nobody here yet.</li>}
              </ul>
            )}
            </div>

            <form
              className="chat__composer"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                className="chat__input"
                value={draft}
                placeholder={`Message ${conv.scope === 'private' ? '' : '#'}${conv.target}`}
                aria-label={`Message ${conv.target}`}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn--primary pressable"
                disabled={!draft.trim() || sending.has(convKey)}
              >
                Send
              </button>
            </form>
            {failed && failed.key === convKey && (
              <p className="chat__failed" role="alert">
                Not sent — {failed.why} Your message is still in the box.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
