/*
 * Seek — native notifications.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Only for things that happen while you are looking elsewhere: a download
 * completing or failing, a private message, your name in a room, a wish that
 * found something new. Everything else the app already shows on screen, and a
 * notification for something visible is just noise. (Nicotine+ notifies for
 * the same set; Seek used to stop at downloads, so a message sent while Seek
 * was in the background went unseen until you happened to look.)
 *
 * Permission is requested lazily, on the first thing worth announcing, rather
 * than with a prompt on launch before the user has any idea what it is for.
 */

import { useEffect, useRef } from 'react';
import type { TransferGroup } from './transferStore.ts';
import type { Conversation } from './chatStore.ts';
import type { WishHit } from './wishHits.ts';

type Permission = 'granted' | 'denied' | 'unknown';

/** Shared by every kind of notification, so permission is asked once. */
let permission: Permission = 'unknown';

async function announce(title: string, body: string): Promise<void> {
  if (permission === 'denied') return;
  if (permission === 'unknown') {
    permission = (await ensurePermission()) ? 'granted' : 'denied';
    if (permission === 'denied') return;
  }
  await send(title, body);
}

async function ensurePermission(): Promise<boolean> {
  try {
    const api = await import('@tauri-apps/plugin-notification');
    if (await api.isPermissionGranted()) return true;
    return (await api.requestPermission()) === 'granted';
  } catch {
    // Not running under Tauri, or the plugin is unavailable. Silence is the
    // right failure here — a missing notification must never break a download.
    return false;
  }
}

async function send(title: string, body: string): Promise<void> {
  try {
    const api = await import('@tauri-apps/plugin-notification');
    api.sendNotification({ title, body });
  } catch {
    /* nothing to do */
  }
}

/**
 * Announce releases that reach a terminal state. Watches the grouped view, not
 * individual files: twelve notifications for one album is exactly the noise
 * this is supposed to avoid.
 */
export function useDownloadNotifications(groups: TransferGroup[]): void {
  const seen = useRef<Map<string, string>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    // The first pass records what already exists without announcing it —
    // otherwise opening the app fires a notification for every past download.
    if (!primed.current) {
      for (const g of groups) seen.current.set(g.key, g.state);
      primed.current = true;
      return;
    }

    for (const g of groups) {
      const was = seen.current.get(g.key);
      if (was === g.state) continue;
      seen.current.set(g.key, g.state);
      if (was === undefined) continue;

      if (g.state === 'finished') {
        void announce('Download complete', `${g.title} — ${g.transfers.length} files`);
      } else if (g.state === 'failed') {
        void announce('Download failed', `${g.title} — ${g.failed} of ${g.transfers.length} files`);
      }
    }
  }, [groups]);
}

/**
 * A private message, or your name said in a room, that you are not looking at.
 *
 * Not every room line: a busy room is hundreds an hour, and the sidebar badge
 * already counts them. Lines are found by the last message seen per
 * conversation rather than by count, because the backlog is capped and stops
 * growing once full.
 */
export function useChatNotifications(
  conversations: Conversation[],
  active: string | null,
): void {
  const last = useRef<Map<string, unknown>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    if (!primed.current) {
      for (const c of conversations) last.current.set(key(c), c.messages.at(-1));
      primed.current = true;
      return;
    }
    const looking = typeof document !== 'undefined' && document.hasFocus();
    for (const c of conversations) {
      const k = key(c);
      const before = last.current.get(k);
      const tail = c.messages.at(-1);
      if (tail === before) continue;
      last.current.set(k, tail);
      const from = before === undefined ? -1 : c.messages.indexOf(before as never);
      const fresh = c.messages.slice(from + 1).filter((m) => !m.outgoing);
      if (fresh.length === 0 || (looking && active === k)) continue;
      const m = fresh[fresh.length - 1];
      if (c.scope === 'private') {
        void announce(m.username, fresh.length > 1 ? `${m.message} (+${fresh.length - 1} more)` : m.message);
      } else if (fresh.some((x) => x.mentioned)) {
        const said = fresh.filter((x) => x.mentioned).at(-1)!;
        void announce(`#${c.target} — ${said.username}`, said.message);
      }
    }
  }, [conversations, active]);
}

const key = (c: Conversation) => `${c.scope}:${c.target}`;

/**
 * A wish that found something you have not been shown — once per wish, until
 * you look. A wish keeps re-running and re-finding the same files; only what
 * is new is worth a notification, the same rule as its badge.
 */
export function useWishNotifications(byQuery: Record<string, WishHit>): void {
  const announced = useRef<Map<string, boolean>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    if (!primed.current) {
      for (const [q, hit] of Object.entries(byQuery)) announced.current.set(q, hit.unseen);
      primed.current = true;
      return;
    }
    for (const [q, hit] of Object.entries(byQuery)) {
      const was = announced.current.get(q) ?? false;
      announced.current.set(q, hit.unseen);
      if (!hit.unseen || was) continue;
      const n = hit.fresh.length;
      void announce(
        'Your wishlist found something',
        `${q} — ${n} new ${n === 1 ? 'file' : 'files'} from ${hit.peerCount} ${hit.peerCount === 1 ? 'person' : 'people'}`,
      );
    }
  }, [byQuery]);
}
