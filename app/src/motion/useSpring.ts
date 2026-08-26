/*
 * Seek — React bindings for the spring.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * These write to the DOM directly rather than through React state. A spring
 * settling at 60fps would otherwise mean sixty renders a second of a
 * five-thousand-row list, which is exactly the kind of thing that turns a
 * smooth scroll into a stuttering one.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { SPRING_DEFAULT, driveSpring } from './spring.ts';
import type { SpringConfig, SpringHandle } from './spring.ts';
import { useReducedMotion } from './prefs.ts';

/**
 * A spring whose value is applied imperatively. Returns `to(target, velocity?)`.
 * Under reduced motion it jumps straight to the target — gentler equivalent,
 * not a broken control.
 */
export function useSpringValue(
  apply: (value: number) => void,
  initial = 0,
  config: SpringConfig = SPRING_DEFAULT,
): (target: number, velocity?: number) => void {
  const reduced = useReducedMotion();
  const handleRef = useRef<SpringHandle | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  if (handleRef.current === null) {
    handleRef.current = driveSpring((v) => applyRef.current(v), initial, config);
  }

  useEffect(() => () => handleRef.current?.stop(), []);

  return useCallback(
    (target: number, velocity?: number) => {
      const h = handleRef.current;
      if (!h) return;
      if (reduced) h.set(target);
      else h.to(target, velocity);
    },
    [reduced],
  );
}

/**
 * Spring an element's transform on one axis. The full `transform` string is
 * written, not a shorthand, so the compositor handles it.
 */
export function useSpringTransform(
  ref: RefObject<HTMLElement | null>,
  axis: 'x' | 'y' = 'y',
  config: SpringConfig = SPRING_DEFAULT,
): (target: number, velocity?: number) => void {
  return useSpringValue(
    (v) => {
      const el = ref.current;
      if (el) {
        el.style.transform = axis === 'y' ? `translate3d(0, ${v}px, 0)` : `translate3d(${v}px, 0, 0)`;
      }
    },
    0,
    config,
  );
}

/**
 * An animated integer, for the result count. Springs the value and writes the
 * text; `tabular-nums` in CSS is what stops the digits jittering as it counts.
 */
export function useSpringNumber(
  ref: RefObject<HTMLElement | null>,
  format: (n: number) => string = (n) => String(Math.round(n)),
): (target: number) => void {
  const formatRef = useRef(format);
  formatRef.current = format;

  const set = useSpringValue(
    (v) => {
      const el = ref.current;
      if (el) el.textContent = formatRef.current(v);
    },
    0,
    // No bounce: a count that overshoots and comes back has, for one frame,
    // told the user a number that was never true.
    { response: 0.5, damping: 1.0 },
  );

  // Paint the initial value so the node is never momentarily blank.
  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent === '') el.textContent = formatRef.current(0);
  }, [ref]);

  return set;
}
