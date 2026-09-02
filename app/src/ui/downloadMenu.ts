/*
 * Seek — the right-click menu for a file (or a selection) in Downloads.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pulled out of DownloadsView so the one thing that is easy to get wrong — WHICH
 * action applies to WHICH subset of a mixed selection — can be tested without a
 * DOM. Over a selection of, say, one running and one failed file, Pause must
 * touch only the running one and Retry only the failed one; a menu that cancels
 * the lot, or retries something already downloading, is worse than no menu.
 *
 * The session methods and clipboard are injected rather than imported, so a test
 * can hand in spies and assert the exact ids each item fires with. Everything
 * else here (the state classifiers, the filename) is already pure.
 */

import type { Transfer } from '../data/transferStore.ts';
import {
  fileName, isActive, isCancelled, isFailed, isTerminal,
} from '../data/transferStore.ts';
import type { MenuItem } from './ContextMenu.tsx';

export interface FileMenuActions {
  pause(ids: string[]): void;
  resume(ids: string[]): void;
  retry(ids: string[]): void;
  /** Stop and REMOVE — the real cancel (see core_host `_cmd_transfer_cancel`). */
  cancel(ids: string[]): void;
  clear(ids: string[]): void;
  copy(text: string): void;
}

/**
 * The menu items for `targets`. Empty when nothing can be done to any of them
 * (the caller then opens no menu at all).
 */
export function fileMenuItems(targets: Transfer[], a: FileMenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  const idsWhere = (p: (t: Transfer) => boolean) => targets.filter(p).map((t) => t.id);

  const cancellable = idsWhere((t) => !isTerminal(t.state));
  const active = idsWhere((t) => isActive(t.state));
  const paused = idsWhere((t) => t.state === 'paused');
  const retryable = idsWhere((t) => isFailed(t.state) || isCancelled(t.state));
  const clearable = idsWhere((t) => isTerminal(t.state));

  const many = targets.length > 1;
  /* Count suffix only when acting on many, so a single-file menu reads "Pause"
     and a selection reads "Pause 3". */
  const suffix = (arr: string[]) => (many ? ` ${arr.length}` : '');

  if (active.length) {
    items.push({ id: 'pause', label: `Pause${suffix(active)}`, run: () => a.pause(active) });
  }
  if (paused.length) {
    items.push({ id: 'resume', label: `Resume${suffix(paused)}`, run: () => a.resume(paused) });
  }
  if (retryable.length) {
    items.push({ id: 'retry', label: `Retry${suffix(retryable)}`, run: () => a.retry(retryable) });
  }
  if (cancellable.length) {
    items.push({
      id: 'cancel', danger: true, separated: items.length > 0,
      label: `Cancel${suffix(cancellable)} — stop and remove`,
      run: () => a.cancel(cancellable),
    });
  }
  if (clearable.length) {
    items.push({ id: 'clear', label: `Clear${suffix(clearable)}`, run: () => a.clear(clearable) });
  }

  // Copy targets a single file — three copy rows for a selection is just noise.
  if (targets.length === 1) {
    const t = targets[0];
    items.push(
      { id: 'copypath', separated: true, label: 'Copy file path', run: () => a.copy(t.path) },
      { id: 'copyname', label: 'Copy file name', run: () => a.copy(fileName(t.path)) },
      { id: 'copyuser', label: 'Copy username', run: () => a.copy(t.username) },
    );
  }

  return items;
}
