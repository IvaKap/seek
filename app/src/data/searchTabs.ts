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

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * Run a search, in a NEW tab unless this one has never been used.
   *
   * Every search getting its own tab is the point — the last one is never
   * destroyed. The exception matters as much as the rule: searching in a tab
   * you just opened must not open a second one beside it and leave the first
   * blank forever.
   */
  openWith(query: string): void;
  /** Close one. Never closes the last: an empty window is not a state. */
  close(id: string): void;
  /**
   * This tab did its job — something was queued from it.
   *
   * Stamped rather than closed: you often queue two records from one set of
   * results, and a tab that vanished on the first would take the second with
   * it. The sweep collects it later.
   */
  markUsed(): void;
}

let seq = 0;
const nextId = () => `tab${++seq}`;

/**
 * How long a tab lives after something was queued from it.
 *
 * Iva's number. A search you have taken what you wanted from is spent, but not
 * immediately — you come back to it, check what else was in the folder, queue a
 * second record. Forty-five minutes is long enough to do that and short enough
 * that an evening's digging does not end in thirty tabs.
 */
const EXPIRE_MS = 45 * 60 * 1000;
/** Checked once a minute; nothing here is urgent to the second. */
const SWEEP_MS = 60 * 1000;

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
  /* When something was queued from a tab. Absent means it is still in use. */
  const usedAt = useRef<Map<string, number>>(new Map());
  /* What each tab last searched for. Absent means it has never run one, which
     is what makes a brand-new tab searchable in place. */
  const ranQuery = useRef<Map<string, string>>(new Map());

  /* The sweep runs on an interval and must see the CURRENT list, not the one
   * that existed when the effect was created. Reading refs rather than adding
   * these to the deps keeps one interval alive for the life of the component
   * instead of tearing it down and rebuilding it on every keystroke. */
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  /**
   * What a tab is called.
   *
   * What it SEARCHED FOR, not what is in the box. Those are the same thing
   * until you start typing the next query — and at that moment the old tab
   * would take the new text as its name, so opening a tab left two of them
   * wearing the same label and the one you came from was unfindable.
   *
   * A tab that has never searched falls back to the box, which is how a fresh
   * tab shows what you are typing into it before you commit.
   */
  const nameOf = useCallback((id: string) => (
    ranQuery.current.get(id) ?? (session.query.trim() || BLANK)
  ), [session.query]);

  labels.current.set(activeId, nameOf(activeId));

  const select = useCallback((id: string) => {
    if (id === activeId) return;
    parked.current.set(activeId, session.snapshot());
    labels.current.set(activeId, nameOf(activeId));
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
    labels.current.set(activeId, nameOf(activeId));
    labels.current.set(id, BLANK);
    session.restore(blank(session));
    setIds((prev) => [...prev, id]);
    setActiveId(id);
    return id;
  }, [activeId, session, nameOf]);

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
    usedAt.current.delete(id);
    ranQuery.current.delete(id);

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

  const openWith = useCallback((query: string) => {
    const text = query.trim();
    if (!text) return;

    /* Three cases, and only one of them opens a tab.
     *
     * A tab that has never run a search IS the fresh one — opening another
     * would leave a blank tab beside the results on the very first use. And
     * pressing Return twice on the same text is a RE-RUN, not a second search;
     * treating it as new would put an identical tab beside the one you are
     * already looking at.
     *
     * Note this cannot be decided from `session.query`: on the ordinary path
     * that is the text being searched for right now, so it is never empty when
     * this is called. What matters is whether this tab has run anything BEFORE,
     * which is what the map records. */
    const ran = ranQuery.current.get(activeRef.current);
    if (ran !== undefined && ran !== text) {
      ranQuery.current.set(open(), text);
    } else {
      ranQuery.current.set(activeRef.current, text);
    }
    session.run(text);
  }, [open, session]);

  const markUsed = useCallback(() => {
    usedAt.current.set(activeRef.current, Date.now());
  }, []);

  /* Collect spent tabs.
   *
   * Everything decided OUT HERE, with `setIds` receiving a finished list —
   * React double-invokes updaters in development to surface impure ones, and
   * deleting from these refs inside the updater is exactly the mistake `close`
   * already had to be rewritten to avoid. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - EXPIRE_MS;
      const doomed = idsRef.current.filter((id) => (
        /* Never the tab being read, whatever its age — a tab disappearing
         * while you are looking at it is worse than any number of stale ones. */
        id !== activeRef.current
        && (usedAt.current.get(id) ?? Infinity) <= cutoff
      ));
      if (doomed.length === 0) return;

      const next = idsRef.current.filter((id) => !doomed.includes(id));
      if (next.length === 0) return;          // never empty the strip
      for (const id of doomed) {
        parked.current.delete(id);
        labels.current.delete(id);
        usedAt.current.delete(id);
        ranQuery.current.delete(id);
      }
      setIds(next);
    }, SWEEP_MS);
    return () => window.clearInterval(timer);
  }, []);

  return {
    tabs: ids.map((id) => ({
      id,
      label: labels.current.get(id) ?? BLANK,
      running: id === activeId && session.running,
    })),
    activeId,
    select,
    open,
    openWith,
    close,
    markUsed,
  };
}
