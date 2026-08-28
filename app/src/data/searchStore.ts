/*
 * Seek — the search session: ingest, batching, filtering, and row order.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Three things here are load-bearing for how the list feels.
 *
 * 1. BATCHING. Results arrive per-peer, hundreds of times over thirty seconds.
 *    They are buffered and flushed on a ~250ms tick, so the list reflows four
 *    times a second at most, never once per packet.
 *
 * 2. FROZEN PREFIX. Rows above the user's scroll position are never reordered.
 *    On each tick the list is split at the first visible row: everything above
 *    it keeps its exact order, everything below is free to re-sort because the
 *    user cannot see it happen. New rows that would land in the frozen prefix
 *    are not inserted at all — they are queued, and the "N new results ↑" pill
 *    is how the user asks for them. At scroll top the prefix is empty, so
 *    everything sorts freely and nothing is ever withheld unnecessarily.
 *
 * 3. PRE-INDEXED FILTERING. Everything a filter reads is computed once on
 *    ingest, so applying one is a linear scan over primitives.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Filters, GroupBy, Release, SortKey, SourceFile, TrackCluster, UserGroup } from '../domain/types.ts';
import { EMPTY_FILTERS } from '../domain/types.ts';
import { createGrouper, matches, terms } from '../domain/group.ts';
import { TIER_RANK } from '../domain/quality.ts';
import { reliabilityFrom } from '../domain/score.ts';
import { adaptSearchResult, isAudioPath } from './adapt.ts';
import type { WireSearchClosedData, WireSearchResultData } from './adapt.ts';
import type { SidecarConnection } from './connectionStore.ts';
import type { ConnectionPhase, SidecarClient } from './sidecarClient.ts';

export const TICK_MS = 250;

/**
 * ConnectionStatus is `offline | connecting | online | away | failed` — there is
 * no 'connected'. `away` is still logged in, so it counts. Keep this predicate
 * as the single place that knows the vocabulary.
 */
export function isSignedIn(serverState: string | null): boolean {
  return serverState === 'online' || serverState === 'away';
}

export type Row =
  | { kind: 'track'; id: string; track: TrackCluster; tick: number }
  | { kind: 'release'; id: string; release: Release; tick: number }
  | { kind: 'user'; id: string; group: UserGroup; tick: number }
  | {
      kind: 'source'; id: string; source: SourceFile; parentId: string;
      last: boolean; tick: number;
      /* What the nested rows actually ARE, which decides what identifies them.
       * Under a track cluster they are PEOPLE offering the same track, so the
       * username is the identity. Under a release or a user group they are
       * FILES from one person — the username is identical on every row and the
       * track title is the only thing telling them apart. */
      context: 'peers' | 'files';
    };

/* ------------------------------------------------------------- comparators */

function trackValue(t: TrackCluster, key: SortKey): number | string {
  switch (key) {
    case 'quality': return -TIER_RANK[t.topTier] * 1000 - t.best.quality.score;
    case 'speed': return -t.best.peer.advertisedSpeed;
    case 'queue': return t.best.peer.queueLength;
    case 'size': return -t.best.size;
    case 'name': return `${t.displayArtist ?? ''} ${t.displayTitle}`.toLowerCase();
    default: return -t.best.score;
  }
}

function releaseValue(r: Release, key: SortKey): number | string {
  switch (key) {
    case 'quality': return -TIER_RANK[r.dominantTier] * 1000;
    case 'speed': return -r.peer.advertisedSpeed;
    case 'queue': return r.peer.queueLength;
    case 'size': return -r.totalSize;
    case 'name': return `${r.artist ?? ''} ${r.title}`.toLowerCase();
    default: return -r.score;
  }
}

function userValue(u: UserGroup, key: SortKey): number | string {
  switch (key) {
    case 'quality': return -TIER_RANK[u.bestTier] * 1000;
    case 'speed': return -u.peer.advertisedSpeed;
    case 'queue': return u.peer.queueLength;
    case 'size': return -u.totalSize;
    case 'name': return u.user.toLowerCase();
    default: return -u.score;
  }
}

function rowValue(row: Row, key: SortKey): number | string {
  if (row.kind === 'track') return trackValue(row.track, key);
  if (row.kind === 'release') return releaseValue(row.release, key);
  if (row.kind === 'user') return userValue(row.group, key);
  return 0;
}

function compare(a: Row, b: Row, key: SortKey): number {
  const av = rowValue(a, key);
  const bv = rowValue(b, key);
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv));
  }
  if (av !== bv) return av - bv;
  // Ties broken by id so the order is deterministic rather than incidental.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ----------------------------------------------------------------- session */

/** Supplied by the app so scoring can use real transfer history. */
export interface SearchSessionOptions {
  reliability?(username: string): number;
}

export interface SearchSession {
  query: string;
  setQuery(q: string): void;
  run(query?: string): void;
  stop(): void;
  running: boolean;
  closedReason: string | null;

  /** Rows in render order, already filtered, grouped and sorted. */
  rows: Row[];
  /** Rows withheld because they would have sorted above the user's view. */
  pendingCount: number;
  foldInPending(): void;
  /** Called by the list on scroll so the store knows what to freeze. */
  reportViewport(firstVisibleIndex: number, atTop: boolean): void;

  totalFiles: number;
  matchedFiles: number;
  peerCount: number;
  /** Newest ingest tick — the list uses it to decide which rows may animate in. */
  tick: number;

  filters: Filters;
  setFilters(next: Filters): void;
  resetFilters(): void;
  groupBy: GroupBy;
  setGroupBy(g: GroupBy): void;
  sort: SortKey;
  setSort(s: SortKey): void;
  expanded: Set<string>;
  toggleExpanded(id: string): void;

  /** Formats present in the current result set, for the filter chips. */
  availableFormats: string[];

  /* ---- the bridge ---- */

  /** Socket state. 'closed' with a null client means deliberate offline/mock. */
  phase: ConnectionPhase;
  /** True when replaying the fixture rather than talking to a real sidecar. */
  isMock: boolean;
  /** Soulseek login state, distinct from the socket. Null until reported. */
  serverState: string | null;
  /** The live client, for Settings. Null in mock mode. */
  client: SidecarClient | null;
  /** Why the Tauri shell could not start a sidecar, if it could not. */
  startupError: string | null;
}

export function useSearchSession(
  /* The shared connection. Passed in rather than created here: one of these
   * exists per TAB, and a hook that opened a socket would open one per tab —
   * five tabs, five sign-ins, five copies of every event. See
   * connectionStore.ts. */
  conn: SidecarConnection,
  options: SearchSessionOptions = {},
): SearchSession {
  const grouper = useMemo(() => createGrouper(), []);

  const { client, sidecar, phase, serverState, startupError } = conn;

  const [query, setQuery] = useState('burial');
  const [running, setRunning] = useState(false);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<Filters>(EMPTY_FILTERS);
  // docs/PRODUCT.md §4: release cards are the default presentation.
  const [groupBy, setGroupByState] = useState<GroupBy>('release');
  const [sort, setSortState] = useState<SortKey>('best');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  /** Bumped once per flushed tick; the only thing that triggers a re-render. */
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<Row[]>([]);

  /* Reliability is read through a ref, not captured. `flush` is memoised on
   * [grouper] alone so the batching tick is stable, and a captured lookup would
   * pin the counts as they were when the search started — a peer whose transfer
   * failed mid-search would keep scoring as if it had not. */
  const reliabilityRef = useRef<(username: string) => number>(() => reliabilityFrom(0, 0));
  reliabilityRef.current = options.reliability ?? ((): number => reliabilityFrom(0, 0));

  const buffer = useRef<WireSearchResultData[]>([]);
  const tickRef = useRef(0);
  const peers = useRef<Set<string>>(new Set());
  const order = useRef<string[]>([]);
  const viewport = useRef({ first: 0, atTop: true });
  /** Set when a fold-in or a filter change should re-sort everything. */
  const resortAll = useRef(true);

  /* ---- ingest, buffered ---- */

  const flush = useCallback(() => {
    const batch = buffer.current;
    if (batch.length === 0) return;
    buffer.current = [];
    tickRef.current += 1;

    for (const data of batch) {
      peers.current.add(data.peer.username);
      // Real responses carry non-audio files; they are not results.
      const audio = { ...data, files: data.files.filter((f) => isAudioPath(f.path)) };
      if (audio.files.length === 0) continue;
      const sources = adaptSearchResult(
        audio, tickRef.current, (username) => reliabilityRef.current(username),
      );
      for (const s of sources) grouper.add(s);
    }
    setTick(tickRef.current);
  }, [grouper]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(flush, TICK_MS);
    return () => window.clearInterval(id);
  }, [running, flush]);

  const run = useCallback(
    (q?: string) => {
      const text = (q ?? query).trim();
      if (!text) return;

      // Record it before running. Fire-and-forget: a history write that fails
      // must never stop a search, which is the thing the user actually asked
      // for. Only real searches count — replaying the fixture is not history.
      if (client) void client.request('history.record', { query: text }).catch(() => {});

      sidecar.stop();
      grouper.reset();
      buffer.current = [];
      peers.current = new Set();
      order.current = [];
      tickRef.current = 0;
      resortAll.current = true;
      setPending([]);
      setExpanded(new Set());
      setClosedReason(null);
      setTick(0);
      setRunning(true);

      sidecar.start(text, {
        onResult(data) {
          buffer.current.push(data);
        },
        onClosed(data: WireSearchClosedData) {
          flush();
          setRunning(false);
          setClosedReason(data.reason);
        },
      });
    },
    [query, sidecar, grouper, flush],
  );

  const stop = useCallback(() => {
    sidecar.stop();
    flush();
    setRunning(false);
    setClosedReason('stopped');
  }, [sidecar, flush]);

  useEffect(() => () => sidecar.stop(), [sidecar]);

  /* ---- derive: filter → group → sort ---- */

  const { rows: nextRows, matchedFiles, availableFormats } = useMemo(() => {
    void tick;
    const all = grouper.all;
    const inc = terms(filters.include);
    const exc = terms(filters.exclude);

    const kept: SourceFile[] = [];
    const formats = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      formats.add(all[i].quality.label);
      if (matches(all[i], filters, inc, exc)) kept.push(all[i]);
    }

    const out: Row[] = [];
    if (groupBy === 'track') {
      for (const t of grouper.tracks(kept)) out.push({ kind: 'track', id: t.id, track: t, tick: t.tick });
    } else if (groupBy === 'release') {
      for (const r of grouper.releases(kept)) out.push({ kind: 'release', id: r.id, release: r, tick: r.tick });
    } else {
      for (const u of grouper.users(kept)) out.push({ kind: 'user', id: u.id, group: u, tick: u.tick });
    }

    return {
      rows: out,
      matchedFiles: kept.length,
      availableFormats: [...formats].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
  }, [grouper, filters, groupBy, tick]);

  /* ---- order: frozen prefix + free suffix + queued ---- */

  const ordered = useMemo(() => {
    const byId = new Map<string, Row>();
    for (const r of nextRows) byId.set(r.id, r);

    // A full re-sort is correct after a filter change, a grouping change, a
    // fold-in, or while the user is parked at the top of the list.
    if (resortAll.current || viewport.current.atTop) {
      resortAll.current = false;
      const sorted = [...nextRows].sort((a, b) => compare(a, b, sort));
      order.current = sorted.map((r) => r.id);
      if (pending.length) setPending([]);
      return sorted;
    }

    const anchor = Math.max(0, Math.min(viewport.current.first, order.current.length));
    const prefix: Row[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < anchor; i++) {
      const row = byId.get(order.current[i]);
      if (row) {
        prefix.push(row);
        seen.add(row.id);
      }
    }

    const suffixExisting: Row[] = [];
    for (let i = anchor; i < order.current.length; i++) {
      const row = byId.get(order.current[i]);
      if (row && !seen.has(row.id)) {
        suffixExisting.push(row);
        seen.add(row.id);
      }
    }

    // Anything genuinely new since the last order was computed.
    const fresh: Row[] = [];
    for (const r of nextRows) if (!seen.has(r.id)) fresh.push(r);

    const boundary = prefix.length > 0 ? prefix[prefix.length - 1] : null;
    const queued: Row[] = [];
    for (const r of fresh) {
      // Would this row have landed above the user's first visible row?
      if (boundary && compare(r, boundary, sort) < 0) queued.push(r);
      else suffixExisting.push(r);
    }

    suffixExisting.sort((a, b) => compare(a, b, sort));
    const result = [...prefix, ...suffixExisting];
    order.current = result.map((r) => r.id);

    if (queued.length) {
      setPending((prev) => {
        const ids = new Set(prev.map((p) => p.id));
        const add = queued.filter((q) => !ids.has(q.id));
        return add.length ? [...prev, ...add] : prev;
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextRows, sort]);

  /* ---- expansion: source rows are flattened in, so one virtualiser sees all ---- */

  const rows = useMemo(() => {
    if (expanded.size === 0) return ordered;
    const out: Row[] = [];
    for (const row of ordered) {
      out.push(row);
      if (!expanded.has(row.id)) continue;
      if (row.kind === 'track') {
        const srcs = row.track.sources;
        srcs.forEach((s, i) =>
          out.push({
            kind: 'source', id: `${row.id}/${s.id}`, source: s,
            parentId: row.id, last: i === srcs.length - 1, tick: s.tick,
            context: 'peers',
          }),
        );
      } else if (row.kind === 'release') {
        const files = row.release.files;
        files.forEach((s, i) =>
          out.push({
            kind: 'source', id: `${row.id}/${s.id}`, source: s,
            parentId: row.id, last: i === files.length - 1, tick: s.tick,
            context: 'files',
          }),
        );
      } else if (row.kind === 'user') {
        const files = row.group.files;
        files.forEach((s, i) =>
          out.push({
            kind: 'source', id: `${row.id}/${s.id}`, source: s,
            parentId: row.id, last: i === files.length - 1, tick: s.tick,
            context: 'files',
          }),
        );
      }
    }
    return out;
  }, [ordered, expanded]);

  /* ---- controls ---- */

  const setFilters = useCallback((next: Filters) => {
    resortAll.current = true;
    setFiltersState(next);
  }, []);

  const resetFilters = useCallback(() => {
    resortAll.current = true;
    setFiltersState({ ...EMPTY_FILTERS, formats: new Set() });
  }, []);

  const setGroupBy = useCallback((g: GroupBy) => {
    resortAll.current = true;
    setExpanded(new Set());
    setGroupByState(g);
  }, []);

  const setSort = useCallback((s: SortKey) => {
    resortAll.current = true;
    setSortState(s);
  }, []);

  const foldInPending = useCallback(() => {
    resortAll.current = true;
    setPending([]);
    setTick((t) => t + 0.0001);
  }, []);

  const reportViewport = useCallback((first: number, atTop: boolean) => {
    viewport.current = { first, atTop };
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return {
    query, setQuery, run, stop, running, closedReason,
    rows,
    pendingCount: pending.length,
    foldInPending,
    reportViewport,
    tick: Math.floor(tick),
    totalFiles: grouper.size(),
    matchedFiles,
    peerCount: peers.current.size,
    filters, setFilters, resetFilters,
    groupBy, setGroupBy,
    sort, setSort,
    expanded, toggleExpanded,
    availableFormats,
    phase, isMock: client === null, serverState, client, startupError,
  };
}
