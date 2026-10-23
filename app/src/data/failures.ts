/*
 * Seek — saying when something did not work.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Fifty-six requests ended in `.catch(() => {})`: join a room, follow someone,
 * add a wish, save a profile — and when the engine said no, the click simply
 * did nothing. That is most of what "buttons that don't make sense" meant.
 * User-initiated actions now report here, and a short notice says what failed
 * and why. Background reads are not reported; they retry instead
 * (`readUntilAnswered`), because a notice for something the person did not do
 * is noise.
 */

import { useSyncExternalStore } from 'react';
import { readableError } from '../domain/folders.ts';
import type { SidecarClient } from './sidecarClient.ts';

interface Failure {
  id: number;
  text: string;
}

/** On screen long enough to read a sentence, then gone. */
const SHOW_MS = 7000;
/** Three at most: a burst of the same failure should not bury the window. */
const MAX_SHOWN = 3;

let items: Failure[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function dismissFailure(id: number): void {
  const next = items.filter((f) => f.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/** `action` is what the person tried, said as they would: "Join #techno". */
export function reportFailure(action: string, error: unknown): void {
  showNotice(`${action} didn't work — ${readableError(error)}`);
}

/** A sentence that is not a failure but still has to be seen — a refusal
 *  made on the person's own rules, say. Shown as written. */
export function showNotice(text: string): void {
  // The same sentence twice in a row is one notice, not two.
  if (items.some((f) => f.text === text)) return;
  const id = ++seq;
  items = [...items, { id, text }].slice(-MAX_SHOWN);
  emit();
  setTimeout(() => dismissFailure(id), SHOW_MS);
}

export function useFailures(): Failure[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => items,
  );
}

/**
 * Ask until the engine answers.
 *
 * For the first read a screen depends on. Each store asked once on connect and
 * swallowed a failure — a busy first launch, a 15 s timeout — so Settings sat
 * on defaults ("No folder set", port 0, no account) presented as the saved
 * values, with nothing ever asking again. Returns the cleanup.
 */
export function readUntilAnswered<T>(
  client: SidecarClient,
  cmd: string,
  params: Record<string, unknown> | undefined,
  onValue: (value: T) => void,
  everyMs = 5000,
): () => void {
  let live = true;
  let timer = 0;
  const ask = () => {
    void client.request<T>(cmd, params)
      .then((value) => { if (live) onValue(value); })
      .catch(() => { if (live) timer = window.setTimeout(ask, everyMs); });
  };
  ask();
  return () => { live = false; window.clearTimeout(timer); };
}

/**
 * `lost` when an open socket stops being open; `back` when it opens again.
 *
 * Events go to whoever is connected when they are sent, so anything still
 * waiting on one when the socket dropped may never hear it: a copy, a check
 * or a decode that finished in the gap answered nobody. Returns the cleanup.
 */
export function onReconnect(client: SidecarClient, lost: () => void, back?: () => void): () => void {
  let state: 'new' | 'open' | 'lost' = 'new';
  return client.onPhase((phase) => {
    if (phase === 'open') {
      if (state === 'lost') back?.();
      state = 'open';
    } else if (state === 'open') {
      state = 'lost';
      lost();
    }
  });
}

/** `prev` without its entries still marked running, or `prev` itself when
 *  there were none, so a state setter can take it without a wasted render. */
export function dropRunning<V extends { state: string }>(prev: Map<string, V>): Map<string, V> {
  let next: Map<string, V> | null = null;
  for (const [key, value] of prev) {
    if (value.state === 'running') (next ??= new Map(prev)).delete(key);
  }
  return next ?? prev;
}
