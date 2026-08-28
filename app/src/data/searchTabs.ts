/*
 * Seek — several searches open at once.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHAT A TAB IS, and what it deliberately is not.
 *
 * One search runs at a time. That is the transport's rule rather than a choice
 * made here: `sidecar.start()` replaces the previous search's handlers, because
 * the client models a single running search (see connectionStore.ts). So a tab
 * is not a second engine — it is a search PUT AWAY, with everything needed to
 * bring it back: its files, its filters, its grouping, its sort, what was
 * expanded, and why it stopped.
 *
 * The thing that was actually asked for is that a new search stop destroying
 * the last one. Before this, the single field replaced the results and they
 * were gone. Now they are a tab, and going back to it is exact.
 *
 * THE ONE LIMITATION, stated rather than hidden: leaving a tab whose search is
 * still streaming stops it. It has to — the next thing that starts takes the
 * transport — so the tab you left keeps the results it had at that moment and
 * reports that it was stopped. A search runs for about thirty seconds, so this
 * is the corner rather than the common case, but a tab that quietly lost its
 * tail would be worse than one that says so.
 */

import { useCallback, useRef, useState } from 'react';
import type { SearchSession, SearchSnapshot } from './searchStore.ts';

export interface SearchTab {
  id: string;
  /** What to print on the tab. The query, or a placeholder before one is run. */
  label: string;
  /** True for the tab whose search is on the wire right now. */
  running: boolean;
}

export interface SearchTabs {
  tabs: SearchTab[];
  activeId: string;
  /** Switch to a tab, putting the current one away first. */
  select(id: string): void;
  /** A new empty tab, focused. Returns its id. */
  open(): string;
  /** Close one. Never closes the last: an empty window is not a state. */
  close(id: string): void;
}

let seq = 0;
const nextId = () => `tab${++seq}`;

/** A tab that has never been searched. Filters and grouping carry over from the
 *  tab you were on, because those are how you like to READ results rather than
 *  anything about a particular query. */
function blank(session: SearchSession): SearchSnapshot {
  return {
    query: '', files: [], peers: [], filters: session.filters,
    groupBy: session.groupBy, sort: session.sort,
    expanded: new Set(), closedReason: null, tick: 0,
  };
}

/** The label a tab shows before anything has been searched in it. */
const BLANK = 'New search';

export function useSearchTabs(session: SearchSession): SearchTabs {
  const [ids, setIds] = useState<string[]>(() => [nextId()]);
  const [activeId, setActiveId] = useState(() => ids[0]);
  /* Snapshots of the tabs that are NOT active. The active tab has no snapshot —
   * it is the live session, and a copy of it would be a second version of the
   * same thing, immediately able to disagree. */
  const parked = useRef<Map<string, SearchSnapshot>>(new Map());
  /* Labels are kept separately from snapshots so a tab that has never been
   * searched still has a name. */
  const labels = useRef<Map<string, string>>(new Map());

  labels.current.set(activeId, session.query.trim() || BLANK);

  const select = useCallback((id: string) => {
    if (id === activeId) return;
    parked.current.set(activeId, session.snapshot());
    labels.current.set(activeId, session.query.trim() || BLANK);
    const snap = parked.current.get(id);
    if (snap) {
      parked.current.delete(id);
      session.restore(snap);
    } else {
      // A tab that has never run: an empty search rather than the last one's
      // results wearing a new name.
      session.restore(blank(session));
    }
    setActiveId(id);
  }, [activeId, session]);

  const open = useCallback(() => {
    const id = nextId();
    parked.current.set(activeId, session.snapshot());
    labels.current.set(activeId, session.query.trim() || BLANK);
    labels.current.set(id, BLANK);
    session.restore(blank(session));
    setIds((prev) => [...prev, id]);
    setActiveId(id);
    return id;
  }, [activeId, session]);

  const close = useCallback((id: string) => {
    /* Everything happens OUT HERE, and the updater below only computes a list.
     * The first version restored the neighbour's snapshot inside the `setIds`
     * updater, which React invokes twice in development to surface impure ones
     * — and this one was: it consumed the snapshot on the first pass, so the
     * second found nothing and restored an empty search. Closing the active tab
     * emptied the screen instead of showing the tab beside it. */
    if (ids.length === 1) return;              // never close the last one
    const at = ids.indexOf(id);
    if (at < 0) return;
    const next = ids.filter((x) => x !== id);
    parked.current.delete(id);
    labels.current.delete(id);

    if (id === activeId) {
      // Focus the neighbour, the way every tab strip does: the one to the
      // right, or the left when there is nothing to the right.
      const heir = next[Math.min(at, next.length - 1)];
      const snap = parked.current.get(heir);
      parked.current.delete(heir);
      session.restore(snap ?? blank(session));
      setActiveId(heir);
    }
    setIds(next);
  }, [ids, activeId, session]);

  return {
    tabs: ids.map((id) => ({
      id,
      label: labels.current.get(id) ?? BLANK,
      running: id === activeId && session.running,
    })),
    activeId,
    select,
    open,
    close,
  };
}
