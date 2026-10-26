/*
 * Seek — the window as Mini Seek: small, at the corner it was in, and above
 * other apps if you like.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The same window, not a second one. A second webview would be a second page
 * with its own socket to the sidecar and its own copy of every store; this
 * keeps one of each and changes only the frame, then puts the full frame back
 * exactly as it was.
 *
 * Every call does nothing outside Tauri: the browser recipe in CLAUDE.md runs
 * the same frontend with no window to resize, and there Mini Seek is simply
 * the small layout.
 */

import { isTauri } from './sidecarClient.ts';

/** Mini Seek's size, after its canvas board. Fixed, like a mini player's. */
export const MINI = { width: 320, height: 560 };
/** tauri.conf.json's minWidth and minHeight, which Mini Seek has to lift. */
const FULL_MIN = { width: 880, height: 560 };

interface Frame { x: number; y: number; width: number; height: number }
/** The full window's frame while small; null while full. */
let full: Frame | null = null;

/* One at a time. Two quick ⇧⌘M used to interleave: the restore ran while the
   shrink was still waiting out full screen, found no frame to go back to, and
   then the shrink finished: the full app in a tiny window that would not
   resize. Queued, each waits for the one before. */
let queue: Promise<void> = Promise.resolve();
function queued(step: () => Promise<void>): Promise<void> {
  const next = queue.then(step);
  queue = next.catch(() => {});
  return next;
}

async function api() {
  const { getCurrentWindow, LogicalPosition, LogicalSize } = await import('@tauri-apps/api/window');
  return { win: getCurrentWindow(), LogicalPosition, LogicalSize };
}

/** Shrink to Mini Seek, keeping the window's top-right corner where it was. */
export function shrink(onTop: boolean): Promise<void> {
  return queued(() => shrinkNow(onTop));
}

async function shrinkNow(onTop: boolean): Promise<void> {
  // Already small: measuring now would save Mini Seek's frame as the full one.
  if (!isTauri() || full) return;
  const { win, LogicalPosition, LogicalSize } = await api();
  // A full-screen window cannot be resized, so leave full screen first.
  if (await win.isFullscreen()) {
    await win.setFullscreen(false);
    /* ponytail: polls for the end of the animation, because Tauri sends no
       event when it finishes. Two seconds, then shrink regardless. */
    for (let i = 0; i < 20 && await win.isFullscreen(); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const scale = await win.scaleFactor();
  const at = (await win.outerPosition()).toLogical(scale);
  const size = (await win.innerSize()).toLogical(scale);
  full = { x: at.x, y: at.y, width: size.width, height: size.height };
  // The minimum first: tauri.conf.json's would hold the window at 880 wide.
  await win.setMinSize(new LogicalSize(MINI.width, MINI.height));
  await win.setSize(new LogicalSize(MINI.width, MINI.height));
  await win.setPosition(new LogicalPosition(at.x + size.width - MINI.width, at.y));
  // Not resizable, which also stops a double-click on its title bar zooming it.
  await win.setResizable(false);
  await win.setAlwaysOnTop(onTop);
}

/**
 * Back to the full window, where it was and as big as it was. With no frame to
 * go back to (a reload while small), it still puts back the full window's
 * rules, which is why the app calls this once at startup.
 */
export function restore(): Promise<void> {
  return queued(restoreNow);
}

async function restoreNow(): Promise<void> {
  if (!isTauri()) return;
  const { win, LogicalPosition, LogicalSize } = await api();
  await win.setAlwaysOnTop(false);
  await win.setResizable(true);
  if (full) {
    await win.setSize(new LogicalSize(full.width, full.height));
    await win.setPosition(new LogicalPosition(full.x, full.y));
    full = null;
  }
  // After the size, so the window does not grow twice.
  await win.setMinSize(new LogicalSize(FULL_MIN.width, FULL_MIN.height));
}

export function keepOnTop(on: boolean): Promise<void> {
  return queued(async () => {
    if (!isTauri()) return;
    const { win } = await api();
    await win.setAlwaysOnTop(on);
  });
}
