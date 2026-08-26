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

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';

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
}

export interface ChatSession {
  rooms: ChatRoom[];
  conversations: Conversation[];
  active: string | null;
  setActive(key: string | null): void;
  join(room: string): void;
  leave(room: string): void;
  openPrivate(username: string): void;
  send(text: string): void;
  refreshRooms(): void;
  /** False when there is no sidecar, or it is not signed in. */
  available: boolean;
}

const key = (scope: ChatScope, target: string) => `${scope}:${target}`;

/** Bounded so a busy room cannot grow the heap without limit. */
const MAX_BACKLOG = 500;

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

    const offMessage = client.on('chat.message', (data) => {
      const m = data as ChatMessage;
      const k = key(m.scope, m.target);
      setMap((prev) => {
        const out = new Map(prev);
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
        return out;
      });
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

    return () => { offMessage(); offRooms(); offMembers(); };
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

  const available = Boolean(client) && signedIn;

  const refreshRooms = useCallback(() => {
    if (!available) return;
    void client?.request('chat.rooms').catch(() => {});
  }, [client, available]);

  useEffect(() => { refreshRooms(); }, [refreshRooms]);

  const join = useCallback((room: string) => {
    if (!available) return;
    void client?.request('chat.join', { room }).catch(() => {});
    setActive(key('room', room));
  }, [client, available, setActive]);

  const leave = useCallback((room: string) => {
    void client?.request('chat.leave', { room }).catch(() => {});
    setMap((prev) => {
      const out = new Map(prev);
      out.delete(key('room', room));
      return out;
    });
    setActiveRaw((cur) => (cur === key('room', room) ? null : cur));
  }, [client]);

  const openPrivate = useCallback((username: string) => {
    if (!available) return;
    void client?.request('chat.open', { username }).catch(() => {});
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

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !active || !available) return;
    const conv = map.get(active);
    if (!conv) return;
    // No optimistic append: the sidecar echoes it back with outgoing=true, and
    // one ingest path means the transcript cannot diverge from the server's.
    void client?.request('chat.say', {
      scope: conv.scope, target: conv.target, message: trimmed,
    }).catch(() => {});
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
