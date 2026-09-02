/*
 * Seek — the density view menu.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §4: grouping and density are orthogonal and must not compete
 * for the same space. Grouping is the primary segmented control; density lives
 * in a toolbar view menu, the way Finder does it. Two segmented controls side by
 * side in one header is exactly the density this redesign exists to remove.
 *
 * The popover scales from its trigger, not from its centre — anchoring a
 * popover to the thing that opened it is what makes the relationship legible.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { IconCheck, IconFilters } from '../icons/index.tsx';
import { SORT_LABELS, naturallyDescending } from '../domain/transferOrder.ts';
import type { SortKey } from '../domain/transferOrder.ts';
import { SEARCH_COLUMN_SET } from '../domain/searchColumns.ts';
import type { ColumnId } from '../domain/searchColumns.ts';
import type { ColumnSet } from '../domain/columns.ts';

export type Density = 'comfortable' | 'compact' | 'table' | 'grid';

/* Search now supports every density, Grid included: a wall of covers is how a
 * collector picks a record out of a pile, so it earns its place once results
 * are grouped by release (the result list forces that pairing). */
export type SearchDensity = Density;

const OPTIONS: Array<{ value: Density; label: string; hint: string }> = [
  { value: 'comfortable', label: 'Comfortable', hint: 'Full release cards' },
  { value: 'compact', label: 'Compact', hint: 'Denser, no recommendation line' },
  { value: 'table', label: 'Table', hint: 'Every column, power-user view' },
  { value: 'grid', label: 'Grid', hint: 'Covers, for picking through a pile' },
];

/* Search does not offer Grid: a search result is a peer's copy of a record and
 * the useful comparison between copies is format, size and queue, none of which
 * a cover shows. Grid earns its place in Completed and Failed, where the rows
 * are records you already chose and the question is which one is which. */
const DEFAULT_DENSITIES: Density[] = ['comfortable', 'compact', 'table'];

/* Sort lives in the SAME popover as density rather than in a control of its
 * own, which is Finder's arrangement and the one docs/PRODUCT.md §4 argues for:
 * grouping is the primary segmented control and everything else that only
 * changes how the same rows are presented belongs behind one toolbar menu. A
 * second segmented control in the header is exactly the density this redesign
 * exists to remove.
 *
 * Optional, because Search uses this menu too and has its own ordering. */
export function ViewMenu<Id extends string = ColumnId>({
  density, onDensity, densities = DEFAULT_DENSITIES,
  sort, onSort, descending, onDescending, columns, onColumns, columnSet,
  sortLabels = SORT_LABELS,
}: {
  /* Optional: a list with only one shape offers no density at all. Uploads is
     that list — one row per peer, no per-file detail to compress and no covers
     to lay out — and it still wants the sort half of this menu. */
  density?: Density;
  onDensity?(d: Density): void;
  /** Which densities this list offers. Defaults to everything but Grid. */
  densities?: Density[];
  sort?: SortKey;
  onSort?(k: SortKey): void;
  descending?: boolean;
  onDescending?(d: boolean): void;
  /** Chosen table columns, in order. Only meaningful at `table` density. */
  columns?: Id[];
  onColumns?(next: Id[]): void;
  /* Which table these columns belong to. Defaults to the search set, so the
     search call site needs no change; the YouTube sheet passes its own. */
  columnSet?: ColumnSet<Id>;
  /** Wording for the sort keys. Uploads reverse the sense of `peer`. */
  sortLabels?: Record<SortKey, string>;
}) {
  const cols = (columnSet ?? SEARCH_COLUMN_SET) as unknown as ColumnSet<Id>;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="viewmenu" ref={wrapRef}>
      <button
        type="button"
        className="viewmenu__trigger pressable"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label="View options"
        /* onClick, not onPointerDown. A keyboard Enter or Space on a button
         * dispatches a click and never a pointerdown, so the pointer handler
         * this menu used could not be reached from the keyboard at all — the
         * trigger took focus, showed a ring, and did nothing. The same is true
         * of every item below. */
        onClick={() => setOpen((v) => !v)}
      >
        <IconFilters size={15} painted={1.6} />
        <span className="viewmenu__label">View</span>
      </button>

      {open && (
        <div className="viewmenu__pop" id={id} role="menu" aria-label="View options">
          {/* A section heading with nothing under it is worse than no section:
              it reads as a list that failed to load. */}
          {density && onDensity && densities.length > 0 && (
            <div className="viewmenu__section">Density</div>
          )}
          {density && onDensity && OPTIONS.filter((o) => densities.includes(o.value)).map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={density === o.value}
              className="viewmenu__item"
              onClick={() => {
                onDensity(o.value);
                setOpen(false);
              }}
            >
              <span className="viewmenu__check" aria-hidden>
                {density === o.value && <IconCheck size={13} painted={1.9} />}
              </span>
              <span className="viewmenu__text">
                <span className="viewmenu__item-label">{o.label}</span>
                <span className="viewmenu__item-hint">{o.hint}</span>
              </span>
            </button>
          ))}

          {/* Only at table density, because only the table has columns. The
              other densities render a designed metadata line whose order is
              part of the reading, and offering to reorder it would be offering
              to break a layout rather than to configure one. */}
          {columns && onColumns && density === 'table' && (
            <>
              <div className="viewmenu__section">Columns</div>
              {cols.all.filter((id) => !cols.isPinned(id)).map((id) => {
                const on = columns.includes(id);
                const at = columns.indexOf(id);
                const pinnedCount = columns.filter((c) => cols.isPinned(c)).length;
                return (
                  <div key={id} className="viewmenu__item viewmenu__item--col">
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      className="viewmenu__coltoggle"
                      onClick={() => onColumns(cols.toggle(columns, id))}
                    >
                      <span className="viewmenu__check" aria-hidden>
                        {on && <IconCheck size={13} painted={1.9} />}
                      </span>
                      <span className="viewmenu__item-label">{cols.label(id)}</span>
                    </button>
                    {/* Buttons rather than a drag handle: dragging inside a
                        popover fights the outside-click dismissal, and two
                        keystrokes move a column for someone who cannot drag. */}
                    <span className="viewmenu__movers">
                      <button
                        type="button"
                        className="viewmenu__move"
                        disabled={!on || at <= pinnedCount}
                        aria-label={`Move ${cols.label(id)} left`}
                        onClick={() => onColumns(cols.reorder(columns, id, at - 1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="viewmenu__move"
                        disabled={!on || at === columns.length - 1}
                        aria-label={`Move ${cols.label(id)} right`}
                        onClick={() => onColumns(cols.reorder(columns, id, at + 1))}
                      >
                        ↓
                      </button>
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {sort && onSort && (
            <>
              <div className="viewmenu__section">Sort by</div>
              {(Object.keys(sortLabels) as SortKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort === key}
                  className="viewmenu__item"
                  onClick={() => {
                    /* Picking the SAME key again flips the direction, which is
                     * how a column header behaves everywhere; picking a new one
                     * starts from whichever way round that key reads best —
                     * nobody wants smallest-first or least-complete-first. */
                    if (key === sort) onDescending?.(!descending);
                    else {
                      onSort(key);
                      onDescending?.(naturallyDescending(key));
                    }
                  }}
                >
                  <span className="viewmenu__check" aria-hidden>
                    {sort === key && <IconCheck size={13} painted={1.9} />}
                  </span>
                  <span className="viewmenu__text">
                    <span className="viewmenu__item-label">{sortLabels[key]}</span>
                    {sort === key && (
                      <span className="viewmenu__item-hint">
                        {descending ? 'Highest first — click to reverse'
                          : 'Lowest first — click to reverse'}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
