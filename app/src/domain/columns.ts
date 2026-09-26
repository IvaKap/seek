/*
 * Seek — the column model shared by every table that has one.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The search results table and the YouTube sheet both let you choose which
 * columns show, drag a header to move a column, and drag a header's edge to
 * resize it. The pure part of that — which ids are valid, pinned columns kept
 * first, add / remove / move, and the grid template the widths feed — lives
 * here, so both tables behave identically and it is testable without a DOM.
 * Each table is one instantiation (`searchColumns.ts`, `youtubeColumns.ts`).
 *
 * WIDTHS ARE CSS CUSTOM PROPERTIES. Every track is `var(--w-<id>, <n>rem)`: the
 * rem fallback is the default, so it scales with the user's text size, and a
 * hand-resized column sets `--w-<id>` (in px) on the table's container. A drag
 * therefore repaints ONE property and every row reflows through CSS, with no
 * React render per pointer move.
 *
 * NOTHING IS DROPPED FOR SPACE. The table used to hide its lowest-priority
 * columns as the pane narrowed. With columns the user picked, placed and sized
 * by hand, silently removing one fights them — so a table wider than its pane
 * scrolls sideways instead, the way Finder's list view does, and the one
 * `fill` column (the search table's Name) takes whatever width is spare.
 */

export interface ColumnSpec<Id extends string> {
  id: Id;
  /** Header text. Rendered uppercase by CSS, so written in sentence case. */
  label: string;
  /** Default width in rem. A hand-resized width overrides it, in px. */
  width: number;
  /** Takes the spare width, and never goes narrower than `width`. One per table. */
  fill?: boolean;
  /** Cannot be removed or moved, and is kept at the front. */
  pinned?: boolean;
}

/**
 * What a column picker needs to add and remove columns. `ViewMenu` takes one of
 * these so it does not have to know which table it is configuring.
 */
export interface ColumnSet<Id extends string> {
  all: Id[];
  label(id: Id): string;
  isPinned(id: Id): boolean;
  toggle(ids: Id[], id: Id): Id[];
}

export interface ColumnEngine<Id extends string> extends ColumnSet<Id> {
  spec(id: Id): ColumnSpec<Id>;
  defaults: Id[];
  normalise(raw: unknown): Id[];
  reorder(ids: Id[], id: Id, to: number): Id[];
  /** The `grid-template-columns` value for these columns, in this order. */
  template(ids: Id[]): string;
  /** The columns' combined width as a CSS sum (gaps excluded), for a `calc()`. */
  trackSum(ids: Id[]): string;
}

export function makeColumns<Id extends string>(
  specs: ColumnSpec<Id>[],
  defaults: Id[],
): ColumnEngine<Id> {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const all = specs.map((s) => s.id);
  const spec = (id: Id) => {
    const found = byId.get(id);
    if (!found) throw new Error(`unknown column: ${id}`);
    return found;
  };

  const track = (id: Id) => `var(--w-${id}, ${spec(id).width}rem)`;

  const template = (ids: Id[]): string =>
    ids.map((id) => (spec(id).fill ? `minmax(${track(id)}, 1fr)` : track(id))).join(' ');

  const trackSum = (ids: Id[]): string =>
    ids.length === 0 ? '0px' : `(${ids.map(track).join(' + ')})`;

  const pinnedFirst = specs.filter((s) => s.pinned).map((s) => s.id);

  const normalise = (raw: unknown): Id[] => {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<Id>();
    const out: Id[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const id = item as Id;
      if (!byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length === 0) return [...defaults];
    // Pinned columns are forced to the front, in their declared order, and are
    // never absent — the row is unreadable without its name column.
    const rest = out.filter((id) => !spec(id).pinned);
    return [...pinnedFirst, ...rest];
  };

  const reorder = (ids: Id[], id: Id, to: number): Id[] => {
    if (spec(id).pinned) return ids;
    const pinnedCount = ids.filter((x) => spec(x).pinned).length;
    const rest = ids.filter((x) => x !== id);
    // Index 0..pinnedCount-1 belong to pinned columns; clamp past them.
    const at = Math.min(Math.max(to, pinnedCount), rest.length);
    rest.splice(at, 0, id);
    return normalise(rest);
  };

  const toggle = (ids: Id[], id: Id): Id[] => {
    if (spec(id).pinned) return ids;
    return ids.includes(id)
      ? normalise(ids.filter((x) => x !== id))
      : normalise([...ids, id]);
  };

  return {
    all,
    defaults,
    spec,
    label: (id) => spec(id).label,
    isPinned: (id) => Boolean(spec(id).pinned),
    normalise,
    reorder,
    toggle,
    template,
    trackSum,
  };
}
