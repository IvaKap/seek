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

export interface Failure {
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
  const text = `${action} didn't work — ${readableError(error)}`;
  // The same sentence twice in a row is one notice, not two.
  if (items.some((f) => f.text === text)) return;
  const id = ++seq;
  items = [...items, { id, text }].slice(-MAX_SHOWN);
  emit();
  setTimeout(() => dismissFailure(id), SHOW_MS);
}

/** A sentence that is not a failure but still has to be seen — a refusal
 *  made on the person's own rules, say. Shown as written. */
export function showNotice(text: string): void {
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
