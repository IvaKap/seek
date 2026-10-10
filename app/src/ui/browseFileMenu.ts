/*
 * Seek — the right-click menu for a file (or a selection) in Browse's file table.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The Downloads sibling (`downloadMenu.ts`) buckets targets by transfer state;
 * a browsed file has no state to bucket by — it is either queued or it is
 * not, and Get handles both. Kept as its own pure, tested function anyway,
 * for the same reason: the actual behaviour (pluralising past one target,
 * only offering per-file Copy actions for a single target) is exactly the
 * kind of thing worth pinning without a DOM.
 */

import type { BrowseFile } from '../data/browseStore.ts';
import { fileName } from '../data/transferStore.ts';
import type { MenuItem } from './ContextMenu.tsx';
import { soulseekUrl } from '../domain/soulseekUrl.ts';

export interface BrowseFileMenuActions {
  queue(files: BrowseFile[]): void;
  /** Ask for a folder, then queue there. Absent where there is no folder panel. */
  queueTo?(files: BrowseFile[]): void;
  copy(text: string): void;
}

export function browseFileMenuItems(
  targets: BrowseFile[], username: string, a: BrowseFileMenuActions,
): MenuItem[] {
  if (targets.length === 0) return [];
  const many = targets.length > 1;

  const items: MenuItem[] = [
    { id: 'get', label: many ? `Get ${targets.length} files` : 'Get', run: () => a.queue(targets) },
  ];
  if (a.queueTo) {
    const to = a.queueTo;
    items.push({ id: 'getto', label: many ? `Get ${targets.length} files to…` : 'Get to…', run: () => to(targets) });
  }

  // Copy targets a single file — three copy rows for a selection is just noise.
  if (!many) {
    items.push(
      { id: 'copypath', separated: true, label: 'Copy file path', run: () => a.copy(targets[0].path) },
      { id: 'copyname', label: 'Copy file name', run: () => a.copy(fileName(targets[0].path)) },
      { id: 'copylink', label: 'Copy Soulseek link', run: () => a.copy(soulseekUrl(username, targets[0].path)) },
    );
  }
  items.push({
    id: 'copyuser', separated: many, label: 'Copy username', run: () => a.copy(username),
  });

  return items;
}
