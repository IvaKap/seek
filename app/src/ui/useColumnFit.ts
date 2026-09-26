/*
 * Seek — the live root font size.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The result list's row-height estimates are in rem, so they have to follow the
 * user's text size. Measured rather than read from a media query: `rem` in a
 * media query resolves against the INITIAL font size, so it never changes when
 * the OS scales text.
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
