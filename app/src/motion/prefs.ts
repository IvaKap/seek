/*
 * Seek — the reduced-motion signal, read at runtime.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * CSS handles reduced motion for declarative animation; springs are driven in JS
 * and have to ask as well. `useReducedMotion` is what makes the spring hooks step
 * straight to their target instead of animating.
 */

import { useEffect, useState } from 'react';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');
