/*
 * Seek — measuring a table's width in rem, so its columns fit.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Extracted from ResultList so the YouTube sheet drops the least-useful column
 * first on exactly the same rule the search table does. Rem, not pixels, and
 * measured rather than declared in a media query: `rem` in a media query
 * resolves against the INITIAL font size, so it never fires when the OS scales
 * text, and a table that keeps every column at 200% text is a table that
 * overflows.
 */

import { useEffect, useState } from 'react';

/** The root font size in px, tracked live so text scaling re-measures the list. */
export function useRootFontSize(): number {
  const [px, setPx] = useState(() =>
    typeof window === 'undefined'
      ? 16
      : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
  );
  useEffect(() => {
    const read = () => {
      const next = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setPx((cur) => (Math.abs(cur - next) > 0.5 ? next : cur));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  return px;
}

/**
 * A container's width in REM, tracked live. Infinity before the first
 * measurement, so the first paint shows every chosen column rather than
 * flashing a stripped-down table.
 */
export function useWidthRem(ref: React.RefObject<HTMLElement | null>, rootPx: number): number {
  const [px, setPx] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof ResizeObserver !== 'function') {
      setPx(node.getBoundingClientRect().width);
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      setPx(entry.contentRect.width);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [ref]);
  return px === 0 ? Number.POSITIVE_INFINITY : px / rootPx;
}
