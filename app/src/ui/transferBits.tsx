/*
 * Seek — the presentation pieces both transfer directions share.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Extracted from `DownloadsView` when uploads got a screen. Nothing here is
 * download-specific: a progress bar, a duration, and the release a group of
 * files belongs to are the same question whichever way the bytes are moving.
 *
 * What did NOT come with them is the whole reason uploads have their own view
 * rather than a filter on the downloads one — verify, organise, preview,
 * related, metadata are all things you do to a file you RECEIVED. None of them
 * mean anything about a file of your own that a stranger is fetching.
 */

import type { TransferGroup } from '../data/transferStore.ts';
import { parsePath } from '../domain/parsePath.ts';
import { duration } from '../domain/format.ts';

export function releaseOf(g: TransferGroup): { artist: string; release: string } {
  const first = g.transfers[0];
  if (!first) return { artist: '', release: g.title };
  const parsed = parsePath(first.path);
  return {
    artist: parsed.artist?.value ?? '',
    // The folder IS the release — the same assumption the whole app makes.
    release: parsed.release?.value ?? g.title,
  };
}

/** Seconds left → `3:07` or `1:02:44`. An em dash where it cannot be known:
 * 0 means no estimate, and `duration` alone would print 0:00. */
export function etaLabel(seconds: number | null): string {
  return duration(seconds || null);
}

/** The longest remaining file decides when the group is done. */
export function groupEta(g: TransferGroup): number | null {
  return g.transfers.reduce<number | null>(
    (max, t) => (t.secondsLeft === null ? max
      : max === null ? t.secondsLeft : Math.max(max, t.secondsLeft)),
    null,
  );
}

export function Bar({ done, total, state }: { done: number; total: number; state: string }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="prog" data-state={state}>
      {/* scaleX, not width — width animates layout every frame. */}
      <div className="prog__fill" style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  );
}
