/*
 * Seek — auto-away.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The engine has no idea whether anyone is at the keyboard; Nicotine+ keeps
 * this timer in its window (gtkgui/mainwindow.py), and so does Seek. It sets
 * away WITHOUT remembering it, and clears only what it set: an away you chose
 * yourself survives you touching the mouse, and an idle spell at quit does not
 * make the next launch start away.
 *
 * Idle means idle in Seek — input in other apps does not count, as in
 * Nicotine+.
 */

import { useEffect, useRef } from 'react';
import type { SidecarClient } from './sidecarClient.ts';

const CHECK_MS = 30_000;

/** Time to go away: online, nobody has touched Seek for `minutes`, and the
 *  status is not one we already set. */
export function shouldGoAway(
  now: number, lastInput: number, minutes: number, status: string | null, autoSet: boolean,
): boolean {
  return minutes > 0 && status === 'online' && !autoSet && now - lastInput >= minutes * 60_000;
}

export function useAutoAway(
  client: SidecarClient | null, status: string | null, minutes: number,
): void {
  const lastInput = useRef(Date.now());
  const autoSet = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!client || minutes <= 0) return undefined;
    const back = () => {
      lastInput.current = Date.now();
      if (!autoSet.current) return;
      autoSet.current = false;
      // Only if it is still the away we set: a manual change since wins.
      if (statusRef.current === 'away') {
        void client.request('users.away', { on: false, remember: false }).catch(() => {});
      }
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, back, { passive: true });
    const timer = window.setInterval(() => {
      // The away we set is gone (a reconnect signs in as online): forget it,
      // so a still-idle spell sets it again instead of never.
      if (autoSet.current && statusRef.current !== 'away') autoSet.current = false;
      if (!shouldGoAway(Date.now(), lastInput.current, minutes, statusRef.current, autoSet.current)) return;
      autoSet.current = true;
      void client.request('users.away', { on: true, remember: false })
        .catch(() => { autoSet.current = false; });
    }, CHECK_MS);
    return () => {
      for (const e of events) window.removeEventListener(e, back);
      window.clearInterval(timer);
    };
  }, [client, minutes]);
}
