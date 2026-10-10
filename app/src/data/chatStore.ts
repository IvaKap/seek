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
import { readUntilAnswered, reportFailure } from './failures.ts';

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

/** A room or a person, with its backlog. */
export interface Conversation {
  scope: ChatScope;
  target: string;
  messages: ChatMessage[];
  members: string[];
  unread: number;
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
        const scope = next.slice(0, sep) as ChatScope;
        const target = next.slice(sep + 1);
        const out = new Map(prev);
        out.set(next, { scope, target, messages: [], members: [], unread: 0 });
        return out;
      }
      if (conv.unread === 0) return prev;
      const out = new Map(prev);
      out.set(next, { ...conv, unread: 0 });
      return out;
    });
  }, []);

  useEffect(() => {
    if (!client) return;

    /* Batched, like transfers. This state lives at the top of the app, and a
       busy room sends several lines a second: applying each as it came copied
       the backlog and redrew every screen per line. Lines now land together,
       at most every FLUSH_MS — still instant to read. */
    let pending: ChatMessage[] = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      setMap((prev) => {
        const out = new Map(prev);
        for (const m of batch) {
          const k = key(m.scope, m.target);
          const conv = out.get(k) ?? {
            scope: m.scope, target: m.target, messages: [], members: [], unread: 0,
          };
          const messages = [...conv.messages, m];
          out.set(k, {
            ...conv,
            messages: messages.length > MAX_BACKLOG
              ? messages.slice(messages.length - MAX_BACKLOG)
              : messages,
            // Our own echoed messages must never mark a conversation unread.
            unread: m.outgoing ? conv.unread : conv.unread + 1,
          });
        }
        return out;
      });
    };
    const offMessage = client.on('chat.message', (data) => {
      pending.push(data as ChatMessage);
      if (!timer) timer = window.setTimeout(flush, FLUSH_MS);
    });

    const offRooms = client.on('chat.rooms', (data) => {
      setRooms((data as { rooms: ChatRoom[] }).rooms ?? []);
    });

    const offMembers = client.on('chat.members', (data) => {
      const d = data as { room: string; users: string[] };
      const k = key('room', d.room);
      setMap((prev) => {
        const out = new Map(prev);
        const conv = out.get(k) ?? {
          scope: 'room' as const, target: d.room, messages: [], members: [], unread: 0,
        };
        out.set(k, { ...conv, members: d.users });
        return out;
      });
    });

    return () => {
      offMessage(); offRooms(); offMembers();
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
      out.set(active, { ...conv, unread: 0 });
      return out;
    });
  }, [active, map.get(active ?? '')?.messages.length]);

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

  const refreshRooms = useCallback(() => {
    if (!available) return;
    void client?.request('chat.rooms').catch(() => {});
  }, [client, available]);

  // On sign-in, asked until answered: one failed request left the rail on
  // "Loading rooms…" for good, with no error and no way to ask again.
  useEffect(() => {
    if (!client || !available) return undefined;
    return readUntilAnswered(client, 'chat.rooms', undefined, () => {});
  }, [client, available]);

  const join = useCallback((room: string) => {
    if (!available) return;
    void client?.request('chat.join', { room })
      .catch((e) => reportFailure(`Join #${room}`, e));
    setActive(key('room', room));
  }, [client, available, setActive]);

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
    if (!available) return;
    void client?.request('chat.open', { username })
      .catch((e) => reportFailure(`Message ${username}`, e));
    setMap((prev) => {
      if (prev.has(key('private', username))) return prev;
      const out = new Map(prev);
      out.set(key('private', username), {
        scope: 'private', target: username, messages: [], members: [], unread: 0,
      });
      return out;
    });
    setActive(key('private', username));
  }, [client, available, setActive]);

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
    join, leave, openPrivate, send, refreshRooms, available,
  };
}
