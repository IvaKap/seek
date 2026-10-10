/*
 * Seek — chat state.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Rooms and private messages share one conversation model, because from the
 * UI's point of view they differ only in how you address them. The sidecar
 * echoes our own sent messages back as ordinary `chat.message` events with
 * `outgoing: true`, so there is a single ingest path and no optimistic-append
 * bookkeeping to get out of sync with the server.
 *
 * Soulseek carries no message ids for room chat. Keys are derived from
 * (target, timestamp, sender, text) — good enough to be stable across renders,
 * and duplicates of an identical line in the same second are indistinguishable
 * on the wire anyway.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { parseLogLine, withoutLive } from '../domain/chatHistory.ts';
import type { HistoryLine } from '../domain/chatHistory.ts';
import { reportFailure, showNotice } from './failures.ts';
import { readableError } from '../domain/folders.ts';

export type ChatScope = 'room' | 'private';

export interface ChatMessage {
  scope: ChatScope;
  target: string;
  username: string;
  message: string;
  outgoing: boolean;
  kind: 'message' | 'action' | 'local' | 'hilite';
  mentioned: boolean;
  timestamp: number;
}

export interface ChatRoom {
  name: string;
  userCount: number;
  joined: boolean;
  private: boolean;
}

export type MemberStatus = 'online' | 'away' | 'offline';

/** Someone in a room, as the server described them. */
export interface ChatMember {
  username: string;
  status: MemberStatus;
  /** Files they share, or null when unknown. */
  files: number | null;
}

/** A room or a person, with its backlog. */
export interface Conversation {
  scope: ChatScope;
  target: string;
  messages: ChatMessage[];
  members: ChatMember[];
  unread: number;
  /** Lines that name you, a subset of `unread`. */
  mentions: number;
  /** A room asked to join that the server has not answered yet. */
  joining?: boolean;
  /** Earlier lines from the engine's chat log, oldest first. Undefined until
   * the conversation has been opened once this session and its log read. */
  history?: HistoryLine[];
}

export interface ChatSession {
  rooms: ChatRoom[];
  conversations: Conversation[];
  active: string | null;
  setActive(key: string | null): void;
  join(room: string): void;
  leave(room: string): void;
  openPrivate(username: string): void;
  /** Close a private conversation. Their next message opens it again. */
  closePrivate(username: string): void;
  closeAllPrivate(): void;
  /** Resolves once the engine has taken the line; rejects with why it did not. */
  send(text: string): Promise<void>;
  refreshRooms(): void;
  /** False when there is no sidecar, or it is not signed in. */
  available: boolean;
}

const key = (scope: ChatScope, target: string) => `${scope}:${target}`;

/** Bounded so a busy room cannot grow the heap without limit. */
const MAX_BACKLOG = 500;

/** How long incoming lines wait to be applied together. */
const FLUSH_MS = 150;

/** How long the server gets to answer a join before it counts as refused. */
const JOIN_WAIT_MS = 15_000;

const blank = (scope: ChatScope, target: string): Conversation => ({
  scope, target, messages: [], members: [], unread: 0, mentions: 0,
});

export function useChatSession(
  client: SidecarClient | null,
  signedIn: boolean,
): ChatSession {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [map, setMap] = useState<Map<string, Conversation>>(() => new Map());
  const [active, setActiveRaw] = useState<string | null>(null);

  const setActive = useCallback((next: string | null) => {
    setActiveRaw(next);
    if (!next) return;
    setMap((prev) => {
      const conv = prev.get(next);
      // Create it if it does not exist yet. Conversations were only born when a
      // message arrived, so selecting a quiet room pointed `active` at nothing
      // and the pane fell through to "pick a room" — which is why clicking a
      // room appeared to do nothing at all. An empty room is a real place.
      if (!conv) {
        const sep = next.indexOf(':');
        const out = new Map(prev);
        out.set(next, blank(next.slice(0, sep) as ChatScope, next.slice(sep + 1)));
        return out;
      }
      if (conv.unread === 0) return prev;
      const out = new Map(prev);
      out.set(next, { ...conv, unread: 0, mentions: 0 });
      return out;
    });
  }, []);

  /* Rooms asked to join that the server has not answered yet, and their
     give-up timers. Refs, so the event handlers below and `join` share them. */
  const joiningRooms = useRef(new Set<string>());
  const joinTimers = useRef(new Map<string, number>());
  /** Stop waiting for a join: forget the room here AND in the engine, which
   *  put it in its joined rooms and autojoin before the server answered. */
  const giveUpJoin = useRef<(room: string, why: string) => void>(() => {});
  giveUpJoin.current = (room, why) => {
    if (!joiningRooms.current.delete(room)) return;
    window.clearTimeout(joinTimers.current.get(room));
    joinTimers.current.delete(room);
    reportFailure(`Join #${room}`, new Error(why));
    void client?.request('chat.leave', { room }).catch(() => {});
    setMap((prev) => {
      const out = new Map(prev);
      out.delete(key('room', room));
      return out;
    });
  };
  useEffect(() => () => { for (const t of joinTimers.current.values()) window.clearTimeout(t); }, []);

  useEffect(() => {
    if (!client) return;

    /* Batched, like transfers. This state lives at the top of the app, and a
       busy room sends several lines a second: applying each as it came copied
       the backlog and redrew every screen per line. Lines now land together,
       at most every FLUSH_MS — still instant to read. */
    let pending: ChatMessage[] = [];
    /* Status changes for people in rooms, batched with the lines: a room of a
       thousand people is a steady trickle of these. */
    let statuses = new Map<string, MemberStatus>();
    let timer = 0;
    const flush = () => {
      timer = 0;
      const batch = pending;
      const changed = statuses;
      pending = [];
      statuses = new Map();
      if (batch.length === 0 && changed.size === 0) return;
      setMap((prev) => {
        // Statuses alone change nothing on screen unless a listed member's
        // did: returning `prev` then spares the whole app a render.
        let touched = batch.length > 0;
        const out = new Map(prev);
        for (const m of batch) {
          const k = key(m.scope, m.target);
          const conv = out.get(k) ?? blank(m.scope, m.target);
          const messages = [...conv.messages, m];
          out.set(k, {
            ...conv,
            messages: messages.length > MAX_BACKLOG
              ? messages.slice(messages.length - MAX_BACKLOG)
              : messages,
            // Our own echoed messages must never mark a conversation unread.
            unread: m.outgoing ? conv.unread : conv.unread + 1,
            mentions: m.mentioned && !m.outgoing ? conv.mentions + 1 : conv.mentions,
          });
        }
        if (changed.size > 0) {
          for (const [k, conv] of out) {
            if (conv.scope !== 'room') continue;
            if (!conv.members.some((p) => changed.has(p.username) && changed.get(p.username) !== p.status)) continue;
            touched = true;
            out.set(k, {
              ...conv,
              members: conv.members.map((p) => (changed.has(p.username)
                ? { ...p, status: changed.get(p.username)! } : p)),
            });
          }
        }
        return touched ? out : prev;
      });
    };
    const schedule = () => { if (!timer) timer = window.setTimeout(flush, FLUSH_MS); };
    const offMessage = client.on('chat.message', (data) => {
      const m = data as ChatMessage;
      // The server answers a refused join with a line of its own in that room
      // (privatechat.py), and nothing else ever says it failed.
      if (m.scope === 'room' && m.username === 'server' && joiningRooms.current.has(m.target)) {
        giveUpJoin.current(m.target, m.message);
        return;
      }
      pending.push(m);
      schedule();
    });
    const offStatus = client.on('user.status', (data) => {
      const d = data as { username: string; status: MemberStatus };
      statuses.set(d.username, d.status);
      schedule();
    });

    const offRooms = client.on('chat.rooms', (data) => {
      roomsArrived.current = true;
      setRooms((data as { rooms: ChatRoom[] }).rooms ?? []);
    });

    // The whole room once, when we join; then each coming and going.
    const offMembers = client.on('chat.members', (data) => {
      const d = data as { room: string; members: ChatMember[] };
      const k = key('room', d.room);
      joiningRooms.current.delete(d.room);
      window.clearTimeout(joinTimers.current.get(d.room));
      joinTimers.current.delete(d.room);
      setMap((prev) => {
        const out = new Map(prev);
        const conv = out.get(k) ?? blank('room', d.room);
        out.set(k, { ...conv, members: d.members, joining: false });
        return out;
      });
    });
    const offMember = client.on('chat.member', (data) => {
      const d = data as { room: string; member: ChatMember; present: boolean };
      const k = key('room', d.room);
      setMap((prev) => {
        const conv = prev.get(k);
        if (!conv) return prev;
        const others = conv.members.filter((p) => p.username !== d.member.username);
        const out = new Map(prev);
        out.set(k, { ...conv, members: d.present ? [...others, d.member] : others });
        return out;
      });
    });

    return () => {
      offMessage(); offStatus(); offRooms(); offMembers(); offMember();
      window.clearTimeout(timer);
    };
  }, [client]);

  // Clearing unread for whatever is on screen belongs here rather than in the
  // view, so switching rooms and receiving while focused behave the same.
  useEffect(() => {
    if (!active) return;
    setMap((prev) => {
      const conv = prev.get(active);
      if (!conv || conv.unread === 0) return prev;
      const out = new Map(prev);
      out.set(active, { ...conv, unread: 0, mentions: 0 });
      return out;
    });
    // The array, not its length: past MAX_BACKLOG the length stops changing,
    // and the open room's badge climbed while you read it.
  }, [active, map.get(active ?? '')?.messages]);

  // Read the log the first time a conversation is opened, so it starts with
  // what was said before rather than empty. Once per conversation per session:
  // the ref survives StrictMode's double effect and a re-render storm alike.
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!client || !active || asked.current.has(active)) return;
    const conv = map.get(active);
    if (!conv) return;
    asked.current.add(active);
    const k = active;
    void client.request<{ lines: string[] }>('chat.history', {
      scope: conv.scope, target: conv.target, limit: null,
    })
      .then((r) => {
        const parsed = (r.lines ?? []).map(parseLogLine);
        setMap((prev) => {
          const now = prev.get(k);
          if (!now) return prev;
          const out = new Map(prev);
          out.set(k, { ...now, history: withoutLive(parsed, now.messages) });
          return out;
        });
      })
      // Not worth a message: the conversation simply starts empty, as before.
      // Allowed to try again next time it is opened.
      .catch(() => { asked.current.delete(k); });
  }, [client, active, map]);

  const available = Boolean(client) && signedIn;

  /* Signed out, the member lists are stale: upstream empties its rooms on a
     disconnect and says nothing. Joined rooms rejoin on sign-in and resend. */
  useEffect(() => {
    if (available) return;
    setMap((prev) => {
      if (![...prev.values()].some((c) => c.members.length > 0)) return prev;
      const out = new Map(prev);
      for (const [k, c] of out) if (c.members.length > 0) out.set(k, { ...c, members: [] });
      return out;
    });
  }, [available]);

  const refreshRooms = useCallback(() => {
    if (!available) return;
    void client?.request('chat.rooms').catch(() => {});
  }, [client, available]);

  /* On sign-in, asked until the LIST arrives. The request is answered at once
     and the rooms come later as an event, so retrying on the answer alone
     left "Loading rooms…" up for good when that event never came. */
  const roomsArrived = useRef(false);
  useEffect(() => {
    if (!client || !available) return undefined;
    roomsArrived.current = false;
    let timer = 0;
    const ask = () => {
      if (roomsArrived.current) return;
      void client.request('chat.rooms').catch(() => {});
      timer = window.setTimeout(ask, 5000);
    };
    ask();
    return () => window.clearTimeout(timer);
  }, [client, available]);

  /* A join is not a join until the server sends the room. Until then the pane
     says "Joining…", and silence or a refusal says so. */
  const join = useCallback((room: string) => {
    if (!available) return;
    const k = key('room', room);
    setActiveRaw(k);
    setMap((prev) => {
      const out = new Map(prev);
      out.set(k, { ...(prev.get(k) ?? blank('room', room)), joining: true });
      return out;
    });
    joiningRooms.current.add(room);
    window.clearTimeout(joinTimers.current.get(room));
    joinTimers.current.set(room, window.setTimeout(
      () => giveUpJoin.current(room, 'the server did not answer'), JOIN_WAIT_MS,
    ));
    void client?.request('chat.join', { room })
      .catch((e) => giveUpJoin.current(room, readableError(e)));
  }, [client, available]);

  const leave = useCallback((room: string) => {
    // Rejoining starts a fresh conversation, so its log is read again.
    asked.current.delete(key('room', room));
    void client?.request('chat.leave', { room })
      .catch((e) => reportFailure(`Leave #${room}`, e));
    setMap((prev) => {
      const out = new Map(prev);
      out.delete(key('room', room));
      return out;
    });
    setActiveRaw((cur) => (cur === key('room', room) ? null : cur));
  }, [client]);

  const openPrivate = useCallback((username: string) => {
    if (!available) {
      showNotice('Sign in to Soulseek to message people.');
      return;
    }
    void client?.request('chat.open', { username })
      .catch((e) => reportFailure(`Message ${username}`, e));
    setMap((prev) => {
      if (prev.has(key('private', username))) return prev;
      const out = new Map(prev);
      out.set(key('private', username), blank('private', username));
      return out;
    });
    setActive(key('private', username));
  }, [client, available, setActive]);

  const dropPrivate = useCallback((usernames: string[]) => {
    const keys = new Set(usernames.map((u) => key('private', u)));
    for (const k of keys) asked.current.delete(k);
    setMap((prev) => {
      const out = new Map(prev);
      for (const k of keys) out.delete(k);
      return out;
    });
    setActiveRaw((cur) => (cur && keys.has(cur) ? null : cur));
  }, []);

  const closePrivate = useCallback((username: string) => {
    dropPrivate([username]);
    void client?.request('chat.close', { username })
      .catch((e) => reportFailure(`Close the chat with ${username}`, e));
  }, [client, dropPrivate]);

  const closeAllPrivate = useCallback(() => {
    dropPrivate([...map.values()].filter((c) => c.scope === 'private').map((c) => c.target));
    void client?.request('chat.closeAll')
      .catch((e) => reportFailure('Close all private chats', e));
  }, [client, map, dropPrivate]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // A REJECTION, not a quiet return: the composer keeps the text until this
    // settles, so a line that cannot go must say so rather than vanish.
    if (!client || !available) throw new Error('Not signed in to Soulseek.');
    const conv = active ? map.get(active) : undefined;
    if (!conv) throw new Error('No conversation is open.');
    // No optimistic append: the sidecar echoes it back with outgoing=true, and
    // one ingest path means the transcript cannot diverge from the server's.
    await client.request('chat.say', {
      // Typed by a person, so never the automatic form — that one prefixes
      // "[Automatic Message]". Sent as null rather than omitted: the schema's
      // Optional means nullable, not absent, and a missing key is rejected.
      scope: conv.scope, target: conv.target, message: trimmed, automatic: null,
    });
  }, [client, active, available, map]);

  const conversations = useMemo(
    () => [...map.values()].sort((a, b) => a.target.localeCompare(b.target)),
    [map],
  );

  return {
    rooms, conversations, active, setActive,
    join, leave, openPrivate, closePrivate, closeAllPrivate, send, refreshRooms, available,
  };
}
