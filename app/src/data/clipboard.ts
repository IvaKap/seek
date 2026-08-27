/*
 * Seek — putting text on the clipboard, and knowing whether it landed.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS FILE EXISTS: `navigator.clipboard` is undefined in the shipped app
 * and present in dev, so Copy diagnostics shipped doing nothing while every
 * test and every hand-check passed.
 *
 * The API is gated on a secure context. A bundle runs at `tauri://localhost`,
 * a custom scheme WKWebView does not treat as secure; `npm run tauri dev` runs
 * at `http://localhost:5273`, which it does. Dev is the configuration that
 * hides it — the same family as the stale `.pyc`, the stale `tsc -b` and the
 * stale frozen sidecar in docs/HANDOFF.md §4.
 *
 * The old call was `navigator.clipboard?.writeText(text)`. Optional chaining
 * makes a missing API evaluate to `undefined` rather than throw, so the
 * caller's success branch ran and the button said "Copied" over an untouched
 * clipboard. A silent no-op that reports success is worse than a crash: the
 * first user to hit it spent a week believing the app was broken in a way it
 * could not be diagnosed, because this IS the diagnostic tool.
 *
 * So: three ways to write, tried in order of reliability, and a BOOLEAN back.
 * Nothing here may report success it did not observe.
 */

import { isTauri } from './sidecarClient.ts';

/**
 * The Tauri plugin. Written from Rust, so neither the secure-context gate nor
 * WebKit's user-activation window applies — and the activation window matters
 * as much as the gate here, because Copy diagnostics awaits the engine for the
 * OS details and the log tail before it has anything to write.
 */
async function viaTauri(text: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return true;
  } catch (e) {
    // A missing capability lands here. Worth a console line: this is the path
    // that is supposed to work in the shipped app, so its failing is news.
    console.error('[seek] clipboard plugin write failed', e);
    return false;
  }
}

/**
 * The web API, awaited rather than fired and forgotten.
 *
 * `?.` is deliberately NOT used: the whole defect was a missing API reading as
 * a successful write. Absent means false, and false means the caller says so.
 */
async function viaNavigator(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Refused for want of user activation, or denied outright.
    return false;
  }
}

/**
 * `execCommand`, which is deprecated and still the only thing that works in a
 * webview with no secure context and no plugin — the browser recipe in
 * CLAUDE.md, for one.
 *
 * Synchronous on purpose. It is the one path that can still succeed inside a
 * user gesture that an await has already spent.
 */
function viaExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = text;
  // Off-screen rather than hidden: `display: none` and `visibility: hidden`
  // are not selectable, and an unselectable field copies nothing. Fixed
  // position at the top keeps the page from scrolling to it.
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
  }
}

/**
 * Put `text` on the clipboard. Returns whether it actually got there.
 *
 * A false is not an error to swallow — it is the caller's cue to stop claiming
 * the copy happened and show the text instead, so a person can select it by
 * hand. That is the difference between a degraded feature and a lie.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (await viaTauri(text)) return true;
  if (await viaNavigator(text)) return true;
  return viaExecCommand(text);
}
