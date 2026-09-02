/*
 * Seek — the list-selection model, as a pure function.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Multi-select is three gestures the whole desktop shares, and getting any of
 * them subtly wrong (a shift-range that starts from the click instead of the
 * anchor, a cmd-click that clears instead of toggling) is the kind of thing you
 * only notice by using it for a week. So the decision lives here, away from the
 * event handler, where every branch can be pinned by a test.
 *
 * `order` is the id list the range is measured in — one release's files. Range
 * selection is deliberately WITHIN a group: shift-clicking across two unrelated
 * releases is not a gesture anyone reaches for, and measuring the range across a
 * list that re-sorts under you would select whatever happened to lie between.
 */

export interface Mods {
  /** ⌘ on macOS, Ctrl elsewhere — toggle one, keep the rest. */
  meta?: boolean;
  /** Extend a contiguous range from the anchor. */
  shift?: boolean;
}

export interface SelectResult {
  selected: Set<string>;
  /** The point a future shift-range measures from. */
  anchor: string | null;
}

/**
 * The next selection after a click on `id`.
 *
 *  - plain click → select only `id`; it becomes the anchor.
 *  - ⌘/Ctrl click → toggle `id` in the current set; it becomes the anchor.
 *  - shift click → the contiguous range in `order` from the anchor to `id`,
 *    replacing the selection, with the anchor kept so a further shift re-pivots
 *    from the same point. With no usable anchor it falls back to a plain click.
 */
export function nextSelection(
  current: ReadonlySet<string>,
  order: readonly string[],
  id: string,
  anchor: string | null,
  mods: Mods,
): SelectResult {
  if (mods.shift && anchor !== null) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return { selected: new Set(order.slice(lo, hi + 1)), anchor };
    }
    // Anchor is in another group (or gone): fall through to a plain select.
  }

  if (mods.meta) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { selected: next, anchor: id };
  }

  return { selected: new Set([id]), anchor: id };
}
