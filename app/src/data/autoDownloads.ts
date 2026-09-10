/*
 * Seek — the auto-download controller.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The one moving part the feature adds, and deliberately a small one. It does
 * NOT search: upstream re-runs each wish on the server's interval and
 * `useWishHits` already ingests the results. This hook only watches those
 * results and, for a wish whose owner asked for it, starts ONE download of the
 * best qualifying file — then gets out of the way until a person reviews it.
 *
 * WHY IT LIVES AT APP LEVEL. It has to run whenever Seek is open, not only when
 * the Wishlist screen is showing — that is the whole point, and it is also why
 * there is no always-on daemon: the sidecar is killed when the app quits, so
 * nothing here (or anywhere) searches while Seek is closed. Keeping shares
 * online means keeping Seek open, which is the bargain we want anyway.
 *
 * WHAT KEEPS IT HONEST. The claim ledger. A wish with a live claim is skipped,
 * so a re-run cannot re-download the same item and "stop searching once a
 * candidate is found" needs no actual stopping — we simply stop acting. The
 * decision of WHAT to grab is the pure planner in domain/autoWishlist.ts; this
 * file only performs it and remembers what it did.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { WishHits } from './wishHits.ts';
import { planAutoDownloads } from '../domain/autoWishlist.ts';
import type { SourceFile } from '../domain/types.ts';
import type { AutoClaim, AutoClaimList, Wish, WishlistState } from '../../../shared/protocol.ts';

/** At most this many auto-downloads in flight at once, so a wall of auto-wishes
 *  cannot open a hundred transfers on a single interval tick. */
const MAX_INFLIGHT = 3;

/** Statuses that occupy a download slot. An awaiting-review claim is done
 *  downloading, so it holds its wish but not a slot. */
const INFLIGHT = new Set(['downloading', 'analysing']);

/** The minimum of a transfers session this controller drives. */
interface Enqueuer {
  enqueue(username: string, path: string, size: number): Promise<void>;
}

export interface AutoDownloads {
  /** Every live claim — consumed by the review UI. */
  claims: AutoClaim[];
}

export function useAutoDownloads(
  client: SidecarClient | null,
  wishHits: WishHits,
  transfers: Enqueuer,
): AutoDownloads {
  const [wishes, setWishes] = useState<Wish[]>([]);
  const [claims, setClaims] = useState<AutoClaim[]>([]);
  /* Until the ledger has loaded, acting would re-download everything already
     awaiting review from a previous session. */
  const loaded = useRef(false);

  // The wishlist itself — which wishes are auto, and their filters. Its own
  // small subscription rather than lifting WishlistView's state, so the
  // controller works with that screen closed.
  useEffect(() => {
    if (!client) return undefined;
    const off = client.on('wishlist.state', (d) => setWishes((d as WishlistState).items));
    void client.request<WishlistState>('wishlist.list').then((s) => setWishes(s.items)).catch(() => {});
    return off;
  }, [client]);

  // The claim ledger, read once on connect so an awaiting-review candidate
  // survives a restart.
  useEffect(() => {
    if (!client) return undefined;
    let live = true;
    void client.request<AutoClaimList>('wishlist.claimsList')
      .then((r) => { if (live) setClaims(r.items); })
      .catch(() => { /* an unreadable ledger reads as empty */ })
      .finally(() => { if (live) loaded.current = true; });
    return () => { live = false; };
  }, [client]);

  const persist = useCallback((next: AutoClaim[]) => {
    setClaims(next);
    void client?.request('wishlist.claims', { items: next }).catch(() => {});
  }, [client]);

  // The reaction: start downloads for eligible wishes as results arrive.
  useEffect(() => {
    if (!client || !loaded.current) return;
    const claimed = new Set(claims.map((c) => c.query));
    const slotsFree = MAX_INFLIGHT - claims.filter((c) => INFLIGHT.has(c.status)).length;
    if (slotsFree <= 0) return;

    const sourcesByQuery: Record<string, SourceFile[]> = {};
    for (const [query, hit] of Object.entries(wishHits.byQuery)) {
      sourcesByQuery[query] = hit.sources;
    }

    const plan = planAutoDownloads(wishes, sourcesByQuery, claimed, slotsFree);
    if (plan.length === 0) return;

    for (const item of plan) {
      void transfers.enqueue(item.source.user, item.source.path, item.source.size).catch(() => {});
    }
    persist([
      ...claims,
      ...plan.map((item): AutoClaim => ({
        query: item.query,
        user: item.source.user,
        transferId: '',
        path: item.source.path,
        status: 'downloading',
      })),
    ]);
  }, [client, wishes, claims, wishHits.byQuery, transfers, persist]);

  return { claims };
}
