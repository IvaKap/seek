/*
 * Seek — the virtualised result list, and the solution to the list-animation trap.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The trap, from the brief: hundreds of results arrive in bursts while the user
 * is scrolling and filtering. Naive per-row enter animations plus virtualisation
 * equals visual chaos. Five rules, each implemented here and marked:
 *
 *  [1] Batch into ~250ms ticks          — in searchStore, not here.
 *  [2] Stable content-derived keys      — `row.id` from the grouper, never an index.
 *  [3] Animate at the group level       — only rows from the newest tick that are
 *                                         actually on screen animate, all on the
 *                                         same frame with a capped stagger. A
 *                                         2,000-row list never runs 2,000 springs.
 *  [4] Freeze while scrolling           — `isScrolling` suppresses entry entirely.
 *  [5] Never re-sort under the cursor   — the store withholds rows that would land
 *                                         above the viewport; this renders the pill.
 *
 * Filtering does not blank and redraw: outgoing rows fade in place for 180ms,
 * and then the survivors SLIDE to their new offsets, because the virtualiser
 * positions every row by `transform` and we enable a transition on exactly that
 * property for the length of the reflow. That is a FLIP with no measurement code.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Row } from '../data/searchStore.ts';
import type { Release } from '../domain/types.ts';
import { copiesOf } from '../domain/bestSources.ts';
import { SourceRow, TrackRow, UserRow } from './rows.tsx';
import { ReleaseCard } from './ReleaseCard.tsx';
import type { PeerLookup } from './PeerHistory.tsx';
import type { SearchDensity } from './ViewMenu.tsx';
import {
  ALL_COLUMNS, COLUMNS, DEFAULT_COLUMNS, templateFor, visibleColumns,
} from '../domain/searchColumns.ts';
import type { ColumnId } from '../domain/searchColumns.ts';
import { IconArrowUp } from '../icons/index.tsx';
import { integer } from '../domain/format.ts';
import { SPRING_DEFAULT, Spring } from '../motion/spring.ts';
import { useReducedMotion } from '../motion/prefs.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { LibrarySession } from '../data/libraryStore.ts';

/*
 * Estimates only — the virtualiser measures the real height of every row. They
 * are expressed in REM-equivalents and multiplied by the live root font size,
 * because a fixed pixel estimate is badly wrong once the user scales text: at
 * 200% the real rows are twice these numbers, and the list lays out overlapping
 * rows until measurement catches up.
 */
const H_SOURCE_REM = 34 / 16;
const H_ROW_REM: Record<SearchDensity, number> = { comfortable: 52 / 16, compact: 44 / 16, table: 32 / 16 };
const H_CARD_REM: Record<SearchDensity, number> = { comfortable: 108 / 16, compact: 64 / 16, table: 34 / 16 };

/** The root font size in px, tracked live so text scaling re-measures the list. */
function useRootFontSize(): number {
  const [px, setPx] = useState(() =>
    typeof window === 'undefined'
      ? 16
      : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
  );
  useEffect(() => {
    const read = () => {
      const next = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setPx((cur) => (Math.abs(cur - next) > 0.5 ? next : cur));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  return px;
}

/**
 * The results container's width in REM, tracked live.
 *
 * Rem rather than pixels, and measured rather than declared in a media query,
 * for the same reason the rules this replaces were container queries: `rem` in
 * a media query resolves against the INITIAL font size, so it never fires when
 * the OS scales text — and a table that keeps nine columns at 200% text is a
 * table that overflows.
 */
function useWidthRem(ref: React.RefObject<HTMLElement | null>, rootPx: number): number {
  const [px, setPx] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof ResizeObserver !== 'function') {
      setPx(node.getBoundingClientRect().width);
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      setPx(entry.contentRect.width);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [ref]);
  // 0 before the first measurement: report a very wide container so the first
  // paint shows every chosen column rather than flashing a stripped-down table.
  return px === 0 ? Number.POSITIVE_INFINITY : px / rootPx;
}

const EXIT_MS = 180;
const REFLOW_MS = 260;
/** Cap the stagger so a burst never takes longer than a beat to land. */
const STAGGER_MS = 26;
const STAGGER_MAX = 130;

export function ResultList({
  rows, currentTick, expanded, onToggle, onQueue, onBrowse, onContext, pendingCount, onFoldIn,
  onViewport, emptyState, density, columns = DEFAULT_COLUMNS, artwork, library, peers,
  copies, onCompare,
}: {
  rows: Row[];
  currentTick: number;
  density: SearchDensity;
  /** Chosen table columns, in order. Ignored at other densities. */
  columns?: ColumnId[];
  expanded: Set<string>;
  onToggle(id: string): void;
  onQueue(row: Row): void;
  onBrowse?(username: string): void;
  onContext?(row: Row, x: number, y: number): void;
  artwork?: ArtworkSession;
  library?: LibrarySession;
  /** Your own transfer history with each peer. Absent means never met. */
  peers?: PeerLookup;
  /** Release id to every copy of that record, grouped once by the view. */
  copies?: Map<string, Release[]>;
  /** Open the comparison for a release. Downloads nothing by itself. */
  onCompare?(release: Release): void;
  pendingCount: number;
  onFoldIn(): void;
  onViewport(first: number, atTop: boolean): void;
  emptyState: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const rootPx = useRootFontSize();
  /* Which columns actually fit, and the grid they imply. Computed here and
     handed down as a custom property so the header and every row subscribe to
     ONE track list — the alignment guarantee the table has always depended on,
     now with a set that can change. */
  const widthRem = useWidthRem(resultsRef, rootPx);
  const shownColumns = useMemo(
    () => (density === 'table' ? visibleColumns(columns, widthRem) : columns),
    [density, columns, widthRem],
  );
  /* The template, plus a position and a visibility for every column.
   *
   * Custom properties rather than restructuring the rows: the cells already sit
   * in a fixed DOM order inside each row type, and grid `order` moves them
   * without any of the three row components needing to know what the user
   * chose. A column that is not shown is hidden rather than unmounted, so the
   * DOM stays identical whatever the width — which is what lets the header and
   * the rows share one track list without either counting children. */
  const columnStyle = useMemo(() => {
    const style: Record<string, string> = { '--cols': templateFor(shownColumns) };
    for (const id of ALL_COLUMNS) {
      const at = shownColumns.indexOf(id);
      style[`--ord-${id}`] = String(at < 0 ? 99 : at);
      style[`--vis-${id}`] = at < 0 ? 'none' : 'inline-flex';
    }
    return style as React.CSSProperties;
  }, [shownColumns]);

  /* ---- [rows lag the store so removals can animate out] ---- */
  const [display, setDisplay] = useState<Row[]>(rows);
  const [exiting, setExiting] = useState<Set<string>>(() => new Set());
  const [reflowing, setReflowing] = useState(false);
  const prevRows = useRef<Row[]>(rows);

  useEffect(() => {
    const prev = prevRows.current;
    prevRows.current = rows;

    const nextIds = new Set(rows.map((r) => r.id));
    const removed = prev.filter((r) => !nextIds.has(r.id)).map((r) => r.id);

    // Additions and reorders commit straight away; only removals need the
    // outgoing phase, and reduced motion skips it entirely.
    if (removed.length === 0 || reduced) {
      setExiting(new Set());
      setDisplay(rows);
      return;
    }

    setExiting(new Set(removed));
    const t1 = window.setTimeout(() => {
      setDisplay(rows);
      setExiting(new Set());
      setReflowing(true);
    }, EXIT_MS);
    const t2 = window.setTimeout(() => setReflowing(false), EXIT_MS + REFLOW_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [rows, reduced]);

  /* A scroll during the reflow window invalidates it. The virtualiser is
   * recycling nodes to new offsets, and `.row-slot` transforms are how it
   * positions them — so a transform transition would slide a recycled row
   * across the viewport instead of placing it. Gating the attribute on
   * `isScrolling` alone is not enough: `reflowing` would still be true on
   * scroll-idle and animate a stale delta. Cancel it outright. */
  useEffect(() => {
    if (!reflowing) return;
    const el = scrollRef.current;
    if (!el) return;
    const cancel = () => setReflowing(false);
    el.addEventListener('scroll', cancel, { passive: true, once: true });
    return () => el.removeEventListener('scroll', cancel);
  }, [reflowing]);

  /* ---- virtualiser ---- */
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const kind = display[i]?.kind;
      const rem = kind === 'source'
        ? H_SOURCE_REM
        : kind === 'release'
          ? H_CARD_REM[density]
          : H_ROW_REM[density];
      return Math.round(rem * rootPx);
    },
    overscan: 10,
    // [2] Content-derived key. An index key here would reuse a DOM node for a
    // different track every time the sort changed.
    getItemKey: (i) => display[i]?.id ?? i,
  });

  // Density and text size both change every row height; drop the measurement
  // cache so the virtualiser re-measures instead of positioning against stale
  // sizes and overlapping rows.
  useLayoutEffect(() => { virtualizer.measure(); }, [density, rootPx, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const isScrolling = virtualizer.isScrolling;

  /* ---- artwork for what is actually on screen ----
   *
   * `items` is the virtualiser's window plus overscan, so this is viewport
   * scoped by construction rather than by a scroll listener. `want()` ignores
   * keys it already knows, so running this every render is free after the
   * first pass. */
  useEffect(() => {
    if (!artwork?.enabled) return;
    for (const item of items) {
      const row = display[item.index];
      if (row?.kind === 'release') {
        artwork.want(row.release.id, row.release.artist, row.release.title);
      }
    }
  }, [items, display, artwork]);

  /* ---- report the viewport so the store knows what it must not reorder ---- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = items.length > 0 ? items[0].index : 0;
    onViewport(first, el.scrollTop <= 4);
  }, [items, onViewport]);

  /* ---- scroll-edge fade on the pane ---- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pane = el.closest('.pane') as HTMLElement | null;
    const onScroll = () => {
      if (pane) pane.dataset.scrolled = el.scrollTop > 6 ? 'true' : 'false';
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /* ---- [3][4] which rows may animate in ---- */
  // Only rows from the newest tick, only those actually rendered, and never
  // while the user is scrolling. Everything else simply exists.
  const enterFrom = useRef(-1);
  useLayoutEffect(() => {
    enterFrom.current = currentTick;
  }, [currentTick]);

  let staggerIndex = 0;

  /* ---- spring-driven scroll to top, interruptible ---- */
  const springRef = useRef<Spring | null>(null);
  const rafRef = useRef(0);

  const cancelScroll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    springRef.current = null;
  }, []);

  const springToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (reduced) {
      el.scrollTop = 0;
      return;
    }
    const s = new Spring(el.scrollTop, SPRING_DEFAULT);
    s.setTarget(0);
    springRef.current = s;
    let last = performance.now();
    const step = (now: number) => {
      const cur = springRef.current;
      if (!cur || !scrollRef.current) return;
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      scrollRef.current.scrollTop = cur.advance(dt);
      if (!cur.settled) rafRef.current = requestAnimationFrame(step);
      else cancelScroll();
    };
    rafRef.current = requestAnimationFrame(step);
  }, [reduced, cancelScroll]);

  // Any real input grabs the animation away from us — a scroll the user cannot
  // interrupt is a scroll that has taken control from them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grab = () => cancelScroll();
    el.addEventListener('wheel', grab, { passive: true });
    el.addEventListener('pointerdown', grab, { passive: true });
    el.addEventListener('touchstart', grab, { passive: true });
    return () => {
      el.removeEventListener('wheel', grab);
      el.removeEventListener('pointerdown', grab);
      el.removeEventListener('touchstart', grab);
    };
  }, [cancelScroll]);

  useEffect(() => cancelScroll, [cancelScroll]);

  const foldIn = useCallback(() => {
    onFoldIn();
    springToTop();
  }, [onFoldIn, springToTop]);

  return (
    <div className="results" ref={resultsRef} style={columnStyle}>
      {/* [5] The single most important interaction decision in the app: new
          results that would sort above the scroll position wait here instead of
          shifting the list the user is reading. */}
      <div className="pill-zone" aria-live="polite">
        {pendingCount > 0 && (
          <button type="button" className="pill pressable" onPointerDown={foldIn}>
            <IconArrowUp size={14} painted={1.7} />
            <span className="tnum">{integer(pendingCount)}</span>
            <span>new {pendingCount === 1 ? 'result' : 'results'}</span>
          </button>
        )}
      </div>

      {density === 'table' && rows.length > 0 && (
        /* A table without a header row cannot be read: nothing tells you whether
           a bare number is a queue depth or a file count. */
        <div className="thead" role="row" aria-hidden>
          {shownColumns.map((id: ColumnId) => (
            <span key={id} data-col={id}>{COLUMNS[id].label}</span>
          ))}
        </div>
      )}

      <div className="scroller" ref={scrollRef} tabIndex={-1}>
        {display.length === 0 ? (
          emptyState
        ) : (
          <div
            className="list-canvas"
            ref={canvasRef}
            data-density={density}
            data-reflow={reflowing && !isScrolling ? 'true' : undefined}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => {
              const row = display[item.index];
              if (!row) return null;
              const isNew = row.tick === enterFrom.current && enterFrom.current > 0;
              const animate = isNew && !isScrolling && !reduced;
              const delay = animate ? Math.min(staggerIndex++ * STAGGER_MS, STAGGER_MAX) : 0;

              return (
                <div
                  key={item.key}
                  className="row-slot"
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-enter={animate ? '1' : undefined}
                  data-exiting={exiting.has(row.id) ? 'true' : undefined}
                  onContextMenu={(e) => {
                    if (!onContext) return;
                    e.preventDefault();
                    onContext(row, e.clientX, e.clientY);
                  }}
                  style={{
                    transform: `translate3d(0, ${item.start}px, 0)`,
                    animationDelay: delay ? `${delay}ms` : undefined,
                  }}
                >
                  {renderRow(row, expanded, onToggle, onQueue, density, onBrowse, artwork, peers,
                    library, copies, onCompare)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function renderRow(
  row: Row,
  expanded: Set<string>,
  onToggle: (id: string) => void,
  onQueue: (row: Row) => void,
  density: SearchDensity,
  onBrowse?: (username: string) => void,
  artwork?: ArtworkSession,
  peers?: PeerLookup,
  library?: LibrarySession,
  copies?: Map<string, Release[]>,
  onCompare?: (release: Release) => void,
) {
  switch (row.kind) {
    case 'track':
      return (
        <TrackRow
          track={row.track}
          expanded={expanded.has(row.id)}
          onToggle={() => onToggle(row.id)}
          onQueue={() => onQueue(row)}
          selected={false}
        />
      );
    case 'release': {
      // A lone copy has nothing to compare against, so the card offers nothing.
      const group = copies ? copiesOf(row.release, copies) : [row.release];
      return (
        <ReleaseCard
          art={artwork?.get(row.release.id)}
          owned={library?.hasRelease(row.release.artist, row.release.title)}
          release={row.release}
          expanded={expanded.has(row.id)}
          onToggle={() => onToggle(row.id)}
          onQueue={() => onQueue(row)}
          density={density}
          peers={peers}
          copyCount={group.length}
          onCompare={onCompare ? () => onCompare(row.release) : undefined}
        />
      );
    }
    case 'user':
      return (
        <UserRow
          group={row.group}
          expanded={expanded.has(row.id)}
          onToggle={() => onToggle(row.id)}
          selected={false}
          onBrowse={onBrowse}
        />
      );
    case 'source':
      return (
        <SourceRow
          source={row.source}
          last={row.last}
          context={row.context}
          onQueue={() => onQueue(row)}
          peers={peers}
        />
      );
  }
}
