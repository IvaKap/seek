/*
 * Seek — close a popover on an outside press or Escape.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';

/** While `open`, a pointerdown outside every element in `refs`, or Escape,
 * calls `close`. Pass stable refs and a close that only sets state: the
 * listeners are bound once per opening. */
export function useDismiss(open: boolean, refs: RefObject<Element | null>[], close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!refs.some((r) => r.current?.contains(target))) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}
