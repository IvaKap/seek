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

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Row } from '../data/searchStore.ts';
import type { Release } from '../domain/types.ts';
import { copiesOf } from '../domain/bestSources.ts';
import { FileRow, QueueButton, SourceRow, TrackRow, UserRow } from './rows.tsx';
import { Placeholder, ReleaseCard } from './ReleaseCard.tsx';
import { SimpleReleaseRow, SimpleTrackRow } from './AllCopies.tsx';
import { useNearViewport } from './useNearViewport.ts';
import type { PeerLookup } from './PeerHistory.tsx';
import type { SearchDensity } from './ViewMenu.tsx';
import {
  ALL_COLUMNS, DEFAULT_COLUMNS, SEARCH_COLUMN_SET, reorderColumns, templateFor,
} from '../domain/searchColumns.ts';
import type { ColumnId } from '../domain/searchColumns.ts';
import { useRootFontSize } from './useColumnFit.ts';
import { ColumnHeaderRow, useColumnWidths } from './columnHeaders.tsx';
import { IconArrowUp } from '../icons/index.tsx';
import { integer } from '../domain/format.ts';
import { driveSpring } from '../motion/spring.ts';
import type { SpringHandle } from '../motion/spring.ts';
import { useReducedMotion } from '../motion/prefs.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { LibrarySession } from '../data/libraryStore.ts';
import { folderKey } from '../data/transferStore.ts';
import type { QueueBadge, TransferState } from '../data/transferStore.ts';

/*
 * Estimates only — the virtualiser measures the real height of every row. They
 * are expressed in REM-equivalents and multiplied by the live root font size,
 * because a fixed pixel estimate is badly wrong once the user scales text: at
 * 200% the real rows are twice these numbers, and the list lays out overlapping
 * rows until measurement catches up.
 */
const H_SOURCE_REM = 34 / 16;
// `grid` never reaches the virtualiser (it renders as a plain CSS grid, below),
// but the records are keyed by the full density set, so it carries a value too.
const H_ROW_REM: Record<SearchDensity, number> = { comfortable: 52 / 16, compact: 44 / 16, table: 32 / 16, grid: 52 / 16 };
const H_CARD_REM: Record<SearchDensity, number> = { comfortable: 108 / 16, compact: 64 / 16, table: 34 / 16, grid: 108 / 16 };

/** Covers requested at once in grid; also the cap on cards rendered without
 *  virtualisation. Release grouping collapses a search to far fewer rows than
 *  this, so the cap is a guard, not a limit anyone reaches. */
const GRID_CAP = 300;

const EXIT_MS = 180;
const REFLOW_MS = 260;
/** Cap the stagger so a burst never takes longer than a beat to land. */
const STAGGER_MS = 26;
const STAGGER_MAX = 130;

export function ResultList({
  rows, currentTick, expanded, onToggle, onQueue, onBrowse, onContext, pendingCount, onFoldIn,
  onViewport, emptyState, density, columns = DEFAULT_COLUMNS, onColumns, artwork, library, peers,
  copies, onCompare, queueStates, folderStates, lead, simple = false,
}: {
  rows: Row[];
  currentTick: number;
  density: SearchDensity;
  /** Chosen table columns, in order. Ignored at other densities. */
  columns?: ColumnId[];
  /** A header was dragged to a new place. */
  onColumns?(next: ColumnId[]): void;
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
  /** Live per-file transfer states, so a Get button reflects what happened. */
  queueStates?: Map<string, TransferState>;
  /** Live per-folder badges, for a release card's Get. */
  folderStates?: Map<string, QueueBadge>;
  pendingCount: number;
  onFoldIn(): void;
  onViewport(first: number, atTop: boolean): void;
  emptyState: React.ReactNode;
  /** Shown above the rows and scrolled with them: Simple's best picks. */
  lead?: React.ReactNode;
  /** Simple's rows: one line of plain words per version (AllCopies.tsx). */
  simple?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const rootPx = useRootFontSize();
  /* Hand-set widths live as `--w-<id>` on `.results`, the one element above
     both the header and the rows. */
  const widths = useColumnWidths<ColumnId>('seek.search.colwidths', ALL_COLUMNS, resultsRef);
  /* The template, the table's minimum width, and a line and a visibility for
   * every column — all custom properties on `.results`, so the header and every
   * row subscribe to ONE track list.
   *
   * Each cell is placed on its column's grid line explicitly (`--col-<id>`),
   * never by `order` and auto-flow. Row kinds carry different cells — a release
   * has no Time of its own, a track row has no Folder — and under auto-flow a
   * missing cell shifted every later one a column to the left, so values
   * drifted out from under their headers. A column that is not shown is hidden
   * rather than unmounted, so no row component needs to know what was chosen. */
  const columnStyle = useMemo(() => {
    const style: Record<string, string> = {
      '--cols': templateFor(columns),
      // Every track and gap, the row's side padding, and its Get button: the
      // width below which the table scrolls sideways rather than cropping.
      '--table-min': `calc(${SEARCH_COLUMN_SET.trackSum(columns)} + ${Math.max(0, columns.length - 1)}`
        + ' * var(--sp-3) + 2 * var(--sp-5) + var(--row-actions-w))',
      ...widths.style,
    };
    for (const id of ALL_COLUMNS) {
      const at = columns.indexOf(id);
      if (at >= 0) style[`--col-${id}`] = String(at + 1);
      style[`--vis-${id}`] = at < 0 ? 'none' : 'inline-flex';
    }
    return style as React.CSSProperties;
  }, [columns, widths.style]);

  /* ---- [rows lag the store so removals can animate out] ---- */
  /* The store's rows are drawn as they come. Only while removals animate out
     are the previous rows HELD on screen. Copying every update into state
     drew the whole table twice per burst of results: once with the old rows,
     then again from the effect with the new ones. */
  const [held, setHeld] = useState<Row[] | null>(null);
  const display = held ?? rows;
  const [exiting, setExiting] = useState<ReadonlySet<string>>(() => new Set());
  const [reflowing, setReflowing] = useState(false);
  const prevRows = useRef<Row[]>(rows);

  // Layout, not passive: a removal must be held before the browser paints the
  // frame without it, or the outgoing rows would blink out and back.
  useLayoutEffect(() => {
    const prev = prevRows.current;
    prevRows.current = rows;

    const nextIds = new Set(rows.map((r) => r.id));
    const removed = prev.filter((r) => !nextIds.has(r.id)).map((r) => r.id);

    // Additions and reorders commit straight away; only removals need the
    // outgoing phase, and reduced motion skips it entirely. Both setters
    // bail out when nothing changes, so the common case costs no render.
    if (removed.length === 0 || reduced) {
      setExiting((e) => (e.size ? new Set() : e));
      setHeld(null);
      return;
    }

    setHeld((h) => h ?? prev);
    setExiting(new Set(removed));
    const t1 = window.setTimeout(() => {
      setHeld(null);
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

  /* ---- the header, measured ----
   *
   * The header now sits INSIDE the scroller, sticky at its top, so it is always
   * exactly as wide as the rows — outside, it was wider by the scrollbar, and
   * the flexible Name column resolved differently in each. Rows therefore start
   * below it, which the virtualiser is told as `scrollMargin` — and below the
   * lead too, which sits above the header and scrolls away. */
  const showHead = density === 'table' && display.length > 0;
  const headH = useHeight(theadRef, showHead);
  const leadH = useHeight(leadRef, lead !== undefined && display.length > 0);
  const above = leadH + headH;

  /* ---- virtualiser ---- */
  const virtualizer = useVirtualizer({
    scrollMargin: above,
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const kind = display[i]?.kind;
      const rem = kind === 'source'
        ? H_SOURCE_REM
        : kind === 'release' && !simple
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
    // Grid renders outside the virtualiser; each card gates its own cover.
    if (density === 'grid') return;
    for (const item of items) {
      const row = display[item.index];
      // Simple shows a track's cover too: the folder its copy sits in.
      const cover = row?.kind === 'release' ? row.release : simple && row?.kind === 'track' ? row.folder : null;
      if (cover) artwork.want(cover.id, cover.artist, cover.title);
    }
  }, [items, display, artwork, density, simple]);

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
  const scrollSpring = useRef<SpringHandle | null>(null);
  const cancelScroll = useCallback(() => scrollSpring.current?.stop(), []);

  const springToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (reduced) {
      el.scrollTop = 0;
      return;
    }
    scrollSpring.current?.stop();
    const h = driveSpring((v) => { if (scrollRef.current) scrollRef.current.scrollTop = v; });
    h.set(el.scrollTop);
    h.to(0);
    scrollSpring.current = h;
  }, [reduced]);

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

  const ctx = useMemo<RowCtx>(() => ({
    simple, density, artwork, library, peers, queueStates, folderStates, onToggle, onQueue, onCompare, onBrowse,
  }), [simple, density, artwork, library, peers, queueStates, folderStates, onToggle, onQueue, onCompare, onBrowse]);

  return (
    <div className="results" ref={resultsRef} style={columnStyle}>
      {/* [5] The single most important interaction decision in the app: new
          results that would sort above the scroll position wait here instead of
          shifting the list the user is reading. */}
      <div className="pill-zone" aria-live="polite">
        {pendingCount > 0 && (
          <button type="button" className="pill pressable" onClick={foldIn}>
            <IconArrowUp size={14} painted={1.7} />
            <span className="tnum">{integer(pendingCount)}</span>
            <span>new {pendingCount === 1 ? 'result' : 'results'}</span>
          </button>
        )}
      </div>

      <div className="scroller" ref={scrollRef} tabIndex={-1} data-density={density}>
        {lead !== undefined && display.length > 0 && <div ref={leadRef}>{lead}</div>}
        {/* A table without a header row cannot be read: nothing tells you
            whether a bare number is a queue depth or a file count. Drag a
            header to move its column, drag its edge to resize it. */}
        {showHead && (
          <ColumnHeaderRow<ColumnId>
            className="thead"
            rowRef={theadRef}
            hidden
            columns={columns}
            label={SEARCH_COLUMN_SET.label}
            isPinned={SEARCH_COLUMN_SET.isPinned}
            onReorder={(id, to) => onColumns?.(reorderColumns(columns, id, to))}
            {...widths.handlers}
          />
        )}
        {display.length === 0 ? (
          emptyState
        ) : density === 'grid' ? (
          /* A wall of covers, for picking a record out of a pile. Plain CSS grid,
             not the virtualiser (which is single-lane): release grouping collapses
             a search to few enough rows that the cap is never reached, and each
             card gates its own cover on the viewport. */
          <div className="results-grid">
            {display.slice(0, GRID_CAP).map((row) => (
              row.kind === 'release' ? (
                <GridCard
                  key={row.id}
                  release={row.release}
                  artwork={artwork}
                  owned={library?.hasRelease(row.release.artist, row.release.title) ?? false}
                  badge={folderStates?.get(folderKey(row.release.peer.username, row.release.folderPath)) ?? 'idle'}
                  onQueue={() => onQueue(row)}
                  onContext={onContext ? (e) => onContext(row, e.clientX, e.clientY) : undefined}
                />
              ) : null
            ))}
          </div>
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
                    // `start` counts from the scroller's top, lead and header included.
                    transform: `translate3d(0, ${item.start - above}px, 0)`,
                    animationDelay: delay ? `${delay}ms` : undefined,
                  }}
                >
                  <RowBody
                    row={row}
                    expanded={expanded.has(row.id)}
                    // A lone copy has nothing to compare against, so the card offers nothing.
                    copyCount={row.kind === 'release' && !simple
                      ? (row.copies ?? (copies ? copiesOf(row.release, copies) : [row.release])).length
                      : 0}
                    ctx={ctx}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** An element's height while `on`, kept current as it resizes. 0 otherwise. */
/** What every row shares, as one memoised object. */
interface RowCtx {
  simple: boolean;
  density: SearchDensity;
  artwork?: ArtworkSession;
  library?: LibrarySession;
  peers?: PeerLookup;
  queueStates?: Map<string, TransferState>;
  folderStates?: Map<string, QueueBadge>;
  onToggle(id: string): void;
  onQueue(row: Row): void;
  onCompare?(release: Release): void;
  onBrowse?(username: string): void;
}

/**
 * One row's content. Memoised, and fed rows that keep their identity while
 * nothing in them changed (searchStore's `steady`), so a burst of results draws
 * the rows it touched rather than every row on screen.
 */
const RowBody = memo(function RowBody({ row, expanded, copyCount, ctx }: {
  row: Row;
  expanded: boolean;
  /** Copies of this record in the results, for a Collector release card. */
  copyCount: number;
  ctx: RowCtx;
}) {
  const {
    simple, density, artwork, library, peers, queueStates, folderStates,
    onToggle, onQueue, onCompare, onBrowse,
  } = ctx;
  if (simple && row.kind === 'track') {
    return (
      <SimpleTrackRow
        track={row.track}
        folder={row.folder}
        art={row.folder ? artwork?.get(row.folder.id) : undefined}
        expanded={expanded}
        onToggle={() => onToggle(row.id)}
        // The copy the row shows, by name: never a pick made at press time.
        onQueue={(copy) => onQueue({ kind: 'file', id: copy.id, source: copy, tick: copy.tick })}
        queueStates={queueStates}
      />
    );
  }
  if (simple && row.kind === 'release') {
    const group = row.copies ?? [row.release];
    const badges = group.map((r) => folderStates?.get(folderKey(r.peer.username, r.folderPath)) ?? 'idle');
    return (
      <SimpleReleaseRow
        copies={group}
        art={artwork?.get(row.release.id)}
        expanded={expanded}
        onToggle={() => onToggle(row.id)}
        onQueue={(copy) => onQueue({ kind: 'release', id: copy.id, release: copy, tick: copy.tick })}
        // The record is what you took, so a copy queued from the comparison counts too.
        badge={badges.find((b) => b !== 'idle') ?? 'idle'}
        onCompare={onCompare}
      />
    );
  }
  switch (row.kind) {
    case 'track':
      return (
        <TrackRow
          track={row.track}
          expanded={expanded}
          onToggle={() => onToggle(row.id)}
          onQueue={() => onQueue(row)}
            queueStates={queueStates}
        />
      );
    case 'release': {
      return (
        <ReleaseCard
          art={artwork?.get(row.release.id)}
          owned={library?.hasRelease(row.release.artist, row.release.title)}
          release={row.release}
          expanded={expanded}
          onToggle={() => onToggle(row.id)}
          onQueue={() => onQueue(row)}
          // 'grid' renders as GridCard, never here — narrow it away for the card.
          density={density === 'grid' ? 'comfortable' : density}
          peers={peers}
          copyCount={copyCount}
          onCompare={onCompare ? () => onCompare(row.release) : undefined}
          queueBadge={folderStates?.get(folderKey(row.release.peer.username, row.release.folderPath)) ?? 'idle'}
        />
      );
    }
    case 'user':
      return (
        <UserRow
          group={row.group}
          expanded={expanded}
          onToggle={() => onToggle(row.id)}
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
          queueStates={queueStates}
          plain={simple}
        />
      );
    case 'file':
      return (
        <FileRow
          source={row.source}
          onQueue={() => onQueue(row)}
          queueStates={queueStates}
        />
      );
  }
});

function useHeight(ref: React.RefObject<HTMLElement | null>, on: boolean): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) { setH(0); return; }
    const read = () => setH(el.offsetHeight);
    read();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on, ref]);
  return h;
}

/**
 * One release as a cover tile in the grid — a square of art with the title and
 * artist beneath it, so a collector reads the pile by sleeve. Aspect ~3:4: the
 * cover is the 3×3 square, the caption the extra row.
 *
 * It gates its OWN cover on the viewport (`useNearViewport`), because the grid
 * is not virtualised — asking for every cover on mount is minutes of a
 * rate-limited volunteer API for tiles nobody scrolled to.
 *
 * Get is the only control, and it reports state (queued / downloading / done)
 * like every other Get, so status reads across the whole wall at a glance.
 */
function GridCard({
  release, artwork, owned, badge, onQueue, onContext,
}: {
  release: Release;
  artwork?: ArtworkSession;
  owned: boolean;
  badge: QueueBadge;
  onQueue(): void;
  onContext?(e: React.MouseEvent): void;
}) {
  const [ref, near] = useNearViewport();
  const art = artwork?.get(release.id);
  useEffect(() => {
    if (near && artwork?.enabled) artwork.want(release.id, release.artist, release.title);
  }, [near, artwork, release.id, release.artist, release.title]);

  return (
    <article className="gridcard" ref={ref} data-owned={owned ? 'true' : undefined} onContextMenu={onContext}>
      <div className="gridcard__cover">
        <Placeholder seed={`${release.artist ?? ''}${release.title}`} />
        {art?.state === 'ready' && (
          <img className="gridcard__img" src={art.dataUri} alt="" loading="lazy" />
        )}
        {owned && <span className="gridcard__owned">In library</span>}
        <span className="gridcard__get">
          <QueueButton
            badge={badge}
            onQueue={onQueue}
            label={`${release.title} from ${release.user}`}
            className="action action--primary pressable qbtn"
            withText
          />
        </span>
      </div>
      <div className="gridcard__cap">
        <span className="gridcard__title" title={release.title}>{release.title}</span>
        {release.artist && (
          <span className="gridcard__artist" title={release.artist}>{release.artist}</span>
        )}
      </div>
    </article>
  );
}
