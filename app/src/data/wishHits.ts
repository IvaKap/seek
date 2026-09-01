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
 *
 * AND IT ONLY ANNOUNCES WHAT IS NEW. Because upstream re-runs the same query
 * forever, most of what a run returns is what the last run returned — the same
 * peers, still holding the same files. A badge that fires on those is telling
 * you the same thing every twelve minutes, so the split between new and
 * already-seen is what makes the badge mean anything. See `domain/wishSeen.ts`
 * for why the split is frozen at ingest rather than re-derived at render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { adaptSearchResult, isAudioPath } from './adapt.ts';
import type { WireSearchResultData } from './adapt.ts';
import { createGrouper } from '../domain/group.ts';
import { reliabilityFrom } from '../domain/score.ts';
import { idsOf, splitSeen } from '../domain/wishSeen.ts';
import type { Release, SourceFile } from '../domain/types.ts';

/** Per wish, so one popular query cannot crowd out the rest. */
const PER_WISH_CAP = 400;

export interface WishHit {
  query: string;
  /** Everything this run returned, new and repeat alike. */
  sources: SourceFile[];
  /** Only what no previous run showed you. What the badge is about. */
  fresh: SourceFile[];
  releases: Release[];
  peerCount: number;
  /** How many of `sources` had already been shown. `sources.length - fresh.length`. */
  seenCount: number;
  /** Epoch ms of the most recent result. */
  foundAt: number;
  /** False once these have been looked at. Drives the badge, not the list. */
  unseen: boolean;
}

export interface WishHits {
  /** Keyed by the wish text, which is what upstream keys the wishlist by. */
  byQuery: Record<string, WishHit>;
  /** Wishes holding results NO earlier run showed you. The sidebar badge. */
  unseenCount: number;
  /** Remember this wish's results so a later run does not announce them again. */
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

  /* What each wish has already shown you, loaded from the sidecar once. A ref
     rather than state: it is read during ingest and never rendered, and
     putting it in state would re-run the subscription effect on every mark. */
  const seen = useRef(new Map<string, Set<string>>());
  /* The seen-set AS IT STOOD when this run began. Frozen, because opening a
     wish marks its results seen — judged against the live set, a run would
     start reporting its own results as old the moment you looked at them. */
  const seenAtRunStart = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    if (!client) return;

    /* Asked for once, not carried on `wishlist.state`: that event fires
       whenever the list or the interval changes, and this is a few thousand
       hashes. The app is the only writer, so one read is enough. */
    let live = true;
    void client.request<{ items: { query: string; ids: string[] }[] }>('wishlist.seenList')
      .then((r) => {
        if (!live) return;
        for (const item of r.items) {
          // MERGE, never replace: a run that landed before this reply came
          // back has already recorded what it marked.
          const set = seen.current.get(item.query) ?? new Set<string>();
          for (const id of item.ids) set.add(id);
          seen.current.set(item.query, set);
        }
      })
      .catch(() => { /* An unreadable seen-set means everything reads as new. */ });

    const offStarted = client.on('search.started', (d) => {
      const ev = d as StartedEvent;
      // The only signal separating a wish from something the user typed.
      if (ev.mode !== 'wishlist') return;
      queryOf.current.set(ev.searchId, ev.query);
      // A new run supersedes the last one — see the header.
      groupers.current.set(ev.query, createGrouper());
      // Freeze what counts as "already shown" for the whole of this run.
      seenAtRunStart.current.set(
        ev.query, new Set(seen.current.get(ev.query) ?? []),
      );
      setByQuery((prev) => ({
        ...prev,
        [ev.query]: {
          query: ev.query, sources: [], fresh: [], releases: [], peerCount: 0,
          seenCount: 0,
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
      const { fresh, seenCount } = splitSeen(
        all, seenAtRunStart.current.get(query) ?? new Set(),
      );
      setByQuery((prev) => ({
        ...prev,
        [query]: {
          query,
          sources: all,
          fresh,
          releases: grouper.releases(all),
          peerCount: new Set(all.map((s) => s.user)).size,
          seenCount,
          foundAt: Date.now(),
          // A run that turned up nothing you have not already been shown is
          // not news, and must not light the badge.
          unseen: fresh.length > 0,
        },
      }));
    });

    return () => { live = false; offStarted(); offResult(); };
  }, [client]);

  /* You looked, so none of this is news any more — including the repeats,
     which is what stops them ageing out of the sidecar's window while they are
     still being offered. Recorded locally FIRST so the next run is judged
     correctly even if the socket drops on the way. */
  const markSeen = useCallback((query: string) => {
    const hit = byQuery[query];
    if (!hit || hit.sources.length === 0) return;

    const ids = idsOf(hit.sources);
    const set = seen.current.get(query) ?? new Set<string>();
    for (const id of ids) set.add(id);
    seen.current.set(query, set);

    /* The count on screen becomes the honest one straight away: they are all
       old now. `fresh` is deliberately NOT recomputed for other wishes — see
       the note on freezing in domain/wishSeen.ts. */
    setByQuery((prev) => (prev[query]
      ? { ...prev, [query]: { ...prev[query], unseen: false, fresh: [],
        seenCount: prev[query].sources.length } }
      : prev));

    void client?.request('wishlist.seen', { query, ids }).catch(() => {
      /* Best effort. A failed write costs one repeated announcement next run,
         which is the status quo ante, not a broken screen. */
    });
  }, [client, byQuery]);

  const forget = useCallback((query: string) => {
    groupers.current.delete(query);
    seen.current.delete(query);
    seenAtRunStart.current.delete(query);
    setByQuery((prev) => {
      if (!(query in prev)) return prev;
      const next = { ...prev };
      delete next[query];
      return next;
    });
  }, []);

  return {
    byQuery,
    /* `unseen` is set from `fresh.length > 0` at ingest and cleared by looking,
       so it already IS "holds something no earlier run showed you". Testing
       `fresh` here as well was a second copy of that rule that no test could
       tell apart from the first. */
    unseenCount: Object.values(byQuery).filter((h) => h.unseen).length,
    markSeen,
    forget,
  };
}
