/*
 * Seek — cover art, never on the critical path.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The brief's rules, and each one exists because breaking it is worse than
 * having no artwork at all:
 *
 *  - Rows render immediately with their deterministic placeholder. Art fades in
 *    when it arrives, and the space is reserved either way, so nothing shifts.
 *  - Only releases in or near the viewport are fetched. A 5,000-result search
 *    must not queue 5,000 lookups against a volunteer-run service.
 *  - Requests are debounced, and a key already known — hit, miss, or in flight —
 *    is never asked for twice.
 *
 * MusicBrainz permits one request per second, so the sidecar gates them
 * globally. That makes restraint here a courtesy with teeth: an impatient
 * client is simply a slow one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';

export type ArtState =
  | { state: 'pending' }
  | {
      state: 'ready';
      dataUri: string;
      source: string;
      /* Completeness rides along free: the same MusicBrainz match that found
       * the cover already knew the release's real track count. 0 means no
       * confident match, NOT a zero-track release. */
      trackCount: number;
      date: string;
      label: string;
    }
  | { state: 'missing' };

export interface ArtworkSession {
  get(key: string): ArtState | undefined;
  /** Ask for a cover. Safe to call every render; repeats are ignored. */
  want(key: string, artist: string | null, release: string): void;
  enabled: boolean;
}

const DEBOUNCE_MS = 180;
/** Per flush. The sidecar is rate limited, so a big burst only queues. */
const MAX_IN_FLIGHT = 12;

export function useArtwork(client: SidecarClient | null, enabled = true): ArtworkSession {
  const [map, setMap] = useState<Map<string, ArtState>>(() => new Map());
  const known = useRef<Set<string>>(new Set());
  const queue = useRef<Map<string, { artist: string; release: string }>>(new Map());
  const timer = useRef(0);

  useEffect(() => {
    if (!client) return;
    const offResult = client.on('artwork.result', (d) => {
      const r = d as {
        key: string; dataUri: string; source: string;
        trackCount?: number; date?: string; label?: string;
      };
      setMap((prev) => new Map(prev).set(r.key, {
        state: 'ready', dataUri: r.dataUri, source: r.source,
        trackCount: r.trackCount ?? 0, date: r.date ?? '', label: r.label ?? '',
      }));
    });
    const offFailed = client.on('artwork.failed', (d) => {
      const r = d as { key: string };
      // A miss is normal — plenty of underground releases are in no database.
      // Record it so the placeholder stays and we never ask again this session.
      setMap((prev) => new Map(prev).set(r.key, { state: 'missing' }));
    });
    return () => { offResult(); offFailed(); };
  }, [client]);

  const flush = useCallback(() => {
    timer.current = 0;
    if (!client) return;
    const batch = [...queue.current.entries()].slice(0, MAX_IN_FLIGHT);
    for (const [key, what] of batch) {
      queue.current.delete(key);
      void client.request('artwork.get', {
        artist: what.artist, release: what.release, key,
      }).catch(() => {
        setMap((prev) => new Map(prev).set(key, { state: 'missing' }));
      });
    }
    // Anything left over waits for the next tick rather than being dropped.
    if (queue.current.size > 0) {
      timer.current = window.setTimeout(flush, DEBOUNCE_MS * 4);
    }
  }, [client]);

  const want = useCallback((key: string, artist: string | null, release: string) => {
    if (!client || !enabled || !key || !release) return;
    if (known.current.has(key)) return;
    known.current.add(key);
    setMap((prev) => (prev.has(key) ? prev : new Map(prev).set(key, { state: 'pending' })));
    queue.current.set(key, { artist: artist ?? '', release });
    if (!timer.current) timer.current = window.setTimeout(flush, DEBOUNCE_MS);
  }, [client, enabled, flush]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  return {
    get: (key) => map.get(key),
    want,
    enabled: Boolean(client) && enabled,
  };
}
