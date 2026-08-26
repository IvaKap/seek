/*
 * Seek — native notifications.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Only for things that finish while you are looking elsewhere: a download
 * completing, a release failing. Everything else the app already shows on
 * screen, and a notification for something visible is just noise.
 *
 * Permission is requested lazily, on the first thing worth announcing, rather
 * than with a prompt on launch before the user has any idea what it is for.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { TransferGroup } from './transferStore.ts';

type Permission = 'granted' | 'denied' | 'unknown';

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
  const permission = useRef<Permission>('unknown');
  const primed = useRef(false);

  const announce = useCallback(async (title: string, body: string) => {
    if (permission.current === 'denied') return;
    if (permission.current === 'unknown') {
      permission.current = (await ensurePermission()) ? 'granted' : 'denied';
      if (permission.current === 'denied') return;
    }
    await send(title, body);
  }, []);

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
  }, [groups, announce]);
}
