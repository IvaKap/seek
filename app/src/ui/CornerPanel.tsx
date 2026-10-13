/*
 * Seek — the corner panel: downloads you can watch without leaving the screen
 * you are on.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * It appears only once a peer has ANSWERED, and then always says where you
 * stand. Upstream marks a file "queued" the moment Get is pressed, before the
 * peer has said a word; a place in line, a transfer starting, a refusal or a
 * finish is an answer. Until then the Get button itself says it is asking.
 *
 * Two forms. Simple opens on the card, one row per release; Collector opens on
 * a two-line pill. Either folds into the other. A finished release stays until
 * you look at Downloads or Completed, so a download that lands while you are
 * elsewhere is not missed.
 */

import { useMemo, useState } from 'react';
import type { TransferGroup } from '../data/transferStore.ts';
import { isAudioPath } from '../data/adapt.ts';
import { groupStatus } from '../domain/transferStatus.ts';
import { count, fileSize, ordinal, speed } from '../domain/format.ts';
import { IconMinus } from '../icons/index.tsx';
import { Bar, releaseOf } from './transferBits.tsx';
import type { Mode } from './viewMode.ts';

/** Rows on the card. The rest are a "Show all" away. */
const MAX_ROWS = 3;

type Kind = 'moving' | 'waiting' | 'trouble' | 'finished';

export interface CornerRow {
  group: TransferGroup;
  kind: Kind;
  line: string;
  sub: string | null;
  /** Place in the peer's queue, for a waiting release. */
  position: number | null;
}

const ORDER: Record<Kind, number> = { moving: 0, waiting: 1, trouble: 2, finished: 3 };

function row(g: TransferGroup, since: number): CornerRow | null {
  if (g.state === 'paused' || g.state === 'cancelled') return null;

  if (g.state === 'finished') {
    const done = Math.max(...g.transfers.map((t) => t.finishedAt ?? 0));
    if (done <= since) return null;
    const tracks = g.transfers.filter((t) => isAudioPath(t.path)).length;
    const what = tracks > 0 ? count(tracks, 'track') : count(g.transfers.length, 'file');
    return { group: g, kind: 'finished', line: `Finished · ${what} now in Completed`, sub: null, position: null };
  }

  const status = groupStatus(g.transfers);
  if (g.state === 'failed' || g.state === 'stalled' || status?.tone === 'refused' || status?.tone === 'broken') {
    const line = status?.text
      ?? (g.state === 'stalled' ? 'Stalled — nothing received for a while' : 'Stopped');
    return { group: g, kind: 'trouble', line, sub: null, position: null };
  }

  const moving = g.transfers.some((t) => t.state === 'transferring' || t.state === 'getting_status');
  if (moving) {
    const rate = g.speed > 0 ? speed(g.speed) : 'Starting';
    return {
      group: g, kind: 'moving',
      line: `${rate} · ${fileSize(g.bytesDone)} of ${fileSize(g.size)}`, sub: null, position: null,
    };
  }

  const positions = g.transfers
    .filter((t) => t.state === 'queued' && t.queuePosition !== null)
    .map((t) => t.queuePosition as number);
  // Queued with no place in line: asked, not yet answered. Not news yet.
  if (positions.length === 0) return null;
  const position = Math.min(...positions);
  const ahead = position - 1;
  return {
    group: g,
    kind: 'waiting',
    line: `Waiting in ${g.username}'s queue · ${ordinal(position)} in line`,
    sub: ahead === 0 ? 'Starts next'
      : `Starts when the ${ahead.toLocaleString('en-US')} ahead of you ${ahead === 1 ? 'finishes' : 'finish'}`,
    position,
  };
}

/**
 * The releases worth a row, moving first: what is happening, then what is
 * waiting, then what needs you, then what landed after `since` (epoch seconds).
 */
export function cornerRows(groups: TransferGroup[], since: number): CornerRow[] {
  return groups
    .map((g) => row(g, since))
    .filter((r): r is CornerRow => r !== null)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/** The pill's lines, most worth knowing first. */
export function cornerSummary(rows: CornerRow[]): string[] {
  const of = (kind: Kind) => rows.filter((r) => r.kind === kind);
  const moving = of('moving');
  const waiting = of('waiting');
  const trouble = of('trouble');
  const finished = of('finished');
  const lines: string[] = [];
  if (moving.length) {
    lines.push(`${moving.length} downloading · ${speed(moving.reduce((n, r) => n + r.group.speed, 0))}`);
  }
  if (waiting.length) {
    const first = Math.min(...waiting.map((r) => r.position ?? Infinity));
    lines.push(`${waiting.length} waiting, ${waiting.length === 1 ? '' : 'nearest '}${ordinal(first)} in line`);
  }
  if (trouble.length) lines.push(`${trouble.length} ${trouble.length === 1 ? 'needs' : 'need'} a look`);
  if (finished.length) lines.push(`${finished.length} finished`);
  return lines;
}

export function CornerPanel({ groups, since, mode, onShowAll, onShowCompleted }: {
  /** Downloads, grouped into releases, from the transfer store. */
  groups: TransferGroup[];
  /** Finished releases older than this (epoch seconds) have been seen. */
  since: number;
  mode: Mode;
  onShowAll(): void;
  onShowCompleted(): void;
}) {
  const rows = useMemo(() => cornerRows(groups, since), [groups, since]);
  const [open, setOpen] = useState(mode === 'simple');
  if (rows.length === 0) return null;

  if (!open) {
    const [first, ...rest] = cornerSummary(rows);
    return (
      <button type="button" className="corner corner--pill pressable" onClick={() => setOpen(true)}>
        <span className="corner__pill-text tnum">
          <span>{first}</span>
          {rest.length > 0 && <span className="corner__dim">{rest.join(' · ')}</span>}
        </span>
      </button>
    );
  }

  return (
    <aside className="corner" aria-label="Downloads">
      <div className="corner__head">
        <span className="corner__title">
          Downloads <span className="corner__dim tnum">{rows.length}</span>
        </span>
        <button type="button" className="corner__link" onClick={onShowAll}>Show all</button>
        <button type="button" className="corner__fold" aria-label="Fold the panel" onClick={() => setOpen(false)}>
          <IconMinus size={12} painted={1.7} />
        </button>
      </div>
      <ul className="corner__rows">
        {rows.slice(0, MAX_ROWS).map((r) => {
          const { artist, release } = releaseOf(r.group);
          return (
            <li key={r.group.key} className="corner__row" data-kind={r.kind}>
              <span className="corner__name">
                {artist && <><b>{artist}</b><span className="corner__dash" aria-hidden> — </span></>}
                {release}
              </span>
              {(r.kind === 'moving' || r.kind === 'finished') && (
                <Bar done={r.group.bytesDone} total={r.group.size} state={r.kind === 'finished' ? 'finished' : 'active'} />
              )}
              <span className="corner__line tnum">{r.line}</span>
              {r.sub && <span className="corner__sub tnum">{r.sub}</span>}
              {r.kind === 'finished' && (
                <button type="button" className="corner__link" onClick={onShowCompleted}>Show in Completed</button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
