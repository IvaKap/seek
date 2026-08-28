/*
 * Seek — "is this row anywhere near the screen yet?"
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The gate in front of every cover lookup. Artwork comes from MusicBrainz and
 * the Cover Art Archive, a volunteer-run service that permits about one request
 * a second, so a list that asks for every cover on mount is not slow — it is
 * minutes of someone else's bandwidth for rows nobody scrolled to. Hyperdub's
 * catalogue alone is 500 records.
 *
 * Lived in `LabelBrowserView` until the Failed and Completed lists needed the
 * same gate. A second copy would drift, and the two would then differ in how
 * far ahead they prefetch, which is precisely the sort of difference nobody
 * notices until one of them is hammering an API.
 *
 * `rootMargin` is deliberately generous: covers should arrive BEFORE the row
 * does, so scrolling reveals finished rows rather than a grid of placeholders
 * filling in behind you.
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export function useNearViewport(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    // Latches on: once a row has been seen, scrolling away must not un-request
    // a cover that has already been fetched and cached.
    if (!node || near) return;
    // No observer (jsdom, an old webview) means show everything rather than
    // nothing — a missing optimisation, never a missing feature.
    if (typeof IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: '400px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  return [ref, near];
}
