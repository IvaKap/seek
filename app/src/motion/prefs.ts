/*
 * Seek — the reduced-motion signal, read at runtime.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * CSS handles reduced motion for declarative animation; springs are driven in JS
 * and have to ask as well. `useReducedMotion` is what makes the spring hooks step
 * straight to their target instead of animating.
 */

import { useSyncExternalStore } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';
// jsdom has no matchMedia; there, motion is simply not reduced.
const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED) : null);

function subscribe(onChange: () => void): () => void {
  const mq = query();
  mq?.addEventListener('change', onChange);
  return () => mq?.removeEventListener('change', onChange);
}

export const useReducedMotion = () => useSyncExternalStore(subscribe, () => query()?.matches ?? false);
