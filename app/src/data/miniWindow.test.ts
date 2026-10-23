/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Mini Seek's frame: it shrinks the window at its top-right corner, lifts the
 * full window's minimum first, and puts the full frame back exactly. A fresh
 * start with nothing to go back to still restores the full window's rules.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const calls: string[] = [];
  const said = (what: string) => async (v: unknown) => {
    const o = v as Record<string, unknown>;
    calls.push(typeof v === 'object' && v !== null
      ? `${what} ${'width' in o ? `${o.width}x${o.height}` : `${o.x},${o.y}`}`
      : `${what} ${String(v)}`);
  };
  return {
    calls,
    tauri: { on: true },
    win: {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(said('fullscreen')),
      // A Retina screen: everything physical is twice the logical size.
      scaleFactor: async () => 2,
      outerPosition: async () => ({ toLogical: (s: number) => ({ x: 2000 / s, y: 200 / s }) }),
      innerSize: vi.fn(async () => ({ toLogical: (s: number) => ({ width: 2560 / s, height: 1680 / s }) })),
      setMinSize: said('min'),
      setSize: said('size'),
      setPosition: said('at'),
      setResizable: said('resizable'),
      setAlwaysOnTop: said('top'),
    },
  };
});

vi.mock('./sidecarClient.ts', () => ({ isTauri: () => mock.tauri.on }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mock.win,
  LogicalSize: class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } },
  LogicalPosition: class { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } },
}));

const { keepOnTop, restore, shrink } = await import('./miniWindow.ts');

beforeEach(async () => {
  mock.tauri.on = true;
  await restore(); // drops a frame an earlier test left behind
  mock.calls.length = 0;
});

describe('Mini Seek’s frame', () => {
  it('shrinks at the top-right corner, then puts the full frame back exactly', async () => {
    await shrink(true);
    expect(mock.calls).toEqual(['min 320x560', 'size 320x560', 'at 1960,100', 'resizable false', 'top true']);

    mock.calls.length = 0;
    await restore();
    expect(mock.calls).toEqual(['top false', 'resizable true', 'size 1280x840', 'at 1000,100', 'min 880x560']);
  });

  it('with no frame to go back to, still restores the full window’s rules', async () => {
    await restore();
    expect(mock.calls).toEqual(['top false', 'resizable true', 'min 880x560']);
  });

  it('leaves full screen before shrinking', async () => {
    mock.win.isFullscreen.mockResolvedValueOnce(true);
    await shrink(false);
    expect(mock.calls[0]).toBe('fullscreen false');
    expect(mock.calls.at(-1)).toBe('top false');
    await restore();
  });

  /* ⇧⌘M twice, fast, from full screen: the way back ran while the shrink was
     still waiting out the full-screen animation, found no frame, and the
     shrink then finished — the full app stuck in a tiny window. */
  it('lets a shrink finish before the way back starts', async () => {
    mock.win.isFullscreen.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const small = shrink(false);
    const back = restore();
    await Promise.all([small, back]);
    expect(mock.calls.at(-1)).toBe('min 880x560');
    expect(mock.calls).toContain('size 1280x840');
    expect(mock.calls.lastIndexOf('resizable true')).toBeGreaterThan(mock.calls.lastIndexOf('resizable false'));
  });

  it('keeps the full frame when asked to shrink while already small', async () => {
    await shrink(true);
    mock.win.innerSize.mockResolvedValueOnce({ toLogical: () => ({ width: 320, height: 560 }) });
    await shrink(true);
    mock.calls.length = 0;
    await restore();
    expect(mock.calls).toContain('size 1280x840');
    expect(mock.calls).toContain('at 1000,100');
  });

  it('does nothing outside Tauri', async () => {
    mock.tauri.on = false;
    await shrink(true);
    await keepOnTop(true);
    await restore();
    expect(mock.calls).toEqual([]);
  });
});
