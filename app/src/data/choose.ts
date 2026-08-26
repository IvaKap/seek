/*
 * Seek — the native folder chooser, where there is one.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The same frontend runs in two shells: inside Tauri, where a real macOS open
 * panel is available, and in a plain browser tab against a hand-started
 * sidecar (the recipe in CLAUDE.md, which is how most of this app gets
 * verified). A browser cannot open a folder picker at all — the File System
 * Access API's `showDirectoryPicker` hands back a sandboxed HANDLE, never a
 * path, and a path is exactly what the sidecar needs.
 *
 * So the picker is an accelerator, never the only way in. Every folder setting
 * keeps an editable path field beside it, which is also what someone typing a
 * path on a volume the panel makes awkward to reach will want.
 */

import { isTauri } from './sidecarClient.ts';

/** Whether a native chooser can be offered at all. */
export function canChooseFolder(): boolean {
  return isTauri();
}

/**
 * Open the macOS folder panel.
 *
 * Returns the chosen absolute path, or null when the user cancelled OR when no
 * native panel exists. Both are "nothing was chosen" as far as a caller is
 * concerned, and neither is an error worth showing.
 */
export async function chooseFolder(title: string, startAt?: string | null): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      directory: true,
      multiple: false,
      title,
      // An empty string is not a valid default and makes the panel open at an
      // arbitrary place; omitting the key opens it where macOS last was.
      ...(startAt ? { defaultPath: startAt } : {}),
    });
    // v2 returns a string for a single selection, or null on cancel. The array
    // branch cannot happen with multiple: false, but is handled rather than
    // cast away — this is exactly the sort of shape assumption that has been
    // wrong before in this project.
    if (typeof picked === 'string') return picked;
    if (Array.isArray(picked)) return picked[0] ?? null;
    return null;
  } catch {
    // A missing capability, a denied permission, a shell without the plugin.
    // The path field is still there, so this is a lost accelerator rather than
    // a lost feature.
    return null;
  }
}

/**
 * Open the macOS file panel, filtered to images.
 *
 * Same contract as `chooseFolder`: null means "nothing was chosen", which
 * covers both cancelling and there being no native panel at all. The profile
 * screen keeps an editable path field beside it for the second case.
 */
export async function chooseImage(title: string, startAt?: string | null): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      directory: false,
      multiple: false,
      title,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
      ...(startAt ? { defaultPath: startAt } : {}),
    });
    if (typeof picked === 'string') return picked;
    if (Array.isArray(picked)) return picked[0] ?? null;
    return null;
  } catch {
    return null;
  }
}
