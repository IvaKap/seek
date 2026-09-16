/*
 * Seek — greet someone the first time they download from you.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Mounted at the app level, beside `useAutoDownloads` and for the same reason:
 * an upload finishes whether or not the Uploads screen is open, so the
 * controller cannot live in a view.
 *
 * The decision of WHO to greet is the pure planner in `domain/autoGreet.ts`;
 * this file only performs it and remembers what it did — the same split the
 * auto-download controller uses, and the reason neither has a test of its own.
 *
 * ONE THING IS DELIBERATELY BACKWARDS from that controller. It enqueues, then
 * persists its claim; a download that slips through the gap can simply be
 * retried. A private message cannot be unsent, so this marks and persists
 * FIRST and sends afterwards. A crash in the gap costs one missed greeting,
 * which is the failure worth having.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { TransferGroup } from './transferStore.ts';
import { planGreetings } from '../domain/autoGreet.ts';

/** Greetings per run of the app. Nothing resets it but a relaunch. */
const MAX_PER_SESSION = 20;

interface GreetedList { users: string[] }

export function useAutoGreet(
  client: SidecarClient | null,
  uploadGroups: TransferGroup[],
  enabled: boolean,
  greeting: string,
  signedIn: boolean,
): void {
  const [greeted, setGreeted] = useState<ReadonlySet<string>>(() => new Set());
  /* Until the ledger has loaded, greeting anyone risks greeting them twice. */
  const loaded = useRef(false);
  /* Upload-group state as last seen, and whether the first pass has run. */
  const seen = useRef(new Map<string, string>());
  const primed = useRef(false);
  const sentThisSession = useRef(0);

  useEffect(() => {
    if (!client) return undefined;
    let live = true;
    void client.request<GreetedList>('greeting.sentList')
      .then((r) => { if (live) setGreeted(new Set(r.users)); })
      .catch(() => { /* an unreadable ledger reads as empty */ })
      .finally(() => { if (live) loaded.current = true; });
    return () => { live = false; };
  }, [client]);

  const remember = useCallback((names: string[]) => {
    setGreeted((prev) => {
      const next = new Set(prev);
      for (const n of names) next.add(n);
      void client?.request('greeting.sent', { users: [...next] }).catch(() => {});
      return next;
    });
  }, [client]);

  useEffect(() => {
    /* The first pass records what is already there without greeting anyone.
       Without it, launching the app would message every peer whose upload
       finished in some previous session — and `seen` is updated on every pass
       whether or not the feature is on, so switching it on mid-session does
       not fire for everything that finished before. */
    if (!primed.current) {
      for (const g of uploadGroups) seen.current.set(g.key, g.state);
      primed.current = true;
      return;
    }

    const candidates: string[] = [];
    for (const g of uploadGroups) {
      const was = seen.current.get(g.key);
      if (was === g.state) continue;
      seen.current.set(g.key, g.state);
      // A group seen for the first time mid-session is a restored row, not a
      // transition — the same trap `notify.ts` and the sidecar's `witnessed`
      // flag both exist for.
      if (was === undefined) continue;
      if (g.state === 'finished') candidates.push(g.username);
    }

    if (!enabled || !signedIn || !client || !loaded.current) return;
    if (candidates.length === 0) return;

    const text = greeting.trim();
    if (!text) return;

    const plan = planGreetings(
      candidates, greeted, MAX_PER_SESSION - sentThisSession.current,
    );
    if (plan.length === 0) return;

    sentThisSession.current += plan.length;
    remember(plan);
    for (const target of plan) {
      void client.request('chat.say', {
        scope: 'private', target, message: text, automatic: true,
      }).catch(() => { /* nothing to retry — the peer stays marked */ });
    }
  }, [uploadGroups, enabled, signedIn, client, greeting, greeted, remember]);
}
