/*
 * Seek — digging sessions.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A session is a container for a binge: the twenty minutes on a Saturday night
 * where one Discogs label page turned into nine tabs. The sidecar decides WHEN
 * one exists — that is a fact about when entries were added — and everything
 * about how it READS is decided here.
 *
 * Including its name. An unnamed session is stored with `name: ""` and a
 * `createdAt`, and the words "Saturday · 11:42 PM" are produced below, in the
 * user's own locale. `DISCOVERY.md` had the sidecar generate that string;
 * building it there would have been Python formatting for display, which this
 * project does not do, and it would have hardcoded English and a 12-hour clock
 * for someone who may use neither.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { WantEntry, WantStatus } from './wantStore.ts';

export interface DigSession {
  id: string;
  /** Empty until renamed. Use `sessionName` rather than reading this. */
  name: string;
  createdAt: number;
  lastActiveAt: number;
  closed: boolean;
}

/** A session plus everything derived from the want list it groups. */
export interface SessionSummary extends DigSession {
  entries: WantEntry[];
  sources: WantEntry['sourceKind'][];
  counts: Record<WantStatus, number>;
}

export interface SessionsSession {
  sessions: SessionSummary[];
  create(name?: string): void;
  rename(id: string, name: string): void;
  close(id: string): void;
  remove(id: string): void;
  enabled: boolean;
}

const EMPTY_COUNTS: Record<WantStatus, number> = {
  pending: 0, searching: 0, found: 0, downloaded: 0, not_found: 0,
};

/**
 * What to call a session.
 *
 * A renamed session keeps its name forever. An unnamed one is described by
 * when it started, which is the only thing that distinguishes it — and today
 * and yesterday are said differently from last month, because "Saturday" is
 * useful for three days and ambiguous after that.
 */
export function sessionName(session: Pick<DigSession, 'name' | 'createdAt'>): string {
  if (session.name.trim()) return session.name;

  const when = new Date(session.createdAt * 1000);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((Date.now() - session.createdAt * 1000) / 86_400_000);

  if (days < 1) return `Today · ${time}`;
  if (days < 2) return `Yesterday · ${time}`;
  if (days < 7) {
    return `${when.toLocaleDateString(undefined, { weekday: 'long' })} · ${time}`;
  }
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${time}`;
}

export function useSessions(
  client: SidecarClient | null, entries: WantEntry[],
): SessionsSession {
  const [sessions, setSessions] = useState<DigSession[]>([]);

  useEffect(() => {
    if (!client) return;
    const off = client.on('session.changed', (data) => {
      setSessions((data as { sessions: DigSession[] }).sessions ?? []);
    });
    void client.request<{ sessions: DigSession[] }>('session.list')
      .then((r) => setSessions(r.sessions ?? []))
      .catch(() => {});
    return off;
  }, [client]);

  /* The aggregates the sidecar deliberately does not store. Recomputed from
   * the want list, which is the only copy — two places holding the same count
   * is two places for it to be wrong. */
  const summaries = useMemo<SessionSummary[]>(() => {
    const grouped = new Map<string, WantEntry[]>();
    for (const entry of entries) {
      if (!entry.sessionId) continue;
      const list = grouped.get(entry.sessionId);
      if (list) list.push(entry);
      else grouped.set(entry.sessionId, [entry]);
    }
    return sessions.map((session) => {
      const own = grouped.get(session.id) ?? [];
      const counts = { ...EMPTY_COUNTS };
      for (const entry of own) counts[entry.status] += 1;
      return {
        ...session,
        entries: own,
        sources: [...new Set(own.map((e) => e.sourceKind))],
        counts,
      };
    });
  }, [sessions, entries]);

  const send = useCallback((cmd: string, params: Record<string, unknown>) => {
    if (!client) return;
    void client.request<{ sessions: DigSession[] }>(cmd, params)
      .then((r) => setSessions(r.sessions ?? []))
      .catch(() => {});
  }, [client]);

  return {
    sessions: summaries,
    create: useCallback((name?: string) => send('session.create', { name: name ?? null }), [send]),
    rename: useCallback((id: string, name: string) => send('session.rename', { id, name }), [send]),
    close: useCallback((id: string) => send('session.close', { id }), [send]),
    remove: useCallback((id: string) => send('session.delete', { id }), [send]),
    enabled: Boolean(client),
  };
}
