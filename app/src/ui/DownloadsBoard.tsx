/*
 * Seek — Downloads · Board: every release as a card in the column of what is
 * happening to it, from a peer's queue to the Rekordbox folder.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * After its canvas board. Simple only: Collector keeps its densities. The
 * columns sort by the same rules as Simple's list and the corner panel
 * (`downloadsKind`), so a release never sits in one column here and another
 * section there. Two columns are new, and both are facts rather than guesses:
 * Checking is a checksum check in progress, Sent is the hand-off's own record.
 *
 * Nothing moves a card on its own. Keep, Reject and Send are the person's.
 */

import type { ReactNode } from 'react';
import type { TransferGroup, TransferSession } from '../data/transferStore.ts';
import { isFailed } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { AutoClaim } from '../../../shared/protocol.ts';
import { summarise } from '../domain/checksums.ts';
import { releaseHandoff } from '../domain/handoff.ts';
import { groupStatus, transferStatus } from '../domain/transferStatus.ts';
import { fileSize, integer, since, spanWords, speed } from '../domain/format.ts';
import { Bar, Cover, ReleaseName } from './transferBits.tsx';
import { FormatBadge } from './rows.tsx';
import { finishedAt, troubleLine } from './CornerPanel.tsx';
import { another, downloadsKind, formatOf, queueLine, rateAndTime } from './DownloadsSimple.tsx';
import { HandoffButton } from './HandoffButton.tsx';
import type { HandoffBits } from './HandoffButton.tsx';
import { reportFailure } from '../data/failures.ts';

/** Sent cards shown; the column still counts them all. */
const MAX_SENT = 8;

export interface Columns {
  queued: TransferGroup[];
  downloading: TransferGroup[];
  checking: TransferGroup[];
  ready: TransferGroup[];
  /** Newest send first. All of them: the Board shows the first few. */
  sent: TransferGroup[];
}

const firstFinished = (g: TransferGroup) => g.transfers.find((t) => t.state === 'finished')?.id;

/**
 * Sort releases into the board's columns. `now` is epoch seconds; `held` are
 * transfers waiting for review, which are Ready whatever their age, because
 * they wait for a decision only the person can make.
 *
 * A finished release is Sent once every finished file is in the Rekordbox
 * folder, Checking while its checksum check runs, and otherwise Ready while it
 * is the last hour's: the same window as Downloads' Just finished. Older ones
 * are Completed's.
 */
export function boardColumns(
  groups: readonly TransferGroup[],
  now: number,
  checks: ChecksumSession['byTransfer'],
  handoff: HandoffBits['session'],
  held: ReadonlySet<string>,
): Columns {
  const out: Columns = { queued: [], downloading: [], checking: [], ready: [], sent: [] };
  const sentAt = new Map<TransferGroup, number>();
  for (const g of groups) {
    if (g.state === 'finished') {
      // Review first: a held file waits for Keep or Reject even when the rest
      // of its folder has already gone.
      if (g.transfers.some((t) => held.has(t.id))) {
        out.ready.push(g);
        continue;
      }
      const ids = g.transfers.filter((t) => t.state === 'finished').map((t) => t.id);
      const r = releaseHandoff(ids, handoff);
      if (ids.length > 0 && r.sent === r.total) {
        out.sent.push(g);
        sentAt.set(g, r.sentAt!);
      } else if (downloadsKind(g, now) !== 'finished') continue;
      else if (checks.get(firstFinished(g) ?? '')?.state === 'running') out.checking.push(g);
      else out.ready.push(g);
      continue;
    }
    const kind = downloadsKind(g, now);
    if (kind === 'moving') out.downloading.push(g);
    else if (kind === 'waiting' || kind === 'trouble') (g.bytesDone > 0 ? out.downloading : out.queued).push(g);
  }
  out.ready.sort((a, b) => finishedAt(b) - finishedAt(a));
  out.sent.sort((a, b) => sentAt.get(b)! - sentAt.get(a)!);
  return out;
}

export type Column = keyof Columns;

export interface Said {
  line: string;
  /** Why it will not come down, as `groupStatus` tones it. */
  tone?: string;
  /** A finished checksum check's tone, which colours the line. */
  check?: string;
  bar?: 'active' | 'paused' | 'trouble';
}

interface SayContext {
  now: number;
  checks: ChecksumSession['byTransfer'];
  handoff: HandoffBits['session'];
  /** Awaiting-review claims, by transfer id. */
  review: ReadonlyMap<string, AutoClaim>;
}

/** The claim a release is waiting for review under, if any. */
export const claimOf = (g: TransferGroup, review: SayContext['review']) =>
  g.transfers.map((t) => review.get(t.id)).find((c) => c !== undefined);

/** What one line says about a release in a column. The Board's cards and the
 * Folders tree say the same thing, so neither can drift from the other. */
export function say(g: TransferGroup, column: Column, ctx: SayContext): Said {
  const trouble = downloadsKind(g, ctx.now) === 'trouble';
  const tone = g.state === 'stalled' ? 'broken' : groupStatus(g.transfers)?.tone;
  switch (column) {
    case 'queued':
      return trouble ? { line: troubleLine(g), tone } : { line: queueLine(g) };
    case 'downloading':
      if (trouble) return { line: troubleLine(g), tone, bar: 'trouble' };
      if (g.state === 'paused') return { line: queueLine(g), bar: 'paused' };
      return { line: `${fileSize(g.bytesDone)} of ${fileSize(g.size)} · ${rateAndTime(g)}`, bar: 'active' };
    case 'checking': {
      // Every sidecar in the folder is checked, so a release with both says both.
      const kinds = ['.ffp', '.md5'].filter((ext) => g.transfers.some((t) => t.path.toLowerCase().endsWith(ext)));
      return { line: `Checking each track against the ${kinds.join(' and ') || 'checksum file'}` };
    }
    case 'ready': {
      if (claimOf(g, ctx.review)) return { line: 'Waiting for your review' };
      const check = ctx.checks.get(firstFinished(g) ?? '');
      const s = check?.state === 'done' ? summarise(check.report!) : null;
      return s && !s.none
        ? { line: s.headline, check: s.tone }
        : { line: `Finished ${spanWords(ctx.now - finishedAt(g))} ago` };
    }
    case 'sent': {
      const ids = g.transfers.filter((t) => t.state === 'finished').map((t) => t.id);
      return { line: `In the Rekordbox folder · sent ${since(releaseHandoff(ids, ctx.handoff).sentAt ?? ctx.now)}` };
    }
  }
}

/**
 * Downloads' header in Board and Folders: the counts Simple's list shows, the
 * layout switch, and where Send to Rekordbox copies to.
 */
export function LayoutHeader({ groups, now, handoff, tools }: {
  groups: readonly TransferGroup[];
  now: number;
  handoff: HandoffBits;
  tools: ReactNode;
}) {
  // Counted as Simple's list counts them, so switching layouts changes nothing.
  const kinds = groups.map((g) => downloadsKind(g, now));
  const inProgress = kinds.filter((k) => k === 'moving' || k === 'waiting').length;
  const total = groups.reduce((n, g, i) => n + (kinds[i] === 'moving' ? g.speed : 0), 0);
  const folder = handoff.session.folder;
  return (
    <header data-tauri-drag-region="deep" className="header header--plain dls__header">
      <div className="dls__heading">
        <h1 className="pane__title">Downloads</h1>
        {inProgress > 0 && (
          <p className="pane__subtitle tnum">
            {integer(inProgress)} in progress{total > 0 && ` · ${speed(total)} in total`}
          </p>
        )}
      </div>
      <div className="dls__tools board__tools">
        <div className="dls__tools">{tools}</div>
        {folder ? (
          <span className="board__folder" title={folder}>Rekordbox folder: {homeShort(folder)}</span>
        ) : (
          <button type="button" className="corner__link" onClick={handoff.onSetFolder}>Choose a Rekordbox folder</button>
        )}
      </div>
    </header>
  );
}

/** `/Users/x/Music/RB` → `~/Music/RB`, as Finder's title bar would say it. */
export function homeShort(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

function Card({ g, artwork, said: { line, tone, check, bar }, chip, children }: {
  g: TransferGroup;
  artwork?: ArtworkSession;
  said: Said;
  chip?: string;
  children?: ReactNode;
}) {
  const format = formatOf(g);
  return (
    <li className="board__card" data-tone={tone}>
      <div className="board__head">
        <Cover g={g} artwork={artwork} size="row" />
        <div className="board__name">
          <span className="board__title"><ReleaseName g={g} /></span>
          <span className="board__chips">
            {format && <FormatBadge label={format.label} tier={format.tier} title={format.description} />}
            {chip && <span className="board__chip">{chip}</span>}
          </span>
        </div>
      </div>
      {bar && <Bar done={g.bytesDone} total={g.size} state={bar} />}
      <span className="board__line tnum" data-check={check}>{line}</span>
      {children && <div className="board__actions">{children}</div>}
    </li>
  );
}

function Column({ id, title, note, count, children }: {
  id: string; title: string; note: string; count: number; children: ReactNode;
}) {
  return (
    <section className="board__col" aria-labelledby={`board-${id}`}>
      <header className="board__colhead">
        <h2 id={`board-${id}`} className="board__h">
          {title} <span className="board__n tnum">{integer(count)}</span>
        </h2>
        <span className="board__note">{note}</span>
      </header>
      {count > 0 ? <ul className="board__cards">{children}</ul> : <p className="board__empty">Nothing here</p>}
    </section>
  );
}

export function DownloadsBoard({
  session, artwork, checksums, handoff, claims, now, tools, notices,
  onFindAnother, onApproveAuto, onRejectAuto,
}: {
  session: TransferSession;
  artwork?: ArtworkSession;
  checksums: ChecksumSession;
  handoff: HandoffBits;
  /** Every auto-download claim; the ones awaiting review are Ready's. */
  claims: readonly AutoClaim[];
  /** Epoch seconds, from DownloadsView's coarse clock. */
  now: number;
  /** The header's buttons, from DownloadsView: the layout switch, Mini Seek. */
  tools: ReactNode;
  notices: ReactNode;
  onFindAnother?(query: string): void;
  onApproveAuto?(query: string): void;
  onRejectAuto?(query: string): void;
}) {
  const review = new Map(claims.filter((c) => c.status === 'awaiting-review').map((c) => [c.transferId, c]));
  const cols = boardColumns(session.groups, now, checksums.byTransfer, handoff.session, handoff.held);
  const ctx = { now, checks: checksums.byTransfer, handoff: handoff.session, review };

  /* What will not come down offers a retry where a retry can change something,
     and another copy otherwise, exactly as Mini Seek does. */
  const rescue = (g: TransferGroup) => {
    if (downloadsKind(g, now) !== 'trouble') return null;
    const retry = g.transfers.filter((t) => isFailed(t.state) && transferStatus(t).retryable).map((t) => t.id);
    if (retry.length > 0) {
      return <button type="button" className="btn pressable" onClick={() => session.retry(retry)}>Retry</button>;
    }
    return onFindAnother && (
      <button type="button" className="btn pressable" onClick={() => onFindAnother(another(g))}>
        {g.bytesDone > 0 ? 'Try another copy' : 'Find another copy'}
      </button>
    );
  };
  const card = (g: TransferGroup, column: Column, children?: ReactNode, chip?: string) => (
    <Card key={g.key} g={g} artwork={artwork} said={say(g, column, ctx)} chip={chip}>{children}</Card>
  );

  return (
    <>
      <LayoutHeader groups={session.groups} now={now} handoff={handoff} tools={tools} />
      <div className="pane__scroll">
        {notices}
        <div className="board">
          <Column id="queued" title="Queued by peer" note="Waiting for a slot on their side" count={cols.queued.length}>
            {cols.queued.map((g) => card(g, 'queued', rescue(g)))}
          </Column>

          <Column id="downloading" title="Downloading" note="Measured speed, updated every 0.4 s" count={cols.downloading.length}>
            {cols.downloading.map((g) => card(g, 'downloading', rescue(g)))}
          </Column>

          <Column id="checking" title="Checking" note="Compared with the .ffp or .md5 it came with" count={cols.checking.length}>
            {cols.checking.map((g) => card(g, 'checking'))}
          </Column>

          <Column id="ready" title="Ready" note="Finished and waiting for you" count={cols.ready.length}>
            {cols.ready.map((g) => {
              const claim = claimOf(g, review);
              return claim ? card(g, 'ready', (
                <>
                  {onApproveAuto && <button type="button" className="btn pressable" onClick={() => onApproveAuto(claim.query)}>Keep</button>}
                  {onRejectAuto && <button type="button" className="btn pressable" onClick={() => onRejectAuto(claim.query)}>Reject</button>}
                </>
              ), 'From your wishlist') : card(g, 'ready', <HandoffButton g={g} handoff={handoff} />);
            })}
          </Column>

          <Column id="sent" title="Sent to Rekordbox" note="Copied into your Rekordbox folder" count={cols.sent.length}>
            {cols.sent.slice(0, MAX_SENT).map((g) => {
              const dest = releaseHandoff(g.transfers.filter((t) => t.state === 'finished').map((t) => t.id), handoff.session).dest;
              return card(g, 'sent', dest && (
                <button
                  type="button" className="btn pressable" title={dest}
                  onClick={() => void handoff.session.reveal(dest).catch((e) => reportFailure('Show the copy in Finder', e))}
                >
                  Show in Finder
                </button>
              ));
            })}
            {cols.sent.length > MAX_SENT && (
              <li className="board__more tnum">and {integer(cols.sent.length - MAX_SENT)} more, in Completed</li>
            )}
          </Column>
        </div>
      </div>
    </>
  );
}
