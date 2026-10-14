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
import { count, fileSize, ordinal, spanWords, speed } from '../domain/format.ts';
import { IconMinus } from '../icons/index.tsx';
import { Bar, releaseOf } from './transferBits.tsx';
import type { Mode } from './viewMode.ts';

/** Rows on the card. The rest are a "Show all" away. */
const MAX_ROWS = 3;

export type Kind = 'moving' | 'waiting' | 'trouble' | 'finished';

export interface CornerRow {
  group: TransferGroup;
  kind: Kind;
  line: string;
  sub: string | null;
  /** Place in the peer's queue, for a waiting release. */
  position: number | null;
}

const ORDER: Record<Kind, number> = { moving: 0, waiting: 1, trouble: 2, finished: 3 };

/**
 * What a release is doing. Downloads · Simple sorts by the same answer, so the
 * panel and the screen never disagree about which release needs you. Null for
 * one you paused or cancelled (you did that), and for one that finished at or
 * before `since` (epoch seconds).
 */
export function kindOf(g: TransferGroup, since: number): Kind | null {
  if (g.state === 'paused' || g.state === 'cancelled') return null;
  if (g.state === 'finished') return finishedAt(g) > since ? 'finished' : null;
  const status = groupStatus(g.transfers);
  if (g.state === 'failed' || g.state === 'stalled' || status?.tone === 'refused' || status?.tone === 'broken') {
    return 'trouble';
  }
  return g.transfers.some((t) => t.state === 'transferring' || t.state === 'getting_status')
    ? 'moving' : 'waiting';
}

/** When a release's last file landed, in epoch seconds. */
export function finishedAt(g: TransferGroup): number {
  return Math.max(0, ...g.transfers.map((t) => t.finishedAt ?? 0));
}

/** Its place in the peer's queue: its first file's. Null until the peer says. */
export function queuePlace(g: TransferGroup): number | null {
  const positions = g.transfers
    .filter((t) => t.state === 'queued' && t.queuePosition !== null)
    .map((t) => t.queuePosition as number);
  return positions.length > 0 ? Math.min(...positions) : null;
}

export function startsWhen(position: number): string {
  const ahead = position - 1;
  return ahead === 0 ? 'Starts next'
    : `Starts when the ${ahead.toLocaleString('en-US')} ahead of you ${ahead === 1 ? 'finishes' : 'finish'}`;
}

/** Why a release in trouble is not coming down, in the shared wording. */
export function troubleLine(g: TransferGroup): string {
  // Given up on by the stall threshold: the number is what decides a retry.
  if (g.state === 'stalled') return `Stalled · nothing has arrived for ${spanWords(g.quietFor)}`;
  return groupStatus(g.transfers)?.text ?? 'Stopped';
}

/**
 * What a release is doing, in a few words for a Status column or a details
 * pane: the trouble line above for a release in trouble, so the panel and the
 * table never disagree, and plainly what the bar shows otherwise. A column
 * cannot leave a moving row blank the way a card can.
 */
export function statusOf(g: TransferGroup): { text: string; tone: string } {
  if (g.state === 'paused') return { text: 'Paused', tone: 'waiting' };
  const kind = kindOf(g, 0);
  if (kind === 'trouble') return { text: troubleLine(g), tone: groupStatus(g.transfers)?.tone ?? 'broken' };
  if (kind === 'finished') return { text: 'Finished', tone: 'done' };
  if (kind === 'moving') return { text: 'Downloading', tone: 'active' };
  return groupStatus(g.transfers) ?? { text: 'Waiting', tone: 'waiting' };
}

function row(g: TransferGroup, since: number): CornerRow | null {
  const kind = kindOf(g, since);
  if (kind === null) return null;

  if (kind === 'finished') {
    const tracks = g.transfers.filter((t) => isAudioPath(t.path)).length;
    const what = tracks > 0 ? count(tracks, 'track') : count(g.transfers.length, 'file');
    return { group: g, kind, line: `Finished · ${what} now in Completed`, sub: null, position: null };
  }
  if (kind === 'trouble') return { group: g, kind, line: troubleLine(g), sub: null, position: null };
  if (kind === 'moving') {
    const rate = g.speed > 0 ? speed(g.speed) : 'Starting';
    return { group: g, kind, line: `${rate} · ${fileSize(g.bytesDone)} of ${fileSize(g.size)}`, sub: null, position: null };
  }

  const position = queuePlace(g);
  // Queued with no place in line: asked, not yet answered. Not news yet.
  if (position === null) return null;
  return {
    group: g,
    kind,
    line: `Waiting in ${g.username}'s queue · ${ordinal(position)} in line`,
    sub: startsWhen(position),
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
