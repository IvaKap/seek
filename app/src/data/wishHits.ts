/*
 * Seek — what the wishlist actually found, kept until you go and look.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A WISH MUST NEVER INTERRUPT. It fires on the server's interval, which means
 * it fires while you are in the middle of something — so a hit does not open a
 * tab, does not steal the search field, and does not touch what is on screen.
 * It waits on the Wishlist screen with a count beside it, the same bargain the
 * search tabs make: a search put away is still there when you come back.
 *
 * This store exists because the ordinary search path deliberately will not
 * carry these. `sidecarClient` routes results only when `searchId` matches the
 * search in front of you — which is right, and is exactly why wishlist results
 * need somewhere else to go.
 *
 * A RE-RUN REPLACES. Upstream keeps one token per wish forever and re-runs it
 * on the timer, and the sidecar starts a fresh registry entry each time
 * (`_adopt_wishlist_search`). Appending across runs would grow one pile of
 * increasingly stale peers; what you want to know is what is out there NOW.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { adaptSearchResult, isAudioPath } from './adapt.ts';
import type { WireSearchResultData } from './adapt.ts';
import { createGrouper } from '../domain/group.ts';
import { reliabilityFrom } from '../domain/score.ts';
import type { Release, SourceFile } from '../domain/types.ts';

/** Per wish, so one popular query cannot crowd out the rest. */
const PER_WISH_CAP = 400;

export interface WishHit {
  query: string;
  sources: SourceFile[];
  releases: Release[];
  peerCount: number;
  /** Epoch ms of the most recent result. */
  foundAt: number;
  /** False once these have been looked at. Drives the badge, not the list. */
  unseen: boolean;
}

export interface WishHits {
  /** Keyed by the wish text, which is what upstream keys the wishlist by. */
  byQuery: Record<string, WishHit>;
  /** Wishes with results you have not looked at. The sidebar badge. */
  unseenCount: number;
  markSeen(query: string): void;
  forget(query: string): void;
}

/** A wishlist run, as announced by the sidecar. */
interface StartedEvent { searchId: number; query: string; mode?: string }

export function useWishHits(client: SidecarClient | null): WishHits {
  const [byQuery, setByQuery] = useState<Record<string, WishHit>>({});

  /* searchId -> wish text. A wish keeps ONE token across every re-run, so this
     is small and long-lived rather than per-run. */
  const queryOf = useRef(new Map<number, string>());
  /* One grouper per wish: grouping is stateful (it remembers which release a
     source was assigned to) and two wishes must not share that state. */
  const groupers = useRef(new Map<string, ReturnType<typeof createGrouper>>());

  useEffect(() => {
    if (!client) return;

    const offStarted = client.on('search.started', (d) => {
      const ev = d as StartedEvent;
      // The only signal separating a wish from something the user typed.
      if (ev.mode !== 'wishlist') return;
      queryOf.current.set(ev.searchId, ev.query);
      // A new run supersedes the last one — see the header.
      groupers.current.set(ev.query, createGrouper());
      setByQuery((prev) => ({
        ...prev,
        [ev.query]: {
          query: ev.query, sources: [], releases: [], peerCount: 0,
          foundAt: Date.now(),
          // Preserved: a run that finds nothing must not clear a badge the
          // previous run earned. It is cleared by LOOKING, not by time passing.
          unseen: prev[ev.query]?.unseen ?? false,
        },
      }));
    });

    const offResult = client.on('search.result', (d) => {
      const data = d as WireSearchResultData;
      const query = queryOf.current.get(data.searchId);
      if (query === undefined) return;

      const grouper = groupers.current.get(query);
      if (!grouper) return;
      if (grouper.size() >= PER_WISH_CAP) return;

      const audio = { ...data, files: data.files.filter((f) => isAudioPath(f.path)) };
      if (audio.files.length === 0) return;

      // Neutral prior for reliability: this runs while you are elsewhere, and
      // reaching into the peer store from here would couple two things that do
      // not otherwise know about each other.
      const sources = adaptSearchResult(audio, 0, () => reliabilityFrom(0, 0));
      for (const s of sources) grouper.add(s);

      const all = grouper.all.slice(0, PER_WISH_CAP);
      setByQuery((prev) => ({
        ...prev,
        [query]: {
          query,
          sources: all,
          releases: grouper.releases(all),
          peerCount: new Set(all.map((s) => s.user)).size,
          foundAt: Date.now(),
          unseen: true,
        },
      }));
    });

    return () => { offStarted(); offResult(); };
  }, [client]);

  const markSeen = useCallback((query: string) => {
    setByQuery((prev) => (
      prev[query] && prev[query].unseen
        ? { ...prev, [query]: { ...prev[query], unseen: false } }
        : prev
    ));
  }, []);

  const forget = useCallback((query: string) => {
    groupers.current.delete(query);
    setByQuery((prev) => {
      if (!(query in prev)) return prev;
      const next = { ...prev };
      delete next[query];
      return next;
    });
  }, []);

  return {
    byQuery,
    unseenCount: Object.values(byQuery).filter((h) => h.unseen && h.sources.length > 0).length,
    markSeen,
    forget,
  };
}
