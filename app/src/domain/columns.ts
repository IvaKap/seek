/*
 * Seek — the reorderable-column engine, shared by every table that has one.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The search results table grew a proper column model — priority-based
 * responsive dropping, a computed `grid-template-columns`, a stored order that
 * survives a column being renamed or removed — and the YouTube sheet wants the
 * same thing. Rather than copy ~80 lines, the pure algorithm lives here,
 * parameterised by a spec map, and each table is one instantiation
 * (`searchColumns.ts`, `youtubeColumns.ts`). The behaviour is identical; only
 * the columns differ.
 *
 * Everything here is pure — no React, no DOM — so it is unit-testable in
 * isolation, which is where the fitting and normalising logic is actually
 * pinned.
 */

export interface ColumnSpec<Id extends string> {
  id: Id;
  /** Header text. Rendered uppercase by CSS, so written in sentence case. */
  label: string;
  /** The grid track. The one flexible column uses a `minmax(_, 1fr)`. */
  track: string;
  /** Width in rem for the fitting calculation. A flexible column counts its min. */
  rem: number;
  /** Lower drops first when space runs short. `Infinity` never drops. */
  priority: number;
  /** Cannot be turned off or moved, and is forced to the front. */
  pinned?: boolean;
  /** Not shown by default — a column the user opts into. */
  extra?: boolean;
}

/**
 * What a column picker needs to render and edit a chosen set. `ViewMenu` takes
 * one of these so it does not have to know which table it is configuring.
 */
export interface ColumnSet<Id extends string> {
  all: Id[];
  label(id: Id): string;
  isPinned(id: Id): boolean;
  reorder(ids: Id[], id: Id, to: number): Id[];
  toggle(ids: Id[], id: Id): Id[];
}

export interface ColumnEngine<Id extends string> extends ColumnSet<Id> {
  spec(id: Id): ColumnSpec<Id>;
  defaults: Id[];
  visible(chosen: Id[], availableRem: number): Id[];
  template(ids: Id[]): string;
  normalise(raw: unknown): Id[];
}

const GAP_REM = 0.75;   // --sp-3, the grid gap

export function makeColumns<Id extends string>(
  specs: ColumnSpec<Id>[],
  defaults: Id[],
  /* Headroom before a column is dropped — a table packed to its exact minimum
   * is unreadable. The search table calibrated this at ~7rem; a caller can
   * override for a denser or airier table. */
  slackRem = 7,
): ColumnEngine<Id> {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const all = specs.map((s) => s.id);
  const spec = (id: Id) => {
    const found = byId.get(id);
    if (!found) throw new Error(`unknown column: ${id}`);
    return found;
  };

  const needs = (ids: Id[]): number => {
    const tracks = ids.reduce((n, id) => n + spec(id).rem, 0);
    return tracks + Math.max(0, ids.length - 1) * GAP_REM + slackRem;
  };

  const visible = (chosen: Id[], availableRem: number): Id[] => {
    const out = [...chosen];
    while (out.length > 1 && needs(out) > availableRem) {
      let worst = -1;
      let worstPriority = Infinity;
      out.forEach((id, i) => {
        const p = spec(id).priority;
        if (p < worstPriority) { worstPriority = p; worst = i; }
      });
      if (worst < 0 || worstPriority === Infinity) break;   // only undroppable left
      out.splice(worst, 1);
    }
    return out;
  };

  const template = (ids: Id[]): string => ids.map((id) => spec(id).track).join(' ');

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
    visible,
    template,
    normalise,
    reorder,
    toggle,
  };
}
