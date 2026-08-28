/*
 * Seek — the columns of the search results table, and which of them fit.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Only the TABLE density has columns. Comfortable and Compact render a designed
 * metadata line whose order is part of the reading — badge first because it is
 * the one piece of colour, quality last because it is the verdict — and turning
 * that into a user-ordered list would be offering to break a layout rather than
 * to configure one.
 *
 * WHAT THIS REPLACES. The template was nine hard-coded track widths in CSS,
 * with three container queries that redefined it and hid columns by
 * `nth-child`. That worked exactly as long as the set never changed: an
 * `nth-child(9)` rule means "the user column" only while user IS ninth. Reorder
 * anything and the responsive rules start hiding the wrong column — which is
 * not hypothetical, because the non-table `.meta` line has three different cell
 * counts sharing one set of nth-child rules, and its release rows have been
 * dropping their track count where they meant to drop the spec.
 *
 * So the template is computed from the chosen columns, and what drops when
 * space runs short is decided by a PRIORITY on each column rather than by its
 * position. The order of sacrifice the CSS encoded is preserved exactly — user,
 * then queue, then spec — it is simply no longer tied to where a column sits.
 */

export type ColumnId =
  | 'name' | 'format' | 'spec' | 'time' | 'size' | 'speed' | 'queue' | 'check'
  | 'user' | 'bitrate' | 'year' | 'files' | 'country';

export interface ColumnSpec {
  id: ColumnId;
  /** Header text. Rendered uppercase by CSS, so written in sentence case. */
  label: string;
  /** The grid track. `name` is the only flexible one. */
  track: string;
  /** Width in rem for the fitting calculation. `name` counts as its minimum. */
  rem: number;
  /**
   * Lower drops first when space runs short. `Infinity` never drops.
   *
   * Name, format and quality are Infinity: the row must be identifiable, the
   * badge is the only colour in the line, and the quality verdict is what the
   * whole screen exists to communicate. Dropping any of them leaves a table
   * that cannot answer the question it was opened to answer.
   */
  priority: number;
  /** Cannot be turned off or moved. Only `name`. */
  pinned?: boolean;
  /** Not shown by default — the columns this change adds. */
  extra?: boolean;
}

const SPECS: ColumnSpec[] = [
  { id: 'name', label: 'Name', track: 'minmax(6rem, 1fr)', rem: 6, priority: Infinity, pinned: true },
  { id: 'format', label: 'Format', track: '4.5rem', rem: 4.5, priority: Infinity },
  { id: 'spec', label: 'Spec', track: '5.5rem', rem: 5.5, priority: 3 },
  { id: 'time', label: 'Time', track: '3.5rem', rem: 3.5, priority: 5 },
  { id: 'size', label: 'Size', track: '5rem', rem: 5, priority: 6 },
  { id: 'speed', label: 'Speed', track: '6rem', rem: 6, priority: 4 },
  { id: 'queue', label: 'Queue', track: '5.5rem', rem: 5.5, priority: 2 },
  { id: 'check', label: 'Check', track: '1.75rem', rem: 1.75, priority: Infinity },
  { id: 'user', label: 'User', track: '7rem', rem: 7, priority: 1 },
  // Added by this change. All opt-in, and all drop before anything that was
  // already on screen — someone who switches one on has not asked to lose Size.
  { id: 'bitrate', label: 'Bitrate', track: '5rem', rem: 5, priority: 0, extra: true },
  { id: 'year', label: 'Year', track: '3.5rem', rem: 3.5, priority: 0, extra: true },
  { id: 'files', label: 'Files', track: '4rem', rem: 4, priority: 0, extra: true },
  { id: 'country', label: 'From', track: '3rem', rem: 3, priority: 0, extra: true },
];

export const COLUMNS: Record<ColumnId, ColumnSpec> = Object.fromEntries(
  SPECS.map((c) => [c.id, c]),
) as Record<ColumnId, ColumnSpec>;

/** Every column, in the order the picker offers them. */
export const ALL_COLUMNS: ColumnId[] = SPECS.map((c) => c.id);

/** Exactly what the table showed before it was configurable. */
export const DEFAULT_COLUMNS: ColumnId[] = [
  'name', 'format', 'spec', 'time', 'size', 'speed', 'queue', 'check', 'user',
];

const GAP_REM = 0.75;   // --sp-3, the grid gap
/*
 * Headroom before a column is dropped.
 *
 * The widths above are minimums, and a table packed to exactly its minimum is
 * unreadable — every cell touching its neighbour. Calibrated against the
 * breakpoints this replaces: the nine default columns measure 44.75rem of track
 * plus 6rem of gaps, and the old CSS dropped the user column at 58em, so about
 * seven rem of slack is what the design already had.
 */
const SLACK_REM = 7;

function needs(ids: ColumnId[]): number {
  const tracks = ids.reduce((n, id) => n + COLUMNS[id].rem, 0);
  return tracks + Math.max(0, ids.length - 1) * GAP_REM + SLACK_REM;
}

/**
 * The columns that actually fit, dropping the least useful first.
 *
 * `availableRem` is the results container in rem, NOT pixels: the old rules
 * were container queries in `em` precisely because a media query in `rem`
 * resolves against the initial font size and so never fires when the OS scales
 * text. Measuring in rem keeps that property.
 */
export function visibleColumns(chosen: ColumnId[], availableRem: number): ColumnId[] {
  const out = [...chosen];
  // Never drop the last droppable one to nothing: a table of Name alone is a
  // list, and the caller has a list.
  while (out.length > 1 && needs(out) > availableRem) {
    let worst = -1;
    let worstPriority = Infinity;
    out.forEach((id, i) => {
      const p = COLUMNS[id].priority;
      if (p < worstPriority) { worstPriority = p; worst = i; }
    });
    if (worst < 0 || worstPriority === Infinity) break;   // only undroppable left
    out.splice(worst, 1);
  }
  return out;
}

/** The `grid-template-columns` value for a set of columns. */
export function templateFor(ids: ColumnId[]): string {
  return ids.map((id) => COLUMNS[id].track).join(' ');
}

/**
 * Clean a stored choice into something renderable.
 *
 * Stored preferences outlive the code that wrote them: a column removed in a
 * later version, a hand-edited value, a truncated write. Anything unrecognised
 * is dropped, duplicates collapse, and `name` is forced to the front because
 * the row is unreadable without it and every other column is right-aligned
 * against it.
 */
export function normaliseColumns(raw: unknown): ColumnId[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<ColumnId>();
  const out: ColumnId[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const id = item as ColumnId;
    if (!COLUMNS[id] || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) return [...DEFAULT_COLUMNS];
  const withoutName = out.filter((id) => id !== 'name');
  return ['name', ...withoutName];
}

/** Move `id` to `to`, keeping `name` pinned at the front. */
export function reorderColumns(ids: ColumnId[], id: ColumnId, to: number): ColumnId[] {
  if (COLUMNS[id]?.pinned) return ids;
  const rest = ids.filter((x) => x !== id);
  // `to` is an index into the whole list, and index 0 belongs to `name`.
  const at = Math.min(Math.max(to, 1), rest.length);
  rest.splice(at, 0, id);
  return normaliseColumns(rest);
}

/** Turn a column on (appended) or off. `name` cannot be turned off. */
export function toggleColumn(ids: ColumnId[], id: ColumnId): ColumnId[] {
  if (COLUMNS[id]?.pinned) return ids;
  return ids.includes(id)
    ? normaliseColumns(ids.filter((x) => x !== id))
    : normaliseColumns([...ids, id]);
}
