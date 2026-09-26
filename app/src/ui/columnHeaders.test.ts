/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The arithmetic behind the table headers' two gestures. jsdom has no
 * PointerEvent to drive a drag end to end, so the pure functions the handlers
 * call are pinned instead.
 */

import { describe, expect, it } from 'vitest';
import { MIN_COL_WIDTH, dropTarget, resizeWidth } from './columnHeaders.tsx';

describe('resizeWidth', () => {
  it('widens or narrows from the start width, never below the minimum', () => {
    expect(resizeWidth(260, 60)).toBe(320);
    expect(resizeWidth(260, -40)).toBe(220);
    expect(resizeWidth(120, -1000)).toBe(MIN_COL_WIDTH);
  });
});

describe('dropTarget', () => {
  // Midpoints of the OTHER columns: name (pinned) at 100, then 300, 400, 500.
  const mids = [100, 300, 400, 500];

  it('lands between the columns whose midpoints the pointer has passed', () => {
    expect(dropTarget(mids, 350, 1)).toBe(2);
    expect(dropTarget(mids, 450, 1)).toBe(3);
  });

  it('can land after the last column', () => {
    expect(dropTarget(mids, 900, 1)).toBe(4);
  });

  it('never lands ahead of a pinned column, however far left it is dragged', () => {
    expect(dropTarget(mids, 0, 1)).toBe(1);
    expect(dropTarget(mids, 50, 1)).toBe(1);
  });
});
