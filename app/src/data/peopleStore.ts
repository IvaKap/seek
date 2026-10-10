/*
 * Seek — the people you have decided something about.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Buddies, the ignore list and the ban list, in one place, because every menu
 * that names a person offers all three: Follow or Unfollow, Ignore or Stop
 * ignoring, Ban or Lift ban. Each menu used to know only how to Follow, and
 * never whether you already did.
 *
 * The lists are upstream's own (`server.ignorelist`, `server.banlist`, the
 * buddy list), so a `/ignore` typed in chat changes them too; the engine says
 * so on `users.lists`, and this follows.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { readUntilAnswered, reportFailure } from './failures.ts';

interface UserLists { ignored: string[]; banned: string[] }

export interface People {
  buddies: ReadonlySet<string>;
  ignored: ReadonlySet<string>;
  banned: ReadonlySet<string>;
  follow(username: string, on: boolean): void;
  ignore(username: string, on: boolean): void;
  ban(username: string, on: boolean): void;
}

const EMPTY: ReadonlySet<string> = new Set();

export function usePeople(client: SidecarClient | null): People {
  const [buddies, setBuddies] = useState<ReadonlySet<string>>(EMPTY);
  const [lists, setLists] = useState<{ ignored: ReadonlySet<string>; banned: ReadonlySet<string> }>(
    { ignored: EMPTY, banned: EMPTY },
  );

  const applyLists = useCallback((l: UserLists) => {
    setLists({ ignored: new Set(l.ignored), banned: new Set(l.banned) });
  }, []);

  useEffect(() => {
    if (!client) {
      setBuddies(EMPTY);
      setLists({ ignored: EMPTY, banned: EMPTY });
      return;
    }
    const fromBuddies = (d: unknown) => setBuddies(new Set((d as { items?: string[] }).items ?? []));
    const off = [
      client.on('buddies.state', fromBuddies),
      client.on('users.lists', (d) => applyLists(d as UserLists)),
    ];
    const stops = [
      readUntilAnswered<{ items: string[] }>(client, 'buddies.list', undefined, fromBuddies),
      readUntilAnswered<UserLists>(client, 'users.lists', undefined, applyLists),
    ];
    return () => { for (const f of off) f(); for (const s of stops) s(); };
  }, [client, applyLists]);

  const follow = useCallback((username: string, on: boolean) => {
    if (!client) return;
    void client.request(on ? 'buddies.add' : 'buddies.remove', { username })
      .catch((e) => reportFailure(`${on ? 'Follow' : 'Unfollow'} ${username}`, e));
  }, [client]);

  const ignore = useCallback((username: string, on: boolean) => {
    if (!client) return;
    void client.request<UserLists>('users.ignore', { username, on })
      .then(applyLists)
      .catch((e) => reportFailure(`${on ? 'Ignore' : 'Stop ignoring'} ${username}`, e));
  }, [client, applyLists]);

  const ban = useCallback((username: string, on: boolean) => {
    if (!client) return;
    void client.request<UserLists>('users.ban', { username, on })
      .then(applyLists)
      .catch((e) => reportFailure(`${on ? 'Ban' : 'Lift the ban on'} ${username}`, e));
  }, [client, applyLists]);

  return useMemo(() => ({
    buddies, ignored: lists.ignored, banned: lists.banned, follow, ignore, ban,
  }), [buddies, lists, follow, ignore, ban]);
}
