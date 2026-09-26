/*
 * Seek — table headers you drag to move a column and drag the edge of to
 * resize it. Shared by the search table and the YouTube sheet.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Direct manipulation replaced the View menu's ↑/↓ movers: moving a column is
 * dragging its header to where you want it, resizing is dragging its edge, and
 * double-clicking an edge puts that column back to its default width. The menu
 * keeps only + and −, to add and remove columns.
 *
 * Both gestures are POINTER events with capture, not HTML5 drag and drop. The
 * Tauri window intercepts native drag events for file drops, and a pointer
 * drag also lets the moving header follow the cursor exactly.
 *
 * Resizing never re-renders rows. `columns.ts` makes each track read
 * `--w-<id>`; a drag writes that one custom property on the table's container
 * and CSS reflows every row. State and localStorage are written once, on
 * release (`useColumnWidths`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const MIN_COL_WIDTH = 44;

/** A column's width after a drag of `deltaX` from `startW`, clamped. Pure, so
 *  the arithmetic is testable without jsdom's absent PointerEvent. */
export function resizeWidth(startW: number, deltaX: number): number {
  return Math.max(MIN_COL_WIDTH, Math.round(startW + deltaX));
}

/**
 * Where a dragged column lands: its index among the OTHER columns, given their
 * horizontal midpoints in order and the pointer's x. Never ahead of the first
 * `pinned` of them, which are the columns that cannot move.
 */
export function dropTarget(mids: readonly number[], x: number, pinned: number): number {
  let i = 0;
  while (i < mids.length && x > mids[i]) i++;
  return Math.max(pinned, i);
}

/* ------------------------------------------------------------------ widths */

function loadWidths<Id extends string>(key: string, all: readonly Id[]): Partial<Record<Id, number>> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}');
    const out: Partial<Record<Id, number>> = {};
    for (const id of all) {
      const v = raw?.[id];
      if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_COL_WIDTH) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Hand-set column widths, persisted under `key` and applied as `--w-<id>` on
 * `target` (the element whose descendants hold the header and the rows).
 *
 * `style` carries the committed widths for the container's `style` prop. The
 * handlers are what a `ColumnHeaderRow` needs: a live preview that writes the
 * property directly, then a commit, a cancel that restores the committed value,
 * and a reset back to the default.
 */
export function useColumnWidths<Id extends string>(
  key: string,
  all: readonly Id[],
  target: React.RefObject<HTMLElement | null>,
) {
  const [widths, setWidths] = useState<Partial<Record<Id, number>>>(() => loadWidths(key, all));
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(widths)); } catch { /* private mode */ }
  }, [key, widths]);

  const style = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, px] of Object.entries(widths)) out[`--w-${id}`] = `${px}px`;
    return out;
  }, [widths]);

  const onResizePreview = useCallback((id: Id, px: number) => {
    target.current?.style.setProperty(`--w-${id}`, `${px}px`);
  }, [target]);

  const onResizeCommit = useCallback((id: Id, px: number) => {
    setWidths((w) => ({ ...w, [id]: px }));
  }, []);

  /* A preview React never heard about has to be undone by hand: nothing in
   * state changed, so no render would put the old value back. */
  const onResizeCancel = useCallback((id: Id) => {
    const el = target.current;
    if (!el) return;
    const px = widthsRef.current[id];
    if (px) el.style.setProperty(`--w-${id}`, `${px}px`);
    else el.style.removeProperty(`--w-${id}`);
  }, [target]);

  const onResizeReset = useCallback((id: Id) => {
    target.current?.style.removeProperty(`--w-${id}`);
    setWidths((w) => {
      if (!(id in w)) return w;
      const next = { ...w };
      delete next[id];
      return next;
    });
  }, [target]);

  return { style, handlers: { onResizePreview, onResizeCommit, onResizeCancel, onResizeReset } };
}

/* -------------------------------------------------------------- header row */

interface DragState<Id extends string> {
  id: Id;
  el: HTMLElement;
  startX: number;
  moved: boolean;
  /** The other columns' boxes, measured once at pointer-down. */
  others: Array<{ id: Id; left: number; right: number }>;
  pinned: number;
  at: number;
}

export function ColumnHeaderRow<Id extends string>({
  columns, label, isPinned, onReorder,
  onResizePreview, onResizeCommit, onResizeCancel, onResizeReset,
  className, rowRef, hidden,
}: {
  columns: readonly Id[];
  label(id: Id): string;
  isPinned(id: Id): boolean;
  /** Move `id` to index `to` among the other columns (`ColumnEngine.reorder`). */
  onReorder(id: Id, to: number): void;
  onResizePreview(id: Id, px: number): void;
  onResizeCommit(id: Id, px: number): void;
  onResizeCancel(id: Id): void;
  onResizeReset(id: Id): void;
  className: string;
  /** For a caller that needs to measure the row. */
  rowRef?: React.RefObject<HTMLDivElement | null>;
  /** Hide the row from assistive tech (the search table's labels are decorative). */
  hidden?: boolean;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = rowRef ?? ownRef;
  const drag = useRef<DragState<Id> | null>(null);
  const resize = useRef<{ id: Id; startX: number; startW: number; px: number | null } | null>(null);
  const [dragging, setDragging] = useState<Id | null>(null);
  const [dropX, setDropX] = useState<number | null>(null);

  const endDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    d.el.style.transform = '';
    setDragging(null);
    setDropX(null);
    if (commit && d.moved) onReorder(d.id, d.at);
  };

  return (
    <div className={className} ref={ref} role="row" aria-hidden={hidden || undefined}>
      {columns.map((id) => {
        const pinned = isPinned(id);
        return (
          <span
            key={id}
            className="colhead"
            data-col={id}
            data-pinned={pinned ? 'true' : undefined}
            data-dragging={dragging === id ? 'true' : undefined}
            title={pinned ? undefined : 'Drag to move this column'}
            onPointerDown={(e) => {
              if (e.button !== 0 || pinned || !ref.current) return;
              const origin = ref.current.getBoundingClientRect().left;
              const others = [...ref.current.querySelectorAll<HTMLElement>(':scope > .colhead')]
                .filter((c) => c.dataset.col !== id)
                .map((c) => {
                  const r = c.getBoundingClientRect();
                  return { id: c.dataset.col as Id, left: r.left - origin, right: r.right - origin };
                });
              drag.current = {
                id, el: e.currentTarget, startX: e.clientX, moved: false, others,
                pinned: others.filter((o) => isPinned(o.id)).length, at: 0,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || !ref.current) return;
              const dx = e.clientX - d.startX;
              // A few pixels of slop, so a click never nudges a column.
              if (!d.moved && Math.abs(dx) < 4) return;
              if (!d.moved) { d.moved = true; setDragging(id); }
              d.el.style.transform = `translateX(${dx}px)`;
              const x = e.clientX - ref.current.getBoundingClientRect().left;
              d.at = dropTarget(d.others.map((o) => (o.left + o.right) / 2), x, d.pinned);
              const before = d.others[d.at - 1];
              const after = d.others[d.at];
              setDropX(before && after ? (before.right + after.left) / 2
                : before ? before.right + 4 : after ? after.left - 4 : 0);
            }}
            onPointerUp={() => endDrag(true)}
            onPointerCancel={() => endDrag(false)}
          >
            <span className="colhead__label">{label(id)}</span>
            <span
              className="colhead__resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${label(id)}`}
              title="Drag to resize · double-click to reset"
              onPointerDown={(e) => {
                // Not a move: the cell underneath must never see this press.
                e.stopPropagation();
                e.preventDefault();
                const cell = e.currentTarget.parentElement;
                if (!cell) return;
                resize.current = {
                  id, startX: e.clientX, startW: cell.getBoundingClientRect().width, px: null,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const r = resize.current;
                if (!r) return;
                r.px = resizeWidth(r.startW, e.clientX - r.startX);
                onResizePreview(r.id, r.px);
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                const r = resize.current;
                resize.current = null;
                if (r && r.px !== null) onResizeCommit(r.id, r.px);
              }}
              onPointerCancel={(e) => {
                e.stopPropagation();
                const r = resize.current;
                resize.current = null;
                if (r) onResizeCancel(r.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onResizeReset(id);
              }}
            />
          </span>
        );
      })}
      {dropX !== null && <span className="colhead__drop" style={{ left: dropX }} aria-hidden />}
    </div>
  );
}
