/*
 * Seek — what else is like this one.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The moment this exists for: a release has just finished downloading, you
 * like it, and the useful next question is "what else is on that label". For a
 * collector who follows labels — which is who this app is for — that is a
 * better question than any similarity score, and Discogs can answer it exactly
 * rather than approximately.
 *
 * Several releases can be asking at once, so results are keyed rather than
 * held singly: the Dig Bar has one search field and therefore one preview, but
 * a downloads list has as many expanded rows as the user cares to open.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { CatalogEntry } from './catalogStore.ts';

export interface RelatedResult {
  state: 'looking' | 'ready' | 'failed';
  byArtist: CatalogEntry[];
  byLabel: CatalogEntry[];
  labelName: string;
  /** An AppSettings field that would fix it, when one would. */
  needs: string;
}

export interface RelatedSession {
  get(key: string): RelatedResult | undefined;
  /** Ask about one release. Safe to call twice; the second is ignored. */
  want(key: string, artist: string, release: string, label: string | null): void;
  enabled: boolean;
}

const LOOKING: RelatedResult = {
  state: 'looking', byArtist: [], byLabel: [], labelName: '', needs: '',
};

export function useRelated(client: SidecarClient | null): RelatedSession {
  const [map, setMap] = useState<Map<string, RelatedResult>>(() => new Map());
  /** Request id to the key that asked, so answers can be placed. */
  const [pending] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    if (!client) return;

    const offResults = client.on('discover.relatedResults', (data) => {
      const d = data as {
        requestId: string; byArtist: CatalogEntry[]; byLabel: CatalogEntry[];
        labelName: string;
      };
      const key = pending.get(d.requestId);
      if (!key) return;
      pending.delete(d.requestId);
      setMap((prev) => new Map(prev).set(key, {
        state: 'ready',
        byArtist: d.byArtist ?? [],
        byLabel: d.byLabel ?? [],
        labelName: d.labelName ?? '',
        needs: '',
      }));
    });

    // The sidecar reports a failed lookup through the shared failure event.
    const offFailed = client.on('discover.parseFailed', (data) => {
      const d = data as { requestId: string; needs: string };
      const key = pending.get(d.requestId);
      if (!key) return;
      pending.delete(d.requestId);
      setMap((prev) => new Map(prev).set(key, {
        ...LOOKING, state: 'failed', needs: d.needs ?? '',
      }));
    });

    return () => { offResults(); offFailed(); };
  }, [client, pending]);

  const want = useCallback((
    key: string, artist: string, release: string, label: string | null,
  ) => {
    if (!client || !key || (!artist && !release)) return;
    // Asked once per release per session. A second ask would cost several
    // rate-limited Discogs pages for an answer already on screen.
    let already = false;
    setMap((prev) => {
      if (prev.has(key)) { already = true; return prev; }
      return new Map(prev).set(key, LOOKING);
    });
    if (already) return;

    void client.request<{ requestId: string }>('discover.related', {
      artist, release, label,
    }).then((reply) => { pending.set(reply.requestId, key); })
      .catch(() => {
        setMap((prev) => new Map(prev).set(key, { ...LOOKING, state: 'failed' }));
      });
  }, [client, pending]);

  return {
    get: (key) => map.get(key),
    want,
    enabled: Boolean(client),
  };
}
