/*
 * Seek — a label's or an artist's whole catalogue.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The use case from `docs/PRODUCT.md`'s world: electronic collectors follow
 * LABELS, not only artists. Hyperdub's back catalogue is a list you work
 * through over months, and the useful question about it is "what of this do I
 * not already have" — which is why the view cross-references the library index
 * rather than just listing records.
 *
 * One catalogue at a time. Browsing a second replaces the first, and a reply
 * for a request the user has moved on from is dropped, exactly as the Dig Bar
 * preview does — for the same reason, that an answer to an abandoned question
 * arriving late is worse than no answer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { UrlProvider } from '../domain/discoverUrl.ts';

export interface CatalogEntry {
  discogsId: number;
  title: string;
  artist: string;
  year: number | null;
  /** Verbatim from the provider: 'CD, Album', '12"'. Empty when unstated. */
  format: string;
  catno: string;
  /** 'Main', 'Appearance', … on an artist discography. Empty for a label. */
  role: string;
  url: string;
}

export interface CatalogRequest {
  sourceKind: UrlProvider;
  kind: 'label' | 'artist';
  id?: number | null;
  name?: string | null;
  url?: string | null;
}

export interface Catalog {
  sourceKind: UrlProvider | null;
  kind: 'label' | 'artist';
  name: string;
  /**
   * The provider's numeric id — Discogs' label/artist id, 0 for Bandcamp.
   *
   * On the wire from the start and discarded here until the label watchlist
   * needed it. It is what identifies a catalogue across a rename and across
   * two spellings of the same URL, and re-browsing with it skips the fuzzy
   * name search that `_resembles` exists to guard against.
   */
  entityId: number | null;
  url: string | null;
  releases: CatalogEntry[];
  /** False when the sidecar stopped paginating before the end. */
  complete: boolean;
  loading: boolean;
  error: string | null;
  /** An AppSettings field the user must supply, e.g. 'discogsToken'. */
  needs: string;
}

export interface CatalogSession {
  catalog: Catalog | null;
  browse(request: CatalogRequest): void;
  clear(): void;
  enabled: boolean;
}

function pending(request: CatalogRequest): Catalog {
  return {
    sourceKind: request.sourceKind,
    kind: request.kind,
    name: request.name ?? '',
    entityId: request.id ?? null,
    url: request.url ?? null,
    releases: [],
    complete: true,
    loading: true,
    error: null,
    needs: '',
  };
}

export function useCatalog(client: SidecarClient | null): CatalogSession {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /* Correlate on the request id the command replies with. Unlike the Dig Bar
   * there is no URL to key on — a catalogue can be addressed by name or by
   * numeric id — so this one does need the id, and the reply always precedes
   * the event because the event costs several HTTP round trips. */
  const active = useRef<string | null>(null);

  useEffect(() => {
    if (!client) return;

    const offCatalog = client.on('discover.catalog', (data) => {
      const d = data as {
        requestId: string; sourceKind: string; kind: 'label' | 'artist';
        name: string; id: number; url: string | null;
        releases: CatalogEntry[]; complete: boolean;
      };
      if (d.requestId !== active.current) return;
      setCatalog({
        sourceKind: d.sourceKind as UrlProvider,
        kind: d.kind,
        name: d.name,
        // 0 is Bandcamp saying "I have no ids", not an id of zero.
        entityId: d.id || null,
        url: d.url,
        releases: d.releases ?? [],
        complete: d.complete,
        loading: false,
        error: null,
        needs: '',
      });
    });

    const offFailed = client.on('discover.browseFailed', (data) => {
      const d = data as {
        requestId: string; reason: string; needs: string; unreachable: boolean;
      };
      if (d.requestId !== active.current) return;
      setCatalog((prev) => (prev ? {
        ...prev,
        loading: false,
        /* `reason` is developer-facing by contract and this view puts `error`
         * straight on screen, so an unreachable provider used to render a raw
         * `<urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] ...>` at the reader.
         * Replaced here rather than in the view: the store is what promised a
         * displayable string. */
        error: d.unreachable
          ? 'Could not reach the provider. Check your connection and try again.'
          : d.reason,
        needs: d.needs ?? '',
      } : prev));
    });

    return () => { offCatalog(); offFailed(); };
  }, [client]);

  const browse = useCallback((request: CatalogRequest) => {
    if (!client) return;
    active.current = null;
    setCatalog(pending(request));
    void client.request<{ requestId: string }>('discover.browse', {
      sourceKind: request.sourceKind,
      kind: request.kind,
      id: request.id ?? null,
      name: request.name ?? null,
      url: request.url ?? null,
    }).then((reply) => { active.current = reply.requestId; })
      .catch((error: Error) => {
        setCatalog((prev) => (prev ? {
          ...prev, loading: false, error: error.message, needs: '',
        } : prev));
      });
  }, [client]);

  const clear = useCallback(() => {
    active.current = null;
    setCatalog(null);
  }, []);

  return { catalog, browse, clear, enabled: Boolean(client) };
}
